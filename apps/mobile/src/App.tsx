/**
 * App.tsx — Root Component
 *
 * Orchestrates the session lifecycle:
 *   1. On mount: App Check → keypair → FCM → drain background queue → publish key
 *   2. App state listener:
 *      - Background transition → wipe all key material + tear down FCM
 *      - Foreground return    → re-initialize session (new keypair + FCM re-register)
 *   3. FCM inbound handler: decrypt → inject into MemoryStore → re-render
 *
 * Error states:
 *   - FCM permission denied → PermissionDeniedScreen (persistent, user must grant)
 *   - Any other init failure → ErrorScreen with retry button
 *
 * The entire application state is volatile. There are zero AsyncStorage reads.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
  Linking,
  Platform,
  StyleSheet,
  Text,
  ToastAndroid,
  TouchableOpacity,
  View,
} from 'react-native';
import { NavigationContainer, type LinkingOptions } from '@react-navigation/native';
import type { AppParamList } from './navigation/AppNavigator';
import { initializeAppCheck } from './services/AppCheckService';
import { initializeSession } from './crypto/PQCEngine';
import { initializeFCM, teardownFCM, drainBackgroundMessages } from './services/FCMService';
import { publishPublicKey } from './services/RelayService';
import { store } from './store/MemoryStore';
import { AppNavigator } from './navigation/AppNavigator';
import { SessionSplash } from './components/SessionSplash';
import { ErrorBoundary } from './components/ErrorBoundary';

// ─── Deep-link configuration ──────────────────────────────────────────────────
// Handles betweenus://addcontact?payload=<encoded-json>
// The payload is the QR JSON string — ScanScreen reads it from route params.

const LINKING_CONFIG: LinkingOptions<AppParamList> = {
  prefixes: ['betweenus://'],
  config: {
    screens: {
      Home: '',
      Scan: {
        path: 'addcontact',
        parse: {
          // Full QR payload from legacy deep links (betweenus://addcontact?payload=...)
          payload: (value: string) => decodeURIComponent(value),
          // Compact userId-only link (betweenus://addcontact?uid=...)
          uid: (value: string) => decodeURIComponent(value),
        },
      },
      Chat: 'chat/:contactId',
    },
  },
  async getInitialURL() {
    const url = await Linking.getInitialURL();
    return url ?? undefined;
  },
  subscribe(listener) {
    const sub = Linking.addEventListener('url', ({ url }) => listener(url));
    return () => sub.remove();
  },
};

// ─── Session state ────────────────────────────────────────────────────────────

type InitState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'permission_denied' }     // FCM permission permanently denied
  | { status: 'error'; message: string }; // Any other init failure

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSessionUserId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function App(): React.ReactElement {
  const [initState, setInitState] = useState<InitState>({ status: 'loading' });
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionVersion, setSessionVersion] = useState(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const needsReinitRef = useRef(false);

  // ── Session Bootstrap ─────────────────────────────────────────────────────
  const startSession = useCallback(async () => {
    setInitState({ status: 'loading' });
    try {
      // 1. Activate App Check (no-op if already active)
      await initializeAppCheck();

      // 2. Generate ephemeral user ID for this session
      const uid = generateSessionUserId();
      store.setUserId(uid);
      setUserId(uid);

      // 3. Generate ML-KEM-768 keypair → stored in MemoryStore volatile RAM
      const publicKeyB64 = await initializeSession();

      // 4. Initialize FCM — tears down any previous listener before re-registering
      const INBOUND_TTL_MS = 5 * 60 * 1000; // 5 minutes visibility window

      const handleInbound = (senderId: string, plaintext: string): void => {
        const expiresAt = Date.now() + INBOUND_TTL_MS;
        store.addMessage(senderId, {
          id: `in-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          direction: 'in',
          plaintextBody: plaintext,
          status: 'delivered',
          ttlSeconds: 0,
          sentAt: Date.now(),
          expiresAt,
        });
        setSessionVersion(v => v + 1);

        // Schedule a prune so inbound messages don't linger in RAM past their TTL.
        // clearSession() already discards everything on backgrounding; this handles
        // the case where the app stays in the foreground for > 5 minutes.
        setTimeout(() => {
          store.pruneExpired(senderId);
          setSessionVersion(v => v + 1);
        }, INBOUND_TTL_MS + 100); // +100 ms buffer so the message is definitely expired
      };

      await initializeFCM(handleInbound);

      // 5. Drain packets received while backgrounded (drops pre-wipe packets)
      await drainBackgroundMessages(handleInbound);

      // 6. Best-effort key registry publish — server returns the canonical userId
      //    derived from SHA-256(publicKey); use it if available, keep local uid otherwise
      const fcmToken = store.getFCMToken() ?? '';
      publishPublicKey(publicKeyB64, fcmToken).then(result => {
        if (result.ok && result.userId) {
          store.setUserId(result.userId);
          setUserId(result.userId);
        }
      }).catch(() => {/* non-critical */});

      setInitState({ status: 'ready' });
      setSessionVersion(v => v + 1);

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('permission denied') || message.includes('FCM permission')) {
        // User explicitly denied notifications — show dedicated screen
        setInitState({ status: 'permission_denied' });
      } else {
        setInitState({ status: 'error', message });
      }
    }
  }, []);

  // Initial mount
  useEffect(() => {
    startSession();
  }, [startSession]);

  // ── App State: Wipe on Background, Re-init on Foreground ──────────────────
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      if (
        (prevState === 'active' || prevState === 'inactive') &&
        nextState === 'background'
      ) {
        teardownFCM();
        store.clearSession();
        setInitState({ status: 'loading' });
        needsReinitRef.current = true;
      }

      if (prevState === 'background' && nextState === 'active') {
        if (needsReinitRef.current) {
          needsReinitRef.current = false;
          // Brief notification so users understand why contacts disappeared
          if (Platform.OS === 'android') {
            ToastAndroid.show(
              'New secure session started — contacts cleared',
              ToastAndroid.SHORT,
            );
          }
          // iOS: no toast equivalent in RN core; the SessionSplash
          // provides visual feedback that a new session is starting.
          startSession();
        }
      }
    });
    return () => subscription.remove();
  }, [startSession]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (initState.status === 'loading') {
    return <SessionSplash />;
  }

  if (initState.status === 'permission_denied') {
    return <PermissionDeniedScreen onRetry={startSession} />;
  }

  if (initState.status === 'error') {
    return <InitErrorScreen message={initState.message} onRetry={startSession} />;
  }

  return (
    <ErrorBoundary>
      <NavigationContainer linking={LINKING_CONFIG}>
        <AppNavigator sessionVersion={sessionVersion} userId={userId} />
      </NavigationContainer>
    </ErrorBoundary>
  );
}

