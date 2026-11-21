import { Capacitor, registerPlugin } from '@capacitor/core';

export interface UltronDeviceControlPluginInterface {
  getCapabilities(): Promise<{
    platform: string;
    sdkInt: number;
    hasFlash: boolean;
    speechRecognitionAvailable: boolean;
    onDeviceSpeechAvailable?: boolean;
    canWriteSystemSettings: boolean;
    ttsReady: boolean;
    isTorchOn: boolean;
  }>;
  getPermissionStatus(): Promise<{
    microphone: string;
    notifications: string;
    canWriteSystemSettings: boolean;
  }>;
  requestAssistantPermissions(): Promise<{
    microphone: string;
    notifications: string;
    canWriteSystemSettings: boolean;
    micState?: string;
  }>;
  executeDeviceCommand(options: {
    commandId: string;
    params?: Record<string, unknown>;
    userConfirmed?: boolean;
  }): Promise<{
    success: boolean;
    message?: string;
    isTorchOn?: boolean;
    volumePercent?: number;
    brightnessPercent?: number;
    scope?: string;
    needsWriteSettings?: boolean;
    batteryPercent?: number;
    isCharging?: boolean;
    time?: string;
    date?: string;
  }>;
  startSingleVoiceRecognition(options: { lang?: string }): Promise<{ started: boolean }>;
  stopSingleVoiceRecognition(): Promise<void>;
  speakNative(options: { text: string; lang?: string; rate?: number; pitch?: number }): Promise<{ spoken: boolean }>;
  stopSpeakingNative(): Promise<void>;
  setAssistantSpeaking(options: { speaking: boolean }): Promise<void>;
  startBackgroundAssistant(options: {
    wakeWord?: string;
    lang?: string;
    wakeWordEnabled?: boolean;
  }): Promise<{ running: boolean; status: string; wakeWord?: string }>;
  updateBackgroundAssistant(options: {
    wakeWord?: string;
    lang?: string;
    wakeWordEnabled?: boolean;
  }): Promise<{ running: boolean; status: string; wakeWord?: string }>;
  stopBackgroundAssistant(): Promise<{ running: boolean; status: string }>;
  getAssistantServiceStatus(): Promise<{
    running: boolean;
    status: string;
    wakeWord?: string;
    wakeWordEnabled?: boolean;
    commandArmed?: boolean;
  }>;
  addListener(
    eventName: 'ultronVoiceEvent',
    listenerFunc: (event: {
      type?: string;
      status?: string;
      text?: string;
      running?: boolean;
      commandArmed?: boolean;
      wakeDetected?: boolean;
      errorCode?: number;
    }) => void
  ): Promise<{ remove: () => Promise<void> }>;
}

export const UltronDeviceControl = registerPlugin<UltronDeviceControlPluginInterface>('UltronDeviceControl');

// Speech Synthesis & Recognition Helper with Android Capacitor Native Bridge + Web Fallback
let currentUtterance: SpeechSynthesisUtterance | null = null;
let currentAudioFallback: HTMLAudioElement | null = null;
let recognitionInstance: any = null;
let nativeSingleSttHandle: { remove: () => Promise<void> } | null = null;
let nativeTtsActive = false;
let webTtsActive = false;
let isSingleListeningActive = false;
let singleListeningEpoch = 0;

// Ensure voices are loaded ahead of time
let cachedVoices: SpeechSynthesisVoice[] = [];

function loadVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  cachedVoices = window.speechSynthesis.getVoices();
  return cachedVoices;
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  loadVoices();
  if (window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }

  const unlockSpeech = () => {
    try {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.resume();
      }
    } catch {}
  };
  window.addEventListener('click', unlockSpeech, { once: true });
  window.addEventListener('touchstart', unlockSpeech, { once: true });
}

export function unlockAudio(): void {
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.resume();
    }
  } catch {}
}

