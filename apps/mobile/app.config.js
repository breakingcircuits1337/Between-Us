/**
 * app.config.js — Dynamic Expo Configuration
 *
 * Merges app.json with build-time environment variables so secrets are never
 * hard-coded in source.  EAS Build injects these via EAS Secrets (CLI:
 * `eas secret:create --scope project --name RELAY_BASE_URL --value <url>`).
 *
 * At runtime the value is read from `expo-constants`:
 *   import Constants from 'expo-constants';
 *   const url = Constants.expoConfig?.extra?.relayBaseUrl;
 *
 * Local development: set RELAY_BASE_URL in .env (never committed).
 */

// Load .env for local development (expo-dotenv or expo's built-in support)
// Expo SDK 50+ automatically loads .env during `expo start`/`expo export`.

/** @type {import('@expo/config').ExpoConfig} */
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    /**
     * Firebase Cloud Functions base URL.
     * Injected via EAS Secret: RELAY_BASE_URL
     * Example: https://us-central1-myproject.cloudfunctions.net
     */
    relayBaseUrl:
      process.env.RELAY_BASE_URL ??
      'https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net',

    /**
     * App Check debug token for non-production builds.
     * Injected via EAS Secret: FIREBASE_APPCHECK_DEBUG_TOKEN
     */
    appCheckDebugToken: process.env.FIREBASE_APPCHECK_DEBUG_TOKEN ?? '',
  },
});
