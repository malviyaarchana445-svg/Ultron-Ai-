import { Router } from 'express';
import {
  generateWithGeminiFallback,
  extractJsonFromText,
  mapGeminiError,
  createRateLimiter,
  ULTRON_SYSTEM_PROMPT
} from './aiClient';

export const codingAgentRouter = Router();
const codeLimiter = createRateLimiter(30, 60_000);

const SUPPORTED_LANGUAGES = new Set([
  'html',
  'css',
  'javascript',
  'python',
  'java',
  'cpp',
  'php',
  'sql'
]);

const ALLOWED_ACTIONS = new Set(['generate', 'explain', 'debug', 'improve', 'scaffold']);

interface CodingFile {
  path: string;
  language: string;
  content: string;
}

interface CodingAgentResponse {
  summary: string;
  files: CodingFile[];
  runInstructions: string;
  warnings: string[];
}

// POST /api/code/assist — Never executes user code on the server; generates/explains/debugs/scaffolds only
codingAgentRouter.post('/assist', codeLimiter, async (req, res) => {
  try {
    const {
      language = 'javascript',
      action = 'generate',
      prompt = '',
      files = [],
      errorLogs = ''
    } = req.body || {};

    const cleanLang = String(language).toLowerCase().trim();
    const cleanAction = String(action).toLowerCase().trim();

    if (!SUPPORTED_LANGUAGES.has(cleanLang)) {
      return res.status(400).json({
        success: false,
        error: `Unsupported language "${language}". Supported: HTML, CSS, JavaScript, Python, Java, C++, PHP, SQL.`
      });
    }

    if (!ALLOWED_ACTIONS.has(cleanAction)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid coding action. Use generate, explain, debug, improve, or scaffold.'
      });
    }

    if (!String(prompt).trim() && (!Array.isArray(files) || files.length === 0)) {
      return res.status(400).json({
        success: false,
        error: 'Provide a coding prompt or existing project files.'
      });
    }

    const existingFilesText = Array.isArray(files) && files.length > 0
      ? files
          .slice(0, 15)
          .map(
            (f: any) =>
              `--- FILE: ${String(f.path || 'untitled').slice(0, 120)} (${String(f.language || cleanLang)}) ---\n${String(f.content || '').slice(0, 25000)}`
          )
          .join('\n\n')
      : 'No existing files attached.';

    const instruction = `You are the Ultron AI Coding Agent (created by Krishna Chouhan and Kiran Panwar).
Primary target language: ${cleanLang.toUpperCase()}.
Requested action: ${cleanAction.toUpperCase()}.

Return ONLY a valid JSON object matching this exact schema (no extra markdown outside JSON):
{
  "summary": "Clear Markdown explanation of what was built, fixed, explained, or improved",
  "files": [
    {
      "path": "relative/file/path.ext",
      "language": "html|css|javascript|python|java|cpp|php|sql",
      "content": "Complete, clean, runnable file source code without placeholders"
    }
  ],
  "runInstructions": "Step-by-step instructions on how to test or run this code",
  "warnings": ["Optional list of breaking changes, destructive file edits, or security notes"]
}

RULES:
- When action is "explain", keep "files" empty or minimal annotated excerpts, and put the thorough line-by-line explanation inside "summary".
- When action is "scaffold" or web frontend ("html"), return clean modular multi-file structures (e.g., index.html, styles.css, app.js).
- Never include malicious payloads, command injection, or hardcoded secrets.`;

    const userPayload = `USER REQUEST:\n${String(prompt).trim()}\n\n${
      errorLogs ? `ERROR / STACK TRACE:\n${String(errorLogs).slice(0, 8000)}\n\n` : ''
    }PROJECT FILES:\n${existingFilesText}`;

    const { text, modelUsed } = await generateWithGeminiFallback({
      systemInstruction: `${ULTRON_SYSTEM_PROMPT}\n${instruction}`,
      contents: [{ role: 'user', parts: [{ text: userPayload }] }],
      temperature: cleanAction === 'explain' ? 0.3 : 0.2,
      responseMimeType: 'application/json'
    });

    const parsed = extractJsonFromText<CodingAgentResponse>(text);
    if (!parsed || typeof parsed.summary !== 'string') {
      return res.json({
        success: true,
        modelUsed,
        result: {
          summary: text,
          files: Array.isArray(files) ? files : [],
          runInstructions: 'Review the code above and run it in your local environment.',
          warnings: []
        }
      });
    }

    const sanitizedFiles: CodingFile[] = Array.isArray(parsed.files)
      ? parsed.files
          .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
          .slice(0, 20)
          .map((f) => ({
            path: f.path.replace(/^\/+/, '').slice(0, 140),
            language: String(f.language || cleanLang).toLowerCase(),
            content: f.content
          }))
      : [];

    return res.json({
      success: true,
      modelUsed,
      result: {
        summary: parsed.summary,
        files: sanitizedFiles,
        runInstructions: String(parsed.runInstructions || ''),
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : []
      }
    });
  } catch (err: any) {
    const mapped = mapGeminiError(err);
    return res.status(mapped.status).json({ success: false, error: mapped.message });
  }
});
