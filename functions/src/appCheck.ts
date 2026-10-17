/**
 * appCheck.ts — Server-side App Check Token Verification
 *
 * Verifies the Firebase App Check token present in every request from the
 * mobile app. The token is sent automatically by @react-native-firebase/app-check
 * in the `X-Firebase-AppCheck` header.
 *
 * Enforcement is controlled by the ENFORCE_APP_CHECK environment variable:
 *   - "true"  → reject requests without a valid token (production)
 *   - "false" → log a warning but allow through (development / emulator)
 *
 * Set the variable in the Firebase Console:
 *   Functions → [function] → Edit → Environment variables
 * Or via CLI:
 *   firebase functions:config:set appcheck.enforce=true
 *   (requires firebase-functions v2 secrets or env; for v1 use process.env)
 */

import * as admin from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import type { Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';

const ENFORCE = process.env['ENFORCE_APP_CHECK'] === 'true';

/**
 * Verifies the App Check token in the request header.
 *
 * Returns true if the token is valid (or enforcement is disabled).
 * Returns false and sends a 401 response if the token is invalid and
 * enforcement is enabled.
 *
 * Usage:
 *   if (!await verifyAppCheck(req, res)) return;
 */
export async function verifyAppCheck(
  req: Request,
  res: Response,
): Promise<boolean> {
  const appCheckToken = req.header('X-Firebase-AppCheck');

  if (!appCheckToken) {
    if (ENFORCE) {
      logger.warn('App Check token missing');
      res.status(401).json({ error: 'App Check token required' });
      return false;
    }
    logger.warn('App Check token missing — enforcement disabled, allowing');
    return true;
  }

  try {
    await admin.appCheck().verifyToken(appCheckToken);
    return true;
  } catch {
    if (ENFORCE) {
      logger.warn('App Check token invalid');
      res.status(401).json({ error: 'App Check token invalid' });
      return false;
    }
    logger.warn('App Check token invalid — enforcement disabled, allowing');
    return true;
  }
}
