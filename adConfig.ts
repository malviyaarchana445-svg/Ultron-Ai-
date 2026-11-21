import { Router } from 'express';

export const adConfigRouter = Router();

const DEFAULT_ADMOB_APP_ID = 'ca-app-pub-9420884023594843~7696266305';
const DEFAULT_PROD_BANNER_UNIT_ID = 'ca-app-pub-9420884023594843/4005092447';
const DEFAULT_PROD_INTERSTITIAL_UNIT_ID = 'ca-app-pub-9420884023594843/9911366100';

// Official Google Mobile Ads Android Test Ad Unit IDs
const OFFICIAL_ANDROID_TEST_BANNER_UNIT_ID = 'ca-app-pub-3940256099942544/6300978111';
const OFFICIAL_ANDROID_TEST_INTERSTITIAL_UNIT_ID = 'ca-app-pub-3940256099942544/1033173712';

export interface PublicAdConfig {
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

export function resolveAdMobConfig(): PublicAdConfig {
  const rawEnv = String(process.env.ADMOB_ENV || 'test').trim().toLowerCase();
  const isProduction = rawEnv === 'production';
  const enabled = String(process.env.ADMOB_ENABLED || 'true').trim().toLowerCase() !== 'false';

  const appId = String(process.env.ADMOB_APP_ID || DEFAULT_ADMOB_APP_ID).trim() || DEFAULT_ADMOB_APP_ID;
  const prodBannerUnitId =
    String(process.env.ADMOB_BANNER_UNIT_ID || DEFAULT_PROD_BANNER_UNIT_ID).trim() || DEFAULT_PROD_BANNER_UNIT_ID;
  const prodInterstitialUnitId =
    String(process.env.ADMOB_INTERSTITIAL_UNIT_ID || DEFAULT_PROD_INTERSTITIAL_UNIT_ID).trim() ||
    DEFAULT_PROD_INTERSTITIAL_UNIT_ID;

  const parsedCooldown = Number(process.env.ADMOB_INTERSTITIAL_COOLDOWN_MS || 180_000);
  const interstitialCooldownMs =
    Number.isFinite(parsedCooldown) && parsedCooldown >= 30_000 ? parsedCooldown : 180_000;

  const parsedCap = Number(process.env.ADMOB_INTERSTITIAL_MAX_PER_SESSION || 4);
  const interstitialMaxPerSession =
    Number.isFinite(parsedCap) && parsedCap >= 1 ? Math.min(10, Math.floor(parsedCap)) : 4;

  return {
    enabled,
    env: isProduction ? 'production' : 'test',
    isTesting: !isProduction,
    appId,
    bannerAdUnitId: isProduction ? prodBannerUnitId : OFFICIAL_ANDROID_TEST_BANNER_UNIT_ID,
    testBannerAdUnitId: OFFICIAL_ANDROID_TEST_BANNER_UNIT_ID,
    bannerPosition: 'bottom',
    bannerSize: 'ADAPTIVE_BANNER',
    interstitialAdUnitId: isProduction ? prodInterstitialUnitId : OFFICIAL_ANDROID_TEST_INTERSTITIAL_UNIT_ID,
    testInterstitialAdUnitId: OFFICIAL_ANDROID_TEST_INTERSTITIAL_UNIT_ID,
    interstitialCooldownMs,
    interstitialMaxPerSession
  };
}

// GET /api/ads/config — Returns active AdMob test/production toggle & ad unit IDs from backend env
adConfigRouter.get('/config', (_req, res) => {
  const config = resolveAdMobConfig();
  return res.json({
    success: true,
    ...config
  });
});
