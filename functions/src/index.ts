/**
 * BETWEENUS — Stateless Cloud Functions Entry Point (Firebase Functions v2)
 *
 * Exported functions:
 *   - relay:         FCM v1 fire-and-forget message relay
 *   - registerKey:   Ephemeral public key + FCM token registry (TTL-gated Firestore write)
 *   - fetchKey:      Public key + FCM token lookup by derived userId
 *
 * Zero-persistence mandate:
 *   - relay() never writes ciphertext to any storage
 *   - registerKey() writes ONLY public keys and FCM tokens with strict TTL; auto-expires
 *   - All functions use App Check token verification (ENFORCE_APP_CHECK env var)
 *   - Function-level logging excludes payload fields to prevent ciphertext
 *     appearing in Cloud Logging traces
 */

export { relay } from './relay';
export { registerKey, fetchKey } from './keyRegistry';
