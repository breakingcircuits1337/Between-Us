/**
 * keyRegistry.ts — Ephemeral Public Key Registry (Firebase Functions v2)
 *
 * Stores ML-KEM-768 public keys and FCM tokens in Firestore with hard TTL expiry.
 * This is the ONLY Firestore write in the core message path.
 *
 * Design rationale:
 *   - Public keys are not sensitive (safe to share openly per PQC design)
 *   - FCM tokens are stored server-side so they are never exposed in QR codes
 *   - Enables async key + token discovery without out-of-band channel
 *   - Keys auto-expire via Firestore TTL policy on the `expiresAt` field
 *   - No message content, no ciphertext, no metadata ever stored here
 *
 * Firestore document schema (collection: `keys/{userId}`):
 *   {
 *     publicKey: string,     // base64 ML-KEM-768 public key (1184 bytes → ~1580 chars)
 *     fcmToken:  string,     // FCM registration token for push delivery routing
 *     expiresAt: Timestamp,  // Firestore TTL field — document auto-deleted
 *     createdAt: Timestamp,
 *   }
 *
 * Rate-limit document schema (collection: `rateLimits/{ip}`):
 *   {
 *     registerCount: number,  // registrations in current window
 *     fetchCount:    number,  // fetches in current window
 *     windowStart:   number,  // Unix ms — window resets after RATE_WINDOW_MS
 *   }
 *
 * Firestore TTL Policy (set this in Firebase Console → Firestore → TTL):
 *   Collection: keys
 *   Field:      expiresAt
 */

import { createHash } from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import * as admin from 'firebase-admin';
import { verifyAppCheck } from './appCheck';

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

// Key registry TTL — 24 hours; user must re-register after app restart anyway
// (keys are in volatile RAM, so they naturally reset on app close)
const KEY_REGISTRY_TTL_SECONDS = 86_400; // 24 hours

// ML-KEM-768 public key is 1184 bytes → base64 is ~1580 chars
const PUBLIC_KEY_MIN_LENGTH = 1000;
const PUBLIC_KEY_MAX_LENGTH = 2000;

// ─── Rate Limiting ────────────────────────────────────────────────────────────
// Sliding-window counter stored in Firestore. Each source IP gets a document
// in the `rateLimits` collection. The window resets after RATE_WINDOW_MS.
//
// Limits are intentionally generous — one registration per app session is
// the expected pattern; limits protect against DoS, not usage metering.

const RATE_WINDOW_MS = 60 * 60 * 1000; // 1-hour sliding window
const REGISTER_LIMIT = 10;             // registrations per IP per hour
const FETCH_LIMIT    = 120;            // lookups per IP per hour

type RateLimitField = 'registerCount' | 'fetchCount';

interface RateLimitDoc {
  registerCount: number;
  fetchCount:    number;
  windowStart:   number;
}

/**
 * Increments a rate-limit counter for the given IP and operation type.
 * Returns true if the request is allowed, false if the limit is exceeded.
 *
 * Uses a Firestore transaction to read-increment-check atomically.
 * Rate-limit documents live in `rateLimits/{ip}` and are never sensitive.
 */
