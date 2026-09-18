

/// working  with form with all



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

const MODEL = 'openai/gpt-oss-120b';

function log(...args) { console.log('[Server]', ...args); }
function logError(...args) { console.error('[Server ERROR]', ...args); }

// Exponential backoff with jitter
function backoffDelay(attempt) {
  const base = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
  return base + Math.random() * 1000;
}

async function callGroqWithRetry(messages, maxAttempts = 4) {
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      log(`Groq attempt ${attempt}/${maxAttempts}`);
      const completion = await groq.chat.completions.create({
        model: MODEL,
        messages,
        temperature: 0.1,
        max_tokens: 2048,
        response_format: { type: 'json_object' }
      });
      return completion.choices[0].message.content;
    } catch (err) {
      lastErr = err;
      const status = err.status || err.response?.status;
      logError(`Attempt ${attempt} failed (status ${status}): ${err.message}`);

      if (status === 429 || (status >= 500 && status < 600) || err.message.includes('Connection error')) {
        if (attempt < maxAttempts) {
          const delay = backoffDelay(attempt);
          log(`Retrying in ${Math.round(delay)}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      break;
    }
  }
  throw lastErr;
}

// ==================== REASONING ENDPOINT ====================
app.post('/api/reason', async (req, res) => {
  const { prompt, image } = req.body;

  if (!prompt) {
    logError('No prompt provided');
    return res.status(400).json({ error: 'prompt is required' });
  }

  // Detect call type — INSIDE the handler
  const promptLower = prompt.toLowerCase();
  const isValidator = promptLower.includes('has the task been fully completed') ||
                      promptLower.includes('is the task fully completed');
  const isPlanner = promptLower.includes('browser automation planner') ||
                    promptLower.includes('universal browser automation planner');
  const isNavigator = promptLower.includes('browser navigator') ||
                      promptLower.includes('universal browser navigator');

  try {
    const messages = [
      {
        role: 'system',
        content: `You are a browser automation agent.
Always respond in valid JSON only. Never include markdown, code fences, or extra text.
- If asked for a plan, return a JSON object with key "steps" whose value is an array.
- If asked for an action, return a JSON object: {"action":"click|type|scroll|navigate|hover|press|wait","selector":"...","value":"..."}.
- If asked for validation, return {"completed": true/false, "reason": "..."}.`
      },
      { role: 'user', content: prompt }
    ];

    if (image) {
      messages[1] = {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: image } }
        ]
      };
    }

    const callType = isPlanner ? 'planner' : isNavigator ? 'navigator' : isValidator ? 'validator' : 'other';
    log(`REQUEST [${callType}] len=${prompt.length}`);

    let responseText = await callGroqWithRetry(messages);

    log('RAW:', responseText.slice(0, 250));

    // Normalize planner response: {"steps":[...]} → [...] or single action → [...]
    if (isPlanner) {
      try {
        const parsed = JSON.parse(responseText.replace(/```json|```/g, '').trim());
        if (parsed && Array.isArray(parsed.steps)) {
          log('Normalize: {steps:[...]} → [...]');
          responseText = JSON.stringify(parsed.steps);
        } else if (parsed && !Array.isArray(parsed) && parsed.action) {
          log('Normalize: single action → [action]');
          responseText = JSON.stringify([parsed]);
        }
      } catch (e) {
        logError('Planner normalize failed:', e.message);
      }
    }

    // Normalize navigator response: navigate value → target
    if (isNavigator) {
      try {
        const parsed = JSON.parse(responseText.replace(/```json|```/g, '').trim());
        if (parsed && parsed.action === 'navigate' && parsed.value && !parsed.target) {
          log('Normalize: navigate value → target');
          parsed.target = parsed.value;
          delete parsed.value;
          responseText = JSON.stringify(parsed);
        }
      } catch (e) {
        logError('Navigator normalize failed:', e.message);
      }
    }

    log('FINAL:', responseText.slice(0, 250));

    res.json({ response: responseText });

  } catch (err) {
    logError('All retries failed:', err.message);

    // GRACEFUL FALLBACK — never crash the client
    if (isValidator) {
      return res.json({
        response: JSON.stringify({
          completed: false,
          reason: 'Validator unavailable (rate limit) — assuming incomplete'
        })
      });
    }
    if (isPlanner) {
      return res.json({ response: JSON.stringify({ steps: [] }) });
    }
    if (isNavigator) {
      return res.json({ response: JSON.stringify({ action: 'skip', selectors: [] }) });
    }
    return res.status(500).json({ error: err.message });
  }
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL });
});

// ==================== START ====================
const PORT = 3000;
app.listen(PORT, () => {
  log(`✅ Agent server running on http://localhost:${PORT}`);
  log(`   Model: ${MODEL}`);
  log(`   API Key loaded: ${process.env.GROQ_API_KEY ? 'YES' : 'NO'}`);
});