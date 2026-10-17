# Local Development Guide

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) |
| Java | ≥ 11 | Required for Firebase Emulator Suite |
| Firebase CLI | latest | `npm i -g firebase-tools` |
| Android Studio | latest | For Android emulator |
| Xcode | ≥ 15 | For iOS simulator (macOS only) |

---

## 1 — Install Dependencies

```bash
# Root (no workspaces — install per package)
cd packages/crypto && npm ci && cd ../..
cd functions && npm ci && cd ..
cd apps/mobile && npm ci && cd ../..
```

---

## 2 — Environment Variables

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```bash
# Get this from: Firebase Console → App Check → Apps → Debug tokens
FIREBASE_APPCHECK_DEBUG_TOKEN=your-token-here

# Keep false locally — App Check enforcement is off in emulator mode
ENFORCE_APP_CHECK=false
```

---

## 3 — Run the Firebase Emulator

The emulator replaces the deployed Cloud Functions for local testing. It does
**not** require a service account key — the emulator bypasses Admin SDK auth.

```bash
# From the repo root
cd functions && npm run serve
```

This starts:
- Functions emulator on `http://localhost:5001`
- Firestore emulator on `http://localhost:8080`
- Emulator UI on `http://localhost:4000`

Set `RELAY_BASE_URL` in `.env.local` to point at the local emulator:

```bash
# .env.local (gitignored)
RELAY_BASE_URL=http://localhost:5001/YOUR_PROJECT_ID/us-central1
```

Expo SDK 50+ automatically picks up `.env.local` during `expo start` / `expo run:*`,
so `app.config.js` will forward the value into the app via `expo-constants`.

> On a physical device, replace `localhost` with your machine's LAN IP (e.g. `192.168.1.x`).

---

## 4 — Run the Mobile App

```bash
cd apps/mobile

# Android (physical device or emulator)
npx expo run:android

# iOS simulator (macOS only)
npx expo run:ios
```

### Using a development build with EAS

```bash
# Build a development client (once — installs native modules)
eas build --profile development --platform android
eas build --profile development --platform ios

# Then start the dev server
npx expo start --dev-client
```

The `eas.json` build profiles are:

| Profile | Purpose |
|---------|---------|
| `development` | Local dev with debug App Check token, `developmentClient: true` |
| `preview` | Internal distribution APK/IPA for testing |
| `production` | Store submission (AAB/IPA) |

---

## 5 — Run Tests

### Crypto package (unit tests)

```bash
cd packages/crypto && npm test
# or from repo root:
npm test
```

Expected output: 23 tests passing, no deprecation warnings.

### Cloud Functions (unit tests)

```bash
cd functions && npm test
# or from repo root:
npm run test:functions
```

Expected output: 28 tests passing. Tests mock firebase-admin — no emulator needed.

### All tests (CI mode with coverage)

```bash
npm run test:ci
```

---

## 6 — Typecheck Everything

```bash
npm run typecheck
# or individually:
cd packages/crypto && npx tsc --noEmit
cd functions && npx tsc --noEmit
cd apps/mobile && npx tsc --noEmit
```

---

## 7 — Full Production Deploy

```bash
# Deploy Firestore indexes + rules + Cloud Functions in one step:
npm run deploy:all
```

This runs `deploy:indexes → deploy:rules → deploy:functions` in sequence.

---

## Common Issues

### `@react-native-firebase` modules not found
These are native modules — they don't work in Expo Go. You must use a
development build (`npx expo run:android` or `eas build --profile development`).

### Emulator: `JAVA_HOME is not set`
Install Java 11+ and set `JAVA_HOME`:
```bash
# macOS (Homebrew)
brew install openjdk@17
export JAVA_HOME=$(brew --prefix openjdk@17)

# Ubuntu
sudo apt install openjdk-17-jdk
```

### App Check token rejected locally
Make sure `FIREBASE_APPCHECK_DEBUG_TOKEN` in `.env.local` matches the debug
token registered in Firebase Console → App Check → Apps → your app → Manage
debug tokens.

### FCM not working on emulator
Firebase Cloud Messaging does not work on Android emulators without Google Play
Services. Use a physical device or an emulator image that includes Google Play.
