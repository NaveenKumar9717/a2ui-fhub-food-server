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
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

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
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': API_KEY
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

    const data = await response.json();
    const rawResultText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawResultText) {
      throw new Error('No content returned from Gemini Flash API.');
    }

    console.log('[FoodAI Server] Gemini response received. Cleaning output...');
    const cleanedJsonText = cleanJsonText(rawResultText);

    // Validate if it is valid JSON
    let parsedJson;
    try {
      parsedJson = JSON.parse(cleanedJsonText);
    } catch (parseErr) {
      console.error('[FoodAI Server] JSON Parsing failed. Raw response text was:', rawResultText);
      return res.status(500).json({
        error: 'Generated output was not valid A2UI JSON.',
        details: parseErr.message,
        rawOutput: rawResultText
      });
    }

    console.log('[FoodAI Server] Successfully parsed and returning A2UI JSON.');
    return res.json(parsedJson);

  } catch (error) {
    console.error('[FoodAI Server] Error generating A2UI JSON:', error);
    return res.status(500).json({ error: 'Server error generating UI.', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[FoodAI Server] Running on http://localhost:${PORT}`);
});
