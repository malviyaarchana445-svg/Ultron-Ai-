import { Router } from 'express';
import mammoth from 'mammoth';
import {
  generateWithGeminiFallback,
  mapGeminiError,
  createRateLimiter,
  ULTRON_SYSTEM_PROMPT
} from './aiClient';

export const fileAnalyzerRouter = Router();
const fileLimiter = createRateLimiter(30, 60_000);

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB
const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.txt',
  '.csv',
  '.json',
  '.md',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.js',
  '.ts',
  '.py',
  '.java',
  '.cpp',
  '.php',
  '.sql',
  '.html',
  '.css'
]);

function getExtension(name: string): string {
  const lower = (name || '').toLowerCase().trim();
  const idx = lower.lastIndexOf('.');
  return idx >= 0 ? lower.slice(idx) : '';
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string; buffer: Buffer } | null {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');
  return { mimeType, base64, buffer };
}

// POST /api/files/extract — Extract readable text from DOCX, PDF, Images (OCR), CSV, JSON, TXT
fileAnalyzerRouter.post('/extract', fileLimiter, async (req, res) => {
  try {
    const { fileName, mimeType, size, dataUrl, textContent } = req.body || {};

    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({ success: false, error: 'fileName is required.' });
    }

    const ext = getExtension(fileName);
    if (!ALLOWED_EXTENSIONS.has(ext) && !(typeof mimeType === 'string' && mimeType.startsWith('image/'))) {
      return res.status(400).json({
        success: false,
        error: `Unsupported file type (${ext || mimeType}). Supported formats: PDF, DOCX, TXT, CSV, JSON, JPG, PNG, WebP.`
      });
    }

    if (typeof size === 'number' && size > MAX_FILE_BYTES) {
      return res.status(400).json({
        success: false,
        error: 'File size exceeds 15MB limit.'
      });
    }

    // 1. Plain-text / JSON / CSV provided directly
    if (typeof textContent === 'string' && textContent.trim().length > 0 && ext !== '.docx') {
      return res.json({
        success: true,
        extractedText: textContent.slice(0, 120000),
        method: 'direct-text'
      });
    }

    const parsed = parseDataUrl(dataUrl);
    if (!parsed) {
      return res.status(400).json({
        success: false,
        error: 'No valid file payload (dataUrl or textContent) provided.'
      });
    }

    if (parsed.buffer.length > MAX_FILE_BYTES) {
      return res.status(400).json({ success: false, error: 'Decoded file payload exceeds 15MB.' });
    }

    // 2. DOCX extraction via mammoth
    if (
      ext === '.docx' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      const result = await mammoth.extractRawText({ buffer: parsed.buffer });
      const text = (result.value || '').trim();
      return res.json({
        success: true,
        extractedText: text.slice(0, 120000) || '[DOCX file contained no readable text]',
        method: 'mammoth-docx'
      });
    }

    // 3. Text / CSV / JSON decoded from base64
    if (ext === '.txt' || ext === '.csv' || ext === '.json' || ext === '.md') {
      const decoded = parsed.buffer.toString('utf-8');
      return res.json({
        success: true,
        extractedText: decoded.slice(0, 120000),
        method: 'utf8-decode'
      });
    }

    // 4. PDF or Image OCR via Gemini multimodal
    if (ext === '.pdf' || parsed.mimeType === 'application/pdf' || parsed.mimeType.startsWith('image/')) {
      const isImage = parsed.mimeType.startsWith('image/');
      const prompt = isImage
        ? 'Perform accurate OCR and visual document extraction on this image. Transcribe all visible text, tables, labels, headings, and key numbers cleanly in Markdown. If no text exists, describe the visual contents thoroughly.'
        : 'Extract and transcribe the full readable content, headings, tables, and key data points from this PDF document cleanly. Preserve structure and avoid omitting important text.';

      const { text } = await generateWithGeminiFallback({
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: parsed.mimeType === 'application/octet-stream' && ext === '.pdf'
                    ? 'application/pdf'
                    : parsed.mimeType,
                  data: parsed.base64
                }
              },
              { text: prompt }
            ]
          }
        ],
        temperature: 0.1
      });

      return res.json({
        success: true,
        extractedText: text.slice(0, 120000),
        method: isImage ? 'gemini-ocr' : 'gemini-pdf-extract'
      });
    }

    return res.status(400).json({ success: false, error: 'Unsupported document payload.' });
  } catch (err: any) {
    const mapped = mapGeminiError(err);
    return res.status(mapped.status).json({ success: false, error: mapped.message });
  }
});

