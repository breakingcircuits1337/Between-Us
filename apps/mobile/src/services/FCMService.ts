/**
 * FCMService.ts — Firebase Cloud Messaging Client (React Native)
 *
 * Uses @react-native-firebase/messaging (native SDK) — NOT firebase/messaging
 * (which is web-only and non-functional in React Native).
 *
 * Handles:
 *   - FCM token acquisition and in-memory storage
 *   - Foreground message parsing and dispatch
 *   - Background / quit-state message handling via setBackgroundMessageHandler
 *
 * Security notes:
 *   - FCM tokens are stored in MemoryStore (volatile RAM) only
 *   - Inbound data payloads are decrypted immediately in-process
 *   - Decrypted plaintext is held only in React component state
 *   - No message content written to notification tray (silent/data-only push)
 */

import messaging, {
  type FirebaseMessagingTypes,
} from '@react-native-firebase/messaging';
import { serializePublicKey } from '@betweenus/crypto';
import { store } from '../store/MemoryStore';
import { decryptIncomingEnvelope, type EncryptedPacket } from '../crypto/PQCEngine';
import { publishPublicKey, sendDeliveryAck } from './RelayService';
import {
  enqueuePendingPacket,
  drainPendingPackets,
  clearPendingQueue,
} from '../store/PendingMessageStore';
import notifee, { AndroidImportance } from '@notifee/react-native';

// ─── Types ───────────────────────────────────────────────────────────────────

export type InboundMessageHandler = (
  senderId: string,
  plaintext: string,
) => void;

// ─── Module-level handler ref ─────────────────────────────────────────────────
// Stored so we can re-register after a session wipe without leaking listeners.
let foregroundUnsubscribe: (() => void) | null = null;

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Requests FCM permission (iOS), retrieves the registration token, stores it
 * in volatile MemoryStore, and registers foreground + background handlers.
 *
 * Safe to call multiple times — tears down the previous foreground listener
 * before attaching a new one, so re-init after a session wipe is clean.
 *
 * @param onInboundMessage  Callback invoked with (senderId, plaintext) on receipt
 * @returns The local FCM registration token (share via QR code)
 */
export async function initializeFCM(
  onInboundMessage: InboundMessageHandler,
): Promise<string> {
  // iOS: request notification permission (Android 13+ also needs this)
  const authStatus = await messaging().requestPermission();
  const enabled =
    authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
    authStatus === messaging.AuthorizationStatus.PROVISIONAL;

  if (!enabled) {
    throw new Error('FCM permission denied — push notifications unavailable');
  }

  // Get the device FCM registration token
  const token = await messaging().getToken();
  store.setFCMToken(token);

  // Tear down any previous foreground listener before re-registering
  if (foregroundUnsubscribe) {
    foregroundUnsubscribe();
    foregroundUnsubscribe = null;
  }

  // Token refresh handler — update store and re-publish to key registry
  // so the peer can still deliver after a token rotation.
  const unsubRefresh = messaging().onTokenRefresh((newToken: string) => {
    store.setFCMToken(newToken);
    // Re-publish is best-effort and non-blocking
    const kp = store.getKeyPair();
    if (kp) {
      publishPublicKey(serializePublicKey(kp.publicKey), newToken).catch(() => {});
    }
  });

  // Foreground message handler (app is open and active)
  // Wire both unsubscribers into one cleanup fn stored in foregroundUnsubscribe.
  const unsubForeground = messaging().onMessage(
    (remoteMessage: FirebaseMessagingTypes.RemoteMessage) => {
      handleInboundPayload(remoteMessage, onInboundMessage).catch(err => {
        console.warn(
          '[FCM] Inbound message handling failed:',
          err instanceof Error ? err.message : err,
        );
      });
    },
  );
  foregroundUnsubscribe = () => {
    unsubForeground();
    unsubRefresh();
  };

  return token;
}

/**
 * Tears down the foreground listener. Call this when the session is wiped
 * so stale handlers from a previous session do not process new messages.
 */
export function teardownFCM(): void {
  if (foregroundUnsubscribe) {
    foregroundUnsubscribe();
    foregroundUnsubscribe = null;
  }
  // Also discard any queued packets — they were encrypted for the wiped key
  clearPendingQueue();
}

