/**
 * relay.ts — Stateless FCM v1 Message Relay (Firebase Functions v2)
 *
 * Accepts an HTTPS POST containing:
 *   - fcmToken:      Recipient's FCM registration token
 *   - packet:        EncryptedPacket (kemCiphertext, iv, authTag, ciphertext, senderId)
 *   - ttlSeconds:    Time-to-live (1–300 seconds; enforced hard cap)
 *
 * Security guarantees:
 *   ✓ Zero disk writes — no Firestore, no Storage, no logging of payload
 *   ✓ Payload field whitelist — unauthorized fields stripped before relay
 *   ✓ Payload size enforcement — rejects over 3.5 KB (FCM budget headroom)
 *   ✓ TTL cap — never exceed 300s regardless of client request
 *   ✓ Logging level ERROR — ciphertext never appears in Cloud Logs
 *   ✓ CORS restricted to no origin (native-only; no browser cross-origin access)
 *
 * Rate limiting / abuse prevention:
 *   App Check tokens are verified on every request via verifyAppCheck().
 *   Set ENFORCE_APP_CHECK=true in Cloud Functions environment variables to
 *   reject requests without a valid token (recommended in production).
 *   Add Cloud Armor rate-limit policy for an extra layer if needed.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { logger } from 'firebase-functions/v2';
import * as admin from 'firebase-admin';
import { verifyAppCheck } from './appCheck';

// Lazy init — prevents cold-start double-initialization
if (admin.apps.length === 0) {
  admin.initializeApp();
}

// v2 global options — apply to all functions in this deployment
setGlobalOptions({
  maxInstances: 100,
  region: 'us-central1',
});

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_TTL_SECONDS = 300; // 5 minutes hard cap
const MAX_PAYLOAD_BYTES = 3584; // 3.5 KB — leaves headroom in 4 KB FCM limit

// Required for all packets
const REQUIRED_PACKET_FIELDS = ['senderId'] as const;
// Required only for message packets (not acks)
const MESSAGE_PACKET_FIELDS = ['kemCiphertext', 'iv', 'authTag', 'ciphertext'] as const;
// Optional — present on ack packets only
const OPTIONAL_PACKET_FIELDS = ['ackMessageId'] as const;
const ALLOWED_PACKET_FIELDS = [
  ...REQUIRED_PACKET_FIELDS,
  ...MESSAGE_PACKET_FIELDS,
  ...OPTIONAL_PACKET_FIELDS,
];

// ─── Schema ──────────────────────────────────────────────────────────────────

interface RelayRequest {
  fcmToken: string;
  packet: {
    kemCiphertext: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    senderId: string;
    ackMessageId?: string;
  };
  ttlSeconds: number;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export const relay = onRequest(
  {
    // minInstances: 0 is default; set to 1 to eliminate cold starts if budget allows
    minInstances: 0,
    cors: false, // Native-only; no browser access
  },
  async (req, res) => {
    // CORS: native mobile clients never send cross-origin requests.
    // Omitting Access-Control-Allow-Origin entirely means browsers cannot
    // make cross-origin requests to this endpoint at all — correct behaviour.
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // ── 1. App Check verification ───────────────────────────────────────────
    if (!await verifyAppCheck(req, res)) return;

    // ── 2. Validate content type ────────────────────────────────────────────
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Content-Type must be application/json' });
      return;
    }

    // ── 3. Parse & validate request body ───────────────────────────────────
    const body = req.body as Partial<RelayRequest>;

    if (!body.fcmToken || typeof body.fcmToken !== 'string') {
      res.status(400).json({ error: 'Missing or invalid fcmToken' });
      return;
    }

    if (!body.packet || typeof body.packet !== 'object') {
      res.status(400).json({ error: 'Missing packet' });
      return;
    }

    // Determine packet type: ack packets have ackMessageId and empty crypto fields
    const rawPacket = body.packet as Record<string, unknown>;
    const isAck = typeof rawPacket['ackMessageId'] === 'string' &&
      (rawPacket['ackMessageId'] as string).length > 0;

    // Whitelist: strip any unauthorized fields from the packet
    const sanitizedPacket: Record<string, string> = {};

    // senderId is required on all packets
    const senderIdValue = rawPacket['senderId'];
    if (typeof senderIdValue !== 'string' || senderIdValue.length === 0) {
      res.status(400).json({ error: 'Missing or invalid packet field: senderId' });
      return;
    }
    sanitizedPacket['senderId'] = senderIdValue;

    if (isAck) {
      // Ack packet: only ackMessageId + senderId are forwarded
      sanitizedPacket['ackMessageId'] = rawPacket['ackMessageId'] as string;
    } else {
      // Message packet: require all crypto fields to be non-empty
      for (const field of MESSAGE_PACKET_FIELDS) {
        const value = rawPacket[field];
        if (typeof value !== 'string' || value.length === 0) {
          res.status(400).json({ error: `Missing or invalid packet field: ${field}` });
          return;
        }
        sanitizedPacket[field] = value;
      }
    }

    // ── 4. Enforce TTL bounds ────────────────────────────────────────────────
    const requestedTTL =
      typeof body.ttlSeconds === 'number' ? body.ttlSeconds : 30;
    const ttlSeconds = Math.min(Math.max(1, requestedTTL), MAX_TTL_SECONDS);

    // ── 5. Enforce payload size ──────────────────────────────────────────────
    const payloadSize = Buffer.byteLength(JSON.stringify(sanitizedPacket), 'utf8');
    if (payloadSize > MAX_PAYLOAD_BYTES) {
      res.status(413).json({
        error: `Payload exceeds ${MAX_PAYLOAD_BYTES} byte limit`,
        actual: payloadSize,
      });
      return;
    }

    // ── 6. Construct FCM v1 message ──────────────────────────────────────────
    // Platform-specific TTL headers per spec
    const apnsExpiration = Math.floor(Date.now() / 1000) + ttlSeconds;

    const message: admin.messaging.Message = {
      token: body.fcmToken,

      // Data-only payload — no notification block
      // This ensures the app handles display; FCM never shows a system notification
      data: sanitizedPacket as Record<string, string>,

      android: {
        ttl: ttlSeconds * 1000, // Android SDK expects milliseconds
        priority: 'high',
      },

      apns: {
        headers: {
          'apns-push-type': 'background',
          'apns-priority': '5',
          'apns-expiration': String(apnsExpiration),
        },
        payload: {
          aps: {
            'content-available': 1, // Silent push — background data delivery
          },
        },
      },
    };

    // ── 7. Fire-and-forget to FCM ────────────────────────────────────────────
    // We do NOT log the message object — it contains the ciphertext blob
    try {
      const messageId = await admin.messaging().send(message);

      // Return only delivery confirmation; never echo back ciphertext
      res.status(200).json({
        ok: true,
        messageId,
        ttlSeconds,
      });
    } catch (err: unknown) {
      // Log error code only — NOT the message body
      const fcmError = err as { code?: string; message?: string };
      logger.error('FCM relay error', {
        code: fcmError.code,
        // Intentionally omitting fcmToken and payload from logs
      });

      if (fcmError.code === 'messaging/registration-token-not-registered') {
        res.status(404).json({ error: 'Recipient token not registered' });
      } else if (fcmError.code === 'messaging/invalid-argument') {
        res.status(400).json({ error: 'Invalid FCM message format' });
      } else {
        res.status(503).json({ error: 'Relay unavailable — retry' });
      }
    }
  },
);
