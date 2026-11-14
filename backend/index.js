// index.js
const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');
const { GoogleGenAI, Type } = require('@google/genai');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[DEBUG] [${new Date().toISOString()}] Incoming ${req.method} request to ${req.url}`);
  next();
});

// Initialize Redis Client
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.on('connect', () => console.log('[DEBUG] Redis Client connected successfully.'));
redisClient.on('ready', () => console.log('[DEBUG] Redis Client ready for commands.'));

// Initialize Gemini Client
const apiKey = process.env.GEMINI_API_KEY || '';
console.log(`[DEBUG] Gemini API Key configured: ${apiKey ? 'YES (Length: ' + apiKey.length + ')' : 'NO (EMPTY KEY)'}`);
const ai = new GoogleGenAI({ apiKey });

const SYSTEM_PROMPT = `
You are an expert Career Advisor Copilot AI. Evaluate candidate resumes against job descriptions and respond strictly in JSON matching the exact schema requested.
`;

app.post('/api/evaluate', async (req, res) => {
  const startTime = Date.now();

  try {
    const { job_description, resume } = req.body;

    if (!job_description || !resume) {
      console.warn('[DEBUG] Step 1 Validation Failed: Missing payload fields.');
      return res.status(400).json({ error: 'job_description and resume are required.' });
    }

    // Hash inputs for Redis caching
    const cacheKey = `eval:${crypto.createHash('sha256').update(job_description + resume).digest('hex')}`;
    console.log(`[DEBUG] Step 2: Generated cacheKey: ${cacheKey}`);

    // Check Cache
    console.log('[DEBUG] Step 3: Querying Redis cache...');
    if (redisClient.isOpen) {
      const cachedData = await redisClient.get(cacheKey);
      if (cachedData) {
        console.log(`[DEBUG] Step 3a: Cache HIT for key ${cacheKey} (${Date.now() - startTime}ms)`);
        
        let parsedCache = JSON.parse(cachedData);
        // FIX 1: Handle legacy array responses stored in cache
        if (Array.isArray(parsedCache)) {
          parsedCache = parsedCache[0] || {};
        }

        return res.json({ cached: true, ...parsedCache });
      }
      console.log('[DEBUG] Step 3b: Cache MISS. Proceeding to Gemini API call.');
    } else {
      console.warn('[DEBUG] Step 3 Warnings: Redis is NOT connected. Skipping cache lookup.');
    }

    const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    console.log(`[DEBUG] Step 4: Calling Gemini API model "${modelName}"...`);

    const apiStartTime = Date.now();
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [
        { role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\nJob Description:\n${job_description}\n\nResume:\n${resume}` }] }
      ],
      config: {
        responseMimeType: 'application/json',
        // FIX 2: Explicit response schema to prevent array returns
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            success_percentage: { type: Type.NUMBER },
            match_feedback_summary: {
              type: Type.OBJECT,
              properties: {
                key_strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
                core_gaps: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ['key_strengths', 'core_gaps']
            },
            training_recommendations: {
              type: Type.OBJECT,
              properties: {
                short_term: { type: Type.ARRAY, items: { type: Type.STRING } },
                medium_term: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ['short_term', 'medium_term']
            },
            alternate_job_types: { type: Type.ARRAY, items: { type: Type.STRING } },
            action_plan_and_timeline: {
              type: Type.OBJECT,
              properties: {
                resume_optimizations: { type: Type.ARRAY, items: { type: Type.STRING } },
                effort_timeframe: { type: Type.STRING },
                next_steps: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ['resume_optimizations', 'effort_timeframe', 'next_steps']
            }
          },
          required: [
            'success_percentage',
            'match_feedback_summary',
            'training_recommendations',
            'alternate_job_types',
            'action_plan_and_timeline'
          ]
        }
      }
    });

    console.log(`[DEBUG] Step 4 Completed: Gemini API responded in ${Date.now() - apiStartTime}ms`);

    let rawParsed = JSON.parse(response.text);
    
    // FIX 3: Ensure result is an object, even if LLM wraps it in an array
    const parsedResult = Array.isArray(rawParsed) ? rawParsed[0] : rawParsed;

    if (redisClient.isOpen) {
      console.log('[DEBUG] Step 6: Caching result in Redis...');
      await redisClient.setEx(cacheKey, 86400, JSON.stringify(parsedResult));
      console.log('[DEBUG] Step 6 Completed: Redis cache updated.');
    }

    console.log(`[DEBUG] Step 7: Request successfully fulfilled in ${Date.now() - startTime}ms`);
    return res.json({ cached: false, ...parsedResult });

  } catch (error) {
    console.error(`[DEBUG] ERROR caught in /api/evaluate after ${Date.now() - startTime}ms:`);
    console.error(`[DEBUG] Error Message: ${error.message}`);
    console.error(`[DEBUG] Error Stack: ${error.stack}`);

    if (error.status) console.error(`[DEBUG] API Status Code: ${error.status}`);

    return res.status(500).json({
      error: 'Failed to process evaluation.',
      debug_message: error.message
    });
  }
});

app.get('/health', async (req, res) => {
  const isRedisReady = redisClient.isOpen;
  res.json({ status: 'ok', redis: isRedisReady ? 'connected' : 'disconnected' });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('[DEBUG] Redis failed to connect on startup:', err.message);
  }

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

startServer();
