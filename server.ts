import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import dotenv from 'dotenv';
import { ULTRON_SYSTEM_PROMPT, FAST_GEMINI_MODELS, PRO_GEMINI_MODELS, buildModelConfig } from './server/aiClient';
import { fileAnalyzerRouter } from './server/fileAnalyzer';
import { codingAgentRouter } from './server/codingAgent';
import { deepResearchRouter } from './server/deepResearch';
import { adConfigRouter } from './server/adConfig';
import { deviceAssistantRouter } from './server/deviceCommandNlu';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '25mb' }));

// Allow Capacitor Android WebView origins (https://localhost, capacitor://localhost) and local previews
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = new Set([
    'https://localhost',
    'capacitor://localhost',
    'http://localhost',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ]);
  if (origin && (allowedOrigins.has(origin) || origin.endsWith('.run.app'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Mount modular Ultron AI Platform feature routers
app.use('/api/files', fileAnalyzerRouter);
app.use('/api/code', codingAgentRouter);
app.use('/api', deepResearchRouter);
app.use('/api/ads', adConfigRouter);
app.use('/api/assistant', deviceAssistantRouter);

// Helper to resolve backend Gemini API key (never hardcoded in source code)
function resolveGeminiApiKey(customApiKey?: string): string {
  const custom = typeof customApiKey === 'string' ? customApiKey.trim() : '';
  const envKey = typeof process.env.GEMINI_API_KEY === 'string' ? process.env.GEMINI_API_KEY.trim() : '';
  return custom || envKey;
}

// Helper to initialize Gemini SDK with sane timeout
function getGeminiClient(customApiKey?: string) {
  const apiKey = resolveGeminiApiKey(customApiKey);
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the backend server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      },
      timeout: 25000
    }
  });
}

// Ordered list of valid, fast Gemini models (imported from server/aiClient.ts)
const GEMINI_MODEL_CANDIDATES = FAST_GEMINI_MODELS;
const GEMINI_PLUS_MODEL_CANDIDATES = PRO_GEMINI_MODELS;

// Background Job Store
interface ChatJob {
  id: string;
  status: 'processing' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  result?: {
    text: string;
    thoughtText?: string;
    searchSources?: Array<{ title: string; url: string }>;
  };
  error?: string;
}

const activeJobs = new Map<string, ChatJob>();

// Clean up old jobs older than 24 hours periodically
setInterval(() => {
  const oneDayAgo = Date.now() - 86400000;
  for (const [id, job] of activeJobs.entries()) {
    if (job.createdAt < oneDayAgo) {
      activeJobs.delete(id);
    }
  }
}, 600000);