// ─── Background / Quit-state handler ─────────────────────────────────────────
// Registered at module load time (before any UI mounts).
// Enqueues the encrypted packet into PendingMessageStore — no decryption here
// because the secret key lives in MemoryStore which is wiped on background.
// App.tsx calls drainBackgroundMessages() after startSession() completes.
// Also shows a generic local notification so the user knows to open the app.
messaging().setBackgroundMessageHandler(
  async (remoteMessage: FirebaseMessagingTypes.RemoteMessage) => {
    const data = remoteMessage.data;
    if (!data) return;

    const { kemCiphertext, iv, authTag, ciphertext, senderId, ackMessageId } = data as {
      kemCiphertext?: string;
      iv?: string;
      authTag?: string;
      ciphertext?: string;
      senderId?: string;
      ackMessageId?: string;
    };

    // Ack packets received in background — no notification needed
    if (ackMessageId) return;

    if (!kemCiphertext || !iv || !authTag || !ciphertext || !senderId) return;

    enqueuePendingPacket({
      packet: { kemCiphertext, iv, authTag, ciphertext },
      senderId,
      receivedAt: Date.now(),
    });

    // Show a generic local notification — content-free to preserve privacy
    try {
      const channelId = await notifee.createChannel({
        id: 'betweenus-messages',
        name: 'Secure Messages',
        importance: AndroidImportance.HIGH,
        sound: 'default',
      });

      await notifee.displayNotification({
        title: 'New secure message',
        body: 'Open BETWEENUS to read your encrypted message.',
        android: {
          channelId,
          pressAction: { id: 'default' },
          // No payload in notification — content only visible inside the app
        },
        ios: {
          sound: 'default',
          // badge is not set — we don't persist count across sessions
        },
      });
    } catch {
      // Notification display is best-effort — message is still queued
    }
  },
);

// ─── Drain background queue ───────────────────────────────────────────────────

/**
 * Decrypts any packets that arrived while the app was backgrounded and
 * dispatches them via the inbound message handler.
 *
 * Call this from App.tsx immediately after initializeFCM() completes so
 * the new session keypair is available for decryption.
 */
export async function drainBackgroundMessages(
  onInboundMessage: InboundMessageHandler,
): Promise<void> {
  const pending = drainPendingPackets();
  for (const { packet, senderId } of pending) {
    try {
      const envelope = await decryptIncomingEnvelope(packet);
      onInboundMessage(senderId, envelope.body);

      // Send ack for background-delivered messages too
      const senderContact = store.getContact(senderId);
      const localUserId = store.getUserId();
      if (senderContact && localUserId && envelope.id) {
        sendDeliveryAck(senderContact.fcmToken, envelope.id, localUserId).catch(() => {});
      }
    } catch {
      // Packet may have been encrypted for a previous session key — drop it
      console.warn('[FCM] Background packet could not be decrypted — dropped');
    }
  }
}

// ─── Inbound Payload Handler ─────────────────────────────────────────────────

/**
 * Parses an inbound FCM RemoteMessage. Handles two packet types:
 *
 *   Ack packet:     { senderId, ackMessageId } — flips a sent message to 'delivered'
 *   Message packet: { senderId, kemCiphertext, iv, authTag, ciphertext }
 *                   Decrypts, invokes handler, then sends an ack back to the sender.
 */
async function handleInboundPayload(
  remoteMessage: FirebaseMessagingTypes.RemoteMessage,
  onInboundMessage: InboundMessageHandler,
): Promise<void> {
  const data = remoteMessage.data;
  if (!data) return;

  const { kemCiphertext, iv, authTag, ciphertext, senderId, ackMessageId } = data as {
    kemCiphertext?: string;
    iv?: string;
    authTag?: string;
    ciphertext?: string;
    senderId?: string;
    ackMessageId?: string;
  };

  if (!senderId) {
    console.warn('[FCM] Missing senderId — ignoring');
    return;
  }

  // ── Ack packet ──────────────────────────────────────────────────────────────
  if (ackMessageId) {
    const found = store.findMessageById(ackMessageId);
    if (found) {
      store.updateMessageStatus(found.contactId, ackMessageId, 'delivered');
    }
    return;
  }

  // ── Message packet ──────────────────────────────────────────────────────────
  if (!kemCiphertext || !iv || !authTag || !ciphertext) {
    console.warn('[FCM] Incomplete packet fields — ignoring');
    return;
  }

  const packet: EncryptedPacket = { kemCiphertext, iv, authTag, ciphertext };
  const envelope = await decryptIncomingEnvelope(packet);

  // Invoke UI handler with decrypted body — only lives in call stack + React state
  onInboundMessage(senderId, envelope.body);

  // Send delivery ack back to the sender if we have a message ID to ack
  const senderContact = store.getContact(senderId);
  const localUserId = store.getUserId();
  if (senderContact && localUserId && envelope.id) {
    sendDeliveryAck(senderContact.fcmToken, envelope.id, localUserId).catch(() => {});
  }
}
