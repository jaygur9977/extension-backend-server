require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});

// Faster + lighter model for coding tasks
const MODEL = 'openai/gpt-oss-20b';
const PORT = 3031;

function log(...a) { console.log('[Coding]', ...a); }
function logErr(...a) { console.error('[Coding ERROR]', ...a); }

async function callGroqWithRetry(messages, maxAttempts = 5) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: MODEL,
        messages,
        temperature: 0.1,
        max_tokens: 1200,
        response_format: { type: 'json_object' }
      });
      return completion.choices[0].message.content;
    } catch (err) {
      lastErr = err;
      const status = err.status || err.response?.status;
      let waitMs = null;
      const ra = err.response?.headers?.['retry-after'];
      if (ra) waitMs = parseInt(ra) * 1000;
      const m = err.message?.match(/try again in (\d+(?:\.\d+)?)s/i);
      if (m) waitMs = Math.ceil(parseFloat(m[1]) * 1000) + 1000;

      logErr(`Attempt ${attempt} (${status}): ${err.message.slice(0, 150)}`);

      if (status === 429 && attempt < maxAttempts) {
        const delay = waitMs || Math.min(5000 * attempt, 40000);
        log(`Rate limited, wait ${Math.round(delay / 1000)}s`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if ((status >= 500 || err.message.includes('Connection error')) && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

app.post('/api/reason', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const p = prompt.toLowerCase();
  const isAnalyzer = p.includes('analyze this browser task') || p.includes('analyze this') || p.includes('you are analyzing');
  const isPlanner = p.includes('create a browser automation plan') || p.includes('create a browser') || p.includes('coding agent') || p.includes('planning rules');
  const isValidator = p.includes('is the task fully completed') || p.includes('is task fully completed');
  const isNavigator = p.includes('match this step') || p.includes('return the best match') || p.includes('browser navigator');


  try {
    const messages = [
      {
        role: 'system',
        content: `You are a CODING-FOCUSED browser agent. You handle file operations, code editing, and IDE tasks.
Always respond with JSON ONLY.

When planning file operations on the Code Explorer:
- "New File" button → {"action":"click","target":"New File"}
- "New Folder" button → {"action":"click","target":"New Folder"}
- Modal input for name → {"action":"type","target":"filename input","value":"<name>"}
- Confirm button → {"action":"click","target":"Create"}
- "Open Folder" button → CANNOT be automated (user must click it)
- "Save" button → {"action":"click","target":"Save"}
- "Refresh" button → {"action":"click","target":"Refresh"}

IMPORTANT: When task requires file picker (Open Folder), STOP and inform user to click manually.`
      },
      { role: 'user', content: prompt }
    ];

    const type = isAnalyzer ? 'analyzer' : isPlanner ? 'planner' : isNavigator ? 'navigator' : isValidator ? 'validator' : 'other';
    log(`[${type}] len=${prompt.length} (~${Math.ceil(prompt.length / 4)} tokens)`);

    let responseText = await callGroqWithRetry(messages);
    log('RAW:', responseText.slice(0, 150));

    if (isPlanner) {
      try {
        const parsed = JSON.parse(responseText.replace(/```json|```/g, '').trim());
        if (Array.isArray(parsed.steps)) responseText = JSON.stringify(parsed.steps);
        else if (parsed.action) responseText = JSON.stringify([parsed]);
      } catch (e) { }
    }
    if (isNavigator) {
      try {
        const parsed = JSON.parse(responseText.replace(/```json|```/g, '').trim());
        if (parsed.action === 'navigate' && parsed.value && !parsed.target) {
          parsed.target = parsed.value; delete parsed.value;
          responseText = JSON.stringify(parsed);
        }
      } catch (e) { }
    }

    res.json({ response: responseText });

  } catch (err) {
    logErr('All retries failed:', err.message.slice(0, 200));

    if (isValidator) return res.json({ response: JSON.stringify({ completed: false, reason: 'validator unavailable' }) });
    if (isPlanner) return res.json({ response: JSON.stringify({ steps: [] }) });
    if (isNavigator) return res.json({ response: JSON.stringify({ action: 'skip', selectors: [] }) });
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, model: MODEL, mode: 'coding' }));

app.listen(PORT, '0.0.0.0', () => {
  log(`Server on http://localhost:${PORT}`);
  log(`Model: ${MODEL} (fast)`);
  log(`Key: ${process.env.GROQ_API_KEY ? 'YES' : 'NO'}`);
});