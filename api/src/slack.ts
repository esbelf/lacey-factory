// Slack messages through an Incoming Webhook (one channel, set when the webhook is created).
import { slackConfig } from "./config";

/** Posts a message; throws when Slack refuses it, so the caller can retry. */
export type Notify = (text: string) => Promise<void>;

export function slackNotifier(): Notify {
  return async (text) => {
    const { webhookUrl } = slackConfig();
    if (!webhookUrl) {
      console.log(`[slack] SLACK_WEBHOOK_URL isn't set, so this wasn't sent:\n${text}`);
      return;
    }
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack refused the message: ${res.status} ${await res.text()}`);
  };
}
