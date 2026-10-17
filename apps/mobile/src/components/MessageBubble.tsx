/**
 * MessageBubble.tsx — Ephemeral Message Display
 *
 * Renders a single message bubble. Inbound messages display plaintext
 * that was decrypted in RAM — the component does NOT store anything
 * beyond its own render cycle. Outbound messages show TTLBadge status.
 *
 * Error bubbles show a "Tap to retry" affordance when an onRetry callback
 * is provided.
 */

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { TTLBadge } from './TTLBadge';
import type { EphemeralMessage } from '../store/MemoryStore';

interface MessageBubbleProps {
  message: EphemeralMessage;
  /** Called when the user taps a failed outbound message to retry. */
  onRetry?: () => void;
}

export function MessageBubble({ message, onRetry }: MessageBubbleProps): React.ReactElement {
  const isOutbound = message.direction === 'out';
  const time = new Date(message.sentAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const bubbleContent = (
    <View style={[styles.bubble, isOutbound ? styles.bubbleOut : styles.bubbleIn]}>
      <Text style={styles.bodyText}>{message.plaintextBody}</Text>
      <Text style={styles.timeText}>{time}</Text>
      {isOutbound && (
        <TTLBadge status={message.status} expiresAt={message.expiresAt} />
      )}
      {isOutbound && message.status === 'error' && onRetry && (
        <Text style={styles.retryHint}>Tap to retry</Text>
      )}
    </View>
  );

  return (
    <View style={[styles.wrapper, isOutbound ? styles.wrapperOut : styles.wrapperIn]}>
      {isOutbound && message.status === 'error' && onRetry ? (
        <TouchableOpacity onPress={onRetry} activeOpacity={0.7}>
          {bubbleContent}
        </TouchableOpacity>
      ) : (
        bubbleContent
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: 3,
    marginHorizontal: 12,
  },
  wrapperOut: { alignItems: 'flex-end' },
  wrapperIn:  { alignItems: 'flex-start' },

  bubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleOut: {
    backgroundColor: '#1e3a5f',
    borderBottomRightRadius: 4,
  },
  bubbleIn: {
    backgroundColor: '#1a1a2e',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: '#2d2d4e',
  },

  bodyText: {
    color: '#e8e8f0',
    fontSize: 15,
    lineHeight: 21,
  },
  timeText: {
    color: '#6b7280',
    fontSize: 10,
    marginTop: 4,
    textAlign: 'right',
  },
  retryHint: {
    color: '#f59e0b',
    fontSize: 10,
    marginTop: 2,
    textAlign: 'right',
    fontStyle: 'italic',
  },
});
