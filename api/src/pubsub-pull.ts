// Local dev with real Gmail: pull notifications from a Pub/Sub subscription
// instead of receiving pushes, so no public URL is needed. Credentials come
// from GOOGLE_APPLICATION_CREDENTIALS (a service account key outside the repo).
import { existsSync } from "node:fs";

import { PubSub } from "@google-cloud/pubsub";

import { decodePubSubData, handleNotification } from "./app";
import { emailConfig } from "./config";
import { appDeps } from "./deps";

export function startPubSubPull() {
  const name = emailConfig().pubsubSubscription;
  if (!name) throw new Error("PUBSUB_MODE=pull needs GMAIL_PUBSUB_SUBSCRIPTION.");
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile && !existsSync(keyFile)) {
    throw new Error(
      `PUBSUB_MODE=pull: no service-account key at ${keyFile}. ` +
        "Put it in ~/.config/lacey-factory/pubsub-sa.json (or set GOOGLE_CREDENTIALS_DIR / GOOGLE_CREDENTIALS_FILE in .env).",
    );
  }
  // A gcloud user login carries no project, so take it from the subscription name.
  const projectId = name.match(/^projects\/([^/]+)\//)?.[1];
  const subscription = new PubSub(projectId ? { projectId } : {}).subscription(name);
  subscription.on("message", async (message) => {
    try {
      await handleNotification(appDeps, decodePubSubData(message.data));
      message.ack();
    } catch (err) {
      console.error("Gmail notification failed; Pub/Sub will redeliver", err);
      message.nack();
    }
  });
  subscription.on("error", (err) => console.error("Pub/Sub subscription error", err));
  console.log(`Pulling Gmail notifications from ${name}`);
}