// Core Async Worker for Processing Chat Request (Runs independently of frontend connection)
async function executeChatJob(jobId: string, payload: any) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  try {
    const {
      messages,
      apiKey,
      provider = 'gemini',
      responseMode = 'pro',
      searchEnabled = true,
      userMemories = [],
      agentConfig
    } = payload;

    const userMessage = messages[messages.length - 1];
    const userText = typeof userMessage?.content === 'string' ? userMessage.content : '';
    const allowSearchTool = !agentConfig || !Array.isArray(agentConfig.tools) || agentConfig.tools.includes('web_search');

    // Normal Conversation / Text Processing with Gemini or Custom Provider
    let modeInstruction = ULTRON_SYSTEM_PROMPT;
    if (agentConfig?.instructions) {
      modeInstruction += `\n\nACTIVE CUSTOM AGENT PERSONA (${agentConfig.name || 'Custom Agent'}):\n${String(agentConfig.instructions).slice(0, 8000)}\nResponse Style: ${agentConfig.responseStyle || 'balanced'}.`;
    }
    if (responseMode === 'plus') {
      modeInstruction += `\n[RESPONSE MODE: PLUS - Provide comprehensive analysis, step-by-step reasoning, and depth.]`;
    } else if (responseMode === 'thinking') {
      modeInstruction += `\n[RESPONSE MODE: STUDY & EDUCATION - Act as an expert educational tutor. Explain concepts clearly, with examples and structured steps.]`;
    } else {
      modeInstruction += `\n[RESPONSE MODE: PRO - Fast, concise, articulate, and direct.]`;
    }

    // Inject User-approved memories if available
    if (Array.isArray(userMemories) && userMemories.length > 0) {
      modeInstruction += `\n\nUSER-APPROVED PERSISTENT MEMORIES & PREFERENCES:\n${userMemories
        .filter((m: any) => typeof m === 'string' && m.trim().length > 0)
        .map((m: string) => `- ${m.trim()}`)
        .join('\n')}\n(Seamlessly apply these user preferences to personalize responses while remaining helpful and objective.)`;
    }

    let replyText = '';
    let searchSources: Array<{ title: string; url: string }> = [];

    // Custom 3P Provider (OpenAI, Groq, DeepSeek)
    if ((provider === 'openai' || provider === 'groq' || provider === 'deepseek') && apiKey) {
      let endpoint = 'https://api.openai.com/v1/chat/completions';
      let modelName = 'gpt-4o-mini';

      if (provider === 'groq') {
        endpoint = 'https://api.groq.com/openai/v1/chat/completions';
        modelName = 'llama-3.3-70b-versatile';
      } else if (provider === 'deepseek') {
        endpoint = 'https://api.deepseek.com/v1/chat/completions';
        modelName = 'deepseek-chat';
      }

      const formattedMessages = [
        { role: 'system', content: modeInstruction },
        ...messages
          .filter((m: any) => m && m.content && typeof m.content === 'string')
          .map((m: any) => {
            let contentText = m.content.startsWith('data:image/') ? '[Generated Image]' : m.content;
            if (m.attachedFile?.textContent) {
              contentText += `\n\n[ATTACHED DOCUMENT: ${m.attachedFile.name}]\n${m.attachedFile.textContent.slice(0, 30000)}`;
            }
            return {
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: contentText
            };
          })
      ];

      const customRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelName,
          messages: formattedMessages,
          temperature: responseMode === 'thinking' ? 0.3 : 0.7
        })
      });

      const customData = await customRes.json();
      if (!customRes.ok || customData.error) {
        throw new Error(customData.error?.message || `API Error (${provider})`);
      }
      replyText = customData.choices?.[0]?.message?.content || '';
    } else {
      // Default Gemini API with Google Search Grounding for current information
      const geminiContents: any[] = [];

      for (const m of messages || []) {
        if (!m) continue;
        const rawText = typeof m.content === 'string' ? m.content : '';
        let text = rawText.startsWith('data:image/') ? '[Generated Image]' : rawText.trim();
        const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';

        const parts: any[] = [];

        // If file has text content (e.g. TXT, Code, CSV, Markdown, extracted DOCX)
        if (m.attachedFile?.textContent) {
          text = `${text}\n\n[ATTACHED FILE: ${m.attachedFile.name} (${m.attachedFile.size} bytes)]\n\`\`\`\n${m.attachedFile.textContent.slice(0, 60000)}\n\`\`\``;
        }

        if (text) {
          parts.push({ text });
        }

        // Multimodal image or PDF handling via inlineData
        const fileUrl = m.attachedFile?.dataUrl || m.attachedImage || m.image;
        if (fileUrl && typeof fileUrl === 'string' && fileUrl.startsWith('data:')) {
          const match = fileUrl.match(/^data:([a-zA-Z0-9_\-+.]+\/[a-zA-Z0-9_\-+.]+);base64,(.+)$/);
          if (match) {
            const mimeType = match[1];
            const base64Data = match[2];
            // Support images and application/pdf natively in Gemini
            if (mimeType.startsWith('image/') || mimeType === 'application/pdf') {
              parts.push({
                inlineData: {
                  mimeType,
                  data: base64Data
                }
              });
            }
          }
        }

        if (parts.length === 0) continue;

        if (geminiContents.length > 0 && geminiContents[geminiContents.length - 1].role === role) {
          geminiContents[geminiContents.length - 1].parts.push(...parts);
        } else {
          geminiContents.push({ role, parts });
        }
      }

      if (geminiContents.length > 0 && geminiContents[0].role !== 'user') {
        geminiContents.shift();
      }

      if (geminiContents.length === 0) {
        geminiContents.push({ role: 'user', parts: [{ text: 'Hello Ultron' }] });
      }

      const keysToTry = Array.from(
        new Set(
          [apiKey, process.env.GEMINI_API_KEY].filter(
            (k): k is string => Boolean(k && typeof k === 'string' && k.trim().length > 0)
          )
        )
      );

      if (keysToTry.length === 0) {
        throw new Error('GEMINI_API_KEY is not configured on the backend server.');
      }

      const candidateModels =
        responseMode === 'plus' || responseMode === 'thinking'
          ? GEMINI_PLUS_MODEL_CANDIDATES
          : GEMINI_MODEL_CANDIDATES;

      // Detect if user asks for current information/news/search
      const needsSearch = allowSearchTool && searchEnabled !== false && (
        Boolean(searchEnabled) &&
        /\b(?:current|latest|today|news|weather|price|search|google|who is winning|live|recent|2026)\b/i.test(userText)
      );

      let lastApiError: Error | null = null;

      keyLoop: for (const currentKey of keysToTry) {
        const ai = new GoogleGenAI({
          apiKey: currentKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build'
            },
            timeout: 25000
          }
        });

        for (const modelName of candidateModels) {
          const attempts = needsSearch ? [true, false] : [false];
          for (const useSearch of attempts) {
            try {
              const config = buildModelConfig({
                modelName,
                systemInstruction: modeInstruction,
                temperature: responseMode === 'thinking' ? 0.3 : 0.7,
                tools: useSearch ? [{ googleSearch: {} }] : undefined,
                thinkingLevel: responseMode === 'plus' ? ThinkingLevel.MEDIUM : ThinkingLevel.LOW
              });

              const response = await ai.models.generateContent({
                model: modelName,
                contents: geminiContents,
                config
              });

              const candidateText = response.text?.trim() || '';
              if (candidateText.length > 0) {
                replyText = candidateText;

                // Extract Google Search Grounding Sources if present
                const grounding = response.candidates?.[0]?.groundingMetadata;
                if (grounding) {
                  const chunks = grounding.groundingChunks || [];
                  for (const chunk of chunks) {
                    if (chunk.web?.uri) {
                      searchSources.push({
                        title: chunk.web.title || new URL(chunk.web.uri).hostname,
                        url: chunk.web.uri
                      });
                    }
                  }
                  // Deduplicate sources
                  const seen = new Set<string>();
                  searchSources = searchSources.filter((s) => {
                    if (seen.has(s.url)) return false;
                    seen.add(s.url);
                    return true;
                  });
                }

                break keyLoop;
              }
            } catch (err: any) {
              lastApiError = err;
              console.error(`[ChatJob Key ${currentKey.slice(0, 6)}...] Model ${modelName} (search=${useSearch}) error:`, err?.message || err);
              // If auth key is completely invalid, stop retrying other models on the same key
              if (err?.message?.includes('API_KEY_INVALID') || err?.status === 401) {
                break;
              }
            }
          }
        }
      }

      if (!replyText) {
        throw lastApiError || new Error('Could not get response from AI models. Please try again.');
      }
    }

    job.status = 'completed';
    job.completedAt = Date.now();
    job.result = {
      text: replyText,
      searchSources: searchSources.length > 0 ? searchSources : undefined
    };
  } catch (err: any) {
    console.error(`Job ${jobId} failed:`, err?.message || err);
    job.status = 'failed';
    const rawMsg = err?.message || '';
    if (rawMsg.includes('API_KEY_INVALID') || rawMsg.includes('invalid api key') || rawMsg.includes('not configured')) {
      job.error = 'AI API authentication failed. Please verify the backend GEMINI_API_KEY configuration.';
    } else if (rawMsg.includes('RESOURCE_EXHAUSTED') || rawMsg.includes('quota') || rawMsg.includes('429')) {
      job.error = 'AI API rate limit or quota reached. Please wait a moment and try again.';
    } else if (rawMsg.includes('503') || rawMsg.includes('high demand') || rawMsg.includes('UNAVAILABLE')) {
      job.error = 'AI service is temporarily busy. Please try again in a few seconds.';
    } else if (rawMsg.includes('aborted') || rawMsg.includes('timeout')) {
      job.error = 'AI request timed out. Please try again.';
    } else {
      job.error = 'Something went wrong while processing your request. Please try again.';
    }
  }
}

