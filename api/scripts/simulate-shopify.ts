// Local dev (SHOPIFY_MODE=fake): put a sample Shopify order in the fake folder,
// or change one, then send the signed webhook Shopify would send to the local API.
//
//   npm run simulate:shopify -w api -- mi             # paid order shipped to Michigan (6% MI tax)
//   npm run simulate:shopify -w api -- oh             # Ohio: no tax
//   npm run simulate:shopify -w api -- on             # Ontario (13% HST)
//   npm run simulate:shopify -w api -- bc             # British Columbia (GST + PST)
//   npm run simulate:shopify -w api -- repeat         # Pat orders twice, 45 days apart: one customer
//   npm run simulate:shopify -w api -- guest          # guest checkout, then a second order with the same email in capitals
//   npm run simulate:shopify -w api -- pending        # not paid yet: the webhook is ignored
//   npm run simulate:shopify -w api -- unknown-sku    # shows under "Needs attention"
//   npm run simulate:shopify -w api -- pay [order id]     # the last (or given) order is paid
//   npm run simulate:shopify -w api -- refund [order id]  # fully refunded: the sale is undone
//   npm run simulate:shopify -w api -- cancel [order id]
//   add --sku LM-XL to use a different SKU, --no-webhook to only write the file
//
// In docker compose: docker compose exec api npm run simulate:shopify -- mi
import { config } from "dotenv";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { shopifyConfig } from "../src/config";
import { fakeShopifyOrder, SAMPLE_CUSTOMERS, SAMPLE_SKUS } from "../src/shopify/fake-orders";
import { shopifyNumericId, type ShopifyOrder } from "../src/shopify/types";
import { signShopifyBody } from "../src/shopify/webhook";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--sku"));
const [command = "mi", target] = positional;
const sku = flag("sku") ?? SAMPLE_SKUS.lakeMatXL;
const apiUrl = process.env.SIMULATE_API_URL ?? "http://localhost:8787";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const xl = (qty = 1) => [{ sku, qty, price: 399.99 }];

const NEW: Record<string, () => ShopifyOrder[]> = {
  mi: () => [fakeShopifyOrder({ region: "MI", customer: SAMPLE_CUSTOMERS.pat, shipping: 25, items: xl() })],
  oh: () => [fakeShopifyOrder({ region: "OH", customer: SAMPLE_CUSTOMERS.pat, items: xl() })],
  on: () => [fakeShopifyOrder({ region: "ON", customer: SAMPLE_CUSTOMERS.renee, shipping: 45, items: xl() })],
  bc: () => [fakeShopifyOrder({ region: "BC", customer: SAMPLE_CUSTOMERS.renee, shipping: 45, items: xl(2) })],
  repeat: () => [
    fakeShopifyOrder({ region: "MI", customer: SAMPLE_CUSTOMERS.pat, createdAt: daysAgo(45), items: xl() }),
    fakeShopifyOrder({ region: "MI", customer: SAMPLE_CUSTOMERS.pat, items: [{ sku: SAMPLE_SKUS.lakeMatL, qty: 1, price: 349.99 }] }),
  ],
  guest: () => [
    fakeShopifyOrder({ region: "OH", customer: SAMPLE_CUSTOMERS.sam, createdAt: daysAgo(10), items: xl() }),
    fakeShopifyOrder({ region: "OH", customer: { ...SAMPLE_CUSTOMERS.sam, email: SAMPLE_CUSTOMERS.sam.email.toUpperCase() }, items: xl() }),
  ],
  pending: () => [fakeShopifyOrder({ region: "MI", customer: SAMPLE_CUSTOMERS.pat, status: "PENDING", items: xl() })],
  "unknown-sku": () => [
    fakeShopifyOrder({ region: "MI", customer: SAMPLE_CUSTOMERS.pat, items: [{ sku: SAMPLE_SKUS.unknown, qty: 1, price: 99.99 }] }),
  ],
};

const CHANGE: Record<string, { topic: string; apply: (o: ShopifyOrder) => void }> = {
  pay: { topic: "orders/paid", apply: (o) => (o.displayFinancialStatus = "PAID") },
  refund: { topic: "orders/updated", apply: (o) => (o.displayFinancialStatus = "REFUNDED") },
  cancel: {
    topic: "orders/cancelled",
    apply: (o) => {
      o.cancelledAt = new Date().toISOString();
      o.displayFinancialStatus = o.displayFinancialStatus === "PAID" ? "REFUNDED" : "VOIDED";
    },
  },
};

const fileName = (o: ShopifyOrder) => `${shopifyNumericId(o.id)}.json`;

async function lastOrderFile(dir: string): Promise<string> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  if (!files.length) throw new Error("No fake orders yet. Create one first, e.g. `mi`.");
  const withTimes = await Promise.all(files.map(async (f) => ({ f, t: (await stat(path.join(dir, f))).mtimeMs })));
  return withTimes.sort((a, b) => b.t - a.t)[0].f;
}

/** What Shopify would POST: the REST order (we only read its id), signed with the client secret. */
async function sendWebhook(topic: string, o: ShopifyOrder) {
  const c = shopifyConfig();
  if (!c.clientSecret) throw new Error("Set SHOPIFY_CLIENT_SECRET in .env (any value works in fake mode) so webhooks can be signed.");
  const body = JSON.stringify({ id: Number(shopifyNumericId(o.id)), admin_graphql_api_id: o.id, name: o.name, updated_at: o.updatedAt });
  const res = await fetch(`${apiUrl}/api/webhooks/shopify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": c.shop,
      "x-shopify-webhook-id": randomUUID(),
      "x-shopify-hmac-sha256": signShopifyBody(body, c.clientSecret),
    },
    body,
  });
  console.log(`  webhook ${topic} → ${res.status}${res.ok ? "" : ` ${await res.text()}`}`);
}

async function main() {
  const c = shopifyConfig();
  if (c.mode !== "fake") throw new Error("simulate:shopify only works with SHOPIFY_MODE=fake.");
  await mkdir(c.fakeDir, { recursive: true });
  const send = !args.includes("--no-webhook");

  if (NEW[command]) {
    for (const o of NEW[command]()) {
      await writeFile(path.join(c.fakeDir, fileName(o)), JSON.stringify(o, null, 2));
      const lines = o.lineItems.nodes.map((i) => `${i.quantity} × ${i.sku}`).join(", ");
      console.log(
        `New order ${o.name} (${o.displayFinancialStatus}) for ${o.email}, ${o.shippingAddress?.provinceCode}: ${lines}, total $${o.totalPriceSet.shopMoney.amount}`,
      );
      if (send) await sendWebhook(o.displayFinancialStatus === "PAID" ? "orders/paid" : "orders/updated", o);
    }
  } else if (CHANGE[command]) {
    const name = target ? `${shopifyNumericId(target)}.json` : await lastOrderFile(c.fakeDir);
    const o = JSON.parse(await readFile(path.join(c.fakeDir, name), "utf8")) as ShopifyOrder;
    CHANGE[command].apply(o);
    o.updatedAt = new Date().toISOString();
    await writeFile(path.join(c.fakeDir, name), JSON.stringify(o, null, 2));
    console.log(`Order ${o.name} is now ${o.displayFinancialStatus}${o.cancelledAt ? " (canceled)" : ""}.`);
    if (send) await sendWebhook(CHANGE[command].topic, o);
  } else {
    throw new Error(`Unknown command "${command}". Try: ${[...Object.keys(NEW), ...Object.keys(CHANGE)].join(", ")}.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
