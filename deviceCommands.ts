export type AllowlistedCommandId =
  | 'torch_on'
  | 'torch_off'
  | 'torch_toggle'
  | 'volume_up'
  | 'volume_down'
  | 'volume_set'
  | 'volume_mute'
  | 'volume_unmute'
  | 'brightness_up'
  | 'brightness_down'
  | 'brightness_set'
  | 'open_wifi_settings'
  | 'open_bluetooth_settings'
  | 'open_sound_settings'
  | 'open_display_settings'
  | 'open_battery_settings'
  | 'open_system_settings'
  | 'get_battery_status'
  | 'get_current_time'
  | 'set_alarm'
  | 'open_alarms'
  | 'dial_phone'
  | 'compose_sms'
  | 'open_security_settings';

export type SensitiveCategory =
  | 'phone_call'
  | 'send_message'
  | 'security_settings'
  | 'delete_files'
  | 'personal_info'
  | 'shell_execution';

export interface DeviceCommandParams {
  level?: number; // 0-100 for volume_set or 10-100 for brightness_set
  hour?: number; // 0-23 for set_alarm
  minute?: number; // 0-59 for set_alarm
  label?: string; // Alarm label or sanitized display label
  phoneNumber?: string; // Sanitized phone number for dial_phone / compose_sms
  messageBody?: string; // Sanitized message body for compose_sms
}

export interface ParsedAssistantCommand {
  kind: 'device_command' | 'blocked_action' | 'conversation';
  commandId: AllowlistedCommandId | null;
  params: DeviceCommandParams;
  replyText: string;
  speechLang: 'hi-IN' | 'en-US';
  requiresConfirmation: boolean;
  sensitiveCategory?: SensitiveCategory;
  confirmationReason?: string;
  normalizedQuery: string;
  wakeWordDetected: boolean;
  source: 'deterministic' | 'ai_nlu' | 'chat';
}

export interface AllowlistedCommandMeta {
  id: AllowlistedCommandId;
  label: string;
  hinglishExample: string;
  category: 'hardware' | 'settings' | 'info' | 'utilities' | 'communication';
  requiresConfirmation: boolean;
  sensitiveCategory?: SensitiveCategory;
  androidSupportNote: string;
}

