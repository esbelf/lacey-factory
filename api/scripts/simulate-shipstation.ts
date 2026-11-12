// Local dev (SHIPSTATION_MODE=fake): buy a fake ShipStation label for an order
// we already have, then send the webhook ShipStation would send to the local API.
//
//   npm run simulate:shipstation -w api -- latest            # a $18.42 label for the newest order
//   npm run simulate:shipstation -w api -- latest split      # two labels (split shipment)
//   npm run simulate:shipstation -w api -- 112-1234567-1234567   # an Amazon order number, or a Shopify #1001
//   npm run simulate:shipstation -w api -- latest shipped    # ShipStation marks it shipped
//   npm run simulate:shipstation -w api -- latest void       # void its newest label, then re-check (voids have no webhook)
//   npm run simulate:shipstation -w api -- unknown           # a label for an order we don't have (stays unlinked)
//   add --cost 24.95 to set the label cost
//
// In docker compose: docker compose exec api npm run simulate:shipstation -- latest
import { config } from "dotenv";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { desc, eq, or } from "drizzle-orm";

import { shipstationConfig } from "../src/config";
import { getDb } from "../src/db";
import { orders } from "../src/db/schema";
import { fakeLabel } from "../src/shipstation/fake-labels";
import type { FakeLabelFile } from "../src/shipstation/source";
import { startShipStationPull } from "../src/temporal/client";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const [target = "latest", action = "label"] = positional;
const cost = flag("cost") ? Number(flag("cost")) : undefined;
const apiUrl = process.env.SIMULATE_API_URL ?? "http://localhost:8787";

async function sendWebhook(body: Record<string, unknown>) {
  const res = await fetch(`${apiUrl}/api/webhooks/shipstation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(`  webhook ${String(body.resource_type)} → ${res.status}${res.ok ? "" : ` ${await res.text()}`}`);
}

async function findOrder() {
  const db = getDb();
  if (target === "latest") return (await db.select().from(orders).orderBy(desc(orders.purchasedAt)).limit(1))[0] ?? null;
  const [o] = await db
    .select()
    .from(orders)
    .where(or(eq(orders.externalId, target), eq(orders.orderName, target), eq(orders.orderName, `#${target.replace(/^#/, "")}`)));
  return o ?? null;
}

async function labelsFor(dir: string, externalOrderId: string): Promise<FakeLabelFile[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const all = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), "utf8")) as FakeLabelFile));
  return all.filter((f) => f.shipment.external_order_id === externalOrderId).sort((a, b) => (a.label.created_at ?? "").localeCompare(b.label.created_at ?? ""));
}

async function main() {
  const c = shipstationConfig();
  if (c.mode !== "fake") throw new Error("simulate:shipstation only works with SHIPSTATION_MODE=fake.");
  await mkdir(c.fakeDir, { recursive: true });
  const save = (f: FakeLabelFile) => writeFile(path.join(c.fakeDir, `${f.label.label_id}.json`), JSON.stringify(f, null, 2));

  if (target === "unknown") {
    const f = fakeLabel({ orderSourceCode: "shopify", externalOrderId: "999999999", shipmentNumber: "99999", cost });
    await save(f);
    console.log(`Label ${f.label.label_id} for Shopify #99999 (no such order): $${f.label.shipment_cost?.amount}`);
    await sendWebhook({ resource_type: "LABEL_CREATED_V2", data: { label_id: f.label.label_id } });
    return;
  }

  const o = await findOrder();
  if (!o) throw new Error(`No order ${target}. Make one first, e.g. npm run simulate:shopify -- mi`);
  const isAmazon = o.source === "amazon";
  const externalOrderId = isAmazon ? o.externalId : (o.externalId.split("/").pop() ?? o.externalId);
  const base = {
    orderSourceCode: isAmazon ? (o.marketplace === "CA" ? "amazon_ca" : "amazon_us") : "shopify",
    externalOrderId,
    shipmentNumber: isAmazon ? undefined : (o.orderName ?? "").replace(/^#/, ""),
    cost,
  };
  const name = o.orderName ?? o.externalId;

  if (action === "void" || action === "shipped") {
    const labels = await labelsFor(c.fakeDir, externalOrderId);
    const last = labels.at(-1);
    if (!last) throw new Error(`Order ${name} has no fake label yet. Run: simulate:shipstation -- ${target}`);
    if (action === "shipped") {
      console.log(`Order ${name} marked shipped in ShipStation`);
      await sendWebhook({ resource_type: "FULFILLMENT_SHIPPED_V2", data: { shipment_id: last.shipment.shipment_id } });
      return;
    }
    last.label = { ...last.label, status: "voided", voided: true, voided_at: new Date().toISOString() };
    await save(last);
    console.log(`Voided label ${last.label.label_id} on order ${name}. Voids have no webhook, so starting a re-check…`);
    await startShipStationPull(null);
    console.log("  re-check started");
    return;
  }

  const files = action === "split" ? [fakeLabel(base), fakeLabel({ ...base, cost: cost ?? 11.1 })] : [fakeLabel(base)];
  for (const f of files) {
    await save(f);
    console.log(`Label ${f.label.label_id} for ${o.source} order ${name}: $${f.label.shipment_cost?.amount} ${f.label.carrier_code} ${f.label.tracking_number}`);
    await sendWebhook({ resource_type: "LABEL_CREATED_V2", data: { label_id: f.label.label_id } });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
