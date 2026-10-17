/**
 * AppNavigator.tsx — Stack Navigator
 *
 * Three-screen stack:
 *   Home  → QR display + contact list
 *   Scan  → Camera QR scanner for key import
 *   Chat  → Ephemeral message thread
 *
 * sessionVersion is used only to re-derive the contact list passed to
 * HomeScreen — it does NOT key the entire navigator (which would destroy
 * any open screen and reset navigation state).
 */

import React, { useMemo } from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import { HomeScreen } from '../screens/HomeScreen';
import { ScanScreen } from '../screens/ScanScreen';
import { ChatScreen } from '../screens/ChatScreen';
import { store } from '../store/MemoryStore';
import type { StackNavigationProp } from '@react-navigation/stack';

export type AppParamList = {
  Home: undefined;
  Scan: {
    /** Full QR JSON string from a QR camera scan or legacy deep link */
    payload?: string;
    /** userId-only from compact deep link — triggers registry lookup */
    uid?: string;
  } | undefined;
  Chat: { contactId: string };
};

export type AppNavigationProp = StackNavigationProp<AppParamList>;

const Stack = createStackNavigator<AppParamList>();

interface AppNavigatorProps {
  userId: string | null;
  /** Bumped by App.tsx whenever contacts or session state changes. */
  sessionVersion: number;
}

export function AppNavigator({ userId, sessionVersion }: AppNavigatorProps): React.ReactElement {
  // Re-derive contacts whenever sessionVersion changes, without remounting the navigator
  const contacts = useMemo(() => store.getAllContacts(), [sessionVersion]);

  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#0a0a0f' },
        headerTintColor: '#7dd3fc',
        headerTitleStyle: { fontWeight: '700', letterSpacing: 1 },
        cardStyle: { backgroundColor: '#0a0a0f' },
      }}
    >
      <Stack.Screen name="Home" options={{ title: 'BETWEENUS', headerShown: false }}>
        {() => (
          <HomeScreen
            contacts={contacts}
            userId={userId}
          />
        )}
      </Stack.Screen>
      <Stack.Screen
        name="Scan"
        component={ScanScreen}
        options={{ title: 'Scan Key QR' }}
      />
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
        options={({ route }) => ({
          title: store.getContact(route.params.contactId)?.displayName ?? 'Chat',
        })}
      />
    </Stack.Navigator>
  );
}