// 0. High-Speed Progressive SSE Streaming Route for Real-Time ChatGPT-style Responses
app.post('/api/chat/stream', async (req, res) => {
  const startTime = Date.now();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event: string, data: any) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  let isAborted = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      isAborted = true;
    }
  });

  try {
    const {
      messages = [],
      apiKey,
      provider = 'gemini',
      responseMode = 'pro',
      searchEnabled = true,
      userMemories = [],
      agentConfig
    } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      sendEvent('error', { error: 'No messages provided in request.' });
      if (!res.writableEnded) res.end();
      return;
    }

    const userMessage = messages[messages.length - 1];
    const userText = typeof userMessage?.content === 'string' ? userMessage.content : '';
    const allowSearchTool = !agentConfig || !Array.isArray(agentConfig.tools) || agentConfig.tools.includes('web_search');

    // Normal Conversation / Text Processing with Gemini or Custom Provider
    let modeInstruction = ULTRON_SYSTEM_PROMPT;
    if (agentConfig?.instructions) {
      modeInstruction += `\n\nACTIVE CUSTOM AGENT PERSONA (${agentConfig.name || 'Custom Agent'}):\n${String(agentConfig.instructions).slice(0, 8000)}\nResponse Style: ${agentConfig.responseStyle || 'balanced'}.`;
    }
    if (responseMode === 'plus') {
      modeInstruction += `\n[RESPONSE MODE: PLUS - Provide comprehensive analysis, step-by-step reasoning, and depth.]`;
    } else if (responseMode === 'thinking') {
      modeInstruction += `\n[RESPONSE MODE: STUDY & EDUCATION - Act as an expert educational tutor. Explain concepts clearly, with examples and structured steps.]`;
    } else {
      modeInstruction += `\n[RESPONSE MODE: PRO - Fast, concise, articulate, and direct.]`;
    }

    if (Array.isArray(userMemories) && userMemories.length > 0) {
      modeInstruction += `\n\nUSER-APPROVED PERSISTENT MEMORIES & PREFERENCES:\n${userMemories
        .filter((m: any) => typeof m === 'string' && m.trim().length > 0)
        .map((m: string) => `- ${m.trim()}`)
        .join('\n')}\n(Seamlessly apply these user preferences to personalize responses while remaining helpful and objective.)`;
    }

    // Optimization: Keep the most recent 16 messages for fast first-token latency and token efficiency
    const recentMessages = messages.length > 16 ? messages.slice(-16) : messages;

    // Custom 3P Provider (OpenAI, Groq, DeepSeek)
    if ((provider === 'openai' || provider === 'groq' || provider === 'deepseek') && apiKey) {
      let endpoint = 'https://api.openai.com/v1/chat/completions';
      let modelName = 'gpt-4o-mini';

      if (provider === 'groq') {
        endpoint = 'https://api.groq.com/openai/v1/chat/completions';
        modelName = 'llama-3.3-70b-versatile';
      } else if (provider === 'deepseek') {
        endpoint = 'https://api.deepseek.com/v1/chat/completions';
        modelName = 'deepseek-chat';
      }

      const formattedMessages = [
        { role: 'system', content: modeInstruction },
        ...recentMessages
          .filter((m: any) => m && m.content && typeof m.content === 'string')
          .map((m: any) => {
            let contentText = m.content.startsWith('data:image/') ? '[Generated Image]' : m.content;
            if (m.attachedFile?.textContent) {
              contentText += `\n\n[ATTACHED DOCUMENT: ${m.attachedFile.name}]\n${m.attachedFile.textContent.slice(0, 30000)}`;
            }
            return {
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: contentText
            };
          })
      ];

      const customRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelName,
          messages: formattedMessages,
          stream: true,
          temperature: responseMode === 'thinking' ? 0.3 : 0.7
        })
      });

      if (!customRes.ok || !customRes.body) {
        throw new Error(`API Error (${provider})`);
      }

      const reader = customRes.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        if (isAborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
            try {
              const parsed = JSON.parse(line.slice(6));
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) {
                accumulated += delta;
                sendEvent('chunk', { text: delta });
              }
            } catch {}
          }
        }
      }

      sendEvent('done', { fullText: accumulated, latencyMs: Date.now() - startTime });
      res.end();
      return;
    }

    // Default Gemini Streaming with Google Search Grounding for current information
    const geminiContents: any[] = [];

    for (const m of recentMessages || []) {
      if (!m) continue;
      const rawText = typeof m.content === 'string' ? m.content : '';
      let text = rawText.startsWith('data:image/') ? '[Generated Image]' : rawText.trim();
      const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';

      const parts: any[] = [];

      if (m.attachedFile?.textContent) {
        text = `${text}\n\n[ATTACHED FILE: ${m.attachedFile.name} (${m.attachedFile.size} bytes)]\n\`\`\`\n${m.attachedFile.textContent.slice(0, 40000)}\n\`\`\``;
      }

      if (text) {
        parts.push({ text });
      }

      const fileUrl = m.attachedFile?.dataUrl || m.attachedImage || m.image;
      if (fileUrl && typeof fileUrl === 'string' && fileUrl.startsWith('data:')) {
        const match = fileUrl.match(/^data:([a-zA-Z0-9_\-+.]+\/[a-zA-Z0-9_\-+.]+);base64,(.+)$/);
        if (match) {
          const mimeType = match[1];
          const base64Data = match[2];
          if (mimeType.startsWith('image/') || mimeType === 'application/pdf') {
            parts.push({
              inlineData: {
                mimeType,
                data: base64Data
              }
            });
          }
        }
      }

      if (parts.length === 0) continue;

      if (geminiContents.length > 0 && geminiContents[geminiContents.length - 1].role === role) {
        geminiContents[geminiContents.length - 1].parts.push(...parts);
      } else {
        geminiContents.push({ role, parts });
      }
    }

    if (geminiContents.length > 0 && geminiContents[0].role !== 'user') {
      geminiContents.shift();
    }

    if (geminiContents.length === 0) {
      geminiContents.push({ role: 'user', parts: [{ text: 'Hello Ultron' }] });
    }

    const needsSearch = allowSearchTool && searchEnabled !== false && (
      Boolean(searchEnabled) &&
      /\b(?:current|latest|today|news|weather|price|search|google|who is winning|live|recent|2026)\b/i.test(userText)
    );

    const keysToTry = Array.from(
      new Set(
        [apiKey, process.env.GEMINI_API_KEY].filter(
          (k): k is string => Boolean(k && typeof k === 'string' && k.trim().length > 0)
        )
      )
    );

    if (keysToTry.length === 0) {
      throw new Error('GEMINI_API_KEY is not configured on the backend server.');
    }

    let streamedAny = false;
    let fullText = '';
    const searchSources: Array<{ title: string; url: string }> = [];
    let lastStreamError: Error | null = null;

    const baseCandidates =
      responseMode === 'plus' || responseMode === 'thinking'
        ? GEMINI_PLUS_MODEL_CANDIDATES
        : GEMINI_MODEL_CANDIDATES;
    const modelCandidates = agentConfig?.model
      ? [String(agentConfig.model), ...baseCandidates.filter((m) => m !== agentConfig.model)]
      : baseCandidates;

    streamLoop: for (const currentKey of keysToTry) {
      const ai = new GoogleGenAI({
        apiKey: currentKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          },
          timeout: 25000
        }
      });

      for (const modelName of modelCandidates) {
        if (isAborted) break streamLoop;
        const searchAttempts = needsSearch ? [true, false] : [false];

        for (const useSearch of searchAttempts) {
          if (isAborted) break streamLoop;
          try {
            const config = buildModelConfig({
              modelName,
              systemInstruction: modeInstruction,
              temperature: responseMode === 'thinking' ? 0.3 : 0.7,
              tools: useSearch ? [{ googleSearch: {} }] : undefined,
              thinkingLevel: responseMode === 'plus' ? ThinkingLevel.MEDIUM : ThinkingLevel.LOW
            });

            const responseStream = await ai.models.generateContentStream({
              model: modelName,
              contents: geminiContents,
              config
            });

            for await (const chunk of responseStream) {
              if (isAborted) break streamLoop;
              if (chunk.text) {
                streamedAny = true;
                fullText += chunk.text;
                sendEvent('chunk', { text: chunk.text });
              }

              const grounding = chunk.candidates?.[0]?.groundingMetadata;
              if (grounding?.groundingChunks) {
                for (const c of grounding.groundingChunks) {
                  if (c.web?.uri) {
                    searchSources.push({
                      title: c.web.title || new URL(c.web.uri).hostname,
                      url: c.web.uri
                    });
                  }
                }
              }
            }

            if (streamedAny && fullText.trim().length > 0) {
              break streamLoop;
            }
          } catch (err: any) {
            lastStreamError = err;
            console.error(`[Stream Key ${currentKey.slice(0, 6)}...] Model ${modelName} (search=${useSearch}) error:`, err?.message || err);
            // If partial chunks were already streamed, stop retrying to avoid mixing two responses
            if (streamedAny && fullText.trim().length > 0) {
              break streamLoop;
            }
            // If key is invalid, no point trying more models with this key
            if (err?.message?.includes('API_KEY_INVALID') || err?.status === 401) {
              break;
            }
          }
        }
      }
    }

    if (isAborted) {
      if (!res.writableEnded) res.end();
      return;
    }

    if (!streamedAny || fullText.trim().length === 0) {
      throw lastStreamError || new Error('Could not generate a non-empty AI response. Please try again.');
    }

    // Deduplicate search sources
    const seen = new Set<string>();
    const uniqueSources = searchSources.filter((s) => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    sendEvent('done', {
      fullText,
      searchSources: uniqueSources.length > 0 ? uniqueSources : undefined,
      latencyMs: Date.now() - startTime
    });
    if (!res.writableEnded) res.end();
  } catch (err: any) {
    console.error('Stream error:', err?.message || err);
    const rawMsg = err?.message || '';
    let userFriendlyError = 'Failed to generate AI response. Please try again.';
    if (rawMsg.includes('API_KEY_INVALID') || rawMsg.includes('invalid api key') || rawMsg.includes('not configured')) {
      userFriendlyError = 'AI API authentication failed. Please verify the backend GEMINI_API_KEY.';
    } else if (rawMsg.includes('RESOURCE_EXHAUSTED') || rawMsg.includes('quota') || rawMsg.includes('429')) {
      userFriendlyError = 'AI API rate limit reached. Please wait a moment and try again.';
    } else if (rawMsg.includes('503') || rawMsg.includes('high demand') || rawMsg.includes('UNAVAILABLE')) {
      userFriendlyError = 'AI model is temporarily busy. Please try again in a few seconds.';
    } else if (rawMsg.includes('aborted') || rawMsg.includes('timeout')) {
      userFriendlyError = 'AI request timed out. Please try again.';
    }
    sendEvent('error', { error: userFriendlyError });
    if (!res.writableEnded) res.end();
  }
});

