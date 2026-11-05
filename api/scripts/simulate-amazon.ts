// Local dev (AMAZON_MODE=fake): put a sample Amazon order in the fake folder,
// or change one, then start a sync as the 15-minute schedule would.
//
//   npm run simulate:amazon -w api -- us             # paid US order, 1 × LakeMat XL
//   npm run simulate:amazon -w api -- ca             # paid Canada order (CAD)
//   npm run simulate:amazon -w api -- multi          # two different mats on one order
//   npm run simulate:amazon -w api -- bundle         # a 2-pack SKU
//   npm run simulate:amazon -w api -- pending        # not paid yet: nothing taken from stock
//   npm run simulate:amazon -w api -- unknown-sku    # shows under "Needs attention"
//   npm run simulate:amazon -w api -- pay [order#]   # the last (or given) order becomes Unshipped
//   npm run simulate:amazon -w api -- ship [order#]
//   npm run simulate:amazon -w api -- cancel [order#]
//   add --sku LM-XL to use a different SKU, --no-sync to skip starting a sync
//
// In docker compose: docker compose exec api npm run simulate:amazon -- us
import { config } from "dotenv";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { fakeOrder, SAMPLE_SKUS } from "../src/amazon/fake-orders";
import type { FakeOrderFile } from "../src/amazon/order-source";
import { amazonConfig } from "../src/config";
import { startAmazonSync } from "../src/temporal/client";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--sku"));
const [command = "us", target] = positional;
const sku = flag("sku");

const NEW: Record<string, () => FakeOrderFile> = {
  us: () => fakeOrder({ market: "US", items: [{ sku: sku ?? SAMPLE_SKUS.lakeMatXL, qty: 1, price: 399.99 }] }),
  ca: () => fakeOrder({ market: "CA", items: [{ sku: sku ?? SAMPLE_SKUS.lakeMatXL, qty: 1, price: 549.99 }] }),
  multi: () =>
    fakeOrder({
      market: "US",
      items: [
        { sku: SAMPLE_SKUS.lakeMatL, qty: 1, price: 349.99 },
        { sku: SAMPLE_SKUS.muckMatXL, qty: 2, price: 459.99 },
      ],
    }),
  bundle: () => fakeOrder({ market: "US", items: [{ sku: sku ?? SAMPLE_SKUS.lakeMatXL2Pack, qty: 1, price: 749.99 }] }),
  pending: () => fakeOrder({ market: "US", status: "Pending", items: [{ sku: sku ?? SAMPLE_SKUS.lakeMatXL, qty: 1, price: 399.99 }] }),
  "unknown-sku": () => fakeOrder({ market: "US", items: [{ sku: sku ?? SAMPLE_SKUS.unknown, qty: 1, price: 99.99 }] }),
};
const CHANGE: Record<string, string> = { pay: "Unshipped", ship: "Shipped", cancel: "Canceled" };

async function lastOrderFile(dir: string): Promise<string> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  if (!files.length) throw new Error("No fake orders yet. Create one first, e.g. `us`.");
  const withTimes = await Promise.all(files.map(async (f) => ({ f, t: (await stat(path.join(dir, f))).mtimeMs })));
  return withTimes.sort((a, b) => b.t - a.t)[0].f;
}

async function main() {
  const c = amazonConfig();
  if (c.mode !== "fake") throw new Error("simulate:amazon only works with AMAZON_MODE=fake.");
  await mkdir(c.fakeDir, { recursive: true });

  if (NEW[command]) {
    const file = NEW[command]();
    await writeFile(path.join(c.fakeDir, `${file.order.AmazonOrderId}.json`), JSON.stringify(file, null, 2));
    const lines = file.items.map((i) => `${i.QuantityOrdered} × ${i.SellerSKU}`).join(", ");
    console.log(`New ${file.order.SalesChannel} order ${file.order.AmazonOrderId} (${file.order.OrderStatus}): ${lines}`);
  } else if (CHANGE[command]) {
    const name = target ? `${target}.json` : await lastOrderFile(c.fakeDir);
    const file = JSON.parse(await readFile(path.join(c.fakeDir, name), "utf8")) as FakeOrderFile;
    file.order.OrderStatus = CHANGE[command];
    file.order.LastUpdateDate = new Date().toISOString();
    if (command === "ship") {
      for (const i of file.items) i.QuantityShipped = i.QuantityOrdered;
      file.order.NumberOfItemsShipped = file.items.reduce((s, i) => s + i.QuantityOrdered, 0);
      file.order.NumberOfItemsUnshipped = 0;
    }
    await writeFile(path.join(c.fakeDir, name), JSON.stringify(file, null, 2));
    console.log(`Order ${file.order.AmazonOrderId} is now ${file.order.OrderStatus}.`);
  } else {
    throw new Error(`Unknown command "${command}". Try: ${[...Object.keys(NEW), ...Object.keys(CHANGE)].join(", ")}.`);
  }

  if (!args.includes("--no-sync")) {
    const r = await startAmazonSync();
    console.log(r === "running" ? "A sync is already running; it may miss this, so run again in a moment." : "Started an Amazon sync.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
