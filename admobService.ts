import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
  AdMob,
  BannerAdPluginEvents,
  BannerAdPosition,
  BannerAdSize,
  InterstitialAdPluginEvents,
  AdmobConsentStatus,
  type AdLoadInfo,
  type AdMobBannerSize,
  type AdMobError,
  type AdmobConsentInfo
} from '@capacitor-community/admob';

export interface BackendAdConfig {
  enabled: boolean;
  env: 'test' | 'production';
  isTesting: boolean;
  appId: string;
  bannerAdUnitId: string;
  testBannerAdUnitId: string;
  bannerPosition: 'bottom';
  bannerSize: 'ADAPTIVE_BANNER';
  interstitialAdUnitId: string;
  testInterstitialAdUnitId: string;
  interstitialCooldownMs: number;
  interstitialMaxPerSession: number;
}

export type BannerLifecycleStatus =
  | 'unavailable'
  | 'consent_pending'
  | 'loading'
  | 'loaded'
  | 'hidden'
  | 'error';

export type InterstitialLifecycleStatus = 'idle' | 'loading' | 'ready' | 'showing' | 'error';

export interface AdMobControllerState {
  isNative: boolean;
  status: BannerLifecycleStatus;
  bannerHeightPx: number;
  canRequestAds: boolean;
  consentStatus: AdmobConsentStatus | 'UNSUPPORTED';
  privacyOptionsRequired: boolean;
  env: 'test' | 'production';
  isTesting: boolean;
  lastError: string | null;
  interstitialStatus: InterstitialLifecycleStatus;
  interstitialShownCount: number;
}

const DEFAULT_BANNER_TEST_ID = 'ca-app-pub-3940256099942544/6300978111';
const DEFAULT_INTERSTITIAL_TEST_ID = 'ca-app-pub-3940256099942544/1033173712';
const STARTUP_GRACE_MS = 45_000;
const INTERSTITIAL_MAX_AGE_MS = 50 * 60 * 1000;
const INTERSTITIAL_SESSION_COUNT_KEY = 'ultron_interstitial_session_count';

const DEFAULT_STATE: AdMobControllerState = {
  isNative: false,
  status: 'unavailable',
  bannerHeightPx: 0,
  canRequestAds: false,
  consentStatus: 'UNSUPPORTED',
  privacyOptionsRequired: false,
  env: 'test',
  isTesting: true,
  lastError: null,
  interstitialStatus: 'idle',
  interstitialShownCount: 0
};

class AdMobController {
  private state: AdMobControllerState = { ...DEFAULT_STATE };
  private listeners = new Set<() => void>();
  private pluginHandles: PluginListenerHandle[] = [];
  private listenersBound = false;

  private configCache: BackendAdConfig | null = null;
  private configPromise: Promise<BackendAdConfig | null> | null = null;
  private initPromise: Promise<boolean> | null = null;
  private sdkInitialized = false;

  // Banner state
  private bannerCreated = false;
  private bannerVisible = false;
  private lastBannerFailedAt = 0;
  private opQueue: Promise<void> = Promise.resolve();

  private desiredShouldShow = false;
  private desiredKeyboardOpen = false;

  // Interstitial state (single-instance, preloaded, frequency-capped)
  private sessionStartedAt = Date.now();
  private authenticatedSessionStarted = false;
  private interstitialPreparePromise: Promise<boolean> | null = null;
  private interstitialShowLock = false;
  private interstitialPreparedAt = 0;
  private lastInterstitialShownAt = 0;
  private lastInterstitialFailedAt = 0;
  private interstitialFailStreak = 0;
  private transitionCounter = 0;
  private hasCompletedGenerationTask = false;
  private preloadTimerId: number | null = null;

  constructor() {
    try {
      const savedCount = Number(sessionStorage.getItem(INTERSTITIAL_SESSION_COUNT_KEY) || 0);
      if (Number.isFinite(savedCount) && savedCount > 0) {
        this.state.interstitialShownCount = savedCount;
      }
    } catch {}
  }

