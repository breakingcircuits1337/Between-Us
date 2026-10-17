/**
 * MemoryStore.ts — Volatile In-Memory State
 *
 * All application state lives here. Nothing in this module touches
 * AsyncStorage, MMKV, SQLite, or any disk-backed store.
 *
 * Lifecycle:
 *   - Populated on app launch (key generation, FCM token fetch)
 *   - Read throughout session for encrypt/decrypt operations
 *   - Implicitly wiped when the process terminates (app close, OS kill)
 *   - Explicitly wipe-able via clearSession() for manual TTL logout
 *
 * Thread safety: React Native runs JS on a single thread; no mutex needed.
 */

import { PQCKeyPair } from '@betweenus/crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'expired' | 'error';

/** Ack packet sent by the recipient back to the sender */
export interface AckPacket {
  ackMessageId: string; // ID of the outbound message being acknowledged
  senderId: string;     // Recipient's userId (so sender can route correctly)
}

export interface EphemeralMessage {
  id: string;                  // UUID, local only — never transmitted
  direction: 'out' | 'in';
  plaintextBody: string;       // Decrypted text — displayed then discarded
  status: MessageStatus;
  ttlSeconds: number;
  sentAt: number;              // Unix ms timestamp
  expiresAt: number;           // Unix ms timestamp for UI countdown
}

export interface Contact {
  userId: string;
  displayName: string;
  publicKey: Uint8Array;       // ML-KEM-768 PK — scanned from QR / fetched from registry
  fcmToken: string;
  addedAt: number;
}

// ─── Store ───────────────────────────────────────────────────────────────────

class MemoryStore {
  // Own keypair — generated once per app session; never persisted
  private _keyPair: PQCKeyPair | null = null;

  // Own FCM registration token — fetched from Firebase on init
  private _fcmToken: string | null = null;

  // Own userId — ephemeral; regenerated each session
  private _userId: string | null = null;

  // Contact book — in volatile RAM; user must re-add via QR on next session
  private _contacts: Map<string, Contact> = new Map();

  // Active message thread — messages visible only while app is open
  private _messages: Map<string, EphemeralMessage[]> = new Map();

  // ── Key Pair ──────────────────────────────────────────────────────────────

  setKeyPair(kp: PQCKeyPair): void {
    this._keyPair = kp;
  }

  getKeyPair(): PQCKeyPair | null {
    return this._keyPair;
  }

  /** Zeroize key material — call on session end or manual wipe */
  wipeKeyPair(): void {
    if (this._keyPair) {
      this._keyPair.publicKey.fill(0);
      this._keyPair.secretKey.fill(0);
      this._keyPair = null;
    }
  }

  // ── FCM Token ─────────────────────────────────────────────────────────────

  setFCMToken(token: string): void {
    this._fcmToken = token;
  }

  getFCMToken(): string | null {
    return this._fcmToken;
  }

  // ── User ID ───────────────────────────────────────────────────────────────

  setUserId(id: string): void {
    this._userId = id;
  }

  getUserId(): string | null {
    return this._userId;
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  addContact(contact: Contact): void {
    this._contacts.set(contact.userId, contact);
  }

  getContact(userId: string): Contact | undefined {
    return this._contacts.get(userId);
  }

  getAllContacts(): Contact[] {
    return Array.from(this._contacts.values());
  }

  removeContact(userId: string): void {
    this._contacts.delete(userId);
    this._messages.delete(userId);
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  addMessage(contactId: string, msg: EphemeralMessage): void {
    const thread = this._messages.get(contactId) ?? [];
    thread.push(msg);
    this._messages.set(contactId, thread);
  }

  getMessages(contactId: string): EphemeralMessage[] {
    return this._messages.get(contactId) ?? [];
  }

  updateMessageStatus(
    contactId: string,
    messageId: string,
    status: MessageStatus,
  ): void {
    const thread = this._messages.get(contactId);
    if (!thread) return;
    const msg = thread.find(m => m.id === messageId);
    if (msg) msg.status = status;
  }

  /**
   * Finds a message by ID across all threads.
   * Used to apply a delivery ack without knowing the contactId upfront.
   * Returns the contactId and message, or undefined if not found.
   */
  findMessageById(messageId: string): { contactId: string; msg: EphemeralMessage } | undefined {
    for (const [contactId, thread] of this._messages) {
      const msg = thread.find(m => m.id === messageId);
      if (msg) return { contactId, msg };
    }
    return undefined;
  }

  /** Remove expired messages from a thread (both inbound and outbound). */
  pruneExpired(contactId: string): void {
    const now = Date.now();
    const thread = this._messages.get(contactId);
    if (!thread) return;
    this._messages.set(
      contactId,
      thread.filter(m => m.expiresAt > now),
    );
  }

  // ── Session Wipe ──────────────────────────────────────────────────────────

  /** Hard wipe all volatile state. Call on app backgrounding or manual clear. */
  clearSession(): void {
    this.wipeKeyPair();
    this._fcmToken = null;
    this._userId = null;
    this._contacts.clear();
    this._messages.clear();
  }
}

// Singleton — one store per JS runtime instance
export const store = new MemoryStore();