export function cleanTextForSpeech(text: string): string {
  let cleanText = (text || '')
    .replace(/THOUGHT:[\s\S]*?(?=ACTION:|$)/gi, '')
    .replace(/ACTION:\w+\(.*?\)/gi, '')
    .replace(/\[Tool.*?\]/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`#@$%^&()=+[\]{}|\\/<>]/g, ' ')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleanText.length > 320) {
    cleanText = cleanText.substring(0, 320) + '...';
  }
  return cleanText;
}

export function getBestMaleVoice(voiceLang: 'hi-IN' | 'en-US' = 'hi-IN'): SpeechSynthesisVoice | null {
  const voices = cachedVoices.length > 0 ? cachedVoices : loadVoices();
  if (!voices || voices.length === 0) return null;

  const femaleKeywords = [
    'female', '#female', '-fem', 'woman', 'girl', 'zira', 'lekha', 'veena', 'swara',
    'kalpana', 'neerja', 'sangeeta', 'ananya', 'samantha', 'karen', 'victoria',
    'moira', 'fiona', 'tessa', 'hazel', 'susan', 'heera', 'yuri', 'kyoko', 'kanya',
    'cfl', 'cfh', 'female_1', 'female_2'
  ];

  const maleKeywords = [
    'male', '#male', '-male', 'david', 'mark', 'george', 'james', 'guy', 'daniel',
    'alex', 'aaron', 'oliver', 'fred', 'hemant', 'ravi', 'rishi', 'karan', 'madhav',
    'deep', 'madhur', 'prabhat', 'hid', 'hie', 'male_1', 'male_2'
  ];

  const isFemale = (v: SpeechSynthesisVoice) => femaleKeywords.some((kw) => v.name.toLowerCase().includes(kw));
  const isMale = (v: SpeechSynthesisVoice) => maleKeywords.some((kw) => v.name.toLowerCase().includes(kw));

  if (voiceLang === 'en-US') {
    const enMale = voices.find((v) => v.lang.toLowerCase().startsWith('en') && !isFemale(v) && isMale(v));
    if (enMale) return enMale;
    const nonFemaleEn = voices.find((v) => v.lang.toLowerCase().startsWith('en') && !isFemale(v));
    if (nonFemaleEn) return nonFemaleEn;
    const anyEn = voices.find((v) => v.lang.toLowerCase().startsWith('en'));
    if (anyEn) return anyEn;
  } else {
    const hiMale = voices.find(
      (v) =>
        (v.lang.toLowerCase().includes('hi') || v.lang.toLowerCase().includes('in')) &&
        !isFemale(v) &&
        isMale(v)
    );
    if (hiMale) return hiMale;

    const nonFemaleHi = voices.find(
      (v) =>
        (v.lang.toLowerCase().includes('hi') || v.name.toLowerCase().includes('hindi') || v.name.includes('हिन्दी')) &&
        !isFemale(v)
    );
    if (nonFemaleHi) return nonFemaleHi;

    const anyHi = voices.find(
      (v) =>
        v.lang === 'hi-IN' ||
        v.lang === 'hi_IN' ||
        v.name.toLowerCase().includes('hindi') ||
        v.name.includes('हिन्दी')
    );
    if (anyHi) return anyHi;
  }

  return voices.find((v) => isMale(v)) || voices.find((v) => !isFemale(v)) || voices[0] || null;
}

export function speakText(
  text: string,
  onStart?: () => void,
  onEnd?: () => void,
  voiceLang: 'hi-IN' | 'en-US' = 'hi-IN',
  speechRate: number = 1.0,
  speechPitch: number = 0.50
): void {
  stopSpeaking();
  unlockAudio();

  const cleanText = cleanTextForSpeech(text);
  if (!cleanText || cleanText.length < 2) {
    onEnd?.();
    return;
  }

  // On Capacitor Android native, prefer Android TextToSpeech first for reliable Hindi/English playback
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    let listenerHandle: { remove: () => Promise<void> } | null = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      nativeTtsActive = false;
      listenerHandle?.remove().catch(() => {});
      onEnd?.();
    };

    UltronDeviceControl.addListener('ultronVoiceEvent', (ev) => {
      if (ev.type === 'tts_start') {
        nativeTtsActive = true;
        onStart?.();
      } else if (ev.type === 'tts_end') {
        finish();
      }
    })
      .then((h) => {
        listenerHandle = h;
        return UltronDeviceControl.speakNative({
          text: cleanText,
          lang: voiceLang,
          rate: Math.max(0.75, Math.min(1.4, speechRate)),
          pitch: Math.max(0.55, Math.min(0.95, speechPitch + 0.15))
        });
      })
      .then((res) => {
        if (!res?.spoken) {
          listenerHandle?.remove().catch(() => {});
          speakWithWebOrAudio(cleanText, onStart, onEnd, voiceLang, speechRate, speechPitch);
        } else {
          // Safety timer if TTS callback never arrives
          setTimeout(() => {
            if (!finished) finish();
          }, Math.max(6000, cleanText.length * 95));
        }
      })
      .catch(() => {
        listenerHandle?.remove().catch(() => {});
        speakWithWebOrAudio(cleanText, onStart, onEnd, voiceLang, speechRate, speechPitch);
      });
    return;
  }

  speakWithWebOrAudio(cleanText, onStart, onEnd, voiceLang, speechRate, speechPitch);
}

function notifyNativeSpeakingState(speaking: boolean): void {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    UltronDeviceControl.setAssistantSpeaking({ speaking }).catch(() => {});
  }
}

function speakWithWebOrAudio(
  cleanText: string,
  onStart?: () => void,
  onEnd?: () => void,
  voiceLang: 'hi-IN' | 'en-US' = 'hi-IN',
  speechRate: number = 1.0,
  speechPitch: number = 0.50
): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();

      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.lang = voiceLang;
      utterance.rate = Math.max(0.7, Math.min(1.4, 0.88 * speechRate));
      utterance.pitch = Math.max(0.35, Math.min(0.9, speechPitch));

      const voice = getBestMaleVoice(voiceLang);
      if (voice) {
        utterance.voice = voice;
      }

      let hasEnded = false;

      utterance.onstart = () => {
        webTtsActive = true;
        notifyNativeSpeakingState(true);
        onStart?.();
      };

      utterance.onend = () => {
        if (!hasEnded) {
          hasEnded = true;
          webTtsActive = false;
          currentUtterance = null;
          notifyNativeSpeakingState(false);
          onEnd?.();
        }
      };

      utterance.onerror = () => {
        if (!hasEnded) {
          hasEnded = true;
          webTtsActive = false;
          currentUtterance = null;
          notifyNativeSpeakingState(false);
          playAudioFallback(cleanText, onStart, onEnd, voiceLang);
        }
      };

      currentUtterance = utterance;
      webTtsActive = true;
      notifyNativeSpeakingState(true);
      window.speechSynthesis.speak(utterance);
      window.speechSynthesis.resume();

      setTimeout(() => {
        if ('speechSynthesis' in window && window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      }, 200);

      return;
    } catch (e) {
      webTtsActive = false;
      notifyNativeSpeakingState(false);
      console.warn('Web Speech API failed, using audio fallback...', e);
    }
  }

  playAudioFallback(cleanText, onStart, onEnd, voiceLang);
}

function playAudioFallback(
  cleanText: string,
  onStart?: () => void,
  onEnd?: () => void,
  voiceLang: 'hi-IN' | 'en-US' = 'hi-IN'
): void {
  try {
    const encodedText = encodeURIComponent(cleanText.substring(0, 200));
    const langCode = voiceLang === 'en-US' ? 'en' : 'hi';
    const audioUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${langCode}&client=tw-ob&q=${encodedText}`;

    if (currentAudioFallback) {
      currentAudioFallback.pause();
      currentAudioFallback = null;
    }

    const audio = new Audio(audioUrl);
    try {
      (audio as any).preservesPitch = false;
      (audio as any).mozPreservesPitch = false;
      (audio as any).webkitPreservesPitch = false;
    } catch {}
    audio.playbackRate = 0.86;
    currentAudioFallback = audio;

    audio.onplay = () => {
      webTtsActive = true;
      notifyNativeSpeakingState(true);
      onStart?.();
    };
    audio.onended = () => {
      webTtsActive = false;
      currentAudioFallback = null;
      notifyNativeSpeakingState(false);
      onEnd?.();
    };
    audio.onerror = () => {
      webTtsActive = false;
      currentAudioFallback = null;
      notifyNativeSpeakingState(false);
      onEnd?.();
    };

    audio.play().catch(() => {
      webTtsActive = false;
      notifyNativeSpeakingState(false);
      onEnd?.();
    });
  } catch {
    webTtsActive = false;
    notifyNativeSpeakingState(false);
    onEnd?.();
  }
}

