import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5001;

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json());

// Reference API Key and Endpoint
const API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent';

// Helper to strip markdown block fences and extract raw JSON array
function cleanJsonText(rawText) {
  let clean = rawText.trim();
  
  // Remove markdown code fences
  if (clean.startsWith('```')) {
    const firstLineBreak = clean.indexOf('\n');
    if (firstLineBreak !== -1) {
      clean = clean.substring(firstLineBreak + 1);
    }
  }
  if (clean.endsWith('```')) {
    clean = clean.substring(0, clean.length - 3);
  }
  clean = clean.trim();

  // Keep only the content between the outer brackets [ ]
  const startIdx = clean.indexOf('[');
  const endIdx = clean.lastIndexOf(']');
  
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return clean.substring(startIdx, endIdx + 1);
  }
  
  return clean;
}

// Incremental parser class to extract JSON objects from a stream of a JSON array
class IncrementalJsonArrayParser {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = '';
    this.depth = 0;
    this.inString = false;
    this.escapeNext = false;
    this.objectStartIdx = -1;
    this.componentStartIdx = -1;
    this.isUpdateComponents = false;
  }

  write(chunk) {
    this.buffer += chunk;
    let i = this.buffer.length - chunk.length;

    while (i < this.buffer.length) {
      const char = this.buffer[i];

      if (this.escapeNext) {
        this.escapeNext = false;
        i++;
        continue;
      }

      if (char === '\\') {
        this.escapeNext = true;
        i++;
        continue;
      }

      if (char === '"') {
        this.inString = !this.inString;
        i++;
        continue;
      }

      if (!this.inString) {
        if (char === '{') {
          if (this.depth === 0) {
            this.objectStartIdx = i;
            this.isUpdateComponents = false;
          } else if (this.depth === 1 && this.isUpdateComponents) {
            this.componentStartIdx = i;
          }
          this.depth++;
        } else if (char === '}') {
          this.depth--;
          
          if (this.depth === 1 && this.isUpdateComponents && this.componentStartIdx !== -1) {
            const compStr = this.buffer.substring(this.componentStartIdx, i + 1);
            try {
              const component = JSON.parse(compStr);
              // Wrap this individual component and emit immediately
              this.onMessage({
                version: 'v0.9',
                updateComponents: {
                  surfaceId: 'main-surface',
                  components: [component]
                }
              });
            } catch (err) {
              // Ignore partial JSON parse errors
            }
            // Replace parsed component in buffer with a tiny placeholder
            const before = this.buffer.substring(0, this.componentStartIdx);
            const after = this.buffer.substring(i + 1);
            this.buffer = before + ' {} ' + after;
            i = this.componentStartIdx + 3; // Jump past placeholder
            this.componentStartIdx = -1;
          } else if (this.depth === 0 && this.objectStartIdx !== -1) {
            const objStr = this.buffer.substring(this.objectStartIdx, i + 1);
            try {
              const parsed = JSON.parse(objStr);
              // Emit normal messages (like createSurface, updateDataModel)
              if (!parsed.updateComponents) {
                this.onMessage(parsed);
              }
            } catch (err) {
              // Ignore invalid JSON parsing chunks
            }
            this.buffer = this.buffer.substring(i + 1);
            i = -1;
            this.objectStartIdx = -1;
          }
        } else if (this.depth === 1 && !this.isUpdateComponents) {
          if (this.buffer.includes('"updateComponents"')) {
            this.isUpdateComponents = true;
          }
        }
      }
      i++;
    }
  }
}

app.post('/api/generate', async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Missing text input field.' });
  }

  console.log(`[FoodAI Server] Received request: "${text}"`);

  try {
    // 1. Read the SKILL.md instruction context
    const skillPath = path.join(__dirname, '.agents', 'skills', 'food-ai', 'SKILL.md');
    let systemInstruction = '';
    
    if (fs.existsSync(skillPath)) {
      systemInstruction = await fs.promises.readFile(skillPath, 'utf-8');
    } else {
      console.warn('SKILL.md not found at path: ', skillPath);
    }

    // 2. Build Prompt
    const fullPrompt = `${systemInstruction}\n\nUser request to act upon:\n"${text}"`;

    // 3. Request Gemini API
    const response = await fetch(`${GEMINI_API_URL}?key=${API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: fullPrompt
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API Error (status ${response.status}): ${errText}`);
    }

    // Set headers for HTTP chunked stream response
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Setup streaming parser pipeline
    const a2uiParser = new IncrementalJsonArrayParser((parsedMessage) => {
      res.write(JSON.stringify(parsedMessage) + '\n');
    });

    const geminiParser = new IncrementalJsonArrayParser((chunkObj) => {
      const chunkText = chunkObj.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (chunkText) {
        a2uiParser.write(chunkText);
      }
    });

    // Read the stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        const textChunk = decoder.decode(value, { stream: true });
        geminiParser.write(textChunk);
      }
    }

    res.end();

  } catch (error) {
    console.error('[FoodAI Server] Error generating A2UI JSON:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Server error generating UI.', details: error.message });
    } else {
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`[FoodAI Server] Running on http://localhost:${PORT}`);
});
