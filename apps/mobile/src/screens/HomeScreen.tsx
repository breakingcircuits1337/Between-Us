/**
 * HomeScreen.tsx — Contact List & Key Identity View
 *
 * Primary screen showing:
 *   - User's own QR code (ML-KEM public key for sharing)
 *   - List of in-memory contacts (lost on app restart)
 *   - Navigation to chat or QR scan
 */

import React, { useCallback, useState } from 'react';
import {
  FlatList,
  SafeAreaView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Alert,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { KeyQRCode } from '../components/KeyQRCode';
import { store, type Contact } from '../store/MemoryStore';
import { buildQRPayload } from '../crypto/PQCEngine';
import type { AppNavigationProp } from '../navigation/AppNavigator';

interface HomeScreenProps {
  /** Contacts list from AppNavigator — used as initial seed. */
  contacts: Contact[];
  userId: string | null;
}

export function HomeScreen({ contacts: initialContacts, userId }: HomeScreenProps): React.ReactElement {
  const navigation = useNavigation<AppNavigationProp>();
  // Local copy so we can refresh without remounting the navigator
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const qrPayload = buildQRPayload();

  // Refresh contact list whenever the screen comes back into focus
  // (e.g. after returning from ScanScreen with a new contact)
  useFocusEffect(
    useCallback(() => {
      setContacts(store.getAllContacts());
    }, []),
  );

  const handleOpenChat = useCallback((contact: Contact) => {
    navigation.navigate('Chat', { contactId: contact.userId });
  }, [navigation]);

  const handleRemoveContact = useCallback((contactId: string) => {
    Alert.alert(
      'Remove Contact',
      'This contact and all in-memory messages will be permanently erased.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            store.removeContact(contactId);
            setContacts(store.getAllContacts());
          },
        },
      ],
    );
  }, []);

  const handleShareQR = useCallback(async () => {
    if (!userId) return;
    try {
      // Share only the userId as a compact deep link.
      // The scanning peer looks up the full public key + FCM token via
      // fetchPeerContact(userId) — no bulky base64 blob in the URL.
      const deepLink = `betweenus://addcontact?uid=${encodeURIComponent(userId)}`;

      await Share.share({
        // iOS uses `url`; Android uses `message`
        url: deepLink,
        message: `Add me on BETWEENUS (post-quantum secure messenger):\n\n${deepLink}`,
        title: 'BETWEENUS — My public key',
      });
    } catch {
      // User dismissed the share sheet — no action needed
    }
  }, [userId]);

  const renderContact = ({ item }: { item: Contact }) => (
    <TouchableOpacity
      style={styles.contactRow}
      onPress={() => handleOpenChat(item)}
      onLongPress={() => handleRemoveContact(item.userId)}
    >
      <View style={styles.contactAvatar}>
        <Text style={styles.contactAvatarText}>
          {item.displayName.charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.contactInfo}>
        <Text style={styles.contactName}>{item.displayName}</Text>
        <Text style={styles.contactSubtext}>
          PQ-KEM · Session only
        </Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>BETWEENUS</Text>
        <Text style={styles.headerSubtitle}>Post-Quantum Ephemeral</Text>
      </View>

      <KeyQRCode qrPayload={qrPayload} userId={userId} />

      {qrPayload && (
        <TouchableOpacity style={styles.shareBtn} onPress={handleShareQR}>
          <Text style={styles.shareBtnText}>⬆ Share my key</Text>
        </TouchableOpacity>
      )}

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Contacts · Session Memory</Text>
        <TouchableOpacity onPress={() => navigation.navigate('Scan')}>
          <Text style={styles.addContactBtn}>+ Scan QR</Text>
        </TouchableOpacity>
      </View>

      {contacts.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateTitle}>No contacts yet</Text>
          <Text style={styles.emptyStateBody}>
            Tap "+ Scan QR" to scan a contact's key.{'\n'}
            Contacts are session-only and reset on restart.
          </Text>
        </View>
      ) : (
        <FlatList
          data={contacts}
          keyExtractor={c => c.userId}
          renderItem={renderContact}
          contentContainerStyle={styles.contactList}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f' },
  header: { alignItems: 'center', paddingTop: 12, paddingBottom: 4 },
  headerTitle: { color: '#7dd3fc', fontSize: 22, fontWeight: '800', letterSpacing: 2 },
  headerSubtitle: { color: '#374151', fontSize: 11, marginTop: 2, letterSpacing: 1 },

  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#1a1a2e',
  },
  sectionTitle: { color: '#6b7280', fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  addContactBtn: { color: '#7dd3fc', fontSize: 13, fontWeight: '600' },

  contactList: { paddingBottom: 20 },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#111827',
  },
  contactAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#1e3a5f',
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactAvatarText: { color: '#7dd3fc', fontSize: 16, fontWeight: '700' },
  contactInfo: { flex: 1, marginLeft: 12 },
  contactName: { color: '#e8e8f0', fontSize: 15, fontWeight: '600' },
  contactSubtext: { color: '#374151', fontSize: 11, marginTop: 2 },
  chevron: { color: '#374151', fontSize: 20 },

  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyStateTitle: { color: '#6b7280', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  emptyStateBody: { color: '#374151', fontSize: 13, textAlign: 'center', lineHeight: 20 },

  shareBtn: {
    alignSelf: 'center',
    marginTop: 4,
    marginBottom: 2,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#1e3a5f',
  },
  shareBtnText: {
    color: '#7dd3fc',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
});
