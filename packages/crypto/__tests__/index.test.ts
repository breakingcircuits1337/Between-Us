/**
 * @betweenus/crypto — Test Suite
 *
 * Covers:
 *   1.  Key generation — correct byte lengths
 *   2.  Encryption round-trip — decrypt(encrypt(msg)) === msg
 *   3.  Multi-message independence — different KEM ciphertexts each call
 *   4.  Tamper detection — modified authTag throws
 *   5.  Tamper detection — modified ciphertext body throws
 *   6.  Tamper detection — modified kemCiphertext produces wrong plaintext
 *   7.  Key serialization round-trip (base64 → Uint8Array → base64)
 *   8.  Large payload — near the 2 KB message budget
 *   9.  Zeroization — sharedSecret fill(0) does not break subsequent calls
 *  10.  Wrong key — decrypting with a different keypair throws
 *  11.  MessageEnvelope layer — encryptForContact / decryptIncomingEnvelope semantics
 */

import { webcrypto } from 'node:crypto';
// Node 20 exposes webcrypto as a global; polyfill for test environment
if (!globalThis.crypto) {
  // @ts-expect-error — webcrypto matches SubtleCrypto shape at runtime
  globalThis.crypto = webcrypto;
}

import {
  generateKeyPair,
  encryptMessage,
  decryptMessage,
  serializePublicKey,
  deserializePublicKey,
  type EncryptedPacket,
} from '../src/index';

// ─── 1. Key generation ────────────────────────────────────────────────────────

describe('generateKeyPair', () => {
  test('returns publicKey of exactly 1184 bytes', () => {
    const kp = generateKeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.byteLength).toBe(1184);
  });

  test('returns secretKey of exactly 2400 bytes', () => {
    const kp = generateKeyPair();
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey.byteLength).toBe(2400);
  });

  test('generates distinct keypairs each call', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    // Probability of collision is astronomically small
    expect(Buffer.from(kp1.publicKey).equals(Buffer.from(kp2.publicKey))).toBe(false);
  });
});

// ─── 2. Encryption round-trip ─────────────────────────────────────────────────

describe('encryptMessage / decryptMessage round-trip', () => {
  let recipientKP: ReturnType<typeof generateKeyPair>;

  beforeAll(() => {
    recipientKP = generateKeyPair();
  });

  test('decrypts to original plaintext', async () => {
    const plaintext = 'Hello, post-quantum world!';
    const packet = await encryptMessage(plaintext, recipientKP.publicKey);
    const recovered = await decryptMessage(packet, recipientKP.secretKey);
    expect(recovered).toBe(plaintext);
  });

  test('round-trips empty string', async () => {
    const packet = await encryptMessage('', recipientKP.publicKey);
    const recovered = await decryptMessage(packet, recipientKP.secretKey);
    expect(recovered).toBe('');
  });

  test('round-trips UTF-8 special characters', async () => {
    const plaintext = '🔒 PQC: δ, ж, 日本語, العربية';
    const packet = await encryptMessage(plaintext, recipientKP.publicKey);
    const recovered = await decryptMessage(packet, recipientKP.secretKey);
    expect(recovered).toBe(plaintext);
  });
});

// ─── 3. Multi-message independence ───────────────────────────────────────────

describe('encryptMessage — ephemeral per-message KEM', () => {
  test('produces distinct kemCiphertext each call', async () => {
    const kp = generateKeyPair();
    const msg = 'same plaintext';
    const p1 = await encryptMessage(msg, kp.publicKey);
    const p2 = await encryptMessage(msg, kp.publicKey);
    expect(p1.kemCiphertext).not.toBe(p2.kemCiphertext);
  });

  test('produces distinct iv each call', async () => {
    const kp = generateKeyPair();
    const p1 = await encryptMessage('x', kp.publicKey);
    const p2 = await encryptMessage('x', kp.publicKey);
    expect(p1.iv).not.toBe(p2.iv);
  });
});

