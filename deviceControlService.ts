import { Capacitor } from '@capacitor/core';
import {
  ALLOWLISTED_COMMAND_REGISTRY,
  AllowlistedCommandId,
  DeviceCommandParams,
  ParsedAssistantCommand,
  detectLanguagePreference,
  isAllowlistedCommandId,
  matchDeterministicCommand,
  sanitizeDeviceParams,
  stripWakeWordFromUtterance
} from './deviceCommands';
import {
  UltronDeviceControl,
  isSingleVoiceListening,
  isSpeakingNow,
  speakText,
  stopSpeaking,
  startListening as startSpeechListening,
  stopListening as stopSpeechListening,
  unlockAudio
} from '../utils/speech';

export type AssistantOrbStatus =
  | 'idle'
  | 'listening'
  | 'wake_listening'
  | 'wake_armed'
  | 'processing'
  | 'speaking'
  | 'paused_os_limit'
  | 'recognizer_unavailable'
  | 'os_restricted'
  | 'permission_denied';

export interface RecentVoiceCommand {
  id: string;
  input: string;
  reply: string;
  commandId: AllowlistedCommandId | null;
  status: 'executed' | 'pending_confirmation' | 'cancelled' | 'blocked' | 'chat_reply' | 'unsupported_web';
  timestamp: string;
  details?: string;
}

export interface PendingSensitiveAction {
  commandId: AllowlistedCommandId;
  params: DeviceCommandParams;
  originalInput: string;
  reason: string;
  speechLang: 'hi-IN' | 'en-US';
}

export interface DeviceControlSnapshot {
  isNativeAndroid: boolean;
  micPermission: 'granted' | 'prompt' | 'denied' | 'unknown';
  notificationPermission: 'granted' | 'prompt' | 'denied' | 'unknown';
  canWriteSystemSettings: boolean;
  hasFlash: boolean;
  speechRecognitionAvailable: boolean;
  onDeviceSpeechAvailable: boolean;
  isTorchOn: boolean;
  orbStatus: AssistantOrbStatus;
  wakeWordArmed: boolean;
  backgroundServiceRunning: boolean;
  backgroundEnabled: boolean;
  wakeWordEnabled: boolean;
  wakeWordPhrase: string;
  voiceLang: 'hi-IN' | 'en-US';
  speechRate: number;
  speechPitch: number;
  lastTranscript: string;
  lastReply: string;
  lastError: string | null;
  pendingConfirmation: PendingSensitiveAction | null;
  recentCommands: RecentVoiceCommand[];
}

const RECENT_STORAGE_KEY = 'ultron_recent_voice_commands_v1';

class DeviceControlManager {
  private listeners = new Set<() => void>();
  private stopSingleCapture: (() => void) | null = null;
  private nativeEventHandle: { remove: () => Promise<void> } | null = null;
  private initialized = false;
  private customApiKey = '';
  private lastSpeakingEndedAtMs = 0;
  private backgroundArmed = false;