// ─── Permission Denied Screen ─────────────────────────────────────────────────

function PermissionDeniedScreen({ onRetry }: { onRetry: () => void }): React.ReactElement {
  return (
    <View style={styles.fullscreen}>
      <Text style={styles.errorIcon}>🔔</Text>
      <Text style={styles.errorTitle}>Notifications Required</Text>
      <Text style={styles.errorBody}>
        BETWEENUS uses silent push notifications to deliver encrypted messages.{'\n\n'}
        Please enable notifications for BETWEENUS in your device Settings, then tap Retry.
      </Text>
      <TouchableOpacity style={styles.retryBtn} onPress={onRetry}>
        <Text style={styles.retryBtnText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Init Error Screen ────────────────────────────────────────────────────────

function InitErrorScreen({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <View style={styles.fullscreen}>
      <Text style={styles.errorIcon}>⚠️</Text>
      <Text style={styles.errorTitle}>Session Failed to Start</Text>
      <Text style={styles.errorBody}>{message}</Text>
      <TouchableOpacity style={styles.retryBtn} onPress={onRetry}>
        <Text style={styles.retryBtnText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  fullscreen: {
    flex: 1,
    backgroundColor: '#0a0a0f',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 36,
    gap: 14,
  },
  errorIcon: {
    fontSize: 40,
    marginBottom: 4,
  },
  errorTitle: {
    color: '#e8e8f0',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  errorBody: {
    color: '#6b7280',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 300,
  },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 32,
    paddingVertical: 13,
    backgroundColor: '#1e3a5f',
    borderRadius: 12,
  },
  retryBtnText: {
    color: '#93c5fd',
    fontSize: 14,
    fontWeight: '600',
  },
});
