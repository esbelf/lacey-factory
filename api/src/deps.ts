// Production wiring for createApp (Node server and Lambda). Tests build their own.
import { OAuth2Client } from "google-auth-library";

import type { AppDeps } from "./app";
import { authenticate } from "./auth";
import { emailConfig } from "./config";
import { getDb } from "./db";
import { documentUrl } from "./storage";
import {
  notifyMailbox,
  notifyShipStation,
  notifyShopifyOrder,
  startAmazonSync,
  startShipStationPull,
  startShopifyPull,
} from "./temporal/client";

const verifier = new OAuth2Client();

export const appDeps: AppDeps = {
  getDb,
  authenticate,
  notifyMailbox,
  startAmazonSync,
  notifyShopifyOrder,
  startShopifyPull,
  notifyShipStation,
  startShipStationPull,
  documentUrl,
  async verifyPushToken(token) {
    const audience = emailConfig().pubsubPushAudience;
    if (!audience) return false;
    try {
      await verifier.verifyIdToken({ idToken: token, audience });
      return true;
    } catch {
      return false;
    }
  },
};
