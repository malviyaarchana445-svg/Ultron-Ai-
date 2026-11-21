import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'studio.ai.ultronexe',
  appName: 'Ultron AI',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;