export const ALLOWLISTED_COMMAND_REGISTRY: Record<AllowlistedCommandId, AllowlistedCommandMeta> = {
  torch_on: {
    id: 'torch_on',
    label: 'Torch On',
    hinglishExample: 'Hey Ultron, torch on karo',
    category: 'hardware',
    requiresConfirmation: false,
    androidSupportNote: 'Android CameraManager torch API'
  },
  torch_off: {
    id: 'torch_off',
    label: 'Torch Off',
    hinglishExample: 'Torch band karo',
    category: 'hardware',
    requiresConfirmation: false,
    androidSupportNote: 'Android CameraManager torch API'
  },
  torch_toggle: {
    id: 'torch_toggle',
    label: 'Toggle Torch',
    hinglishExample: 'Flashlight toggle karo',
    category: 'hardware',
    requiresConfirmation: false,
    androidSupportNote: 'Android CameraManager torch API'
  },
  volume_up: {
    id: 'volume_up',
    label: 'Volume Up',
    hinglishExample: 'Volume increase karo',
    category: 'hardware',
    requiresConfirmation: false,
    androidSupportNote: 'Android AudioManager media stream'
  },
  volume_down: {
    id: 'volume_down',
    label: 'Volume Down',
    hinglishExample: 'Volume kam karo',
    category: 'hardware',
    requiresConfirmation: false,
    androidSupportNote: 'Android AudioManager media stream'
  },
  volume_set: {
    id: 'volume_set',
    label: 'Set Volume',
    hinglishExample: 'Volume 60 percent karo',
    category: 'hardware',
    requiresConfirmation: false,
    androidSupportNote: 'Android AudioManager media stream'
  },
  volume_mute: {
    id: 'volume_mute',
    label: 'Mute Volume',
    hinglishExample: 'Awaz mute karo',
    category: 'hardware',
    requiresConfirmation: false,
    androidSupportNote: 'Android AudioManager media stream'
  },
  volume_unmute: {
    id: 'volume_unmute',
    label: 'Unmute Volume',
    hinglishExample: 'Volume unmute karo',
    category: 'hardware',
    requiresConfirmation: false,
    androidSupportNote: 'Android AudioManager media stream'
  },
  brightness_up: {
    id: 'brightness_up',
    label: 'Brightness Up',
    hinglishExample: 'Brightness badhao',
    category: 'hardware',
    requiresConfirmation: false,
    androidSupportNote: 'Adjusts app/system brightness or opens Display Settings'
  },
  brightness_down: {
    id: 'brightness_down',
    label: 'Brightness Down',
    hinglishExample: 'Brightness kam karo',
    category: 'hardware',
    requiresConfirmation: false,
    androidSupportNote: 'Adjusts app/system brightness or opens Display Settings'
  },
  brightness_set: {
    id: 'brightness_set',
    label: 'Set Brightness',
    hinglishExample: 'Brightness 50% karo',
    category: 'hardware',
    requiresConfirmation: false,
    androidSupportNote: 'Adjusts app/system brightness or opens Display Settings'
  },
  open_wifi_settings: {
    id: 'open_wifi_settings',
    label: 'Wi-Fi Settings',
    hinglishExample: 'Wi-Fi settings kholo',
    category: 'settings',
    requiresConfirmation: false,
    androidSupportNote: 'Opens Android Wi-Fi Panel / Settings (Android 10+ policy)'
  },
  open_bluetooth_settings: {
    id: 'open_bluetooth_settings',
    label: 'Bluetooth Settings',
    hinglishExample: 'Bluetooth settings kholo',
    category: 'settings',
    requiresConfirmation: false,
    androidSupportNote: 'Opens Android Bluetooth Settings (Android 13+ policy)'
  },
  open_sound_settings: {
    id: 'open_sound_settings',
    label: 'Sound Settings',
    hinglishExample: 'Sound settings kholo',
    category: 'settings',
    requiresConfirmation: false,
    androidSupportNote: 'Opens Android Sound / Volume Panel'
  },
  open_display_settings: {
    id: 'open_display_settings',
    label: 'Display Settings',
    hinglishExample: 'Display settings open karo',
    category: 'settings',
    requiresConfirmation: false,
    androidSupportNote: 'Opens Android Display Settings'
  },
  open_battery_settings: {
    id: 'open_battery_settings',
    label: 'Battery Settings',
    hinglishExample: 'Battery settings kholo',
    category: 'settings',
    requiresConfirmation: false,
    androidSupportNote: 'Opens Android Battery Usage / Saver Settings'
  },
  open_system_settings: {
    id: 'open_system_settings',
    label: 'Device Settings',
    hinglishExample: 'Settings open karo',
    category: 'settings',
    requiresConfirmation: false,
    androidSupportNote: 'Opens main Android Settings'
  },
  get_battery_status: {
    id: 'get_battery_status',
    label: 'Battery Status',
    hinglishExample: 'Phone ki battery kitni hai?',
    category: 'info',
    requiresConfirmation: false,
    androidSupportNote: 'Reads BatteryManager charge % and charging state'
  },
  get_current_time: {
    id: 'get_current_time',
    label: 'Current Time',
    hinglishExample: 'Time kya hua hai?',
    category: 'info',
    requiresConfirmation: false,
    androidSupportNote: 'Reads local device clock'
  },
  set_alarm: {
    id: 'set_alarm',
    label: 'Set Alarm',
    hinglishExample: 'Subah 7 baje ka alarm set karo',
    category: 'utilities',
    requiresConfirmation: false,
    androidSupportNote: 'Launches Android Clock SET_ALARM intent'
  },
  open_alarms: {
    id: 'open_alarms',
    label: 'Alarm Helper',
    hinglishExample: 'Alarm set karne mein help karo',
    category: 'utilities',
    requiresConfirmation: false,
    androidSupportNote: 'Opens Android Clock Alarms'
  },
  dial_phone: {
    id: 'dial_phone',
    label: 'Phone Dialer',
    hinglishExample: '9876543210 par call karo',
    category: 'communication',
    requiresConfirmation: true,
    sensitiveCategory: 'phone_call',
    androidSupportNote: 'Opens Dialer after explicit confirmation'
  },
  compose_sms: {
    id: 'compose_sms',
    label: 'Compose Message',
    hinglishExample: 'Send message to 9876543210',
    category: 'communication',
    requiresConfirmation: true,
    sensitiveCategory: 'send_message',
    androidSupportNote: 'Opens SMS composer after explicit confirmation'
  },
  open_security_settings: {
    id: 'open_security_settings',
    label: 'Security Settings',
    hinglishExample: 'Security settings kholo',
    category: 'settings',
    requiresConfirmation: true,
    sensitiveCategory: 'security_settings',
    androidSupportNote: 'Opens Security Settings only after explicit confirmation'
  }
};