  public getSnapshot = (): AdMobControllerState => {
    return this.state;
  };

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(partial: Partial<AdMobControllerState>) {
    const next: AdMobControllerState = { ...this.state, ...partial };
    const changed =
      next.isNative !== this.state.isNative ||
      next.status !== this.state.status ||
      next.bannerHeightPx !== this.state.bannerHeightPx ||
      next.canRequestAds !== this.state.canRequestAds ||
      next.consentStatus !== this.state.consentStatus ||
      next.privacyOptionsRequired !== this.state.privacyOptionsRequired ||
      next.env !== this.state.env ||
      next.isTesting !== this.state.isTesting ||
      next.lastError !== this.state.lastError ||
      next.interstitialStatus !== this.state.interstitialStatus ||
      next.interstitialShownCount !== this.state.interstitialShownCount;

    if (!changed) return;
    this.state = next;
    for (const cb of this.listeners) {
      cb();
    }
  }

  public isNativeRuntime(): boolean {
    try {
      return Capacitor.isNativePlatform();
    } catch {
      return false;
    }
  }

  private isUserTypingOrFocusedInput(): boolean {
    if (typeof document === 'undefined') return false;
    const active = document.activeElement as HTMLElement | null;
    if (!active) return false;
    const tag = active.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || active.isContentEditable;
  }

