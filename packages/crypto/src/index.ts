/**
 * @betweenus/crypto — Post-Quantum Cryptographic Engine
 *
 * Implements:
 *   - Key Encapsulation: ML-KEM-768 (CRYSTALS-Kyber, NIST FIPS 203)
 *   - Symmetric Encryption: AES-256-GCM (authenticated encryption)
 *
 * Security Properties:
 *   - Harvest-now-decrypt-later resistant (PQC KEM)
 *   - Forward secrecy via ephemeral encapsulation per message
 *   - Authenticated ciphertext (GCM auth tag)
 *   - All key material lives in caller's memory; never touches disk
 */

import { ml_kem768 as mlkem768 } from '@noble/post-quantum/ml-kem';
import { randomBytes } from '@noble/hashes/utils';

// ─── Types ─────────────────────────────────────────────────────────────────

/** ML-KEM-768 key pair. Both fields are raw Uint8Array; store in volatile RAM. */
export interface PQCKeyPair {
  /** Public key — safe to share out-of-band (QR code, NFC). 1184 bytes. */
  publicKey: Uint8Array;
  /** Secret key — NEVER leave device. Wipe on app close. 2400 bytes. */
  secretKey: Uint8Array;
}

/** Wire format for an encrypted message packet. */
export interface EncryptedPacket {
  /**
   * ML-KEM ciphertext from encapsulate(). Recipient uses this + their sk
   * to recover the shared secret. 1088 bytes base64-encoded.
   */
  kemCiphertext: string; // base64

  /**
   * AES-256-GCM random nonce. 12 bytes base64-encoded.
   * Single-use — unique per message.
   */
  iv: string; // base64

  /**
   * AES-256-GCM authentication tag. 16 bytes base64-encoded.
   * Verifies ciphertext integrity before decryption.
   */
  authTag: string; // base64

  /**
   * AES-256-GCM encrypted plaintext body. Variable length.
   */
  ciphertext: string; // base64
}

// ─── Key Generation ─────────────────────────────────────────────────────────

/**
 * Generates a fresh ML-KEM-768 key pair.
 *
 * Call once per app session. Store result only in volatile memory.
 * Wipe by overwriting with zeros or losing reference (GC).
 *
 * @example
 * const kp = generateKeyPair();
 * // share kp.publicKey via QR; keep kp.secretKey local
 */
export function generateKeyPair(): PQCKeyPair {
  const { publicKey, secretKey } = mlkem768.keygen();
  return { publicKey, secretKey };
}

// ─── Encryption ─────────────────────────────────────────────────────────────

/**
 * Encrypts a plaintext message for a recipient using ML-KEM-768 + AES-256-GCM.
 *
 * Flow:
 *   1. mlkem768.encapsulate(recipientPublicKey) → { sharedSecret K, kemCiphertext C }
 *   2. AES-256-GCM.encrypt(plaintext, key=K, iv=random96bit) → { ciphertext, authTag }
 *   3. Return wire packet { C, iv, authTag, ciphertext }
 *
 * The sharedSecret K is ephemeral — discarded after encrypt; not stored.
 *
 * @param plaintext     Raw message string (UTF-8)
 * @param recipientPK   Recipient's ML-KEM-768 public key (1184 bytes)
 * @returns             EncryptedPacket ready for relay dispatch
 * @throws              If Web Crypto API is unavailable
 */
export async function encryptMessage(
  plaintext: string,
  recipientPK: Uint8Array,
): Promise<EncryptedPacket> {
  // Step 1: PQC key encapsulation — derive ephemeral shared secret
  const { cipherText: kemCiphertext, sharedSecret } =
    mlkem768.encapsulate(recipientPK);

  // Step 2: AES-256-GCM symmetric encryption
  const key = await importAESKey(sharedSecret);
  const iv = randomBytes(12); // 96-bit nonce — MUST be unique per message
  const plaintextBytes = new TextEncoder().encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer, tagLength: 128 },
    key,
    plaintextBytes,
  );

  // AES-GCM appends the 16-byte auth tag to the ciphertext buffer
  const encryptedArray = new Uint8Array(encrypted);
  const ciphertext = encryptedArray.slice(0, -16);
  const authTag = encryptedArray.slice(-16);

  // Zeroize the shared secret immediately after use
  sharedSecret.fill(0);

  return {
    kemCiphertext: toBase64(kemCiphertext),
    iv: toBase64(iv),
    authTag: toBase64(authTag),
    ciphertext: toBase64(ciphertext),
  };
}

// ─── Decryption ─────────────────────────────────────────────────────────────

/**
 * Decrypts an EncryptedPacket using the recipient's ML-KEM-768 secret key.
 *
 * Flow:
 *   1. mlkem768.decapsulate(kemCiphertext, secretKey) → sharedSecret K
 *   2. AES-256-GCM.decrypt(ciphertext, key=K, iv, authTag) → plaintext
 *   3. Zeroize K; return plaintext string
 *
 * If the auth tag fails verification, throws — message has been tampered with.
 *
 * @param packet    Wire packet received from FCM push notification
 * @param secretKey Local ML-KEM-768 secret key (2400 bytes, in-memory only)
 * @returns         Decrypted plaintext string
 * @throws          DOMException if auth tag mismatch (tampered/corrupted packet)
 * @throws          Error if KEM decapsulation fails
 */
export async function decryptMessage(
  packet: EncryptedPacket,
  secretKey: Uint8Array,
): Promise<string> {
  // Step 1: PQC decapsulation — recover shared secret
  const kemCiphertextBytes = fromBase64(packet.kemCiphertext);
  const sharedSecret = mlkem768.decapsulate(kemCiphertextBytes, secretKey);

  // Step 2: AES-256-GCM authenticated decryption
  const key = await importAESKey(sharedSecret);
  const iv = fromBase64(packet.iv);
  const authTag = fromBase64(packet.authTag);
  const ciphertext = fromBase64(packet.ciphertext);

  // Recombine ciphertext + auth tag as expected by Web Crypto
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer, tagLength: 128 },
      key,
      combined,
    );
  } finally {
    // Zeroize shared secret regardless of decryption outcome
    sharedSecret.fill(0);
  }

  return new TextDecoder().decode(decrypted);
}

// ─── Key Serialization ───────────────────────────────────────────────────────

/**
 * Serializes a public key to base64 for QR code / NFC transmission.
 * Safe to transmit over any channel.
 */
export function serializePublicKey(pk: Uint8Array): string {
  return toBase64(pk);
}

/**
 * Deserializes a base64-encoded public key (e.g., scanned from QR code).
 */
export function deserializePublicKey(b64: string): Uint8Array {
  return fromBase64(b64);
}

// ─── Utilities ───────────────────────────────────────────────────────────────

async function importAESKey(rawKey: Uint8Array): Promise<CryptoKey> {
  // ML-KEM shared secret is 32 bytes — perfect for AES-256
  // slice() creates a copy; zeroize it after import to match our zeroization policy
  const keyMaterial = rawKey.slice(0, 32);
  try {
    return await crypto.subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'AES-GCM' },
      false, // non-extractable
      ['encrypt', 'decrypt'],
    );
  } finally {
    keyMaterial.fill(0);
  }
}

function toBase64(bytes: Uint8Array): string {
  // Avoid spread-operator stack overflow for large buffers (e.g. KEM ciphertext)
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
