/**
 * PendingMessageStore.ts — Background Message Queue
 *
 * When a FCM data push arrives while the app is in the background or
 * killed state, the background handler cannot decrypt the packet because:
 *   - The secret key is wiped on background transition
 *   - The background JS context has no access to MemoryStore
 *
 * Solution: store the raw encrypted packet in a module-level queue in the
 * background handler's JS context. When the app returns to the foreground
 * and a new session is initialized, App.tsx calls drainPendingMessages()
 * which decrypts and injects all queued packets, then clears the queue.
 *
 * The queue holds EncryptedPacket + senderId only — never plaintext.
 * It is a plain in-memory array (module scope) — no disk writes.
 * It is cleared after draining and on session wipe.
 */

import type { EncryptedPacket } from '@betweenus/crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PendingPacket {
  packet: EncryptedPacket;
  senderId: string;
  receivedAt: number; // Unix ms — packets older than session TTL are dropped
}

// ─── Queue ───────────────────────────────────────────────────────────────────

// Shared across background handler and foreground drain call.
// The RN bridge ensures these run on the same JS thread.
const queue: PendingPacket[] = [];

// Packets older than this are dropped without attempting decryption.
// Matches the maximum FCM TTL (300s) with a small buffer.
const MAX_PENDING_AGE_MS = 310_000;

export function enqueuePendingPacket(pending: PendingPacket): void {
  queue.push(pending);
}

/**
 * Returns all packets received since the last drain, filtered to those
 * that arrived within MAX_PENDING_AGE_MS. Clears the queue.
 */
export function drainPendingPackets(): PendingPacket[] {
  const now = Date.now();
  const valid = queue.filter(p => now - p.receivedAt < MAX_PENDING_AGE_MS);
  queue.length = 0;
  return valid;
}

export function clearPendingQueue(): void {
  queue.length = 0;
}
