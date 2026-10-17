/**
 * PQCEngine.ts — React Native PQC Crypto Adapter
 *
 * Wraps @betweenus/crypto for use in the React Native environment.
 * Handles:
 *   - Session keypair generation and volatile storage
 *   - Message encryption for outbound sends
 *   - Message decryption for inbound FCM payloads
 *   - Base64 QR payload encoding/decoding for key exchange
 *
 * All crypto operations are async (Web Crypto API backed).
 * Key material never touches AsyncStorage or native file system.
 */

import {
  generateKeyPair,
  encryptMessage,
  decryptMessage,
  serializePublicKey,
  deserializePublicKey,
  type PQCKeyPair,
  type EncryptedPacket,
} from '@betweenus/crypto';

import { store } from '../store/MemoryStore';

export type { EncryptedPacket };

// ─── Session Init ─────────────────────────────────────────────────────────────

/**
 * Generates a fresh ML-KEM-768 keypair for this session.
 * Stores it in volatile MemoryStore. Call once on app launch.
 *
 * @returns Public key as base64 (safe to display in QR code)
 */
export async function initializeSession(): Promise<string> {
  const kp: PQCKeyPair = generateKeyPair();
  store.setKeyPair(kp);
  return serializePublicKey(kp.publicKey);
}

// ─── Encrypt ─────────────────────────────────────────────────────────────────

/**
 * Wire format for the plaintext envelope.
 * The message ID is included so the recipient can send a specific delivery ack.
 */
export interface MessageEnvelope {
  id: string;    // Local message ID — not secret, used only for ack routing
  body: string;  // Actual plaintext content
}

/**
 * Encrypts a message envelope for a recipient identified by their userId.
 * Recipient must already be in the MemoryStore contact book.
 *
 * @param recipientUserId  Target contact's userId
 * @param msgId            Local message ID (for ack routing)
 * @param plaintext        Raw message text
 * @throws Error if contact not found or has no public key
 */
export async function encryptForContact(
  recipientUserId: string,
  msgId: string,
  plaintext: string,
): Promise<EncryptedPacket> {
  const contact = store.getContact(recipientUserId);
  if (!contact) {
    throw new Error(`No contact found for userId: ${recipientUserId}`);
  }
  const envelope: MessageEnvelope = { id: msgId, body: plaintext };
  return encryptMessage(JSON.stringify(envelope), contact.publicKey);
}

/**
 * Decrypts an incoming EncryptedPacket and parses the message envelope.
 * Returns the envelope containing the sender's message ID and plaintext body.
 */
export async function decryptIncomingEnvelope(
  packet: EncryptedPacket,
): Promise<MessageEnvelope> {
  const kp = store.getKeyPair();
  if (!kp) {
    throw new Error('No active session keypair — re-launch app');
  }
  const raw = await decryptMessage(packet, kp.secretKey);
  try {
    const envelope = JSON.parse(raw) as MessageEnvelope;
    if (typeof envelope.id !== 'string' || typeof envelope.body !== 'string') {
      // Backwards-compatible: treat raw string as body with unknown id
      return { id: '', body: raw };
    }
    return envelope;
  } catch {
    // Non-JSON payload (old client) — treat as raw body
    return { id: '', body: raw };
  }
}

// ─── Decrypt ─────────────────────────────────────────────────────────────────

/**
 * Decrypts an incoming EncryptedPacket using the local session secret key.
 *
 * @throws Error if no session keypair exists (app not initialized)
 * @throws DOMException if authentication tag verification fails (tampered data)
 */
export async function decryptIncoming(packet: EncryptedPacket): Promise<string> {
  const kp = store.getKeyPair();
  if (!kp) {
    throw new Error('No active session keypair — re-launch app');
  }
  return decryptMessage(packet, kp.secretKey);
}

// ─── QR Key Exchange ─────────────────────────────────────────────────────────

/**
 * Builds the QR payload string to display as a scannable QR code.
 * Format: JSON with userId and publicKey (base64) only.
 *
 * The FCM token is intentionally excluded — it is stored server-side in the
 * key registry and fetched by the scanning peer via fetchPeerContact().
 * This prevents accidental FCM token exposure to anyone who photographs the QR.
 *
 * The QR payload is the out-of-band key exchange mechanism.
 */
export function buildQRPayload(): string | null {
  const kp = store.getKeyPair();
  const userId = store.getUserId();

  if (!kp || !userId) return null;

  return JSON.stringify({
    v: 2,                                      // Protocol version (v2: no FCM in QR)
    uid: userId,
    pk: serializePublicKey(kp.publicKey),      // ML-KEM-768 public key
  });
}

/**
 * Parses a scanned QR payload and registers the contact in MemoryStore.
 * The contact's FCM token is fetched from the key registry server.
 *
 * @param qrPayload   Raw string from QR scan
 * @param displayName User-supplied display name
 * @param fcmToken    Token fetched from the key registry for the scanned userId
 *
 * @throws SyntaxError if payload is not valid JSON
 * @throws Error if payload schema is invalid or public key is malformed
 */
export function importContactFromQR(
  qrPayload: string,
  displayName: string,
  fcmToken: string,
): void {
  let parsed: { v: number; uid: string; pk: string; fcm?: string };

  try {
    parsed = JSON.parse(qrPayload);
  } catch {
    throw new Error('Invalid QR code — not parseable JSON');
  }

  // Accept v1 (legacy, had fcm field) and v2 (no fcm field)
  if (!parsed.uid || !parsed.pk || (parsed.v !== 1 && parsed.v !== 2)) {
    throw new Error('Invalid QR code — missing required fields or wrong version');
  }

  // v1 compatibility: use embedded fcm if present and no registry token provided
  const resolvedFcmToken = fcmToken || parsed.fcm || '';
  if (!resolvedFcmToken) {
    throw new Error('Could not resolve FCM token — key registry unavailable');
  }

  let publicKey: Uint8Array;
  try {
    publicKey = deserializePublicKey(parsed.pk);
  } catch {
    throw new Error('Invalid QR code — public key decoding failed');
  }

  // ML-KEM-768 public key is exactly 1184 bytes
  if (publicKey.length !== 1184) {
    throw new Error(`Invalid public key length: ${publicKey.length} (expected 1184)`);
  }

  store.addContact({
    userId: parsed.uid,
    displayName,
    publicKey,
    fcmToken: resolvedFcmToken,
    addedAt: Date.now(),
  });
}
