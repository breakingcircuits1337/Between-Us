<div align="center">

```
██████╗ ███████╗████████╗██╗    ██╗███████╗███████╗███╗   ██╗██╗   ██╗███████╗
██╔══██╗██╔════╝╚══██╔══╝██║    ██║██╔════╝██╔════╝████╗  ██║██║   ██║██╔════╝
██████╔╝█████╗     ██║   ██║ █╗ ██║█████╗  █████╗  ██╔██╗ ██║██║   ██║███████╗
██╔══██╗██╔══╝     ██║   ██║███╗██║██╔══╝  ██╔══╝  ██║╚██╗██║██║   ██║╚════██║
██████╔╝███████╗   ██║   ╚███╔███╔╝███████╗███████╗██║ ╚████║╚██████╔╝███████║
╚═════╝ ╚══════╝   ╚═╝    ╚══╝╚══╝ ╚══════╝╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝
```

**Stateless · Post-Quantum · Ephemeral Messaging**

*No database. No logs. No history. Messages exist only in transit and in RAM.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PQC: ML-KEM-768](https://img.shields.io/badge/PQC-ML--KEM--768-purple)](https://csrc.nist.gov/pubs/fips/203/final)
[![Cipher: AES-256-GCM](https://img.shields.io/badge/Cipher-AES--256--GCM-green)](https://en.wikipedia.org/wiki/Galois/Counter_Mode)
[![Transport: FCM v1](https://img.shields.io/badge/Transport-FCM%20v1-orange)](https://firebase.google.com/docs/cloud-messaging)
[![CI](https://github.com/yourorg/betweenus/actions/workflows/ci.yml/badge.svg)](https://github.com/yourorg/betweenus/actions/workflows/ci.yml)

</div>

---

## What is BETWEENUS?

BETWEENUS is a **zero-persistence ephemeral messenger** built on three guarantees:

1. **No server stores anything** — the relay is a pure HTTP-to-FCM forwarder with zero disk writes
2. **No client stores anything** — all keys and messages live in volatile RAM, wiped on app close
3. **No classical crypto** — every session uses **ML-KEM-768** (NIST FIPS 203 / CRYSTALS-Kyber), nullifying harvest-now-decrypt-later attacks

If a message is not delivered before its TTL expires, it disappears forever — from FCM, from the relay, from everywhere.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        CLIENT — Volatile RAM Only                         │
│                                                                            │
│   ┌─────────────────┐    ┌───────────────────┐    ┌──────────────────┐   │
│   │  ML-KEM-768     │    │   AES-256-GCM     │    │  TTL Watchdog    │   │
│   │  Keypair        │───▶│   Encrypt/Decrypt │    │  Scheduled timer │   │
│   │  (RAM only)     │    │   (Web Crypto API)│    │  → UI expiry     │   │
│   └─────────────────┘    └───────────────────┘    └──────────────────┘   │
│                                    │                                       │
│                    HTTPS POST (ciphertext blob + TTL)                      │
└────────────────────────────────────┼─────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                STATELESS RELAY — Firebase Cloud Function v2               │
│                                                                            │
│   • Accepts POST → App Check verify → validates JSON schema               │
│   • Strips unauthorized fields; enforces 3.5 KB payload cap               │
│   • Enforces 300s TTL hard ceiling                                        │
│   • Constructs FCM v1 payload with platform TTL headers                   │
│   • ZERO disk writes — no Firestore, no Storage, no payload logging       │
│                                                                            │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │ FCM v1 REST API
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    FCM INFRASTRUCTURE — Google                             │
│                                                                            │
│   Android: android.ttl (ms)    ──┐                                        │
│   iOS:     apns-expiration (s)  ─┤── Packet held until delivery or drop  │
│                                  └── Expired packets → void (no log)      │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Cryptographic Specification

| Layer              | Algorithm           | Standard          | Purpose                         |
|--------------------|---------------------|-------------------|---------------------------------|
| Key Encapsulation  | **ML-KEM-768**      | NIST FIPS 203     | Post-quantum shared secret      |
| Symmetric Cipher   | **AES-256-GCM**     | NIST SP 800-38D   | Authenticated payload encryption|
| Key Exchange       | **QR Code / NFC**   | Out-of-band       | Public key distribution         |
| Nonce              | **96-bit random**   | CSPRNG            | Single-use per message          |

### Why ML-KEM-768?

Classical ECDH/RSA is vulnerable to **harvest-now-decrypt-later (HNDL)** attacks — an adversary records ciphertext today and decrypts it once a cryptographically relevant quantum computer arrives. ML-KEM-768 is immune to Shor's algorithm, providing long-term security regardless of future quantum advances.

### Message Flow

```
SENDER                                              RECIPIENT
  │                                                     │
  │   [Key Exchange — out of band via QR scan]          │
  │◀────────────── Bob's ML-KEM-768 PK (1184 bytes) ───│
  │                                                     │
  │   mlkem768.encapsulate(Bob.publicKey)               │
  │   → sharedSecret K  (ephemeral, 32 bytes)           │
  │   → kemCiphertext C (1088 bytes)                    │
  │                                                     │
  │   AES-256-GCM.encrypt({ id, body }, K, iv_96)       │
  │   → { iv, authTag, ciphertext }                     │
  │                                                     │
  │   K ──── ZEROIZED (.fill(0)) ─────────────────────  │
  │                                                     │
  │── HTTPS POST → relay ─────────────────────────────▶ FCM
  │   { C, iv, authTag, ciphertext, senderId, ttl }     │
  │                                                     │
  │                       mlkem768.decapsulate(C, sk)   │
  │                       → sharedSecret K              │
  │                                                     │
  │                       AES-256-GCM.decrypt           │
  │                       → { id, body } (displayed)    │
  │                                                     │
  │                       K ──── ZEROIZED ───────────── │
  │                                                     │
  │◀── Delivery Ack (ackMessageId via relay) ───────────│
  │    Status flipped: 'sent' → 'delivered'             │
```

---

## Repository Structure

```
BETWEENUS/
│
├── packages/
│   └── crypto/                       # @betweenus/crypto
│       ├── src/index.ts              # ML-KEM-768 + AES-256-GCM engine
│       └── __tests__/index.test.ts   # 23 tests: round-trip, tamper, envelope, edge cases
│
├── functions/                        # Firebase Cloud Functions v2
│   └── src/
│       ├── index.ts                  # Barrel export
│       ├── appCheck.ts               # App Check token verification middleware
│       ├── relay.ts                  # Stateless FCM v1 relay (zero disk writes)
│       └── keyRegistry.ts            # Ephemeral public key + FCM token store (24h TTL)
│
├── apps/
│   └── mobile/                       # React Native (Expo bare workflow)
│       └── src/
│           ├── App.tsx               # Session bootstrap + error/permission states
│           ├── store/
│           │   ├── MemoryStore.ts    # Volatile RAM state — no AsyncStorage
│           │   └── PendingMessageStore.ts  # Background message queue
│           ├── crypto/
│           │   └── PQCEngine.ts      # RN PQC adapter (encrypt / decrypt / QR)
│           ├── services/
│           │   ├── AppCheckService.ts  # Firebase App Check initialization
│           │   ├── FCMService.ts       # Token acquisition + inbound handler + acks
│           │   └── RelayService.ts     # HTTPS relay client + key registry client
│           ├── screens/
│           │   ├── HomeScreen.tsx    # QR display + contact list
│           │   ├── ChatScreen.tsx    # Ephemeral thread + scheduled TTL watchdog
│           │   └── ScanScreen.tsx    # Camera QR scanner + registry key fetch
│           └── components/
│               ├── ErrorBoundary.tsx # Render-error recovery
│               ├── SessionSplash.tsx # Loading/re-init screen
│               ├── TTLBadge.tsx      # Live countdown / delivery status UI
│               ├── MessageBubble.tsx # Ephemeral message bubble
│               └── KeyQRCode.tsx     # Public key QR renderer (no FCM token)
│
├── .github/workflows/ci.yml         # CI: typecheck + tests on every PR
├── firestore.rules                   # Deny all direct client DB access
├── firestore.indexes.json            # TTL auto-expiry on keys.expiresAt
├── firebase.json
└── .firebaserc
```

---

## Security Model

| Threat                              | Mitigation                                                    |
|-------------------------------------|---------------------------------------------------------------|
| Harvest-now-decrypt-later           | ML-KEM-768 (NIST FIPS 203) — quantum-safe KEM                |
| Master key compromise               | Ephemeral per-message encapsulation; no long-term KEM key     |
| Ciphertext in server logs           | Relay logs error codes only — payload fields excluded         |
| Message persistence on server       | Relay has zero Firestore / Cloud Storage writes               |
| Key material on disk                | All keys in volatile RAM; `.fill(0)` zeroization after use    |
| App backgrounding exposure          | `AppState` listener triggers `store.clearSession()`           |
| Auth tag bypass / tampered packets  | AES-GCM 128-bit tag — decryption throws on mismatch           |
| Nonce reuse                         | 96-bit CSPRNG nonce, unique per message                       |
| Relay reading plaintext             | Relay receives only PQC ciphertext — never plaintext          |
| Undelivered message exposure        | FCM drops at TTL — no dead-letter queue, no tombstoning       |
| Key registry data leakage           | Only public keys stored (safe by PQC design); 24h auto-expiry |
| FCM token in QR code                | FCM token stored server-side only; QR contains public key only|
| userId spoofing / key overwrite     | userId derived server-side from SHA-256(publicKey)            |
| Direct DB client access             | Firestore rules deny all client reads/writes                  |
| Unauthenticated relay abuse         | Firebase App Check enforced on all Cloud Functions            |
| Key registry DoS / flooding         | Sliding-window rate limit: 10 registrations / 120 lookups per IP per hour |

---

## Quick Start

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) |
| npm | ≥ 10 | bundled with Node |
| Firebase CLI | latest | `npm i -g firebase-tools` |
| Expo CLI | latest | `npm i -g expo-cli` |
| EAS CLI | latest | `npm i -g eas-cli` |

You also need a **Firebase project** with:
- Cloud Functions enabled (Blaze plan required)
- Cloud Messaging (FCM) enabled
- Firestore enabled (for the key registry)
- App Check enabled (Play Integrity / App Attest)

> ⚠️ **Expo Go is not supported.** This project uses native modules (`@react-native-firebase`, `@notifee/react-native`) that require a custom development build. Use `expo run:android` / `expo run:ios` or EAS Build.

---

### Step 1 — Install

```bash
git clone https://github.com/yourorg/betweenus.git
cd BETWEENUS
npm install
```

---

### Step 2 — Configure Firebase Project

```bash
firebase login

# Set your project ID
nano .firebaserc
# → "default": "YOUR_FIREBASE_PROJECT_ID"
```

Place your **Firebase Admin SDK service account key** at:

```
functions/serviceAccount.json
```

> ⚠️ This file is `.gitignored`. Never commit it.

Generate one at: **Firebase Console → Project Settings → Service Accounts → Generate New Private Key**

---

### Step 3 — Deploy Everything (Functions + Firestore Rules + TTL Index)

```bash
# Install function dependencies (first time only)
cd functions && npm install && cd ..

# Deploy indexes, security rules, and all Cloud Functions in one command:
npm run deploy:all
```

Or deploy individually:

```bash
npm run deploy:indexes    # Firestore TTL index (keys.expiresAt) + rateLimits index
npm run deploy:rules      # Firestore security rules (deny all direct client access)
npm run deploy:functions  # Cloud Functions (relay, registerKey, fetchKey)
```

Note the deployed URLs:
```
https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/relay
https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/registerKey
https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/fetchKey
```

Set `ENFORCE_APP_CHECK=true` in each function's environment variables in the Firebase Console before going to production.

---

### Step 4 — Verify Firestore TTL

The Firestore TTL index is deployed by `npm run deploy:indexes` (via `firestore.indexes.json`).
Confirm it's active in the Firebase Console:
1. **Firestore → Indexes → Single Field**
2. Look for `keys / expiresAt` with TTL enabled ✓

Key documents auto-delete after 24 hours. Rate-limit documents in `rateLimits/` have no TTL — they naturally roll over when the 1-hour window expires.

---

### Step 5 — Enable Firebase App Check

1. **Firebase Console → App Check → Get started**
2. Register your Android app with **Play Integrity**
3. Register your iOS app with **App Attest**
4. Go to **Cloud Functions** and enforce App Check on `relay`, `registerKey`, `fetchKey`

For local development, set a debug token:
```bash
# .env.local (gitignored)
FIREBASE_APPCHECK_DEBUG_TOKEN=your-debug-token-from-firebase-console
```

---

### Step 6 — Configure the Mobile App

Set the relay URL via environment variable — **do not edit `RelayService.ts`**.

**For local development**, add to `.env.local` (gitignored):

```bash
RELAY_BASE_URL=https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net
```

**For EAS Build (preview / production)**, register an EAS Secret:

```bash
eas secret:create --scope project --name RELAY_BASE_URL \
  --value https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net
```

The value is read at build time via [`apps/mobile/app.config.js`](apps/mobile/app.config.js) and
exposed through `expo-constants` — no secret ever touches source control.

Add the FCM platform config files:

| File | Path |
|------|------|
| `google-services.json` | `apps/mobile/google-services.json` |
| `GoogleService-Info.plist` | `apps/mobile/GoogleService-Info.plist` |

---

### Step 7 — Build and Run (bare workflow)

```bash
# Android
cd apps/mobile && npx expo run:android

# iOS
cd apps/mobile && npx expo run:ios

# Or use EAS Build for a full production build
eas build --platform android
eas build --platform ios
```

---

### Step 8 — Run Tests

```bash
npm test          # crypto package tests (23 tests)
npm run test:ci   # with coverage report
```

---

## TTL Reference

### Recommended Thresholds

| Sensitivity | TTL  | Use Case                        |
|-------------|------|---------------------------------|
| Maximum     | 30s  | One-time codes, location pins   |
| High        | 60s  | Default — most messages         |
| Medium      | 120s | Longer compose time needed      |
| Low         | 300s | Background delivery tolerance   |

### Platform Encoding

```
Android → message.android.ttl       = ttlSeconds * 1000   (milliseconds)
iOS     → apns-expiration header    = Unix.now() + ttlSeconds
```

---

## Payload Size Budget

FCM data payload hard cap is **4,096 bytes**.

| Field | Typical Size |
|-------|-------------|
| ML-KEM-768 `kemCiphertext` (base64) | ~1,450 bytes |
| AES-GCM `iv` (base64) | 16 bytes |
| AES-GCM `authTag` (base64) | 24 bytes |
| JSON overhead + FCM envelope | ~200 bytes |
| **Available for message body** | **~2,400 bytes** |

The relay enforces a **3,584-byte server-side cap** as safety margin.

---

## Zero-Persistence Guarantee Checklist

- [x] Relay function makes **zero Firestore writes**
- [x] Relay function makes **zero Cloud Storage writes**
- [x] Payload fields are **excluded from all log output**
- [x] Shared secrets are **`.fill(0)` zeroized** immediately after use
- [x] Client state lives in **in-process Map only** — no AsyncStorage reads
- [x] App background event **wipes all session state**
- [x] Key registry stores **public keys and FCM tokens only** — keys are not sensitive by PQC design
- [x] Key documents **auto-delete** via Firestore TTL policy after 24h
- [x] Firestore rules **block all direct client read/write access**
- [x] FCM drops undelivered packets at TTL — **no dead-letter queue**
- [x] FCM token **not exposed in QR code** — stored server-side only
- [x] userId is **derived from SHA-256(publicKey)** server-side — cannot be spoofed

---

## License

MIT — Use responsibly. BETWEENUS is a research and demonstration project, not a certified cryptographic product. For regulated environments, conduct an independent security audit.
