/**
 * ChatScreen.tsx — Ephemeral Message Thread
 *
 * Displays the in-memory message thread for a contact.
 * Handles:
 *   - Message composition with TTL selector
 *   - PQC encryption before send
 *   - Relay dispatch and status tracking
 *   - TTL watchdog: marks messages as expired when timer fires
 *   - No persistence — thread is empty on next app launch
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { MessageBubble } from '../components/MessageBubble';
import { store, type EphemeralMessage } from '../store/MemoryStore';
import { encryptForContact } from '../crypto/PQCEngine';
import { sendEncryptedPacket } from '../services/RelayService';
import type { AppParamList } from '../navigation/AppNavigator';

type ChatRoute = RouteProp<AppParamList, 'Chat'>;

// Available TTL options in seconds
const TTL_OPTIONS = [30, 60, 120, 300] as const;
type TTLOption = typeof TTL_OPTIONS[number];

const TTL_LABELS: Record<TTLOption, string> = {
  30: '30s',
  60: '1m',
  120: '2m',
  300: '5m',
};

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function ChatScreen(): React.ReactElement {
  const route = useRoute<ChatRoute>();
  const { contactId } = route.params;
  const contact = store.getContact(contactId);

  const [messages, setMessages] = useState<EphemeralMessage[]>(
    () => store.getMessages(contactId),
  );
  const [inputText, setInputText] = useState('');
  const [selectedTTL, setSelectedTTL] = useState<TTLOption>(60);
  const [isSending, setIsSending] = useState(false);

  // Enforce a 400-byte plaintext budget. FCM has a 4 KB total data payload cap;
  // ML-KEM-768 kemCiphertext (~1088 B base64) + AES-GCM overhead + JSON envelope
  // consumes ~1700 B, leaving ~400 bytes for the message body.
  //
  // We track bytes (not chars) because emoji/CJK can be 3-4 bytes per character.
  // `onChangeText` hard-clamps input so the user cannot type past the limit —
  // removing the unreliable `maxLength` char-count prop.
  const MAX_MESSAGE_BYTES = 400;

  const countBytes = (s: string): number => new TextEncoder().encode(s).length;

  const handleChangeText = useCallback((text: string): void => {
    // If the new value already exceeds the limit, truncate to the last codepoint
    // that keeps total bytes ≤ MAX_MESSAGE_BYTES.
    if (countBytes(text) <= MAX_MESSAGE_BYTES) {
      setInputText(text);
      return;
    }
    // Binary-search the longest prefix whose byte length ≤ MAX_MESSAGE_BYTES
    let lo = 0;
    let hi = [...text].length; // codepoint count (handles surrogates correctly)
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (countBytes([...text].slice(0, mid).join('')) <= MAX_MESSAGE_BYTES) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    setInputText([...text].slice(0, lo).join(''));
  }, []);

  const inputByteLength = useMemo(() => countBytes(inputText), [inputText]);
  // isOverBudget can only be true transiently (e.g. paste of a huge block);
  // the handler above clamps on every keystroke.
  const isOverBudget = inputByteLength > MAX_MESSAGE_BYTES;
  const listRef = useRef<FlatList>(null);

  // ── TTL Watchdog ─────────────────────────────────────────────────────────
  // Schedules a single timeout at the next message expiry rather than polling
  // every second. Re-schedules itself after each expiry until no 'sent'
  // messages remain.
  useEffect(() => {
    function scheduleNextExpiry(): ReturnType<typeof setTimeout> | null {
      const now = Date.now();
      const sentMessages = store.getMessages(contactId)
        .filter(m => m.status === 'sent' && m.expiresAt > now);

      if (sentMessages.length === 0) return null;

      const nextExpiry = Math.min(...sentMessages.map(m => m.expiresAt));
      const delay = Math.max(0, nextExpiry - now);

      return setTimeout(() => {
        const nowFired = Date.now();
        const updated = store.getMessages(contactId).map(msg => {
          if (msg.status === 'sent' && msg.expiresAt <= nowFired) {
            store.updateMessageStatus(contactId, msg.id, 'expired');
            return { ...msg, status: 'expired' as const };
          }
          return msg;
        });
        setMessages([...updated]);
        scheduleNextExpiry(); // re-schedule for the next one
      }, delay);
    }

    const timer = scheduleNextExpiry();
    return () => { if (timer) clearTimeout(timer); };
  }, [contactId, messages]);

  // ── Dispatch Helper ───────────────────────────────────────────────────────
  // Shared by handleSend (new message) and handleRetry (re-send failed message).
  const dispatchMessage = useCallback(async (
    msgId: string,
    text: string,
    ttlSeconds: TTLOption,
  ): Promise<void> => {
    if (!contact) return;

    store.updateMessageStatus(contactId, msgId, 'sending');
    setMessages(store.getMessages(contactId).map(m =>
      m.id === msgId ? { ...m, status: 'sending' as const } : m,
    ));

    try {
      const packet = await encryptForContact(contactId, msgId, text);
      const localUserId = store.getUserId() ?? 'unknown';
      const fcmPacket = { ...packet, senderId: localUserId };

      // Read the FCM token fresh from the store at dispatch time rather than
      // closing over the contact object captured at render — avoids stale token
      // if the contact was re-registered between renders.
      const currentContact = store.getContact(contactId);
      const fcmToken = currentContact?.fcmToken ?? contact?.fcmToken ?? '';

      const result = await sendEncryptedPacket(fcmToken, fcmPacket, ttlSeconds);
      const newStatus = result.ok ? 'sent' : 'error';

      store.updateMessageStatus(contactId, msgId, newStatus);
      setMessages(store.getMessages(contactId).map(m =>
        m.id === msgId ? { ...m, status: newStatus } : m,
      ));
    } catch {
      store.updateMessageStatus(contactId, msgId, 'error');
      setMessages(store.getMessages(contactId).map(m =>
        m.id === msgId ? { ...m, status: 'error' as const } : m,
      ));
    }
  }, [contact, contactId]);

  // ── Send Handler ──────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !contact || isSending) return;

    setInputText('');
    setIsSending(true);

    const msgId = generateId();
    const now = Date.now();

    // Optimistic message insert
    const outMsg: EphemeralMessage = {
      id: msgId,
      direction: 'out',
      plaintextBody: text,
      status: 'sending',
      ttlSeconds: selectedTTL,
      sentAt: now,
      expiresAt: now + selectedTTL * 1000,
    };

    store.addMessage(contactId, outMsg);
    setMessages(prev => [...prev, outMsg]);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);

    await dispatchMessage(msgId, text, selectedTTL);
    setIsSending(false);
  }, [inputText, contact, contactId, selectedTTL, isSending, dispatchMessage]);

  // ── Retry Handler ─────────────────────────────────────────────────────────
  const handleRetry = useCallback(async (msg: EphemeralMessage) => {
    if (isSending) return;
    setIsSending(true);

    // Reset expiresAt from now so the message gets a fresh TTL window
    const now = Date.now();
    const ttl = (msg.ttlSeconds || 60) as TTLOption;
    store.updateMessageStatus(contactId, msg.id, 'sending');
    // Update expiresAt directly via store reference
    const thread = store.getMessages(contactId);
    const stored = thread.find(m => m.id === msg.id);
    if (stored) {
      stored.expiresAt = now + ttl * 1000;
      stored.sentAt = now;
    }
    setMessages([...store.getMessages(contactId)]);

    await dispatchMessage(msg.id, msg.plaintextBody, ttl);
    setIsSending(false);
  }, [isSending, contactId, dispatchMessage]);

  if (!contact) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.errorText}>Contact not found in session memory</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Thread header */}
      <View style={styles.chatHeader}>
        <Text style={styles.contactName}>{contact.displayName}</Text>
        <Text style={styles.encLabel}>🔒 ML-KEM-768 · Session only</Text>
      </View>

      {/* Message list */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={m => m.id}
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            onRetry={item.status === 'error' ? () => handleRetry(item) : undefined}
          />
        )}
        contentContainerStyle={styles.messageList}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
      />

      {/* Compose bar */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={90}
      >
        {/* TTL selector */}
        <View style={styles.ttlRow}>
          <Text style={styles.ttlLabel}>TTL:</Text>
          {TTL_OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt}
              style={[styles.ttlChip, selectedTTL === opt && styles.ttlChipActive]}
              onPress={() => setSelectedTTL(opt)}
            >
              <Text style={[styles.ttlChipText, selectedTTL === opt && styles.ttlChipTextActive]}>
                {TTL_LABELS[opt]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Input row */}
        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, isOverBudget && styles.inputOverBudget]}
            value={inputText}
            onChangeText={handleChangeText}
            placeholder="Ephemeral message…"
            placeholderTextColor="#374151"
            multiline
            returnKeyType="send"
            onSubmitEditing={handleSend}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!inputText.trim() || isSending || isOverBudget) && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!inputText.trim() || isSending || isOverBudget}
          >
            <Text style={styles.sendBtnText}>↑</Text>
          </TouchableOpacity>
        </View>
      {inputByteLength > 350 && (
        <Text style={[styles.budgetWarning, isOverBudget && styles.budgetWarningOver]}>
          {inputByteLength}/{MAX_MESSAGE_BYTES} bytes{isOverBudget ? ' — too long' : ''}
        </Text>
      )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f' },
  errorText: { color: '#ef4444', textAlign: 'center', marginTop: 40 },

  chatHeader: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a2e',
    alignItems: 'center',
  },
  contactName: { color: '#e8e8f0', fontSize: 16, fontWeight: '700' },
  encLabel: { color: '#374151', fontSize: 10, marginTop: 2, letterSpacing: 0.5 },

  messageList: { paddingVertical: 12, paddingBottom: 8 },

  ttlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: '#111827',
  },
  ttlLabel: { color: '#4b5563', fontSize: 11, marginRight: 4 },
  ttlChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e3a5f',
  },
  ttlChipActive: { backgroundColor: '#1e3a5f', borderColor: '#3b82f6' },
  ttlChipText: { color: '#4b5563', fontSize: 11 },
  ttlChipTextActive: { color: '#93c5fd', fontWeight: '600' },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#111827',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#1e3a5f',
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#e8e8f0',
    fontSize: 15,
    maxHeight: 120,
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#1e40af',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#1a1a2e' },
  sendBtnText: { color: '#93c5fd', fontSize: 20, fontWeight: '700' },
  inputOverBudget: { borderColor: '#ef4444' },
  budgetWarning: {
    color: '#6b7280',
    fontSize: 11,
    textAlign: 'center',
    paddingBottom: 4,
  },
  budgetWarningOver: {
    color: '#ef4444',
  },
});
