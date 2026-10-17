/**
 * TTLBadge.tsx — Message TTL Status Indicator
 *
 * Displays the live countdown for outbound messages and the
 * final delivery status (Delivered / Not Delivered / Expired).
 *
 * Rendering modes:
 *   - 'sending'   → animated pulsing dot + "Sending..."
 *   - 'sent'      → countdown timer (e.g., "TTL 47s")
 *   - 'delivered' → green check + "Delivered"
 *   - 'expired'   → red icon + "Message Not Delivered"
 *   - 'error'     → red icon + error text
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, Animated } from 'react-native';
import type { MessageStatus } from '../store/MemoryStore';

interface TTLBadgeProps {
  status: MessageStatus;
  expiresAt: number;  // Unix ms — used for countdown while status === 'sent'
}

export function TTLBadge({ status, expiresAt }: TTLBadgeProps): React.ReactElement {
  const [remaining, setRemaining] = useState<number>(
    Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
  );
  const pulseAnim = React.useRef(new Animated.Value(1)).current;

  // Countdown: schedule a timeout to fire at each whole-second boundary
  // rather than polling at 500ms. Recalculates on every tick so drift is ≤ 1ms.
  useEffect(() => {
    if (status !== 'sent') return;

    let timer: ReturnType<typeof setTimeout>;

    function tick(): void {
      const now = Date.now();
      const secs = Math.max(0, Math.ceil((expiresAt - now) / 1000));
      setRemaining(secs);
      if (secs > 0) {
        // Schedule next tick at the exact ms when the next whole second turns
        const msUntilNextSecond = (expiresAt - now) % 1000 || 1000;
        timer = setTimeout(tick, msUntilNextSecond);
      }
    }

    tick();
    return () => clearTimeout(timer);
  }, [status, expiresAt]);

  // Pulse animation for 'sending'
  useEffect(() => {
    if (status !== 'sending') return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [status, pulseAnim]);

  if (status === 'sending') {
    return (
      <View style={styles.row}>
        <Animated.View style={[styles.dot, styles.dotGray, { opacity: pulseAnim }]} />
        <Text style={styles.labelGray}>Sending…</Text>
      </View>
    );
  }

  if (status === 'sent') {
    return (
      <View style={styles.row}>
        <View style={[styles.dot, remaining > 10 ? styles.dotAmber : styles.dotRed]} />
        <Text style={[styles.label, remaining > 10 ? styles.labelAmber : styles.labelRed]}>
          TTL {remaining}s
        </Text>
      </View>
    );
  }

  if (status === 'delivered') {
    return (
      <View style={styles.row}>
        <Text style={styles.checkmark}>✓</Text>
        <Text style={[styles.label, styles.labelGreen]}>Delivered</Text>
      </View>
    );
  }

  if (status === 'expired') {
    return (
      <View style={styles.row}>
        <Text style={styles.xmark}>✕</Text>
        <Text style={[styles.label, styles.labelRed]}>Message Not Delivered</Text>
      </View>
    );
  }

  // 'error'
  return (
    <View style={styles.row}>
      <Text style={styles.xmark}>!</Text>
      <Text style={[styles.label, styles.labelRed]}>Send Failed</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 3,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotGray:  { backgroundColor: '#6b7280' },
  dotAmber: { backgroundColor: '#f59e0b' },
  dotRed:   { backgroundColor: '#ef4444' },
  label: {
    fontSize: 10,
    fontFamily: 'monospace',
  },
  labelGray:  { color: '#6b7280' },
  labelAmber: { color: '#f59e0b' },
  labelRed:   { color: '#ef4444' },
  labelGreen: { color: '#22c55e' },
  checkmark: { color: '#22c55e', fontSize: 11, fontWeight: '700' },
  xmark:     { color: '#ef4444', fontSize: 11, fontWeight: '700' },
});