export const ALLOWLISTED_COMMAND_IDS = Object.keys(ALLOWLISTED_COMMAND_REGISTRY) as AllowlistedCommandId[];

export function isAllowlistedCommandId(value: unknown): value is AllowlistedCommandId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ALLOWLISTED_COMMAND_REGISTRY, value);
}

export function sanitizeDeviceParams(
  commandId: AllowlistedCommandId,
  rawParams?: Record<string, unknown>
): DeviceCommandParams {
  const params: DeviceCommandParams = {};
  if (!rawParams || typeof rawParams !== 'object') return params;

  if (commandId === 'volume_set' || commandId === 'brightness_set') {
    const rawLevel = Number(rawParams.level);
    if (Number.isFinite(rawLevel)) {
      const minVal = commandId === 'brightness_set' ? 10 : 0;
      params.level = Math.max(minVal, Math.min(100, Math.round(rawLevel)));
    }
  }

  if (commandId === 'set_alarm') {
    const rawHour = Number(rawParams.hour);
    const rawMinute = Number(rawParams.minute);
    if (Number.isFinite(rawHour)) {
      params.hour = Math.max(0, Math.min(23, Math.floor(rawHour)));
    }
    if (Number.isFinite(rawMinute)) {
      params.minute = Math.max(0, Math.min(59, Math.floor(rawMinute)));
    }
    if (typeof rawParams.label === 'string' && rawParams.label.trim()) {
      params.label = rawParams.label.replace(/[^\w\s\-.,:]/g, '').trim().slice(0, 60);
    }
  }

  if (commandId === 'dial_phone' || commandId === 'compose_sms') {
    if (typeof rawParams.phoneNumber === 'string') {
      const digits = rawParams.phoneNumber.replace(/[^0-9+*#]/g, '').slice(0, 18);
      if (digits.length >= 3) {
        params.phoneNumber = digits;
      }
    }
    if (commandId === 'compose_sms' && typeof rawParams.messageBody === 'string') {
      params.messageBody = rawParams.messageBody.replace(/[<>]/g, '').trim().slice(0, 280);
    }
  }

  return params;
}

export function stripWakeWordFromUtterance(
  rawText: string,
  wakePhrase = 'Hey Ultron'
): { wakeWordDetected: boolean; cleanedCommand: string } {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return { wakeWordDetected: false, cleanedCommand: '' };

  const normalizedCustom = wakePhrase.trim().toLowerCase();
  const customEscaped = wakePhrase
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');

  const isDefaultUltronPhrase = !normalizedCustom || normalizedCustom.includes('ultron');

  const patterns: RegExp[] = [];
  if (customEscaped) {
    patterns.push(new RegExp(`^(?:${customEscaped})[,:\\s\\-!?]*`, 'i'));
  }
  if (isDefaultUltronPhrase) {
    // Include common English & Hindi STT transcriptions of "Hey Ultron"
    patterns.push(
      /^(?:hey|hi|hello|ok|okay|yo|listen|suno|a|hay|हे)?\s*(?:ultron|altron|ultran|electron|अल्ट्रॉन|अल्ट्रोन|उल्ट्रोन)[,:\s\-!?]*/i
    );
  }

  for (const rx of patterns) {
    const match = trimmed.match(rx);
    if (match) {
      const cleaned = trimmed.slice(match[0].length).trim();
      return {
        wakeWordDetected: true,
        cleanedCommand: cleaned
      };
    }
  }

  return {
    wakeWordDetected: false,
    cleanedCommand: trimmed
  };
}

export function detectLanguagePreference(
  text: string,
  fallback: 'hi-IN' | 'en-US' = 'hi-IN'
): 'hi-IN' | 'en-US' {
  if (/[\u0900-\u097F]/.test(text)) return 'hi-IN';
  if (
    /\b(?:karo|karna|kijiye|kholo|batao|kitni|kitna|hua|hai|chalu|band|kam|badhao|ghatao|lagao|subah|shaam|raat|bhai|mera|meri|phone ki|awaz|aawaz|baje)\b/i.test(
      text
    )
  ) {
    return 'hi-IN';
  }
  return fallback;
}

function parseTimeForAlarm(text: string): { hour?: number; minute?: number; label?: string } {
  const timeMatch = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|baje)?\b/i);
  if (!timeMatch) return {};

  let hour = Number(timeMatch[1]);
  const minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
  const suffix = (timeMatch[3] || '').toLowerCase();

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return {};

  if ((suffix === 'pm' || suffix === 'p.m.' || /\b(?:shaam|evening|night|raat)\b/i.test(text)) && hour < 12) {
    hour += 12;
  } else if ((suffix === 'am' || suffix === 'a.m.' || /\b(?:subah|morning)\b/i.test(text)) && hour === 12) {
    hour = 0;
  }

  return { hour, minute, label: 'Ultron Alarm' };
}