  public async loadBackendConfig(forceRefresh = false): Promise<BackendAdConfig | null> {
    if (this.configCache && !forceRefresh) {
      return this.configCache;
    }
    if (this.configPromise && !forceRefresh) {
      return this.configPromise;
    }

    this.configPromise = (async () => {
      try {
        const res = await fetch('/api/ads/config', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`Ad config endpoint returned HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!data || typeof data.bannerAdUnitId !== 'string') {
          throw new Error('Invalid ad configuration payload.');
        }
        const parsed: BackendAdConfig = {
          enabled: Boolean(data.enabled),
          env: data.env === 'production' ? 'production' : 'test',
          isTesting: data.isTesting !== false,
          appId: String(data.appId || ''),
          bannerAdUnitId: String(data.bannerAdUnitId),
          testBannerAdUnitId: String(data.testBannerAdUnitId || DEFAULT_BANNER_TEST_ID),
          bannerPosition: 'bottom',
          bannerSize: 'ADAPTIVE_BANNER',
          interstitialAdUnitId: String(data.interstitialAdUnitId || DEFAULT_INTERSTITIAL_TEST_ID),
          testInterstitialAdUnitId: String(data.testInterstitialAdUnitId || DEFAULT_INTERSTITIAL_TEST_ID),
          interstitialCooldownMs:
            typeof data.interstitialCooldownMs === 'number' && data.interstitialCooldownMs >= 30_000
              ? data.interstitialCooldownMs
              : 180_000,
          interstitialMaxPerSession:
            typeof data.interstitialMaxPerSession === 'number' && data.interstitialMaxPerSession >= 1
              ? data.interstitialMaxPerSession
              : 4
        };
        this.configCache = parsed;
        this.setState({
          env: parsed.env,
          isTesting: parsed.isTesting
        });
        return parsed;
      } catch (err: any) {
        console.warn('[AdMob] Failed to fetch /api/ads/config, using safe test defaults:', err?.message || err);
        const safeTestFallback: BackendAdConfig = {
          enabled: true,
          env: 'test',
          isTesting: true,
          appId: 'ca-app-pub-9420884023594843~7696266305',
          bannerAdUnitId: DEFAULT_BANNER_TEST_ID,
          testBannerAdUnitId: DEFAULT_BANNER_TEST_ID,
          bannerPosition: 'bottom',
          bannerSize: 'ADAPTIVE_BANNER',
          interstitialAdUnitId: DEFAULT_INTERSTITIAL_TEST_ID,
          testInterstitialAdUnitId: DEFAULT_INTERSTITIAL_TEST_ID,
          interstitialCooldownMs: 180_000,
          interstitialMaxPerSession: 4
        };
        this.setState({ env: 'test', isTesting: true });
        return safeTestFallback;
      } finally {
        this.configPromise = null;
      }
    })();

    return this.configPromise;
  }

  private async bindPluginListeners(): Promise<void> {
    if (this.listenersBound) return;
    this.listenersBound = true;

    try {
      // Banner Events
      const hSize = await AdMob.addListener(BannerAdPluginEvents.SizeChanged, (info: AdMobBannerSize) => {
        const height = Math.max(0, Math.round(info?.height || 0));
        if (!this.desiredShouldShow || this.desiredKeyboardOpen || !this.bannerVisible) {
          this.setState({ bannerHeightPx: 0 });
          return;
        }
        this.setState({
          bannerHeightPx: height,
          status: height > 0 ? 'loaded' : this.state.status
        });
      });

      const hLoaded = await AdMob.addListener(BannerAdPluginEvents.Loaded, async () => {
        this.lastBannerFailedAt = 0;
        let measuredHeight = this.state.bannerHeightPx;
        try {
          const size = await AdMob.getBannerSize();
          if (size && typeof size.height === 'number' && size.height > 0) {
            measuredHeight = Math.round(size.height);
          }
        } catch {}

        if (!this.desiredShouldShow || this.desiredKeyboardOpen) {
          try {
            await AdMob.hideBanner();
          } catch {}
          this.bannerVisible = false;
          this.setState({ status: 'hidden', bannerHeightPx: 0, lastError: null });
          return;
        }

        this.bannerVisible = true;
        this.setState({
          status: 'loaded',
          bannerHeightPx: measuredHeight > 0 ? measuredHeight : 56,
          lastError: null
        });
      });

      const hFailed = await AdMob.addListener(BannerAdPluginEvents.FailedToLoad, (err: AdMobError) => {
        console.warn('[AdMob] Banner failed to load:', err?.code, err?.message);
        this.bannerVisible = false;
        this.bannerCreated = false;
        this.lastBannerFailedAt = Date.now();
        this.setState({
          status: 'error',
          bannerHeightPx: 0,
          lastError: err?.message || 'Ad request failed or unavailable.'
        });
      });

      // Interstitial Events
      const hIntLoaded = await AdMob.addListener(InterstitialAdPluginEvents.Loaded, (_info: AdLoadInfo) => {
        this.interstitialFailStreak = 0;
        this.lastInterstitialFailedAt = 0;
        this.interstitialPreparedAt = Date.now();
        this.setState({ interstitialStatus: 'ready', lastError: null });
      });

      const hIntFailedToLoad = await AdMob.addListener(
        InterstitialAdPluginEvents.FailedToLoad,
        (err: AdMobError) => {
          console.warn('[AdMob] Interstitial failed to load:', err?.code, err?.message);
          this.lastInterstitialFailedAt = Date.now();
          this.interstitialPreparedAt = 0;
          this.interstitialFailStreak = Math.min(4, this.interstitialFailStreak + 1);
          this.setState({
            interstitialStatus: 'error',
            lastError: err?.message || 'Interstitial failed to load.'
          });
        }
      );

      const hIntShowed = await AdMob.addListener(InterstitialAdPluginEvents.Showed, () => {
        this.lastInterstitialShownAt = Date.now();
        this.interstitialPreparedAt = 0;
        const nextCount = this.state.interstitialShownCount + 1;
        try {
          sessionStorage.setItem(INTERSTITIAL_SESSION_COUNT_KEY, String(nextCount));
        } catch {}
        this.setState({
          interstitialStatus: 'showing',
          interstitialShownCount: nextCount
        });
      });

      const hIntFailedToShow = await AdMob.addListener(
        InterstitialAdPluginEvents.FailedToShow,
        (err: AdMobError) => {
          console.warn('[AdMob] Interstitial failed to show:', err?.code, err?.message);
          this.interstitialShowLock = false;
          this.interstitialPreparedAt = 0;
          this.setState({ interstitialStatus: 'idle' });
          this.scheduleInterstitialPreload(8_000);
        }
      );

      const hIntDismissed = await AdMob.addListener(InterstitialAdPluginEvents.Dismissed, () => {
        this.interstitialShowLock = false;
        this.interstitialPreparedAt = 0;
        this.setState({ interstitialStatus: 'idle' });
        this.scheduleInterstitialPreload(4_000);
      });

      this.pluginHandles.push(
        hSize,
        hLoaded,
        hFailed,
        hIntLoaded,
        hIntFailedToLoad,
        hIntShowed,
        hIntFailedToShow,
        hIntDismissed
      );
    } catch (err: any) {
      this.listenersBound = false;
      console.warn('[AdMob] Listener binding error:', err?.message || err);
    }
  }

  private async ensureInitializedAndConsented(): Promise<boolean> {
    if (!this.isNativeRuntime()) {
      this.setState({
        isNative: false,
        status: 'unavailable',
        bannerHeightPx: 0,
        canRequestAds: false,
        consentStatus: 'UNSUPPORTED',
        privacyOptionsRequired: false,
        interstitialStatus: 'idle'
      });
      return false;
    }

    this.setState({ isNative: true });

    const config = await this.loadBackendConfig();
    if (!config || !config.enabled) {
      this.setState({
        status: 'unavailable',
        bannerHeightPx: 0,
        canRequestAds: false
      });
      return false;
    }

    if (this.sdkInitialized && this.state.canRequestAds) {
      return true;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        this.setState({ status: 'consent_pending', lastError: null });
        await this.bindPluginListeners();

        // 1. Run Google UMP (User Messaging Platform) Consent Check
        let consentInfo: AdmobConsentInfo = await AdMob.requestConsentInfo();

        if (
          consentInfo.isConsentFormAvailable &&
          consentInfo.status === AdmobConsentStatus.REQUIRED
        ) {
          consentInfo = await AdMob.showConsentForm();
        }

        const privacyRequired =
          String(consentInfo.privacyOptionsRequirementStatus) === 'REQUIRED';

        this.setState({
          canRequestAds: Boolean(consentInfo.canRequestAds),
          consentStatus: consentInfo.status,
          privacyOptionsRequired: privacyRequired
        });

        if (!consentInfo.canRequestAds) {
          this.setState({
            status: 'unavailable',
            bannerHeightPx: 0,
            lastError: 'Ad consent not granted.'
          });
          return false;
        }

        // 2. Initialize Google Mobile Ads SDK strictly once
        if (!this.sdkInitialized) {
          await AdMob.initialize({
            initializeForTesting: config.isTesting
          });
          this.sdkInitialized = true;
        }

        return true;
      } catch (err: any) {
        console.warn('[AdMob] UMP / SDK initialization error:', err?.message || err);
        this.setState({
          status: 'error',
          bannerHeightPx: 0,
          canRequestAds: false,
          lastError: err?.message || 'Unable to initialize AdMob or consent flow.'
        });
        return false;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  public syncChatBannerVisibility(params: {
    shouldShowBanner: boolean;
    isKeyboardOpen: boolean;
  }): void {
    this.desiredShouldShow = params.shouldShowBanner;
    this.desiredKeyboardOpen = params.isKeyboardOpen;

    this.opQueue = this.opQueue
      .then(() => this.applyDesiredBannerState())
      .catch((err) => {
        console.warn('[AdMob] State sync error:', err?.message || err);
      });
  }

  private async applyDesiredBannerState(): Promise<void> {
    if (!this.isNativeRuntime()) {
      await this.loadBackendConfig();
      this.setState({
        isNative: false,
        status: 'unavailable',
        bannerHeightPx: 0
      });
      return;
    }

    const canShowNow = this.desiredShouldShow && !this.desiredKeyboardOpen;

    if (!canShowNow) {
      if (this.bannerCreated && this.bannerVisible) {
        try {
          await AdMob.hideBanner();
        } catch {}
      }
      this.bannerVisible = false;
      this.setState({
        status: this.state.status === 'unavailable' ? 'unavailable' : 'hidden',
        bannerHeightPx: 0
      });
      return;
    }

    if (!this.bannerCreated && this.lastBannerFailedAt > 0 && Date.now() - this.lastBannerFailedAt < 60_000) {
      this.setState({ bannerHeightPx: 0 });
      return;
    }

    const ready = await this.ensureInitializedAndConsented();
    if (!ready) {
      this.setState({ bannerHeightPx: 0 });
      return;
    }

    // Quietly preload interstitial in background after SDK + UMP consent succeed
    this.scheduleInterstitialPreload(2_500);

    if (!this.desiredShouldShow || this.desiredKeyboardOpen) {
      this.setState({ bannerHeightPx: 0, status: 'hidden' });
      return;
    }

    const config = await this.loadBackendConfig();
    if (!config || !config.enabled) {
      this.setState({ bannerHeightPx: 0, status: 'unavailable' });
      return;
    }

    if (this.bannerCreated && !this.bannerVisible) {
      try {
        await AdMob.resumeBanner();
        this.bannerVisible = true;
        let height = 56;
        try {
          const size = await AdMob.getBannerSize();
          if (size?.height && size.height > 0) {
            height = Math.round(size.height);
          }
        } catch {}
        this.setState({
          status: 'loaded',
          bannerHeightPx: height,
          lastError: null
        });
      } catch (err: any) {
        console.warn('[AdMob] resumeBanner error:', err?.message || err);
        this.bannerCreated = false;
        this.bannerVisible = false;
        this.setState({ status: 'error', bannerHeightPx: 0 });
      }
      return;
    }

    if (this.bannerCreated && this.bannerVisible) {
      return;
    }

    this.setState({ status: 'loading', lastError: null });
    try {
      await AdMob.showBanner({
        adId: config.bannerAdUnitId,
        adSize: BannerAdSize.ADAPTIVE_BANNER,
        position: BannerAdPosition.BOTTOM_CENTER,
        margin: 0,
        isTesting: config.isTesting
      });
      this.bannerCreated = true;
      this.bannerVisible = true;
    } catch (err: any) {
      console.warn('[AdMob] showBanner failed:', err?.message || err);
      this.bannerCreated = false;
      this.bannerVisible = false;
      this.lastBannerFailedAt = Date.now();
      this.setState({
        status: 'error',
        bannerHeightPx: 0,
        lastError: err?.message || 'Failed to load banner advertisement.'
      });
    }
  }

  private scheduleInterstitialPreload(delayMs = 1500): void {
    if (!this.isNativeRuntime() || typeof window === 'undefined') return;
    if (this.preloadTimerId !== null) return;
    if (this.state.interstitialStatus === 'ready' || this.state.interstitialStatus === 'loading') return;

    this.preloadTimerId = window.setTimeout(() => {
      this.preloadTimerId = null;
      void this.preloadInterstitial();
    }, delayMs);
  }

  /**
   * Preloads a single interstitial instance ahead of natural navigation transitions.
   * Respects consent, failure backoff, session cap, and duplicate-request prevention.
   */
  public async preloadInterstitial(): Promise<boolean> {
    if (!this.isNativeRuntime()) return false;
    if (this.interstitialPreparePromise) return this.interstitialPreparePromise;
    if (this.state.interstitialStatus === 'ready' || this.state.interstitialStatus === 'showing') {
      return this.state.interstitialStatus === 'ready';
    }

    this.interstitialPreparePromise = (async () => {
      try {
        const config = await this.loadBackendConfig();
        if (!config || !config.enabled) return false;

        if (this.state.interstitialShownCount >= config.interstitialMaxPerSession) {
          return false;
        }

        const backoffMs = Math.min(300_000, 60_000 * Math.pow(2, Math.max(0, this.interstitialFailStreak - 1)));
        if (this.lastInterstitialFailedAt > 0 && Date.now() - this.lastInterstitialFailedAt < backoffMs) {
          return false;
        }

        const ready = await this.ensureInitializedAndConsented();
        if (!ready) return false;

        this.setState({ interstitialStatus: 'loading' });
        await AdMob.prepareInterstitial({
          adId: config.interstitialAdUnitId,
          isTesting: config.isTesting
        });
        this.interstitialFailStreak = 0;
        this.lastInterstitialFailedAt = 0;
        this.interstitialPreparedAt = Date.now();
        this.setState({ interstitialStatus: 'ready', lastError: null });
        return true;
      } catch (err: any) {
        console.warn('[AdMob] Interstitial preload error:', err?.message || err);
        this.lastInterstitialFailedAt = Date.now();
        this.interstitialPreparedAt = 0;
        this.interstitialFailStreak = Math.min(4, this.interstitialFailStreak + 1);
        this.setState({
          interstitialStatus: 'error',
          lastError: err?.message || 'Interstitial preload failed.'
        });
        return false;
      } finally {
        this.interstitialPreparePromise = null;
      }
    })();

    return this.interstitialPreparePromise;
  }

  /**
   * Anchors the 45-second startup grace period to when the authenticated session begins,
   * so time spent on AuthScreen does not consume the in-app grace window.
   */
  public markAuthenticatedSessionStarted(): void {
    if (this.authenticatedSessionStarted) return;
    this.authenticatedSessionStarted = true;
    this.sessionStartedAt = Date.now();
  }

  /**
   * Records completion of a user-requested media generation task (image/video)
   * without interrupting the user while they inspect their generated result.
   */
  public markGenerationTaskCompleted(): void {
    this.hasCompletedGenerationTask = true;
    this.scheduleInterstitialPreload(1_000);
  }

  /**
   * Attempts to show a preloaded interstitial ONLY at natural UI transition points
   * (navigating between major studio/chat sections or starting a fresh chat after finishing work).
   * Strictly blocked during auth, payment, consent, voice mode, typing, loading, or cooldowns.
   */
  public async maybeShowInterstitialAtTransition(context: {
    reason: 'section_switch' | 'new_chat';
    isAuthenticated: boolean;
    isBusyGeneratingOrChatting: boolean;
    isModalOrConsentBlocking: boolean;
    isVoiceOpen: boolean;
    isKeyboardOpen: boolean;
  }): Promise<boolean> {
    if (!this.isNativeRuntime()) return false;

    // Never interrupt auth, payment, consent, modals, voice conversation, loading, or typing
    if (
      !context.isAuthenticated ||
      context.isBusyGeneratingOrChatting ||
      context.isModalOrConsentBlocking ||
      context.isVoiceOpen ||
      context.isKeyboardOpen ||
      this.isUserTypingOrFocusedInput() ||
      this.interstitialShowLock
    ) {
      return false;
    }

    const config = await this.loadBackendConfig();
    if (!config || !config.enabled || !this.state.canRequestAds) {
      return false;
    }

    if (this.state.interstitialShownCount >= config.interstitialMaxPerSession) {
      return false;
    }

    this.transitionCounter += 1;

    const now = Date.now();
    // Respect startup grace period so initial navigation is never jarring
    if (now - this.sessionStartedAt < STARTUP_GRACE_MS) {
      this.scheduleInterstitialPreload(1_000);
      return false;
    }

    // Require either a completed generation task + transition away, or at least 2 major transitions
    const hasNaturalMilestone = this.hasCompletedGenerationTask || this.transitionCounter >= 2;
    if (!hasNaturalMilestone) {
      this.scheduleInterstitialPreload(1_000);
      return false;
    }

    // Enforce reasonable cooldown between interstitials
    if (
      this.lastInterstitialShownAt > 0 &&
      now - this.lastInterstitialShownAt < config.interstitialCooldownMs
    ) {
      return false;
    }

    // Refresh stale preloaded ads proactively before Google Mobile Ads 60-min expiration
    if (
      this.state.interstitialStatus === 'ready' &&
      this.interstitialPreparedAt > 0 &&
      now - this.interstitialPreparedAt >= INTERSTITIAL_MAX_AGE_MS
    ) {
      this.interstitialPreparedAt = 0;
      this.setState({ interstitialStatus: 'idle' });
      this.scheduleInterstitialPreload(500);
      return false;
    }

    // Only show if an interstitial is ALREADY preloaded — never freeze navigation waiting on network
    if (this.state.interstitialStatus !== 'ready') {
      this.scheduleInterstitialPreload(1_000);
      return false;
    }

    this.interstitialShowLock = true;
    this.setState({ interstitialStatus: 'showing' });

    try {
      await AdMob.showInterstitial();
      this.hasCompletedGenerationTask = false;
      this.transitionCounter = 0;
      return true;
    } catch (err: any) {
      console.warn('[AdMob] Interstitial show failed:', err?.message || err);
      this.interstitialShowLock = false;
      this.interstitialPreparedAt = 0;
      this.setState({ interstitialStatus: 'idle' });
      this.scheduleInterstitialPreload(5_000);
      return false;
    }
  }

  public async openPrivacyOptions(): Promise<{ ok: boolean; message: string }> {
    if (!this.isNativeRuntime()) {
      return {
        ok: false,
        message: 'Ad privacy preferences apply inside the Ultron AI Android app.'
      };
    }

    try {
      if (this.state.consentStatus === 'UNSUPPORTED') {
        await AdMob.requestConsentInfo();
      }
      await AdMob.showPrivacyOptionsForm();
      const updatedInfo = await AdMob.requestConsentInfo();
      const privacyRequired =
        String(updatedInfo.privacyOptionsRequirementStatus) === 'REQUIRED';

      this.setState({
        canRequestAds: Boolean(updatedInfo.canRequestAds),
        consentStatus: updatedInfo.status,
        privacyOptionsRequired: privacyRequired
      });

      if (!updatedInfo.canRequestAds && this.bannerCreated) {
        await AdMob.removeBanner().catch(() => {});
        this.bannerCreated = false;
        this.bannerVisible = false;
        this.setState({ status: 'unavailable', bannerHeightPx: 0 });
      } else if (updatedInfo.canRequestAds && this.desiredShouldShow && !this.desiredKeyboardOpen) {
        this.syncChatBannerVisibility({
          shouldShowBanner: true,
          isKeyboardOpen: false
        });
      }

      return { ok: true, message: 'Ad privacy preferences updated.' };
    } catch (err: any) {
      return {
        ok: false,
        message: err?.message || 'Privacy options form is not currently required or available.'
      };
    }
  }

  public destroyBannerOnSignOut(): void {
    this.desiredShouldShow = false;
    this.desiredKeyboardOpen = false;
    this.hasCompletedGenerationTask = false;
    this.transitionCounter = 0;
    this.interstitialShowLock = false;
    this.interstitialPreparedAt = 0;
    this.authenticatedSessionStarted = false;
    if (this.preloadTimerId !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.preloadTimerId);
      this.preloadTimerId = null;
    }

    this.opQueue = this.opQueue
      .then(async () => {
        if (this.isNativeRuntime() && this.bannerCreated) {
          try {
            await AdMob.removeBanner();
          } catch {}
        }
        this.bannerCreated = false;
        this.bannerVisible = false;
        this.setState({
          status: this.isNativeRuntime() ? 'hidden' : 'unavailable',
          bannerHeightPx: 0,
          interstitialStatus: 'idle'
        });
      })
      .catch(() => {});
  }

  public async disposeListeners(): Promise<void> {
    if (this.preloadTimerId !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.preloadTimerId);
      this.preloadTimerId = null;
    }
    for (const handle of this.pluginHandles) {
      try {
        await handle.remove();
      } catch {}
    }
    this.pluginHandles = [];
    this.listenersBound = false;
  }
}

export const admobController = new AdMobController();