export function stopSpeaking(): void {
  nativeTtsActive = false;
  webTtsActive = false;
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    UltronDeviceControl.stopSpeakingNative().catch(() => {});
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
  if (currentAudioFallback) {
    try {
      currentAudioFallback.pause();
      currentAudioFallback = null;
    } catch {}
  }
  currentUtterance = null;
}

export function pauseSpeaking(): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
        window.speechSynthesis.pause();
      }
    } catch {}
  }
  if (currentAudioFallback && !currentAudioFallback.paused) {
    try {
      currentAudioFallback.pause();
    } catch {}
  }
}

export function resumeSpeaking(): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    } catch {}
  }
  if (currentAudioFallback && currentAudioFallback.paused) {
    try {
      currentAudioFallback.play().catch(() => {});
    } catch {}
  }
}

export function isSpeechPaused(): boolean {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    return window.speechSynthesis.paused;
  }
  if (currentAudioFallback) {
    return currentAudioFallback.paused;
  }
  return false;
}

export function isSpeakingNow(): boolean {
  if (nativeTtsActive || webTtsActive) return true;
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    if (window.speechSynthesis.speaking) return true;
  }
  if (currentAudioFallback && !currentAudioFallback.paused) {
    return true;
  }
  return false;
}

export function isSingleVoiceListening(): boolean {
  return isSingleListeningActive;
}

