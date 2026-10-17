/**
 * ScanScreen.tsx — QR Code Scanner for Key Exchange
 *
 * Uses the device camera to scan a peer's public key QR code.
 * On successful scan:
 *   1. Parses the QR JSON payload
 *   2. Validates ML-KEM-768 public key (1184 bytes)
 *   3. Adds contact to volatile MemoryStore
 *   4. Navigates back to HomeScreen
 *
 * No network call needed — pure out-of-band key exchange.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  Alert,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { importContactFromQR } from '../crypto/PQCEngine';
import { fetchPeerContact } from '../services/RelayService';
import type { AppNavigationProp, AppParamList } from '../navigation/AppNavigator';

type ScanRoute = RouteProp<AppParamList, 'Scan'>;

export function ScanScreen(): React.ReactElement {
  const navigation = useNavigation<AppNavigationProp>();
  const route = useRoute<ScanRoute>();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [showNameInput, setShowNameInput] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);

  // Ref mirrors scanned state so async callbacks and the mount-only useEffect
  // always read the current value without stale closure issues.
  const scannedRef = React.useRef(false);
  const markScanned = (): void => {
    scannedRef.current = true;
    setScanned(true);
  };
  const unmarkScanned = (): void => {
    scannedRef.current = false;
    setScanned(false);
  };

  // Auto-process a deep-link payload passed via navigation params.
  // Two cases:
  //   1. `payload` — full QR JSON (legacy links, camera scan delegate)
  //   2. `uid`     — compact userId-only link; ScanScreen fetches QR data from registry
  useEffect(() => {
    const deepLinkPayload = route.params?.payload;
    const deepLinkUid = route.params?.uid;

    if (deepLinkPayload && !scannedRef.current) {
      handleBarCodeScanned({ data: deepLinkPayload });
    } else if (deepLinkUid && !scannedRef.current) {
      handleUidDeepLink(deepLinkUid);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handles betweenus://addcontact?uid=<userId> deep links.
  // Fetches the full QR payload from the key registry then flows into the normal
  // "Key Scanned" name-entry UI.
  const handleUidDeepLink = useCallback(async (uid: string) => {
    if (scannedRef.current) return;
    markScanned();
    setIsLookingUp(true);

    const result = await fetchPeerContact(uid);
    setIsLookingUp(false);

    if (!result) {
      Alert.alert(
        'Contact Not Found',
        'No key found for this ID in the registry. Ask your contact to share their QR again.',
        [{ text: 'OK', onPress: unmarkScanned }],
      );
      return;
    }

    // Synthesize a minimal v2 QR payload so the normal importContactFromQR path is used
    const syntheticPayload = JSON.stringify({ v: 2, uid, pk: result.publicKey });
    setPendingPayload(syntheticPayload);
    setPendingUserId(uid);
    setShowNameInput(true);
  }, []); // no dep on scanned — reads ref directly

  const handleBarCodeScanned = useCallback(
    async ({ data }: { data: string }) => {
      if (scannedRef.current) return;
      markScanned();

      // Parse the QR to extract the userId for registry lookup
      let parsedUid: string | null = null;
      try {
        const parsed = JSON.parse(data) as { uid?: string };
        parsedUid = parsed.uid ?? null;
      } catch {
        // Will fail at importContactFromQR with a clear error
      }

      setPendingPayload(data);
      setPendingUserId(parsedUid);

      // Eagerly fetch the FCM token from the registry in the background
      // so it's ready when the user confirms. Non-blocking.
      if (parsedUid) {
        setIsLookingUp(true);
        fetchPeerContact(parsedUid).finally(() => setIsLookingUp(false));
      }

      setShowNameInput(true);
    },
    [], // no dep on scanned — reads ref directly
  );

  const handleConfirmContact = useCallback(async () => {
    if (!pendingPayload) return;
    const name = displayName.trim() || 'Unknown';

    // Fetch FCM token from registry (v2 QR has no embedded token)
    let fcmToken = '';
    if (pendingUserId) {
      setIsLookingUp(true);
      const result = await fetchPeerContact(pendingUserId);
      setIsLookingUp(false);
      if (result) {
        fcmToken = result.fcmToken;
      }
    }

    try {
      importContactFromQR(pendingPayload, name, fcmToken);
      navigation.goBack();
    } catch (err) {
      Alert.alert(
        'Invalid QR Code',
        err instanceof Error ? err.message : 'Could not parse QR payload',
        [{ text: 'Scan Again', onPress: () => { unmarkScanned(); setShowNameInput(false); } }],
      );
    }
  }, [pendingPayload, pendingUserId, displayName, navigation]);

  if (!permission) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.infoText}>Requesting camera permission…</Text>
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.infoText}>Camera permission required for QR scanning</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Grant Permission</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  if (showNameInput) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.nameInputContainer}>
          <Text style={styles.nameInputTitle}>Key Scanned ✓</Text>
          <Text style={styles.nameInputSubtitle}>
            ML-KEM-768 public key imported.{'\n'}Enter a display name for this contact.
          </Text>
          <TextInput
            style={styles.nameInput}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Display name…"
            placeholderTextColor="#374151"
            autoFocus
            maxLength={40}
          />
          <TouchableOpacity
            style={[styles.confirmBtn, isLookingUp && styles.confirmBtnDisabled]}
            onPress={handleConfirmContact}
            disabled={isLookingUp}
          >
            {isLookingUp
              ? <ActivityIndicator color="#93c5fd" />
              : <Text style={styles.confirmBtnText}>Add Contact</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={() => { unmarkScanned(); setShowNameInput(false); }}
          >
            <Text style={styles.cancelBtnText}>Scan Again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.cameraWrapper}>
        <CameraView
          style={styles.camera}
          onBarcodeScanned={handleBarCodeScanned}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        />
        <View style={styles.overlay}>
          <View style={styles.scanFrame} />
        </View>
      </View>
      <Text style={styles.scanInstructions}>
        Point at a contact's BETWEENUS QR code{'\n'}to import their ML-KEM-768 public key
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f' },
  infoText: { color: '#6b7280', textAlign: 'center', marginTop: 80 },

  cameraWrapper: { flex: 1, position: 'relative' },
  camera: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanFrame: {
    width: 240,
    height: 240,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: '#7dd3fc',
  },
  scanInstructions: {
    color: '#6b7280',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 20,
    lineHeight: 20,
  },

  permBtn: {
    marginTop: 20,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#1e3a5f',
    borderRadius: 10,
  },
  permBtnText: { color: '#93c5fd', fontSize: 14 },

  nameInputContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  nameInputTitle: { color: '#4ade80', fontSize: 24, fontWeight: '800', marginBottom: 12 },
  nameInputSubtitle: {
    color: '#6b7280', fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 24,
  },
  nameInput: {
    width: '100%',
    backgroundColor: '#111827',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e3a5f',
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#e8e8f0',
    fontSize: 16,
    marginBottom: 16,
  },
  confirmBtn: {
    width: '100%',
    backgroundColor: '#1e40af',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  confirmBtnDisabled: { backgroundColor: '#1e3a5f' },
  confirmBtnText: { color: '#e8e8f0', fontSize: 15, fontWeight: '700' },
  cancelBtn: { paddingVertical: 10 },
  cancelBtnText: { color: '#6b7280', fontSize: 13 },
});