// POST /api/files/analyze — Summarize, extract key insights, or answer document-specific Q&A
fileAnalyzerRouter.post('/analyze', fileLimiter, async (req, res) => {
  try {
    const {
      fileName,
      mimeType,
      extractedText = '',
      dataUrl,
      action = 'summarize',
      question = '',
      history = []
    } = req.body || {};

    if (!fileName) {
      return res.status(400).json({ success: false, error: 'fileName is required.' });
    }

    let taskPrompt = '';
    if (action === 'extract_key_info') {
      taskPrompt = `Analyze the document "${fileName}" and extract structured key information:\n- Main Entities / People / Organizations\n- Key Dates, Figures & Metrics\n- Core Action Items or Requirements\n- Critical Warnings or Constraints`;
    } else if (action === 'qa') {
      if (!question || !String(question).trim()) {
        return res.status(400).json({ success: false, error: 'Question is required for document Q&A.' });
      }
      taskPrompt = `Answer the user's question strictly grounded in the document "${fileName}". If an answer is not present in the document, explicitly say so.\n\nQuestion: ${String(question).trim()}`;
    } else {
      taskPrompt = `Generate a thorough, well-structured executive summary of "${fileName}". Include:\n1. High-Level Overview\n2. Key Takeaways (bullet points)\n3. Notable Details & Data\n4. Conclusion / Next Steps`;
    }

    const parts: any[] = [];
    if (extractedText && typeof extractedText === 'string') {
      parts.push({
        text: `[DOCUMENT: ${fileName} (${mimeType || 'document'})]\n\`\`\`\n${extractedText.slice(0, 90000)}\n\`\`\``
      });
    }

    const parsed = parseDataUrl(dataUrl);
    if (parsed && (parsed.mimeType.startsWith('image/') || parsed.mimeType === 'application/pdf')) {
      parts.push({
        inlineData: {
          mimeType: parsed.mimeType,
          data: parsed.base64
        }
      });
    }

    if (Array.isArray(history) && history.length > 0) {
      const historyBlock = history
        .slice(-10)
        .map((h: any) => `${h.role === 'assistant' ? 'Ultron' : 'User'}: ${String(h.content || '').slice(0, 2000)}`)
        .join('\n');
      parts.push({ text: `\nPrevious Document Conversation:\n${historyBlock}` });
    }

    parts.push({ text: `\n\n${taskPrompt}` });

    const { text, modelUsed } = await generateWithGeminiFallback({
      systemInstruction: `${ULTRON_SYSTEM_PROMPT}\nYou are currently operating in Ultron AI File Analyzer mode. Be precise, cite exact sections/figures from the uploaded document, and never hallucinate missing facts.`,
      contents: [{ role: 'user', parts }],
      temperature: 0.25
    });

    return res.json({ success: true, analysis: text, modelUsed });
  } catch (err: any) {
    const mapped = mapGeminiError(err);
    return res.status(mapped.status).json({ success: false, error: mapped.message });
  }
});

// POST /api/files/compare — Compare two or more uploaded documents
fileAnalyzerRouter.post('/compare', fileLimiter, async (req, res) => {
  try {
    const { documents = [], focus = '' } = req.body || {};
    if (!Array.isArray(documents) || documents.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'At least 2 documents are required for comparison.'
      });
    }

    const docTextBlocks = documents
      .slice(0, 5)
      .map((d: any, idx: number) => {
        const snippet = String(d.extractedText || d.summary || '[No text extracted]').slice(0, 28000);
        return `=== DOCUMENT ${idx + 1}: ${String(d.name || `Doc ${idx + 1}`)} ===\n${snippet}`;
      })
      .join('\n\n');

    const prompt = `Compare the following documents in detail${focus ? ` with special focus on: ${focus}` : ''}.\n\nProduce a clean Markdown report with:\n1. **Side-by-Side Comparison Table** (Aspect | ${documents.slice(0, 5).map((d: any) => d.name).join(' | ')})\n2. **Key Similarities**\n3. **Critical Differences & Discrepancies**\n4. **Gaps or Missing Information**\n5. **Overall Synthesis**\n\n${docTextBlocks}`;

    const { text, modelUsed } = await generateWithGeminiFallback({
      systemInstruction: `${ULTRON_SYSTEM_PROMPT}\nOperate as a meticulous document auditor comparing multiple sources accurately.`,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      temperature: 0.25
    });

    return res.json({ success: true, comparison: text, modelUsed });
  } catch (err: any) {
    const mapped = mapGeminiError(err);
    return res.status(mapped.status).json({ success: false, error: mapped.message });
  }
});