export function startListening(
  onResult: (text: string) => void,
  onError?: (err: string) => void,
  onEnd?: () => void,
  lang: string = 'hi-IN'
): () => void {
  // Always tear down any existing recognition session first to prevent duplicate mic streams
  stopListening();
  stopSpeaking();

  const myEpoch = ++singleListeningEpoch;
  isSingleListeningActive = true;

  // Prefer native Android SpeechRecognizer on Capacitor Android
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    let active = true;
    const cleanupNative = () => {
      active = false;
      if (singleListeningEpoch === myEpoch) {
        isSingleListeningActive = false;
      }
      nativeSingleSttHandle?.remove().catch(() => {});
      nativeSingleSttHandle = null;
    };

    UltronDeviceControl.addListener('ultronVoiceEvent', (ev) => {
      if (!active || singleListeningEpoch !== myEpoch) return;
      if (ev.type === 'single_stt_result') {
        cleanupNative();
        if (ev.text && ev.text.trim()) {
          onResult(ev.text.trim());
        } else {
          onEnd?.();
        }
      } else if (ev.type === 'single_stt_error') {
        cleanupNative();
        onError?.(ev.text || 'Speech recognition failed.');
      } else if (ev.type === 'ptt_paused_background') {
        cleanupNative();
        onEnd?.();
      }
    })
      .then((handle) => {
        if (!active || singleListeningEpoch !== myEpoch) {
          handle.remove().catch(() => {});
          return;
        }
        nativeSingleSttHandle = handle;
        return UltronDeviceControl.startSingleVoiceRecognition({ lang });
      })
      .catch((err) => {
        if (!active) return;
        cleanupNative();
        onError?.(err?.message || 'Microphone permission or speech recognizer unavailable.');
      });

    return () => {
      if (singleListeningEpoch === myEpoch) {
        cleanupNative();
        UltronDeviceControl.stopSingleVoiceRecognition().catch(() => {});
      }
    };
  }

  const SpeechRecognition =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : null;

  if (!SpeechRecognition) {
    isSingleListeningActive = false;
    onError?.('Speech Recognition API is not supported in this browser. You can still type commands below.');
    return () => {};
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = lang;

  recognition.onresult = (event: any) => {
    if (singleListeningEpoch !== myEpoch || isSpeakingNow()) return;
    isSingleListeningActive = false;
    recognitionInstance = null;
    const transcript = event.results?.[0]?.[0]?.transcript;
    if (transcript) {
      onResult(transcript);
    } else {
      onEnd?.();
    }
  };

  recognition.onerror = (event: any) => {
    if (singleListeningEpoch !== myEpoch) return;
    isSingleListeningActive = false;
    recognitionInstance = null;
    const errorType = event.error || '';
    if (errorType === 'aborted') {
      onEnd?.();
      return;
    }
    if (errorType === 'not-allowed' || errorType === 'service-not-allowed') {
      onError?.('Microphone permission was denied. Please allow microphone access in your browser settings.');
    } else if (errorType === 'no-speech') {
      onEnd?.();
    } else if (errorType === 'network') {
      onError?.('Network error during speech recognition. Please check your connection.');
    } else {
      onError?.(`Speech recognition error: ${errorType}`);
    }
  };

  recognition.onend = () => {
    if (singleListeningEpoch === myEpoch) {
      isSingleListeningActive = false;
      recognitionInstance = null;
      onEnd?.();
    }
  };

  recognitionInstance = recognition;

  try {
    recognition.start();
  } catch (err: any) {
    isSingleListeningActive = false;
    recognitionInstance = null;
    onError?.(err?.message || 'Failed to start microphone');
  }

  return () => {
    if (singleListeningEpoch === myEpoch) {
      stopListening();
    }
  };
}

export function stopListening(): void {
  singleListeningEpoch++;
  isSingleListeningActive = false;
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    nativeSingleSttHandle?.remove().catch(() => {});
    nativeSingleSttHandle = null;
    UltronDeviceControl.stopSingleVoiceRecognition().catch(() => {});
  }
  if (recognitionInstance) {
    try {
      recognitionInstance.onresult = null;
      recognitionInstance.onerror = null;
      recognitionInstance.onend = null;
      recognitionInstance.stop();
      recognitionInstance.abort();
    } catch {}
    recognitionInstance = null;
  }
}

export function startInterruptListening(
  _onUserInterrupted: (text: string) => void,
  _lang: string = 'hi-IN'
): () => void {
  return () => {};
}