// ─── 4. Tamper detection — authTag ───────────────────────────────────────────

describe('tamper detection', () => {
  let kp: ReturnType<typeof generateKeyPair>;
  let packet: EncryptedPacket;

  beforeAll(async () => {
    kp = generateKeyPair();
    packet = await encryptMessage('sensitive data', kp.publicKey);
  });

  test('throws when authTag is flipped', async () => {
    const tampered: EncryptedPacket = {
      ...packet,
      authTag: flipFirstByte(packet.authTag),
    };
    await expect(decryptMessage(tampered, kp.secretKey)).rejects.toThrow();
  });

  // ─── 5. Tamper detection — ciphertext body ───────────────────────────────

  test('throws when ciphertext body is flipped', async () => {
    const tampered: EncryptedPacket = {
      ...packet,
      ciphertext: flipFirstByte(packet.ciphertext),
    };
    await expect(decryptMessage(tampered, kp.secretKey)).rejects.toThrow();
  });

  // ─── 6. Wrong KEM ciphertext → decapsulate fails → wrong key → auth failure

  test('throws when kemCiphertext is replaced with another valid-length ciphertext', async () => {
    // Generate a fresh packet for the same key — its kemCiphertext is valid
    // length but belongs to a different encapsulation, producing a different
    // shared secret, which will fail the AES-GCM auth tag check.
    const decoy = await encryptMessage('decoy', kp.publicKey);
    const tampered: EncryptedPacket = {
      ...packet,
      kemCiphertext: decoy.kemCiphertext,
    };
    await expect(decryptMessage(tampered, kp.secretKey)).rejects.toThrow();
  });
});

// ─── 7. Key serialization round-trip ─────────────────────────────────────────

describe('serializePublicKey / deserializePublicKey', () => {
  test('round-trips cleanly', () => {
    const kp = generateKeyPair();
    const b64 = serializePublicKey(kp.publicKey);
    const recovered = deserializePublicKey(b64);
    expect(Buffer.from(recovered).equals(Buffer.from(kp.publicKey))).toBe(true);
  });

  test('serialized key is a valid base64 string', () => {
    const kp = generateKeyPair();
    const b64 = serializePublicKey(kp.publicKey);
    expect(/^[A-Za-z0-9+/=]+$/.test(b64)).toBe(true);
  });

  test('serialized key length is ~1580 chars (1184 bytes in base64)', () => {
    const kp = generateKeyPair();
    const b64 = serializePublicKey(kp.publicKey);
    // base64 of 1184 bytes = ceil(1184/3)*4 = 1580 chars
    expect(b64.length).toBe(Math.ceil(1184 / 3) * 4);
  });
});

// ─── 8. Large payload ────────────────────────────────────────────────────────

describe('large payload', () => {
  test('round-trips a ~1800-byte UTF-8 message', async () => {
    const kp = generateKeyPair();
    // ~1800 bytes of ASCII — near practical message budget
    const plaintext = 'A'.repeat(1800);
    const packet = await encryptMessage(plaintext, kp.publicKey);
    const recovered = await decryptMessage(packet, kp.secretKey);
    expect(recovered).toBe(plaintext);
  });
});

// ─── 9. Zeroization does not corrupt subsequent calls ────────────────────────

describe('zeroization safety', () => {
  test('keypair is still usable after a first encrypt/decrypt cycle', async () => {
    const kp = generateKeyPair();
    const msg1 = 'first message';
    const msg2 = 'second message';

    const p1 = await encryptMessage(msg1, kp.publicKey);
    await decryptMessage(p1, kp.secretKey); // zeroizes shared secret internally

    const p2 = await encryptMessage(msg2, kp.publicKey);
    const recovered = await decryptMessage(p2, kp.secretKey);
    expect(recovered).toBe(msg2);
  });
});

// ─── 10. Wrong recipient key ──────────────────────────────────────────────────

