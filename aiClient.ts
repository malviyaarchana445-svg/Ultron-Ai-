import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { Request, Response, NextFunction } from 'express';

export const ULTRON_SYSTEM_PROMPT = `MANDATORY IDENTITY & CREATOR ATTRIBUTION:
Your name is Ultron AI. You were created by Krishna Chouhan and Kiran Panwar.
CRITICAL RULE: NEVER refer to yourself as "Gemini", "Hydrogen", "Google AI", or "a large language model built by Google". Whenever anyone asks who you are, what AI/model you are, or who created/made/built you, ALWAYS answer proudly that you are Ultron AI, created by Krishna Chouhan and Kiran Panwar.

CORE IDENTITY & CAPABILITIES:
1. You provide clean, articulate, well-structured, natural ChatGPT-style responses.
2. Always speak about your creators Krishna Chouhan and Kiran Panwar with respect and pride when asked about your origin or creators.
3. Capabilities:
   - General AI conversations, deep reasoning, and intelligent Q&A.
   - Educational tutoring, homework explanations, and step-by-step concept clarity.
   - Coding assistance, debugging, refactoring, and multi-file scaffolding (HTML, CSS, JavaScript, Python, Java, C++, PHP, SQL).
   - Mathematics, formulas, derivations, and quantitative analysis.
   - Multimodal document analysis (PDF, DOCX, TXT, CSV, JSON, JPG, PNG, WebP OCR & Q&A).
   - Deep Research, live Web Browsing with verified sources, Android Device Control & Voice Assistant (Hinglish & English), and Custom AI Agents.
   - Important Honesty Rule: Never claim you executed a hardware action (torch, volume, settings, call) inside normal text chat unless the Device Control module actually executed it; guide the user to Device Control or confirm safely.
4. Language Rule:
   - If the user writes in ENGLISH, respond in fluent ENGLISH.
   - If the user writes in HINDI or HINGLISH, respond naturally in Devanagari Hindi or Hinglish matching the user's language.
5. Formatting:
   - Use clean Markdown with headings, bold highlights, lists, tables, and fenced code blocks where helpful.
   - Give direct, clear answers without artificial wrapper tags.`;

export const FAST_GEMINI_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-2.5-flash'
];

export const PRO_GEMINI_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash'
];

export function resolveGeminiApiKey(customApiKey?: string): string {
  const custom = typeof customApiKey === 'string' ? customApiKey.trim() : '';
  const envKey = typeof process.env.GEMINI_API_KEY === 'string' ? process.env.GEMINI_API_KEY.trim() : '';
  return custom || envKey;
}

export function getGeminiClient(customApiKey?: string, timeoutMs = 45000): GoogleGenAI {
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
      timeout: timeoutMs
    }
  });
}

export function buildModelConfig(options: {
  modelName: string;
  systemInstruction?: string;
  temperature?: number;
  tools?: any[];
  responseMimeType?: string;
  thinkingLevel?: ThinkingLevel;
}): Record<string, any> {
  const config: Record<string, any> = {};
  if (options.systemInstruction) {
    config.systemInstruction = options.systemInstruction;
  }
  const isGemini4 = options.modelName.startsWith('gemini-4-');
  if (!isGemini4 && typeof options.temperature === 'number') {
    config.temperature = options.temperature;
  }
  if (options.modelName === 'gemini-4-hydrogen') {
    config.thinkingConfig = {
      thinkingLevel: options.thinkingLevel || ThinkingLevel.LOW
    };
  }
  if (options.tools && options.tools.length > 0) {
    config.tools = options.tools;
  }
  if (options.responseMimeType) {
    config.responseMimeType = options.responseMimeType;
  }
  return config;
}