function extractPhoneNumber(text: string): string | undefined {
  const match = text.match(/(\+?\d[\d\s\-]{5,17}\d)/);
  if (!match) return undefined;
  const digits = match[1].replace(/[^0-9+]/g, '');
  return digits.length >= 3 ? digits : undefined;
}

function extractLevelPercent(text: string): number | undefined {
  const match = text.match(/\b(\d{1,3})\s*(?:%|percent|pratishat)?\b/i);
  if (!match) return undefined;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num < 0 || num > 100) return undefined;
  return num;
}

export function buildCommandOutcome(
  commandId: AllowlistedCommandId,
  params: DeviceCommandParams,
  replyText: string,
  speechLang: 'hi-IN' | 'en-US',
  normalizedQuery: string,
  wakeWordDetected: boolean,
  source: 'deterministic' | 'ai_nlu',
  confirmationReason?: string
): ParsedAssistantCommand {
  const meta = ALLOWLISTED_COMMAND_REGISTRY[commandId];
  const sanitized = sanitizeDeviceParams(commandId, params as Record<string, unknown>);
  return {
    kind: 'device_command',
    commandId,
    params: sanitized,
    replyText,
    speechLang,
    requiresConfirmation: meta.requiresConfirmation,
    sensitiveCategory: meta.sensitiveCategory,
    confirmationReason:
      confirmationReason ||
      (meta.requiresConfirmation ? `Confirm before Ultron executes "${meta.label}".` : undefined),
    normalizedQuery,
    wakeWordDetected,
    source
  };
}