describe('wrong recipient key', () => {
  test('decrypting with a different keypair throws', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const packet = await encryptMessage('for alice only', alice.publicKey);
    // Bob tries to decrypt a message not addressed to him
    await expect(decryptMessage(packet, bob.secretKey)).rejects.toThrow();
  });
});

// ─── 11. MessageEnvelope layer ───────────────────────────────────────────────
// Mirrors the encryptForContact / decryptIncomingEnvelope logic in PQCEngine.ts
// but without the MemoryStore dependency so it runs in the pure crypto package.

interface MessageEnvelope {
  id: string;
  body: string;
}

async function encryptEnvelope(
  plaintext: string,
  msgId: string,
  recipientPublicKey: Uint8Array,
): Promise<ReturnType<typeof encryptMessage>> {
  const envelope: MessageEnvelope = { id: msgId, body: plaintext };
  return encryptMessage(JSON.stringify(envelope), recipientPublicKey);
}

async function decryptEnvelope(
  packet: EncryptedPacket,
  recipientSecretKey: Uint8Array,
): Promise<MessageEnvelope> {
  const raw = await decryptMessage(packet, recipientSecretKey);
  try {
    const parsed = JSON.parse(raw) as MessageEnvelope;
    if (typeof parsed.id !== 'string' || typeof parsed.body !== 'string') {
      return { id: '', body: raw };
    }
    return parsed;
  } catch {
    return { id: '', body: raw };
  }
}

describe('MessageEnvelope layer (encryptForContact / decryptIncomingEnvelope)', () => {
  let kp: ReturnType<typeof generateKeyPair>;

  beforeAll(() => {
    kp = generateKeyPair();
  });

  test('envelope round-trip preserves body and id', async () => {
    const id = 'msg-abc123';
    const body = 'Hello from the envelope layer';
    const packet = await encryptEnvelope(body, id, kp.publicKey);
    const recovered = await decryptEnvelope(packet, kp.secretKey);
    expect(recovered.id).toBe(id);
    expect(recovered.body).toBe(body);
  });

  test('envelope encrypts each message independently (different kemCiphertext)', async () => {
    const p1 = await encryptEnvelope('msg', 'id-1', kp.publicKey);
    const p2 = await encryptEnvelope('msg', 'id-2', kp.publicKey);
    expect(p1.kemCiphertext).not.toBe(p2.kemCiphertext);
  });

  test('decryption with wrong key throws on envelope', async () => {
    const other = generateKeyPair();
    const packet = await encryptEnvelope('secret', 'id-x', kp.publicKey);
    await expect(decryptEnvelope(packet, other.secretKey)).rejects.toThrow();
  });

  test('tampered authTag fails at envelope layer', async () => {
    const packet = await encryptEnvelope('tamper-test', 'id-t', kp.publicKey);
    const tampered: EncryptedPacket = { ...packet, authTag: flipFirstByte(packet.authTag) };
    await expect(decryptEnvelope(tampered, kp.secretKey)).rejects.toThrow();
  });

  test('envelope body is not readable without the secret key (tampered kemCiphertext)', async () => {
    const decoy = await encryptEnvelope('decoy', 'id-d', kp.publicKey);
    const packet = await encryptEnvelope('real', 'id-r', kp.publicKey);
    const tampered: EncryptedPacket = { ...packet, kemCiphertext: decoy.kemCiphertext };
    await expect(decryptEnvelope(tampered, kp.secretKey)).rejects.toThrow();
  });

  test('UTF-8 message body survives envelope round-trip', async () => {
    const body = '🔐 post-quantum: 日本語, العربية, Ελληνικά';
    const packet = await encryptEnvelope(body, 'id-utf8', kp.publicKey);
    const recovered = await decryptEnvelope(packet, kp.secretKey);
    expect(recovered.body).toBe(body);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Flip the first byte of a base64-encoded value. */
function flipFirstByte(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  bytes[0] ^= 0xff;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
