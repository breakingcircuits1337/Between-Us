/**
 * SessionSplash.tsx — Session Initialization / Re-initialization Screen
 *
 * Shown while App.tsx is generating a new ML-KEM-768 keypair and
 * fetching the FCM token. Typically visible for < 200ms on first launch
 * and briefly on foreground return after a background wipe.
 *
 * Does not use any storage or network — purely presentational.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

interface SessionSplashProps {
  /** Shown below the logo. Defaults to 'Generating secure session…' */
  message?: string;
}

export function SessionSplash({
  message = 'Generating secure session…',
}: SessionSplashProps): React.ReactElement {
  const fadeAnim = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(fadeAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [fadeAnim]);

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>BETWEENUS</Text>
      <Text style={styles.tagline}>Post-Quantum · Ephemeral</Text>
      <Animated.View style={[styles.indicator, { opacity: fadeAnim }]}>
        <View style={styles.dot} />
        <View style={styles.dot} />
        <View style={styles.dot} />
      </Animated.View>
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0f',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  logo: {
    color: '#7dd3fc',
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 3,
  },
  tagline: {
    color: '#374151',
    fontSize: 11,
    letterSpacing: 1.5,
    marginBottom: 24,
  },
  indicator: {
    flexDirection: 'row',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#1e40af',
  },
  message: {
    color: '#4b5563',
    fontSize: 12,
    marginTop: 8,
    letterSpacing: 0.5,
  },
});