  private state: DeviceControlSnapshot = {
    isNativeAndroid: Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android',
    micPermission: 'unknown',
    notificationPermission: 'unknown',
    canWriteSystemSettings: false,
    hasFlash: false,
    speechRecognitionAvailable: false,
    onDeviceSpeechAvailable: false,
    isTorchOn: false,
    orbStatus: 'idle',
    wakeWordArmed: false,
    backgroundServiceRunning: false,
    backgroundEnabled: false,
    wakeWordEnabled: true,
    wakeWordPhrase: 'Hey Ultron',
    voiceLang: 'hi-IN',
    speechRate: 1.0,
    speechPitch: 0.5,
    lastTranscript: '',
    lastReply: '',
    lastError: null,
    pendingConfirmation: null,
    recentCommands: this.loadRecentCommands()
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): DeviceControlSnapshot => this.state;

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private patch(partial: Partial<DeviceControlSnapshot>) {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private loadRecentCommands(): RecentVoiceCommand[] {
    try {
      const raw = localStorage.getItem(RECENT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.slice(0, 25);
      }
    } catch {}
    return [];
  }

  private pushRecentCommand(entry: Omit<RecentVoiceCommand, 'id' | 'timestamp'>) {
    const item: RecentVoiceCommand = {
      ...entry,
      id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    const next = [item, ...this.state.recentCommands].slice(0, 25);
    try {
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
    } catch {}
    this.patch({ recentCommands: next });
  }

  clearRecentCommands() {
    try {
      localStorage.removeItem(RECENT_STORAGE_KEY);
    } catch {}
    this.patch({ recentCommands: [] });
  }

  syncPreferences(opts: {
    voiceLang: 'hi-IN' | 'en-US';
    speechRate: number;
    speechPitch: number;
    wakeWordEnabled?: boolean;
    wakeWordPhrase?: string;
    backgroundListeningEnabled?: boolean;
    apiKey?: string;
  }) {
    if (typeof opts.apiKey === 'string') {
      this.customApiKey = opts.apiKey;
    }
    const nextWake = typeof opts.wakeWordEnabled === 'boolean' ? opts.wakeWordEnabled : this.state.wakeWordEnabled;
    const nextPhrase =
      typeof opts.wakeWordPhrase === 'string' && opts.wakeWordPhrase.trim()
        ? opts.wakeWordPhrase.trim()
        : this.state.wakeWordPhrase;
    const nextBg =
      typeof opts.backgroundListeningEnabled === 'boolean'
        ? opts.backgroundListeningEnabled
        : this.state.backgroundEnabled;

    const wakeConfigChanged =
      nextWake !== this.state.wakeWordEnabled ||
      nextPhrase !== this.state.wakeWordPhrase ||
      opts.voiceLang !== this.state.voiceLang;

    if (
      opts.voiceLang !== this.state.voiceLang ||
      opts.speechRate !== this.state.speechRate ||
      opts.speechPitch !== this.state.speechPitch ||
      nextWake !== this.state.wakeWordEnabled ||
      nextPhrase !== this.state.wakeWordPhrase ||
      nextBg !== this.state.backgroundEnabled
    ) {
      this.patch({
        voiceLang: opts.voiceLang,
        speechRate: opts.speechRate,
        speechPitch: opts.speechPitch,
        wakeWordEnabled: nextWake,
        wakeWordPhrase: nextPhrase,
        backgroundEnabled: nextBg
      });
    }

    if (wakeConfigChanged && this.state.isNativeAndroid && this.state.backgroundServiceRunning) {
      UltronDeviceControl.updateBackgroundAssistant({
        wakeWord: nextPhrase,
        lang: opts.voiceLang,
        wakeWordEnabled: nextWake
      }).catch(() => {});
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      await this.refreshHardwareAndPermissions();
      return;
    }
    this.initialized = true;

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          if (this.state.orbStatus === 'listening') {
            this.stopPushToTalk();
          }
        } else {
          void this.refreshHardwareAndPermissions();
        }
      });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => {
        void this.refreshHardwareAndPermissions();
      });
    }

    if (this.state.isNativeAndroid) {
      try {
        this.nativeEventHandle = await UltronDeviceControl.addListener('ultronVoiceEvent', (ev) => {
          if (ev.type === 'wake_detected') {
            if (this.state.orbStatus === 'speaking' || isSpeakingNow()) return;
            this.backgroundArmed = true;
            this.patch({
              orbStatus: 'wake_armed',
              wakeWordArmed: true,
              lastTranscript: ev.text || this.state.wakeWordPhrase,
              lastError: null
            });
          } else if (ev.type === 'transcript' && ev.text) {
            void this.handleBackgroundTranscript(ev.text, Boolean(ev.wakeDetected));
          } else if (ev.type === 'status' || ev.type === 'state_sync') {
            const st = (ev.status || 'idle') as AssistantOrbStatus;
            const armed = Boolean(ev.commandArmed);
            if (!armed) this.backgroundArmed = false;
            const isSpeakingOrBusy = this.state.orbStatus === 'speaking' || this.state.orbStatus === 'processing' || this.state.orbStatus === 'listening';
            this.patch({
              ...(isSpeakingOrBusy ? {} : { orbStatus: ev.running ? st : 'idle' }),
              wakeWordArmed: armed,
              backgroundServiceRunning: Boolean(ev.running),
              backgroundEnabled: Boolean(ev.running),
              lastError: ev.text || null
            });
          } else if (ev.type === 'ptt_paused_background') {
            this.stopSingleCapture = null;
            this.patch({
              orbStatus: this.state.backgroundServiceRunning
                ? this.state.wakeWordEnabled
                  ? 'wake_listening'
                  : 'listening'
                : 'idle'
            });
          } else if (ev.type === 'stopped') {
            this.backgroundArmed = false;
            this.patch({
              backgroundServiceRunning: false,
              backgroundEnabled: false,
              wakeWordArmed: false,
              orbStatus: 'idle',
              lastError: ev.text || null
            });
          } else if (ev.type === 'error') {
            this.backgroundArmed = false;
            this.patch({
              lastError: ev.text || 'Voice assistant service error.',
              backgroundServiceRunning: Boolean(ev.running),
              wakeWordArmed: false,
              orbStatus: (ev.status as AssistantOrbStatus) || 'idle'
            });
          }
        });
      } catch (err) {
        console.warn('[DeviceControl] Native listener error:', err);
      }
    }

    await this.refreshHardwareAndPermissions();
  }

  async refreshHardwareAndPermissions(): Promise<void> {
    if (!this.state.isNativeAndroid) {
      let micState: 'granted' | 'prompt' | 'denied' | 'unknown' = 'prompt';
      try {
        if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
          const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          micState = perm.state === 'granted' ? 'granted' : perm.state === 'denied' ? 'denied' : 'prompt';
        }
      } catch {}
      const speechOk =
        typeof window !== 'undefined' &&
        Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
      this.patch({
        micPermission: micState,
        speechRecognitionAvailable: speechOk,
        onDeviceSpeechAvailable: false
      });
      return;
    }

    try {
      const [caps, perms, svc] = await Promise.all([
        UltronDeviceControl.getCapabilities(),
        UltronDeviceControl.getPermissionStatus(),
        UltronDeviceControl.getAssistantServiceStatus()
      ]);

      const keepCurrentBusyOrb =
        this.state.orbStatus === 'listening' ||
        this.state.orbStatus === 'processing' ||
        this.state.orbStatus === 'speaking';

      this.patch({
        hasFlash: Boolean(caps.hasFlash),
        speechRecognitionAvailable: Boolean(caps.speechRecognitionAvailable),
        onDeviceSpeechAvailable: Boolean(caps.onDeviceSpeechAvailable),
        canWriteSystemSettings: Boolean(caps.canWriteSystemSettings),
        isTorchOn: Boolean(caps.isTorchOn),
        micPermission: perms.microphone === 'granted' ? 'granted' : 'prompt',
        notificationPermission: perms.notifications === 'granted' ? 'granted' : 'prompt',
        backgroundServiceRunning: Boolean(svc.running),
        backgroundEnabled: Boolean(svc.running),
        wakeWordArmed: Boolean(svc.commandArmed),
        ...(keepCurrentBusyOrb
          ? {}
          : {
              orbStatus: svc.running ? ((svc.status as AssistantOrbStatus) || 'wake_listening') : 'idle'
            })
      });
    } catch (err: any) {
      this.patch({ lastError: err?.message || 'Unable to inspect Android capabilities.' });
    }
  }

  async requestPermissions(): Promise<boolean> {
    if (!this.state.isNativeAndroid) {
      try {
        if (navigator.mediaDevices?.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
          this.patch({ micPermission: 'granted', lastError: null });
          return true;
        }
      } catch {
        this.patch({
          micPermission: 'denied',
          lastError: 'Microphone permission denied in browser.'
        });
        return false;
      }
      return false;
    }

    try {
      const res = await UltronDeviceControl.requestAssistantPermissions();
      const granted = res.microphone === 'granted';
      this.patch({
        micPermission: granted ? 'granted' : 'denied',
        notificationPermission: res.notifications === 'granted' ? 'granted' : 'prompt',
        canWriteSystemSettings: Boolean(res.canWriteSystemSettings),
        lastError: granted ? null : 'Microphone permission is required for voice commands.'
      });
      return granted;
    } catch (err: any) {
      this.patch({ lastError: err?.message || 'Failed to request permissions.' });
      return false;
    }
  }

  async toggleBackgroundAssistant(enable: boolean): Promise<void> {
    if (!enable) {
      if (this.state.isNativeAndroid) {
        await UltronDeviceControl.stopBackgroundAssistant().catch(() => {});
      }
      this.patch({
        backgroundEnabled: false,
        backgroundServiceRunning: false,
        orbStatus: 'idle',
        lastError: null
      });
      return;
    }

    if (!this.state.isNativeAndroid) {
      this.patch({
        backgroundEnabled: false,
        backgroundServiceRunning: false,
        lastError:
          'Android background foreground microphone service requires the installed Ultron Android APK. Use Push-to-Talk in browser preview.'
      });
      return;
    }

    if (this.state.micPermission !== 'granted') {
      const ok = await this.requestPermissions();
      if (!ok) return;
    }

    try {
      const res = await UltronDeviceControl.startBackgroundAssistant({
        wakeWord: this.state.wakeWordPhrase,
        lang: this.state.voiceLang,
        wakeWordEnabled: this.state.wakeWordEnabled
      });
      this.patch({
        backgroundEnabled: Boolean(res.running),
        backgroundServiceRunning: Boolean(res.running),
        orbStatus: (res.status as AssistantOrbStatus) || 'wake_listening',
        lastError: null
      });
    } catch (err: any) {
      this.patch({
        backgroundEnabled: false,
        backgroundServiceRunning: false,
        orbStatus: 'os_restricted',
        lastError: err?.message || 'Failed to start Android background voice service.'
      });
    }
  }

  private getIdleOrWakeOrbStatus(): AssistantOrbStatus {
    if (!this.state.backgroundServiceRunning) return 'idle';
    return this.state.wakeWordEnabled ? 'wake_listening' : 'listening';
  }

  private async handleBackgroundTranscript(rawTranscript: string, nativeWakeConfirmed = false): Promise<void> {
    // Intelligent Activation: Ignore background wake-word transcripts while Ultron is speaking or cooling down
    if (this.state.orbStatus === 'speaking' || isSpeakingNow() || Date.now() - this.lastSpeakingEndedAtMs < 850) {
      return;
    }
    if (this.state.orbStatus === 'listening') {
      // Prevent duplicate processing when Push-to-Talk is explicitly capturing
      return;
    }

    const { wakeWordDetected, cleanedCommand } = stripWakeWordFromUtterance(
      rawTranscript,
      this.state.wakeWordPhrase
    );

    if (this.state.wakeWordEnabled && !wakeWordDetected && !nativeWakeConfirmed && !this.backgroundArmed) {
      return;
    }

    if (wakeWordDetected && !cleanedCommand) {
      this.backgroundArmed = true;
      this.patch({
        orbStatus: 'wake_armed',
        wakeWordArmed: true,
        lastTranscript: rawTranscript,
        lastError: null
      });
      return;
    }

    this.backgroundArmed = false;
    this.patch({ wakeWordArmed: false });
    const targetText = cleanedCommand || rawTranscript;
    if (!targetText.trim()) return;
    await this.processCommandText(rawTranscript);
  }

  startPushToTalk(): void {
    // Prevent duplicate microphone sessions: toggling while listening stops capture cleanly
    if (this.state.orbStatus === 'listening' || isSingleVoiceListening()) {
      this.stopPushToTalk();
      return;
    }

    unlockAudio();
    this.interruptSpeaking();
    this.backgroundArmed = false;
    this.patch({ lastError: null, orbStatus: 'listening', wakeWordArmed: false });

    this.stopSingleCapture = startSpeechListening(
      (transcript) => {
        this.stopSingleCapture = null;
        this.patch({ lastTranscript: transcript });
        void this.processCommandText(transcript);
      },
      (err) => {
        this.stopSingleCapture = null;
        this.patch({
          orbStatus: this.getIdleOrWakeOrbStatus(),
          lastError: err
        });
      },
      () => {
        this.stopSingleCapture = null;
        if (this.state.orbStatus === 'listening') {
          this.patch({
            orbStatus: this.getIdleOrWakeOrbStatus()
          });
        }
      },
      this.state.voiceLang
    );
  }

  stopPushToTalk(): void {
    this.stopSingleCapture?.();
    this.stopSingleCapture = null;
    stopSpeechListening();
    this.patch({
      orbStatus: this.getIdleOrWakeOrbStatus()
    });
  }

  interruptSpeaking(): void {
    stopSpeaking();
    this.lastSpeakingEndedAtMs = Date.now();
    if (this.state.orbStatus === 'speaking') {
      this.patch({
        orbStatus: this.getIdleOrWakeOrbStatus()
      });
    }
  }

  speakReply(text: string, lang: 'hi-IN' | 'en-US' = this.state.voiceLang): void {
    if (!text.trim()) return;
    speakText(
      text,
      () => {
        this.patch({ orbStatus: 'speaking' });
      },
      () => {
        this.lastSpeakingEndedAtMs = Date.now();
        if (this.state.orbStatus === 'speaking') {
          this.patch({
            orbStatus: this.getIdleOrWakeOrbStatus()
          });
        }
      },
      lang,
      this.state.speechRate,
      this.state.speechPitch
    );
  }

  async processCommandText(rawText: string): Promise<ParsedAssistantCommand | null> {
    const trimmed = (rawText || '').trim();
    if (!trimmed) return null;

    this.interruptSpeaking();
    this.backgroundArmed = false;
    this.patch({
      lastTranscript: trimmed,
      orbStatus: 'processing',
      wakeWordArmed: false,
      lastError: null
    });

    // Step 1: Instant local deterministic match (works 100% offline inside Android APK too)
    const localMatch = matchDeterministicCommand(trimmed, {
      wakePhrase: this.state.wakeWordPhrase,
      defaultLang: this.state.voiceLang
    });
    if (localMatch && localMatch.commandId !== null) {
      return await this.applyParsedCommand(trimmed, localMatch);
    }
    if (localMatch && localMatch.kind === 'blocked_action') {
      return await this.applyParsedCommand(trimmed, localMatch);
    }
    if (localMatch && localMatch.wakeWordDetected && !localMatch.normalizedQuery) {
      // Standalone wake word ("Hey Ultron") -> arm command capture
      this.backgroundArmed = true;
      this.patch({
        lastReply: localMatch.replyText,
        orbStatus: 'wake_armed',
        wakeWordArmed: true
      });
      return localMatch;
    }

    // Step 2: Backend Gemini NLU for natural conversational or complex requests
    try {
      const res = await fetch('/api/assistant/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmed,
          wakePhrase: this.state.wakeWordPhrase,
          voiceLang: this.state.voiceLang,
          ...(this.customApiKey ? { apiKey: this.customApiKey } : {})
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success || !data.result) {
        throw new Error(data.error || 'Could not parse assistant command.');
      }

      const parsed: ParsedAssistantCommand = data.result;
      return await this.applyParsedCommand(trimmed, parsed);
    } catch (err: any) {
      // Offline / static APK conversational fallback without crashing device control
      if (localMatch) {
        return await this.applyParsedCommand(trimmed, localMatch);
      }
      const lang = detectLanguagePreference(trimmed, this.state.voiceLang);
      const offlineReply =
        lang === 'hi-IN'
          ? 'Main offline mode mein hoon. Torch, Volume, Brightness, Wi-Fi/Bluetooth settings, Battery, Time ya Alarm commands abhi bhi directly chalenge.'
          : 'Backend AI is unreachable right now, but on-device commands (Torch, Volume, Brightness, Settings, Battery, Time, Alarms) still work locally.';
      this.pushRecentCommand({
        input: trimmed,
        reply: offlineReply,
        commandId: null,
        status: 'chat_reply'
      });
      this.patch({
        lastReply: offlineReply,
        lastError: err?.message || null,
        orbStatus: this.getIdleOrWakeOrbStatus()
      });
      this.speakReply(offlineReply, lang);
      return null;
    }
  }

  async applyParsedCommand(trimmed: string, parsed: ParsedAssistantCommand): Promise<ParsedAssistantCommand> {
    this.interruptSpeaking();
    this.patch({ lastTranscript: trimmed, lastError: null });

    if (parsed.kind === 'blocked_action') {
      this.pushRecentCommand({
        input: trimmed,
        reply: parsed.replyText,
        commandId: null,
        status: 'blocked'
      });
      this.patch({ lastReply: parsed.replyText, orbStatus: this.getIdleOrWakeOrbStatus() });
      this.speakReply(parsed.replyText, parsed.speechLang);
      return parsed;
    }

    if (parsed.kind === 'device_command' && parsed.commandId && isAllowlistedCommandId(parsed.commandId)) {
      if (parsed.requiresConfirmation) {
        this.patch({
          pendingConfirmation: {
            commandId: parsed.commandId,
            params: parsed.params,
            originalInput: trimmed,
            reason:
              parsed.confirmationReason || `Confirm executing "${ALLOWLISTED_COMMAND_REGISTRY[parsed.commandId].label}".`,
            speechLang: parsed.speechLang
          },
          lastReply: parsed.replyText,
          orbStatus: this.getIdleOrWakeOrbStatus()
        });
        this.speakReply(parsed.replyText, parsed.speechLang);
        return parsed;
      }

      await this.executeAllowlistedCommand(
        parsed.commandId,
        parsed.params,
        false,
        trimmed,
        parsed.replyText,
        parsed.speechLang
      );
      return parsed;
    }

    this.pushRecentCommand({
      input: trimmed,
      reply: parsed.replyText,
      commandId: null,
      status: 'chat_reply'
    });
    this.patch({ lastReply: parsed.replyText, orbStatus: this.getIdleOrWakeOrbStatus() });
    this.speakReply(parsed.replyText, parsed.speechLang);
    return parsed;
  }

  async confirmPendingAction(): Promise<void> {
    const pending = this.state.pendingConfirmation;
    if (!pending) return;
    this.patch({ pendingConfirmation: null });
    await this.executeAllowlistedCommand(
      pending.commandId,
      pending.params,
      true,
      pending.originalInput,
      undefined,
      pending.speechLang
    );
  }

  cancelPendingAction(): void {
    const pending = this.state.pendingConfirmation;
    if (!pending) return;
    const cancelText =
      pending.speechLang === 'hi-IN' ? 'Action cancel kar diya gaya hai.' : 'Sensitive action cancelled.';
    this.pushRecentCommand({
      input: pending.originalInput,
      reply: cancelText,
      commandId: pending.commandId,
      status: 'cancelled'
    });
    this.patch({
      pendingConfirmation: null,
      lastReply: cancelText
    });
    this.speakReply(cancelText, pending.speechLang);
  }

  async executeAllowlistedCommand(
    commandId: AllowlistedCommandId,
    rawParams: DeviceCommandParams = {},
    userConfirmed = false,
    originalInput?: string,
    suggestedReply?: string,
    speechLang: 'hi-IN' | 'en-US' = this.state.voiceLang
  ): Promise<void> {
    if (!isAllowlistedCommandId(commandId)) {
      this.patch({ lastError: 'Rejected non-allowlisted command.' });
      return;
    }

    const meta = ALLOWLISTED_COMMAND_REGISTRY[commandId];
    const params = sanitizeDeviceParams(commandId, rawParams as Record<string, unknown>);
    const inputLabel = originalInput || meta.hinglishExample;

    if (meta.requiresConfirmation && !userConfirmed) {
      const promptReply =
        speechLang === 'hi-IN'
          ? `${meta.label} execute karne se pehle please confirm karein.`
          : `Please confirm before executing ${meta.label}.`;
      this.patch({
        pendingConfirmation: {
          commandId,
          params,
          originalInput: inputLabel,
          reason: `Sensitive action (${meta.label}) requires your confirmation.`,
          speechLang
        },
        lastReply: promptReply
      });
      this.speakReply(promptReply, speechLang);
      return;
    }

    if (this.state.isNativeAndroid) {
      try {
        const res = await UltronDeviceControl.executeDeviceCommand({
          commandId,
          params: params as Record<string, unknown>,
          userConfirmed
        });

        let finalReply = suggestedReply || res.message || `${meta.label} executed.`;
        if (commandId === 'get_battery_status' && typeof res.batteryPercent === 'number' && res.batteryPercent >= 0) {
          finalReply =
            speechLang === 'hi-IN'
              ? `Phone ki battery ${res.batteryPercent}% hai${res.isCharging ? ' aur charge ho rahi hai' : ''}.`
              : `Your phone battery is at ${res.batteryPercent}%${res.isCharging ? ' and charging' : ''}.`;
        } else if (commandId === 'get_current_time' && res.time) {
          finalReply =
            speechLang === 'hi-IN'
              ? `Abhi ${res.time} hue hain (${res.date || ''}).`
              : `The current time is ${res.time} (${res.date || ''}).`;
        } else if (
          (commandId === 'brightness_up' || commandId === 'brightness_down' || commandId === 'brightness_set') &&
          res.scope === 'app_window' &&
          typeof res.brightnessPercent === 'number'
        ) {
          finalReply =
            speechLang === 'hi-IN'
              ? `App screen brightness ${res.brightnessPercent}% set ki hai. Global system brightness ke liye Modify System Settings permission chahiye.`
              : `App brightness set to ${res.brightnessPercent}%. Global brightness needs Android Modify System Settings permission.`;
        }

        if (typeof res.isTorchOn === 'boolean') {
          this.patch({ isTorchOn: res.isTorchOn });
        }

        this.pushRecentCommand({
          input: inputLabel,
          reply: finalReply,
          commandId,
          status: 'executed',
          details: res.message
        });
        this.patch({ lastReply: finalReply, lastError: null, orbStatus: this.getIdleOrWakeOrbStatus() });
        this.speakReply(finalReply, speechLang);
      } catch (err: any) {
        const errMsg = err?.message || `Unable to execute ${meta.label}.`;
        this.pushRecentCommand({
          input: inputLabel,
          reply: errMsg,
          commandId,
          status: 'blocked'
        });
        this.patch({ lastError: errMsg, lastReply: errMsg, orbStatus: this.getIdleOrWakeOrbStatus() });
        this.speakReply(errMsg, speechLang);
      }
      return;
    }

    // Browser / PWA safe fallback (Never pretends unsupported native hardware succeeded)
    if (commandId === 'get_current_time') {
      const now = new Date();
      const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      const reply =
        speechLang === 'hi-IN' ? `Abhi ${time} hue hain (${date}).` : `Current time is ${time} (${date}).`;
      this.pushRecentCommand({ input: inputLabel, reply, commandId, status: 'executed' });
      this.patch({ lastReply: reply, orbStatus: this.getIdleOrWakeOrbStatus() });
      this.speakReply(reply, speechLang);
      return;
    }

    if (commandId === 'get_battery_status') {
      try {
        if (typeof (navigator as any).getBattery === 'function') {
          const bat = await (navigator as any).getBattery();
          const pct = Math.round(bat.level * 100);
          const reply =
            speechLang === 'hi-IN'
              ? `Device ki battery ${pct}% hai${bat.charging ? ' aur charging par hai' : ''}.`
              : `Battery level is ${pct}%${bat.charging ? ' (charging)' : ''}.`;
          this.pushRecentCommand({ input: inputLabel, reply, commandId, status: 'executed' });
          this.patch({ lastReply: reply, orbStatus: this.getIdleOrWakeOrbStatus() });
          this.speakReply(reply, speechLang);
          return;
        }
      } catch {}
    }

    const webNotice =
      speechLang === 'hi-IN'
        ? `${meta.label} Android native control hai. Browser preview mein hardware APIs uplabdh nahi hain; yeh Ultron Android APK par real device APIs se kaam karta hai.`
        : `${meta.label} uses native Android APIs and runs on the installed Ultron Android APK (not directly available in a desktop/web browser).`;

    this.pushRecentCommand({
      input: inputLabel,
      reply: webNotice,
      commandId,
      status: 'unsupported_web'
    });
    this.patch({ lastReply: webNotice, orbStatus: this.getIdleOrWakeOrbStatus() });
    this.speakReply(webNotice, speechLang);
  }
}

export const deviceControlService = new DeviceControlManager();
