import { Router } from 'express';
import { ThinkingLevel, Type } from '@google/genai';
import {
  ALLOWLISTED_COMMAND_IDS,
  ParsedAssistantCommand,
  buildBlockedOutcome,
  buildCommandOutcome,
  detectLanguagePreference,
  isAllowlistedCommandId,
  matchDeterministicCommand,
  stripWakeWordFromUtterance
} from '../src/services/deviceCommands';
import {
  FAST_GEMINI_MODELS,
  ULTRON_SYSTEM_PROMPT,
  buildModelConfig,
  createRateLimiter,
  extractJsonFromText,
  getGeminiClient
} from './aiClient';

export const deviceAssistantRouter = Router();
const assistantLimiter = createRateLimiter(60, 60_000);
export { matchDeterministicCommand };


const NLU_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intentType: {
      type: Type.STRING,
      description: 'Must be one of: device_command, blocked_action, conversation'
    },
    commandId: {
      type: Type.STRING,
      description: `Allowlisted command ID (${ALLOWLISTED_COMMAND_IDS.join(', ')}) or empty string if conversation`
    },
    level: {
      type: Type.INTEGER,
      description: 'Optional 0-100 level for volume_set or brightness_set'
    },
    hour: {
      type: Type.INTEGER,
      description: 'Optional 0-23 hour for set_alarm'
    },
    minute: {
      type: Type.INTEGER,
      description: 'Optional 0-59 minute for set_alarm'
    },
    phoneNumber: {
      type: Type.STRING,
      description: 'Optional phone number digits for dial_phone or compose_sms'
    },
    replyText: {
      type: Type.STRING,
      description: 'Natural short conversational response in Hinglish, Hindi, or English matching the user.'
    },
    speechLang: {
      type: Type.STRING,
      description: 'hi-IN for Hindi/Hinglish or en-US for English'
    }
  },
  required: ['intentType', 'replyText', 'speechLang']
};