async function checkRateLimit(
  ip: string,
  field: RateLimitField,
  limit: number,
): Promise<boolean> {
  const ref = db.collection('rateLimits').doc(ip);

  try {
    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();

      if (!snap.exists) {
        // First request from this IP — create window
        tx.set(ref, { registerCount: 0, fetchCount: 0, windowStart: now });
        return true; // count will be 1 after increment below, still under any limit
      }

      const data = snap.data() as RateLimitDoc;
      const windowAge = now - data.windowStart;

      if (windowAge > RATE_WINDOW_MS) {
        // Window expired — reset counters
        tx.set(ref, { registerCount: 0, fetchCount: 0, windowStart: now });
        return true;
      }

      const current = data[field] ?? 0;
      if (current >= limit) {
        return false; // limit exceeded; do NOT increment
      }

      tx.update(ref, { [field]: current + 1 });
      return true;
    });

    return allowed;
  } catch (err) {
    // If rate-limit check itself fails (Firestore outage), fail open —
    // we do not want a Firestore hiccup to lock all users out.
    logger.warn('Rate-limit check failed — failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * Derives a stable, collision-resistant userId from a public key.
 * Uses the first 16 hex chars of SHA-256(publicKey) — 64 bits of entropy,
 * sufficient for a non-secret identifier in a low-scale system.
 * The client can no longer claim an arbitrary userId and overwrite another
 * user's key registration.
 */
function deriveUserId(publicKeyB64: string): string {
  return createHash('sha256').update(publicKeyB64).digest('hex').slice(0, 16);
}

// ─── Register Key ─────────────────────────────────────────────────────────────

/**
 * POST /registerKey
 * Body: { userId: string, publicKey: string (base64) }
 *
 * Upserts the public key for a given userId with a 24h TTL.
 * Call this once when the app generates a new keypair.
 */
export const registerKey = onRequest(
  { cors: false },
  async (req, res) => {
    // No CORS headers — native-only endpoint; browsers blocked by default.
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
    if (!await verifyAppCheck(req, res)) return;

    // ── Rate limiting ────────────────────────────────────────────────────────
    const clientIp = req.ip ?? req.headers['x-forwarded-for'] ?? 'unknown';
    const ip = Array.isArray(clientIp) ? clientIp[0] : clientIp;
    if (!await checkRateLimit(ip, 'registerCount', REGISTER_LIMIT)) {
      res.status(429).json({
        error: 'Too many registrations — try again later',
        retryAfterSeconds: Math.ceil(RATE_WINDOW_MS / 1000),
      });
      return;
    }

    const { publicKey, fcmToken } = req.body as { publicKey?: string; fcmToken?: string };

    // ── Validation ──────────────────────────────────────────────────────────
    // userId is derived server-side from the public key — never trusted from client
    if (
      !publicKey ||
      typeof publicKey !== 'string' ||
      publicKey.length < PUBLIC_KEY_MIN_LENGTH ||
      publicKey.length > PUBLIC_KEY_MAX_LENGTH
    ) {
      res.status(400).json({ error: 'Invalid publicKey length' });
      return;
    }

    // Basic base64 validation
    if (!/^[A-Za-z0-9+/=]+$/.test(publicKey)) {
      res.status(400).json({ error: 'publicKey must be base64' });
      return;
    }

    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.length === 0) {
      res.status(400).json({ error: 'Missing or invalid fcmToken' });
      return;
    }

    // ── Write ───────────────────────────────────────────────────────────────
    const derivedUserId = deriveUserId(publicKey);
    const now = admin.firestore.Timestamp.now();
    const expiresAt = admin.firestore.Timestamp.fromMillis(
      Date.now() + KEY_REGISTRY_TTL_SECONDS * 1000,
    );

    try {
      await db.collection('keys').doc(derivedUserId).set({
        publicKey,        // Public key — safe to store (PQC design)
        fcmToken,         // FCM token — stored server-side, never in QR
        createdAt: now,
        expiresAt,        // Firestore TTL policy deletes this document at this time
      });

      // Return the derived userId so the client knows what ID to share with peers
      res.status(200).json({ ok: true, userId: derivedUserId, expiresAt: expiresAt.toDate().toISOString() });
    } catch (err) {
      logger.error('keyRegistry.registerKey error', { derivedUserId });
      res.status(503).json({ error: 'Key registration failed' });
    }
  },
);

// ─── Fetch Key ────────────────────────────────────────────────────────────────

/**
 * GET /fetchKey?userId=xxx
 *
 * Returns the public key for the specified userId, if registered and not expired.
 * Used when QR/NFC key exchange is not possible.
 */
export const fetchKey = onRequest(
  { cors: false },
  async (req, res) => {
    // No CORS headers — native-only endpoint; browsers blocked by default.
    if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
    if (!await verifyAppCheck(req, res)) return;

    // ── Rate limiting ────────────────────────────────────────────────────────
    const clientIp = req.ip ?? req.headers['x-forwarded-for'] ?? 'unknown';
    const ip = Array.isArray(clientIp) ? clientIp[0] : clientIp;
    if (!await checkRateLimit(ip, 'fetchCount', FETCH_LIMIT)) {
      res.status(429).json({
        error: 'Too many lookups — try again later',
        retryAfterSeconds: Math.ceil(RATE_WINDOW_MS / 1000),
      });
      return;
    }

    const userId = req.query['userId'];
    // userId is now a 16-char hex string derived from SHA-256(publicKey)
    if (!userId || typeof userId !== 'string' || !/^[0-9a-f]{16}$/.test(userId)) {
      res.status(400).json({ error: 'Invalid userId (expected 16-char hex)' });
      return;
    }

    try {
      const doc = await db.collection('keys').doc(userId).get();

      if (!doc.exists) {
        res.status(404).json({ error: 'Key not found or expired' });
        return;
      }

      const data = doc.data()!;

      // Belt-and-suspenders: check expiry in case TTL policy is lagging
      const expiresAt: admin.firestore.Timestamp = data['expiresAt'];
      if (expiresAt.toMillis() < Date.now()) {
        res.status(404).json({ error: 'Key expired' });
        return;
      }

      // Return public key and FCM token — both needed by the scanning peer
      res.status(200).json({
        publicKey: data['publicKey'],
        fcmToken:  data['fcmToken'],
      });
    } catch (err) {
      logger.error('keyRegistry.fetchKey error', { userId });
      res.status(503).json({ error: 'Key fetch failed' });
    }
  },
);