export function buildBlockedOutcome(
  sensitiveCategory: SensitiveCategory,
  replyText: string,
  speechLang: 'hi-IN' | 'en-US',
  normalizedQuery: string,
  wakeWordDetected: boolean
): ParsedAssistantCommand {
  return {
    kind: 'blocked_action',
    commandId: null,
    params: {},
    replyText,
    speechLang,
    requiresConfirmation: true,
    sensitiveCategory,
    confirmationReason: replyText,
    normalizedQuery,
    wakeWordDetected,
    source: 'deterministic'
  };
}

export function matchDeterministicCommand(
  rawInput: string,
  options?: { wakePhrase?: string; defaultLang?: 'hi-IN' | 'en-US' }
): ParsedAssistantCommand | null {
  const { wakeWordDetected, cleanedCommand } = stripWakeWordFromUtterance(
    rawInput,
    options?.wakePhrase || 'Hey Ultron'
  );
  const query = cleanedCommand || rawInput.trim();
  const lang = detectLanguagePreference(rawInput, options?.defaultLang || 'hi-IN');
  const lower = query.toLowerCase().trim();

  if (!lower) {
    if (wakeWordDetected) {
      return {
        kind: 'conversation',
        commandId: null,
        params: {},
        replyText: lang === 'hi-IN' ? 'Haan, boliye main sun raha hoon.' : 'Yes, I am listening. How can I help?',
        speechLang: lang,
        requiresConfirmation: false,
        normalizedQuery: '',
        wakeWordDetected: true,
        source: 'deterministic'
      };
    }
    return null;
  }

  // 1. STRICT SECURITY BLOCKS — NEVER execute arbitrary shell commands, silent deletes, or privacy bypass
  if (
    /\b(?:rm\s+-rf|sudo|su\s+-c|adb\s+shell|chmod|chown|mkfs|format\s+disk|powershell|bash\s+-c|sh\s+-c|eval\(|exec\(|shell\s+command|run\s+terminal)\b/i.test(
      lower
    )
  ) {
    return buildBlockedOutcome(
      'shell_execution',
      lang === 'hi-IN'
        ? 'Security policy ke tahat Ultron arbitrary shell ya system commands execute nahi karta. Sirf safe allowlisted device controls supported hain.'
        : 'For your security, Ultron never executes arbitrary shell or system commands. Only allowlisted Android controls are supported.',
      lang,
      query,
      wakeWordDetected
    );
  }

  if (
    /\b(?:delete|remove|erase|wipe|format)\b.*\b(?:file|files|photo|photos|gallery|folder|storage|data|sdcard|contact|contacts)\b|\b(?:file|files|photo|data)\s+(?:delete|mitao|hatao)\b/i.test(
      lower
    )
  ) {
    return buildBlockedOutcome(
      'delete_files',
      lang === 'hi-IN'
        ? 'Files ya personal data delete karne ki request security protection ke liye block hai. Please phone ke Files app se manually verify karke delete karein.'
        : 'Deleting device files or personal data requires direct confirmation in your Android Files manager and cannot be executed automatically by voice.',
      lang,
      query,
      wakeWordDetected
    );
  }

  if (
    /\b(?:secretly\s+record|hidden\s+record|bypass\s+permission|read\s+otp|steal\s+password|dump\s+sms|export\s+contacts)\b/i.test(
      lower
    )
  ) {
    return buildBlockedOutcome(
      'personal_info',
      lang === 'hi-IN'
        ? 'Privacy rules ke mutabik Ultron bina permission personal info access ya secret recording nahi karta.'
        : 'Ultron strictly respects Android privacy indicators and never accesses personal data or records secretly.',
      lang,
      query,
      wakeWordDetected
    );
  }

  // 2. SENSITIVE CONFIRMATION-GATED ACTIONS
  if (
    /\b(?:security\s+setting|security\s+settings|screen\s+lock|lock\s+screen\s+password|pin\s+change|fingerprint\s+setting|biometric)\b/i.test(
      lower
    )
  ) {
    return buildCommandOutcome(
      'open_security_settings',
      {},
      lang === 'hi-IN'
        ? 'Security settings kholne se pehle please confirm karein.'
        : 'Please confirm before opening Android Security Settings.',
      lang,
      query,
      wakeWordDetected,
      'deterministic',
      'Opening Security Settings involves device lock & security controls. Confirm to proceed.'
    );
  }

  if (/\b(?:call|dial|phone\s+lagao|call\s+karo)\b|कॉल/i.test(lower)) {
    const phone = extractPhoneNumber(query);
    return buildCommandOutcome(
      'dial_phone',
      { phoneNumber: phone },
      phone
        ? lang === 'hi-IN'
          ? `${phone} par call ke liye dialer kholne se pehle confirm karein.`
          : `Confirm to open the dialer for ${phone}.`
        : lang === 'hi-IN'
        ? 'Phone dialer kholne se pehle confirm karein.'
        : 'Confirm to open the phone dialer.',
      lang,
      query,
      wakeWordDetected,
      'deterministic',
      phone
        ? `Confirm opening the phone dialer for ${phone}. You will still tap Call inside Android Dialer.`
        : 'Confirm opening the phone dialer.'
    );
  }

  if (/\b(?:sms|text\s+message|message\s+bhejo|send\s+message|send\s+sms)\b|मैसेज/i.test(lower)) {
    const phone = extractPhoneNumber(query);
    return buildCommandOutcome(
      'compose_sms',
      { phoneNumber: phone, messageBody: '' },
      lang === 'hi-IN'
        ? 'Message compose karne se pehle please confirm karein.'
        : 'Please confirm before opening your Messages app.',
      lang,
      query,
      wakeWordDetected,
      'deterministic',
      phone
        ? `Confirm opening SMS composer for ${phone}. Ultron never sends messages silently.`
        : 'Confirm opening your Android Messages app.'
    );
  }

  // 3. TORCH / FLASHLIGHT
  if (/\b(?:torch|flashlight|flash\s*light|flash)\b|टॉर्च|फ्लैश/i.test(lower)) {
    if (/\b(?:off|band|close|disable|stop|bujhao)\b|बंद/i.test(lower)) {
      return buildCommandOutcome(
        'torch_off',
        {},
        lang === 'hi-IN' ? 'Torch band kar diya.' : 'Flashlight turned off.',
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
    if (/\b(?:toggle|switch)\b/i.test(lower)) {
      return buildCommandOutcome(
        'torch_toggle',
        {},
        lang === 'hi-IN' ? 'Torch toggle kar diya.' : 'Flashlight toggled.',
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
    if (
      /\b(?:on|chalu|jalao|start|open|enable|turn\s+on)\b|चालू|ऑन|जलाओ/i.test(lower) ||
      lower === 'torch' ||
      lower === 'flashlight'
    ) {
      return buildCommandOutcome(
        'torch_on',
        {},
        lang === 'hi-IN' ? 'Torch on kar diya.' : 'Flashlight turned on.',
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
  }

  // 4. VOLUME CONTROLS
  if (/\b(?:mute|silent|awaz\s+band|aawaz\s+band)\b|म्यूट/i.test(lower)) {
    return buildCommandOutcome(
      'volume_mute',
      {},
      lang === 'hi-IN' ? 'Media volume mute kar diya.' : 'Media volume muted.',
      lang,
      query,
      wakeWordDetected,
      'deterministic'
    );
  }
  if (/\b(?:unmute)\b/i.test(lower)) {
    return buildCommandOutcome(
      'volume_unmute',
      {},
      lang === 'hi-IN' ? 'Volume unmute kar diya.' : 'Media volume unmuted.',
      lang,
      query,
      wakeWordDetected,
      'deterministic'
    );
  }
  if (/\b(?:volume|awaz|aawaz|sound)\b|वॉल्यूम|आवाज़|आवाज/i.test(lower)) {
    if (
      /\b(?:settings|setting|panel|kholo|open)\b/i.test(lower) &&
      !/\b(?:increase|decrease|up|down|badhao|badha|kam|set)\b/i.test(lower)
    ) {
      return buildCommandOutcome(
        'open_sound_settings',
        {},
        lang === 'hi-IN' ? 'Sound settings khol raha hoon.' : 'Opening sound settings.',
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
    const level = extractLevelPercent(lower);
    if (
      level !== undefined &&
      /\b(?:set|pe|par|to|karo)\b/i.test(lower) &&
      !/\b(?:increase|decrease|badhao|badha|kam|ghatao)\b/i.test(lower)
    ) {
      return buildCommandOutcome(
        'volume_set',
        { level },
        lang === 'hi-IN' ? `Volume ${level}% par set kar diya.` : `Volume set to ${level}%.`,
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
    if (/\b(?:down|decrease|kam|low|reduce|ghatao|lower|slow)\b|कम|घटाओ/i.test(lower)) {
      return buildCommandOutcome(
        'volume_down',
        {},
        lang === 'hi-IN' ? 'Volume kam kar diya.' : 'Volume decreased.',
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
    if (/\b(?:up|increase|zyada|high|badhao|badha|raise|louder|full|max)\b|बढ़ाओ|ज्यादा/i.test(lower)) {
      return buildCommandOutcome(
        'volume_up',
        {},
        lang === 'hi-IN' ? 'Volume badha diya hai.' : 'Volume increased.',
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
  }

  // 5. BRIGHTNESS CONTROLS
  if (/\b(?:brightness|roshni|screen\s+light)\b|ब्राइटनेस|रोशनी/i.test(lower)) {
    if (
      /\b(?:settings|setting|display)\b/i.test(lower) &&
      !/\b(?:up|down|kam|zyada|badhao|badha|increase|decrease|set)\b/i.test(lower)
    ) {
      return buildCommandOutcome(
        'open_display_settings',
        {},
        lang === 'hi-IN' ? 'Display settings khol raha hoon.' : 'Opening display settings.',
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
    const level = extractLevelPercent(lower);
    if (level !== undefined && !/\b(?:up|down|kam|zyada|badhao|badha|increase|decrease)\b/i.test(lower)) {
      return buildCommandOutcome(
        'brightness_set',
        { level },
        lang === 'hi-IN' ? `Brightness ${level}% par adjust kar raha hoon.` : `Adjusting brightness to ${level}%.`,
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
    if (/\b(?:down|decrease|kam|low|dim|ghatao|reduce)\b|कम/i.test(lower)) {
      return buildCommandOutcome(
        'brightness_down',
        {},
        lang === 'hi-IN' ? 'Brightness kam kar raha hoon.' : 'Lowering brightness.',
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
    if (/\b(?:up|increase|zyada|high|badhao|badha|bright|raise|max)\b|बढ़ाओ/i.test(lower)) {
      return buildCommandOutcome(
        'brightness_up',
        {},
        lang === 'hi-IN' ? 'Brightness badha raha hoon.' : 'Increasing brightness.',
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
  }

  // 6. SETTINGS INTENTS (Wi-Fi, Bluetooth, Battery, Display, Main Settings)
  if (/\b(?:wi-?fi|wifi)\b|वाईफाई|वाई-फाई/i.test(lower)) {
    return buildCommandOutcome(
      'open_wifi_settings',
      {},
      lang === 'hi-IN'
        ? 'Wi-Fi settings khol raha hoon. Android security policy ke karan direct Wi-Fi toggle system panel se hota hai.'
        : 'Opening Android Wi-Fi settings panel.',
      lang,
      query,
      wakeWordDetected,
      'deterministic'
    );
  }

  if (/\b(?:bluetooth|bt)\b|ब्लूटूथ/i.test(lower)) {
    return buildCommandOutcome(
      'open_bluetooth_settings',
      {},
      lang === 'hi-IN' ? 'Bluetooth settings khol raha hoon.' : 'Opening Android Bluetooth settings.',
      lang,
      query,
      wakeWordDetected,
      'deterministic'
    );
  }

  // 7. BATTERY STATUS vs BATTERY SETTINGS
  if (/\b(?:battery|charge|charging)\b|बैटरी/i.test(lower)) {
    if (
      /\b(?:settings|setting|saver|kholo|open)\b/i.test(lower) &&
      !/\b(?:kitni|level|percent|check|status|kya|how\s+much)\b/i.test(lower)
    ) {
      return buildCommandOutcome(
        'open_battery_settings',
        {},
        lang === 'hi-IN' ? 'Battery settings khol raha hoon.' : 'Opening battery settings.',
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
    return buildCommandOutcome(
      'get_battery_status',
      {},
      lang === 'hi-IN' ? 'Battery status check kar raha hoon.' : 'Checking battery status.',
      lang,
      query,
      wakeWordDetected,
      'deterministic'
    );
  }

  // 8. CURRENT TIME
  if (
    /\b(?:time|samay|waqt|clock)\b|टाइम|समय|वक्त|कितने\s+बजे/i.test(lower) &&
    !/\b(?:alarm|set|timer)\b/i.test(lower)
  ) {
    return buildCommandOutcome(
      'get_current_time',
      {},
      lang === 'hi-IN' ? 'Abhi ka time check kar raha hoon.' : 'Checking the current time.',
      lang,
      query,
      wakeWordDetected,
      'deterministic'
    );
  }

  // 9. ALARM HELPER / SET ALARM
  if (/\b(?:alarm|alarms|wake\s+me)\b|अलार्म/i.test(lower)) {
    const parsedTime = parseTimeForAlarm(lower);
    if (typeof parsedTime.hour === 'number') {
      const displayHr = parsedTime.hour % 12 || 12;
      const amPm = parsedTime.hour >= 12 ? 'PM' : 'AM';
      const displayMin = String(parsedTime.minute || 0).padStart(2, '0');
      return buildCommandOutcome(
        'set_alarm',
        parsedTime,
        lang === 'hi-IN'
          ? `${displayHr}:${displayMin} ${amPm} ka alarm set karne ke liye Clock open kar raha hoon.`
          : `Opening Android Clock to set an alarm for ${displayHr}:${displayMin} ${amPm}.`,
        lang,
        query,
        wakeWordDetected,
        'deterministic'
      );
    }
    return buildCommandOutcome(
      'open_alarms',
      {},
      lang === 'hi-IN'
        ? 'Alarm set karne ke liye aapka Clock Alarms screen open kar raha hoon.'
        : 'Opening your Clock app alarms so you can set an alarm.',
      lang,
      query,
      wakeWordDetected,
      'deterministic'
    );
  }

  // 10. GENERAL SETTINGS
  if (/\b(?:display\s+settings|screen\s+settings)\b/i.test(lower)) {
    return buildCommandOutcome(
      'open_display_settings',
      {},
      lang === 'hi-IN' ? 'Display settings khol raha hoon.' : 'Opening display settings.',
      lang,
      query,
      wakeWordDetected,
      'deterministic'
    );
  }

  if (
    (/\b(?:settings|setting)\b|सेटिंग्स|सेटिंग/i.test(lower) &&
      /\b(?:open|kholo|launch|show|chalao)\b|खोलो/i.test(lower)) ||
    lower === 'settings' ||
    lower === 'open settings' ||
    lower === 'settings kholo'
  ) {
    return buildCommandOutcome(
      'open_system_settings',
      {},
      lang === 'hi-IN' ? 'Device settings open kar raha hoon.' : 'Opening device settings.',
      lang,
      query,
      wakeWordDetected,
      'deterministic'
    );
  }

  return null;
}
