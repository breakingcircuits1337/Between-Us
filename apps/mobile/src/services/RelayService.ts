/**
 * RelayService.ts — HTTPS Relay Client
 *
 * Handles communication with the stateless Firebase Cloud Function relay.
 * Responsible for:
 *   - Sending encrypted packets via POST /relay
 *   - Registering the local public key via POST /registerKey (optional)
 *   - Fetching peer public keys via GET /fetchKey (fallback to QR)
 *
 * The relay endpoint URL must be configured before first use.
 * Never transmit plaintext through this service.
 */

import Constants from 'expo-constants';
import { EncryptedPacket } from '../crypto/PQCEngine';

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Base URL of the deployed Firebase Cloud Functions.
 *
 * Injected at build time via app.config.js → EAS Secret RELAY_BASE_URL.
 * Falls back to the placeholder so the app still compiles locally before the
 * secret is configured — network calls will simply fail gracefully.
 */
const RELAY_BASE_URL: string =
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  (Constants.expoConfig?.extra as { relayBaseUrl?: string } | undefined)
    ?.relayBaseUrl ??
  'https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net';

const RELAY_ENDPOINT = `${RELAY_BASE_URL}/relay`;
const REGISTER_KEY_ENDPOINT = `${RELAY_BASE_URL}/registerKey`;
const FETCH_KEY_ENDPOINT = `${RELAY_BASE_URL}/fetchKey`;

// ─── Types ───────────────────────────────────────────────────────────────────

export type SendResult =
  | { ok: true; messageId: string; ttlSeconds: number }
  | { ok: false; error: string };

// ─── Send Message ─────────────────────────────────────────────────────────────

/**
 * Dispatches an encrypted packet to the relay for FCM delivery.
 *
 * @param fcmToken    Recipient's FCM registration token
 * @param packet      ML-KEM-encapsulated, AES-256-GCM encrypted payload
 * @param ttlSeconds  Time-to-live (clamped server-side to 300s max)
 * @returns           SendResult with FCM message ID on success
 */
export async function sendEncryptedPacket(
  fcmToken: string,
  packet: EncryptedPacket,
  ttlSeconds: number = 60,
): Promise<SendResult> {
  try {
    const response = await fetch(RELAY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fcmToken, packet, ttlSeconds }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      return {
        ok: false,
        error: (errorBody as { error?: string }).error ?? `HTTP ${response.status}`,
      };
    }

    const data = await response.json() as { ok: boolean; messageId: string; ttlSeconds: number };
    return { ok: true, messageId: data.messageId, ttlSeconds: data.ttlSeconds };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}

// ─── Key Registry ─────────────────────────────────────────────────────────────

/**
 * Publishes the local public key and FCM token to the ephemeral key registry.
 * Call once after key generation so peers can discover the key and delivery
 * address without a direct QR code scan.
 *
 * @param publicKey  Base64 ML-KEM-768 public key
 * @param fcmToken   Local FCM registration token
 */
export async function publishPublicKey(
  publicKey: string,
  fcmToken: string,
): Promise<{ ok: boolean; userId?: string; expiresAt?: string; error?: string }> {
  try {
    const response = await fetch(REGISTER_KEY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No userId sent — server derives it from SHA-256(publicKey)
      body: JSON.stringify({ publicKey, fcmToken }),
    });

    const data = await response.json() as { ok?: boolean; userId?: string; expiresAt?: string; error?: string };
    return response.ok
      ? { ok: true, userId: data.userId, expiresAt: data.expiresAt }
      : { ok: false, error: data.error };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

// ─── Send Ack ─────────────────────────────────────────────────────────────────

/**
 * Sends a delivery acknowledgement back to the original sender.
 * The ack is a normal relay call with `ackMessageId` in the packet so the
 * relay passes it through and the sender's FCM handler can flip the status.
 *
 * @param senderFcmToken  The original sender's FCM token (from their Contact record)
 * @param ackMessageId    ID of the outbound message being acknowledged
 * @param localUserId     Recipient's own userId (routed back as senderId on the ack)
 */
export async function sendDeliveryAck(
  senderFcmToken: string,
  ackMessageId: string,
  localUserId: string,
): Promise<void> {
  // Ack packets are tiny — no encryption needed (ackMessageId is not sensitive;
  // it is a locally generated random ID, never the message content).
  // We still go through the relay so the sender's FCM token is never exposed
  // to the recipient directly.
  try {
    await fetch(RELAY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fcmToken: senderFcmToken,
        packet: {
          kemCiphertext: '',   // empty — relay whitelists but doesn't validate length for ack
          iv: '',
          authTag: '',
          ciphertext: '',
          senderId: localUserId,
          ackMessageId,        // extra field — relay passes it through as data
        },
        ttlSeconds: 30,        // acks are time-sensitive; short TTL
      }),
    });
  } catch {
    // Ack failure is non-fatal — sender's message stays 'sent' until TTL
  }
}

/**
 * Fetches a peer's public key and FCM token from the key registry.
 * Returns null if not found or expired (peer must re-share QR).
 */
export async function fetchPeerContact(
  userId: string,
): Promise<{ publicKey: string; fcmToken: string } | null> {
  try {
    const response = await fetch(
      `${FETCH_KEY_ENDPOINT}?userId=${encodeURIComponent(userId)}`,
    );
    if (!response.ok) return null;
    const data = await response.json() as { publicKey?: string; fcmToken?: string };
    if (!data.publicKey || !data.fcmToken) return null;
    return { publicKey: data.publicKey, fcmToken: data.fcmToken };
  } catch {
    return null;
  }
}