// POST /api/assistant/command — Parse English / Hindi / Hinglish voice or text command into strict allowlisted Android actions or conversational reply
deviceAssistantRouter.post('/command', assistantLimiter, async (req, res) => {
  try {
    const rawText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const wakePhrase = typeof req.body?.wakePhrase === 'string' && req.body.wakePhrase.trim()
      ? req.body.wakePhrase.trim()
      : 'Hey Ultron';
    const defaultLang: 'hi-IN' | 'en-US' = req.body?.voiceLang === 'en-US' ? 'en-US' : 'hi-IN';
    const customApiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined;
    const deterministicOnly = Boolean(req.body?.deterministicOnly);

    if (!rawText) {
      return res.status(400).json({ success: false, error: 'Command text is required.' });
    }

    // Step 1: Deterministic fast parser (sub-2ms)
    const deterministic = matchDeterministicCommand(rawText, { wakePhrase, defaultLang });
    if (deterministic) {
      return res.json({ success: true, result: deterministic });
    }

    // Step 2: Gemini structured classification + conversational fallback
    const { wakeWordDetected, cleanedCommand } = stripWakeWordFromUtterance(rawText, wakePhrase);
    const query = cleanedCommand || rawText;
    const preferredLang = detectLanguagePreference(rawText, defaultLang);

    if (deterministicOnly) {
      return res.json({
        success: true,
        result: {
          kind: 'conversation',
          commandId: null,
          params: {},
          replyText: '',
          speechLang: preferredLang,
          requiresConfirmation: false,
          normalizedQuery: query,
          wakeWordDetected,
          source: 'chat'
        } satisfies ParsedAssistantCommand
      });
    }

    try {
      const ai = getGeminiClient(customApiKey, 15000);
      const nluInstruction = `${ULTRON_SYSTEM_PROMPT}

ROLE: You are Ultron AI Voice & Android Device Control Assistant.
Classify the user's English, Hindi, or Hinglish command into STRICTLY ONE of:
1. "device_command" ONLY when it cleanly maps to one of these allowlisted IDs:
   ${ALLOWLISTED_COMMAND_IDS.join(', ')}
2. "blocked_action" if the user tries to delete device files, run shell/root/adb commands, bypass security/permissions, or extract private data.
3. "conversation" for general Q&A, greetings, math, weather/knowledge, or identity questions ("Who created you?" -> Krishna Chouhan and Kiran Panwar).

Rules:
- Keep replyText natural, friendly, concise (1-2 sentences ideal for speech), matching English or Hinglish/Hindi.
- NEVER invent fake command IDs or pretend you toggled Wi-Fi/Bluetooth directly (map those to open_wifi_settings / open_bluetooth_settings).
- Never generate shell commands.`;

      let parsed: any = null;
      for (const modelName of FAST_GEMINI_MODELS) {
        try {
          const config = buildModelConfig({
            modelName,
            systemInstruction: nluInstruction,
            temperature: 0.2,
            responseMimeType: 'application/json',
            thinkingLevel: ThinkingLevel.LOW
          });
          config.responseSchema = NLU_RESPONSE_SCHEMA;

          const response = await ai.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts: [{ text: query }] }],
            config
          });
          const json = extractJsonFromText(response.text || '');
          if (json && typeof json.replyText === 'string') {
            parsed = json;
            break;
          }
        } catch (err) {
          console.warn(`[Assistant NLU] ${modelName} fallback:`, (err as any)?.message || err);
        }
      }

      if (parsed) {
        const speechLang: 'hi-IN' | 'en-US' = parsed.speechLang === 'en-US' ? 'en-US' : 'hi-IN';

        if (parsed.intentType === 'blocked_action') {
          return res.json({
            success: true,
            result: buildBlockedOutcome(
              'delete_files',
              parsed.replyText,
              speechLang,
              query,
              wakeWordDetected
            )
          });
        }

        if (parsed.intentType === 'device_command' && isAllowlistedCommandId(parsed.commandId)) {
          return res.json({
            success: true,
            result: buildCommandOutcome(
              parsed.commandId,
              {
                level: typeof parsed.level === 'number' ? parsed.level : undefined,
                hour: typeof parsed.hour === 'number' ? parsed.hour : undefined,
                minute: typeof parsed.minute === 'number' ? parsed.minute : undefined,
                phoneNumber: typeof parsed.phoneNumber === 'string' ? parsed.phoneNumber : undefined
              },
              parsed.replyText,
              speechLang,
              query,
              wakeWordDetected,
              'ai_nlu'
            )
          });
        }

        return res.json({
          success: true,
          result: {
            kind: 'conversation',
            commandId: null,
            params: {},
            replyText: parsed.replyText,
            speechLang,
            requiresConfirmation: false,
            normalizedQuery: query,
            wakeWordDetected,
            source: 'chat'
          } satisfies ParsedAssistantCommand
        });
      }
    } catch (aiErr: any) {
      console.warn('[Assistant NLU] AI fallback unavailable:', aiErr?.message || aiErr);
    }

    // Offline / key-free graceful conversational fallback
    const creatorAsked = /\b(?:who\s+(?:made|created|built)|creator|kisne\s+banaya|created\s+by)\b/i.test(query);
    const fallbackReply = creatorAsked
      ? preferredLang === 'hi-IN'
        ? 'Main Ultron AI hoon, mujhe Krishna Chouhan aur Kiran Panwar ne banaya hai.'
        : 'I am Ultron AI, created by Krishna Chouhan and Kiran Panwar.'
      : preferredLang === 'hi-IN'
      ? 'Main aapki device commands jaise Torch, Volume, Brightness, Wi-Fi, Bluetooth, Battery, Time aur Alarm mein turant madad kar sakta hoon, ya normal chat mein kisi bhi sawaal ka jawaab de sakta hoon.'
      : 'I can run device controls like Torch, Volume, Brightness, Wi-Fi/Bluetooth settings, Battery, Time, and Alarms, or answer questions in Chat.';

    return res.json({
      success: true,
      result: {
        kind: 'conversation',
        commandId: null,
        params: {},
        replyText: fallbackReply,
        speechLang: preferredLang,
        requiresConfirmation: false,
        normalizedQuery: query,
        wakeWordDetected,
        source: 'chat'
      } satisfies ParsedAssistantCommand
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message || 'Failed to parse assistant command.'
    });
  }
});
