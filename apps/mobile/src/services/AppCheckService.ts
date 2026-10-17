/**
 * AppCheckService.ts — Firebase App Check Initialization
 *
 * Activates App Check using platform-native attestation providers:
 *   - Android: Play Integrity (production) / Debug provider (dev builds)
 *   - iOS:     App Attest (production)     / Debug provider (dev builds)
 *
 * App Check tokens are automatically attached to all @react-native-firebase
 * requests. The relay and keyRegistry Cloud Functions enforce App Check via
 * the Firebase Admin SDK `AppCheck.verifyToken()` call — see relay.ts and
 * keyRegistry.ts.
 *
 * Setup required (one-time, in Firebase Console):
 *   1. App Check → Register app → Choose Play Integrity (Android) / App Attest (iOS)
 *   2. Cloud Functions → Enforce App Check on `relay` and `registerKey`/`fetchKey`
 *
 * For local development, set the FIREBASE_APPCHECK_DEBUG_TOKEN env variable or
 * use the debug provider (DEBUG_TOKEN constant below). Never ship debug tokens.
 */

import appCheck, {
  FirebaseAppCheckTypes,
} from '@react-native-firebase/app-check';

// ─── Debug token ──────────────────────────────────────────────────────────────
// Override in your .env.local / Expo secrets for dev builds.
// Set to undefined to disable debug provider in production.
const DEBUG_TOKEN: string | undefined =
  process.env['FIREBASE_APPCHECK_DEBUG_TOKEN'];

// ─── Initialize ───────────────────────────────────────────────────────────────

let initialized = false;

/**
 * Activates App Check. Call once from app entry before any Firebase service
 * calls are made. Safe to call multiple times — skips if already active.
 */
export async function initializeAppCheck(): Promise<void> {
  if (initialized) return;

  let provider: FirebaseAppCheckTypes.AppCheckProvider;

  if (DEBUG_TOKEN) {
    // Development: use debug provider with a known token
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    provider = (appCheck() as any).newDebugAppCheckProvider(DEBUG_TOKEN); // eslint-disable-line @typescript-eslint/no-explicit-any
  } else if (process.env['NODE_ENV'] === 'test') {
    // Test environment: skip App Check entirely
    return;
  } else {
    // Production: platform-native attestation
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    provider = (appCheck() as any).newReactNativeFirebaseAppCheckProvider(); // eslint-disable-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await (provider as any).configure({ // eslint-disable-line @typescript-eslint/no-explicit-any
      android: {
        provider: 'playIntegrity',
      },
      apple: {
        provider: 'appAttest',
      },
    });
  }

  await appCheck().initializeAppCheck({
    provider,
    isTokenAutoRefreshEnabled: true,
  });

  initialized = true;
}

/**
 * Resets the initialization flag. Only needed in tests.
 */
export function resetAppCheckForTests(): void {
  initialized = false;
}
