# Security Policy

## Scope

BETWEENUS is a research and demonstration project for post-quantum ephemeral
messaging. The following components are **in scope** for security reports:

| Component | Scope |
|-----------|-------|
| `packages/crypto` — ML-KEM-768 + AES-256-GCM implementation | ✅ In scope |
| `functions/src/relay.ts` — FCM relay logic and payload validation | ✅ In scope |
| `functions/src/keyRegistry.ts` — Public key registry | ✅ In scope |
| `apps/mobile` — Session lifecycle, key handling, FCM integration | ✅ In scope |
| Third-party dependencies (Firebase, `@noble/post-quantum`) | ⬆ Report upstream |
| Social engineering, phishing | ❌ Out of scope |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities by emailing:

```
security@betweenus.app
```

Include:
- A description of the vulnerability and its impact
- Steps to reproduce or a proof-of-concept
- The affected component and version/commit SHA
- Any suggested mitigations (optional)

You will receive an acknowledgement within **48 hours** and a resolution
timeline within **7 days** of the initial report.

## Disclosure Policy

- We follow **coordinated disclosure**: please allow 90 days for a fix before
  publishing details publicly.
- If a fix requires longer than 90 days, we will communicate a revised timeline
  and coordinate a joint disclosure date.
- We will credit reporters in the release notes unless anonymity is requested.

## Cryptographic Notice

BETWEENUS uses:
- **ML-KEM-768** (NIST FIPS 203) for key encapsulation
- **AES-256-GCM** for symmetric authenticated encryption

Neither algorithm has known practical attacks. However, this project has
**not undergone a formal cryptographic audit**. For use in regulated or
high-assurance environments, commission an independent audit before deployment.

## Supported Versions

| Version | Supported |
|---------|-----------|
| `main` branch | ✅ Current |
| All prior releases | ❌ No backports |