export function mapGeminiError(err: any): { status: number; message: string; isPaidKeyRequired?: boolean } {
  const raw = String(err?.message || err || '');
  const status = Number(err?.status || 0);

  if (raw.includes('not configured')) {
    return { status: 500, message: 'GEMINI_API_KEY is not configured on the backend server.' };
  }
  if (raw.includes('API_KEY_INVALID') || raw.includes('invalid api key') || status === 401) {
    return { status: 401, message: 'AI API authentication failed. Please verify the backend GEMINI_API_KEY.' };
  }
  if (status === 429 || raw.includes('RESOURCE_EXHAUSTED') || raw.includes('exceeded your current quota')) {
    return { status: 429, message: 'AI API rate limit or quota reached. Please wait a moment and try again.' };
  }
  if (status === 403 || raw.includes('PERMISSION_DENIED') || raw.includes('billing enabled')) {
    return {
      status: 403,
      message: 'This advanced AI model requires a paid Gemini API key with billing enabled in Google AI Studio.',
      isPaidKeyRequired: true
    };
  }
  if (status === 404 || raw.includes('NOT_FOUND')) {
    return { status: 404, message: 'Requested AI model is currently unavailable or unsupported.' };
  }
  if (status === 503 || raw.includes('UNAVAILABLE') || raw.includes('high demand')) {
    return { status: 503, message: 'AI service is temporarily busy. Please try again in a few seconds.' };
  }
  if (raw.includes('aborted') || raw.includes('timeout') || status === 504 || raw.includes('DEADLINE_EXCEEDED')) {
    return { status: 504, message: 'AI request timed out. Please try again.' };
  }
  return { status: 500, message: raw || 'Failed to process AI request.' };
}

export async function generateWithGeminiFallback(options: {
  contents: any;
  systemInstruction?: string;
  temperature?: number;
  models?: string[];
  tools?: any[];
  responseMimeType?: string;
  customApiKey?: string;
  timeoutMs?: number;
  thinkingLevel?: ThinkingLevel;
}): Promise<{ text: string; modelUsed: string; searchSources: Array<{ title: string; url: string }> }> {
  const ai = getGeminiClient(options.customApiKey, options.timeoutMs ?? 25000);
  const models = options.models && options.models.length > 0 ? options.models : FAST_GEMINI_MODELS;

  let lastError: any = null;

  for (const modelName of models) {
    try {
      const config = buildModelConfig({
        modelName,
        systemInstruction: options.systemInstruction,
        temperature: options.temperature ?? 0.5,
        tools: options.tools,
        responseMimeType: options.responseMimeType,
        thinkingLevel: options.thinkingLevel
      });

      const response = await ai.models.generateContent({
        model: modelName,
        contents: options.contents,
        config
      });

      const text = response.text?.trim() || '';
      if (!text) continue;

      const searchSources: Array<{ title: string; url: string }> = [];
      const grounding = response.candidates?.[0]?.groundingMetadata;
      if (grounding?.groundingChunks) {
        const seen = new Set<string>();
        for (const chunk of grounding.groundingChunks) {
          const uri = chunk.web?.uri;
          if (uri && !seen.has(uri)) {
            seen.add(uri);
            let title = chunk.web?.title || '';
            if (!title) {
              try {
                title = new URL(uri).hostname;
              } catch {
                title = uri;
              }
            }
            searchSources.push({ title, url: uri });
          }
        }
      }

      return { text, modelUsed: modelName, searchSources };
    } catch (err: any) {
      lastError = err;
      console.warn(`[Gemini Fallback] ${modelName} failed:`, err?.message || err);
      if (err?.status === 401 || String(err?.message || '').includes('API_KEY_INVALID')) {
        break;
      }
    }
  }

  throw lastError || new Error('All Gemini model candidates failed to produce a response.');
}

export function extractJsonFromText<T = any>(raw: string): T | null {
  const cleaned = raw.trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {}

  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch {}
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
    } catch {}
  }
  return null;
}

// Lightweight sliding-window per-IP rate limiter for expensive endpoints
const rateBucket = new Map<string, number[]>();

export function createRateLimiter(maxRequests = 40, windowMs = 60_000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const history = (rateBucket.get(ip) || []).filter((ts) => now - ts < windowMs);
    if (history.length >= maxRequests) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please wait a few seconds before sending another request.'
      });
    }
    history.push(now);
    rateBucket.set(ip, history);
    next();
  };
}
