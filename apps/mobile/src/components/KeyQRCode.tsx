/**
 * KeyQRCode.tsx — Public Key QR Display
 *
 * Shows the user's ML-KEM-768 public key, FCM token, and userId as a
 * scannable QR code for out-of-band key exchange with a contact.
 *
 * The QR payload is safe to display publicly — it contains only:
 *   - Public key (not sensitive by PQC design)
 *   - FCM token (needed for push delivery routing)
 *   - User ID (session ephemeral identifier)
 *
 * The secret key is NEVER included in the QR payload.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import QRCode from 'react-qr-code';
import * as Clipboard from 'expo-clipboard';

interface KeyQRCodeProps {
  qrPayload: string | null;
  userId: string | null;
}

export function KeyQRCode({ qrPayload, userId }: KeyQRCodeProps): React.ReactElement {
  const [copied, setCopied] = useState(false);

  if (!qrPayload) {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.placeholderText}>Generating keypair…</Text>
      </View>
    );
  }

  const handleCopyUserId = async (): Promise<void> => {
    if (!userId) return;
    await Clipboard.setStringAsync(userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={styles.container}>
      <View
        style={styles.qrWrapper}
        accessible={true}
        accessibilityLabel="Your BETWEENUS public key QR code — share this with a contact to establish an encrypted session"
        accessibilityRole="image"
      >
        <QRCode
          value={qrPayload}
          size={220}
          bgColor="#0a0a0f"
          fgColor="#7dd3fc"
          level="M"
        />
      </View>

      <Text style={styles.caption}>Your public key QR</Text>
      <Text style={styles.subcaption}>
        Share this with a contact to establish an encrypted session.{'\n'}
        Each app restart generates a new key.
      </Text>

      {userId && (
        <TouchableOpacity onPress={handleCopyUserId} style={styles.userIdBadge}>
          {copied ? (
            <Text style={styles.copiedLabel}>✓ Copied!</Text>
          ) : (
            <>
              <Text style={styles.userIdLabel}>User ID: </Text>
              <Text style={styles.userId}>{userId}</Text>
            </>
          )}
        </TouchableOpacity>
      )}

      <View style={styles.securityNote}>
        <Text style={styles.securityNoteText}>
          🔒 ML-KEM-768 · Secret key never leaves this device
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    padding: 20,
  },
  qrWrapper: {
    padding: 16,
    backgroundColor: '#0a0a0f',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1e40af',
  },
  placeholder: {
    width: 252,
    height: 252,
    backgroundColor: '#111827',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: {
    color: '#6b7280',
    fontSize: 14,
  },
  caption: {
    color: '#93c5fd',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 16,
  },
  subcaption: {
    color: '#6b7280',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 18,
    maxWidth: 280,
  },
  userIdBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  userIdLabel: { color: '#6b7280', fontSize: 12 },
  copiedLabel: { color: '#4ade80', fontSize: 12, fontWeight: '600' },
  userId: {
    color: '#7dd3fc',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  securityNote: {
    marginTop: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#052e16',
    borderRadius: 8,
  },
  securityNoteText: {
    color: '#4ade80',
    fontSize: 11,
    textAlign: 'center',
  },
});