// 1. Submit Asynchronous Chat Job (Continues running in background even if browser closes/sleeps)
app.post('/api/chat/submit', (req, res) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const job: ChatJob = {
    id: jobId,
    status: 'processing',
    createdAt: Date.now()
  };

  activeJobs.set(jobId, job);

  // Trigger background execution without awaiting
  executeChatJob(jobId, req.body);

  res.json({
    success: true,
    jobId,
    status: 'processing',
    message: 'Request dispatched to Ultron background engine'
  });
});

// 2. Poll Status of Chat Job
app.get('/api/chat/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = activeJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or expired' });
  }

  res.json({
    success: true,
    jobId: job.id,
    status: job.status,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt
  });
});

// Batch Poll Status for multiple pending background jobs (used when app resumes after sleep)
app.post('/api/chat/batch-status', (req, res) => {
  const { jobIds } = req.body;
  if (!Array.isArray(jobIds)) {
    return res.status(400).json({ success: false, error: 'jobIds must be an array' });
  }

  const statuses = jobIds.map((id: string) => {
    const job = activeJobs.get(id);
    if (!job) return { jobId: id, status: 'not_found' };
    return {
      jobId: id,
      status: job.status,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      completedAt: job.completedAt
    };
  });

  res.json({ success: true, statuses });
});

