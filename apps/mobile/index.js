import 'react-native-gesture-handler';

// ─── FCM background handler — MUST be registered before registerRootComponent ──
// @react-native-firebase requires the background message handler to be set at
// module load time so it is available when the app is woken from a killed state.
// This import triggers the setBackgroundMessageHandler call in FCMService.ts.
import './src/services/FCMService';

import { registerRootComponent } from 'expo';
import App from './src/App';

registerRootComponent(App);