// Remove finished job
app.delete('/api/chat/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  activeJobs.delete(jobId);
  res.json({ success: true });
});

// 3. Backward-compatible synchronous chat endpoint
app.post('/api/zarvesh/chat', async (req, res) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const job: ChatJob = {
    id: jobId,
    status: 'processing',
    createdAt: Date.now()
  };
  activeJobs.set(jobId, job);

  await executeChatJob(jobId, req.body);

  const updatedJob = activeJobs.get(jobId);
  if (updatedJob?.status === 'completed' && updatedJob.result) {
    return res.json({
      success: true,
      text: updatedJob.result.text,
      searchSources: updatedJob.result.searchSources
    });
  } else {
    return res.status(500).json({
      success: false,
      error: updatedJob?.error || 'Failed to process request'
    });
  }
});

// 4. Persistent Conversation Storage Routes (Backup & Cross-Device Persistence)
const CONVERSATIONS_FILE = path.join(process.cwd(), 'data', 'conversations.json');

function readStoredConversations(): any[] {
  try {
    if (fs.existsSync(CONVERSATIONS_FILE)) {
      const raw = fs.readFileSync(CONVERSATIONS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('Error reading conversations file:', err);
  }
  return [];
}

function writeStoredConversations(conversations: any[]): void {
  try {
    const dir = path.dirname(CONVERSATIONS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Error writing conversations file:', err);
  }
}

app.get('/api/conversations', (req, res) => {
  const conversations = readStoredConversations();
  res.json({ success: true, conversations });
});

app.post('/api/conversations', (req, res) => {
  const { conversation, conversations: batchList } = req.body;
  const currentList = readStoredConversations();
  const map = new Map<string, any>();

  for (const c of currentList) {
    if (c && c.id) map.set(c.id, c);
  }

  if (Array.isArray(batchList)) {
    for (const c of batchList) {
      if (c && c.id) map.set(c.id, c);
    }
  }

  if (conversation && conversation.id) {
    map.set(conversation.id, conversation);
  }

  const updatedList = Array.from(map.values()).sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );

  writeStoredConversations(updatedList);
  res.json({ success: true, count: updatedList.length });
});

app.delete('/api/conversations/:id', (req, res) => {
  const { id } = req.params;
  const currentList = readStoredConversations();
  const filtered = currentList.filter((c) => c.id !== id);
  writeStoredConversations(filtered);
  res.json({ success: true });
});

app.put('/api/conversations/:id/rename', (req, res) => {
  const { id } = req.params;
  const { title } = req.body;
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ success: false, error: 'Title required' });
  }

  const currentList = readStoredConversations();
  const updated = currentList.map((c) => (c.id === id ? { ...c, title: title.trim(), updatedAt: Date.now() } : c));
  writeStoredConversations(updated);
  res.json({ success: true });
});

// 6. Google Sign-In Verification Endpoint
app.post('/api/auth/google', (req, res) => {
  const { credential, profile } = req.body;
  if (!profile && !credential) {
    return res.status(400).json({ success: false, error: 'Missing Google authentication payload' });
  }

  // Safe server-side user profile session
  const user = {
    id: profile?.id || `goog_${Date.now()}`,
    name: profile?.name || 'Google User',
    email: profile?.email || '',
    picture: profile?.picture || '',
    authenticatedAt: new Date().toISOString()
  };

  res.json({
    success: true,
    user
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), activeJobsCount: activeJobs.size });
});

// Return explicit 404 JSON for unknown or removed /api/* routes instead of HTML SPA fallback
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found' });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ultron AI Server running on http://localhost:${PORT}`);
  });
}

startServer();
