// The email workflows end to end on a local Temporal test server, with Gmail,
// S3 and Claude replaced by fakes and the real database code on PGlite.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { loadCatalog } from "../src/domain/catalog";
import { fakeOrder } from "../src/amazon/fake-orders";
import { FakeOrderSource, type OrderSource } from "../src/amazon/order-source";
import { saveSupplier } from "../src/domain/invoices";
import { mapSku } from "../src/domain/orders";
import { addSupplierSteelProduct, createSteelItem } from "../src/domain/steel";
import { FakeMailSource, type FakeEmail } from "../src/email/mail-source";
import { createActivities } from "../src/temporal/activities";
import type { DocumentReader } from "../src/temporal/extract";
import { mailboxWorkflowId, SIGNALS, WORKFLOWS } from "../src/temporal/names";
import { hanesPackingList } from "./fixtures/hanes-extraction";
import { steelInvoice } from "./fixtures/steel-extraction";

const ACCOUNT = "eric@lakemat.com";
let env: TestWorkflowEnvironment;
let db: DB;
let inbox: string;
let fixtures: string;
const stored = new Map<string, Buffer>();
let reads = 0;

const reader: DocumentReader = {
  async read(_doc, _mime, hint) {
    reads++;
    return hint.supplierName === "Midwest Steel" ? steelInvoice : hanesPackingList;
  },
};

async function deliver(e: Omit<FakeEmail, "receivedAt">) {
  await mkdir(path.join(inbox, ACCOUNT), { recursive: true });
  await writeFile(path.join(inbox, ACCOUNT, `${e.id}.json`), JSON.stringify({ ...e, receivedAt: "2026-09-18T15:00:00Z" }));
}

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger("WARN") });
  env = await TestWorkflowEnvironment.createLocal();
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: "drizzle" });
  db = pg as unknown as DB;
  await loadCatalog(db);
  const [hanes] = await db.select().from(schema.suppliers);
  await saveSupplier(db, { id: hanes.id, name: hanes.name, emailPatterns: "@hanesgeo.com" });
  await db.insert(schema.emailAccounts).values({ email: ACCOUNT, status: "connected", historyId: "0" });

  const root = await mkdtemp(path.join(tmpdir(), "factory-wf-"));
  inbox = path.join(root, "inbox");
  fixtures = path.join(root, "fixtures");
  await mkdir(fixtures, { recursive: true });
  await writeFile(path.join(fixtures, "hanes.pdf"), "%PDF-1.4 fake hanes packing list");
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

async function withWorker<T>(fn: () => Promise<T>, orders: OrderSource | null = null): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    bundlerOptions: { webpackConfigHook: (c) => ({ ...c, stats: "errors-only", infrastructureLogging: { level: "error" } }) },
    taskQueue: "test",
    workflowsPath: fileURLToPath(new URL("../src/temporal/workflows/index.ts", import.meta.url)),
    activities: createActivities({
      db,
      mail: new FakeMailSource(inbox, fixtures),
      reader,
      store: {
        put: async (key, body) => void stored.set(key, body),
        get: async (key) => stored.get(key)!,
      },
      orders,
    }),
  });
  return worker.runUntil(fn);
}

describe("email workflows", () => {
  it("a Hanes email becomes four registered rolls, once", async () => {
    await deliver({
      id: "m1",
      historyId: 1,
      from: "Hanes Geo Components <orders@hanesgeo.com>",
      subject: "Packing list 084-51752",
      attachments: [{ filename: "084-51752.pdf", path: "hanes.pdf" }],
    });
    await deliver({ id: "m2", historyId: 2, from: "Someone <someone@gmail.com>", subject: "Hi", attachments: [] });

    await withWorker(async () => {
      const outcome = await env.client.workflow.execute(WORKFLOWS.processEmail, {
        workflowId: "email-test-m1",
        taskQueue: "test",
        args: [{ account: ACCOUNT, messageId: "m1" }],
      });
      expect(outcome).toBe("done");

      // The same email again (e.g. a Gmail history replay) does nothing new.
      const again = await env.client.workflow.execute(WORKFLOWS.processEmail, {
        workflowId: "email-test-m1-again",
        taskQueue: "test",
        args: [{ account: ACCOUNT, messageId: "m1" }],
      });
      expect(again).toBe("done");

      const other = await env.client.workflow.execute(WORKFLOWS.processEmail, {
        workflowId: "email-test-m2",
        taskQueue: "test",
        args: [{ account: ACCOUNT, messageId: "m2" }],
      });
      expect(other).toBe("not_a_supplier");
    });

    const rolls = await db.select().from(schema.rolls);
    expect(rolls).toHaveLength(4);
    expect(reads).toBe(1);
    expect([...stored.keys()][0]).toMatch(/^suppliers\/hanes-geo-components\/2026\/09\/2026-09-18_hanes-geo-components_m1_[0-9a-f]{8}\.pdf$/);
    const [doc] = await db.select().from(schema.supplierDocuments);
    expect(doc).toMatchObject({ status: "registered", invoiceNumber: "084-51752" });
  }, 120_000);

  it("a Gmail notification wakes the mailbox workflow, which processes new mail", async () => {
    await deliver({
      id: "m3",
      historyId: 3,
      from: "orders@hanesgeo.com",
      subject: "Another packing list",
      attachments: [{ filename: "scan.pdf", path: "hanes.pdf" }],
    });

    await withWorker(async () => {
      const handle = await env.client.workflow.signalWithStart(WORKFLOWS.mailbox, {
        workflowId: mailboxWorkflowId(ACCOUNT),
        taskQueue: "test",
        args: [{ email: ACCOUNT }],
        signal: SIGNALS.gmailNotification,
        signalArgs: [{ emailAddress: ACCOUNT, historyId: "3" }],
      });
      // Wait until the mailbox has saved the new cursor.
      for (let i = 0; i < 100; i++) {
        const [acct] = await db.select().from(schema.emailAccounts);
        if (acct.historyId === "3") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const status = await handle.query<{ emailsStarted: number }>("status");
      expect(status.emailsStarted).toBe(3); // m1, m2 and m3 since history 0
      // m1 was already processed above under a different id; m3 is a duplicate invoice number.
      for (let i = 0; i < 100; i++) {
        const docs = await db.select().from(schema.supplierDocuments);
        if (docs.length === 2 && docs.every((d) => d.status !== "processing")) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await handle.terminate();
    });

    const docs = await db.select().from(schema.supplierDocuments);
    expect(docs.map((d) => d.status).sort()).toEqual(["duplicate", "registered"]);
    expect(await db.select().from(schema.rolls)).toHaveLength(4);
  }, 120_000);

  it("a steel supplier's invoice becomes cost lots through the same workflow", async () => {
    const supplierId = await saveSupplier(db, { name: "Midwest Steel", emailPatterns: "@midweststeel.com", kind: "steel" });
    for (const [code, name] of [["SP-114-10", "small pole"], ["SP-158-10", "large pole"]]) {
      const item = await createSteelItem(db, { name });
      await addSupplierSteelProduct(db, { supplierId, productCode: code, steelItemId: item.id });
    }
    await deliver({
      id: "m4",
      historyId: 4,
      from: "Midwest Steel <billing@midweststeel.com>",
      subject: "Invoice S-5001",
      attachments: [{ filename: "S-5001.pdf", path: "hanes.pdf" }],
    });

    await withWorker(async () => {
      const outcome = await env.client.workflow.execute(WORKFLOWS.processEmail, {
        workflowId: "email-test-m4",
        taskQueue: "test",
        args: [{ account: ACCOUNT, messageId: "m4" }],
      });
      expect(outcome).toBe("done");
    });

    const [doc] = await db.select().from(schema.supplierDocuments).where(eq(schema.supplierDocuments.supplierId, supplierId));
    expect(doc).toMatchObject({ status: "registered", invoiceNumber: "S-5001", shippingCost: 120 });
    const lots = await db.select().from(schema.steelLots);
    expect(lots.map((l) => l.qty).sort()).toEqual([20, 40]);
  }, 120_000);
});

describe("Amazon order sync", () => {
  it("reads every page of orders, records their sales, and a second run changes nothing", async () => {
    const dir = path.join(inbox, "..", "amazon");
    await mkdir(dir, { recursive: true });
    const [product] = await db.select().from(schema.products).where(eq(schema.products.name, "Boatlift Mat Large"));
    await mapSku(db, ACCOUNT, { source: "amazon", sku: "BL-L", productId: product.id, qtyPerUnit: 1 });
    const now = Date.now();
    for (let n = 0; n < 3; n++) {
      const at = new Date(now - (60 - n * 20) * 60_000).toISOString(); // 60, 40, 20 minutes ago
      const f = fakeOrder({ id: `114-000000${n}-0000000`, market: n === 2 ? "CA" : "US", purchasedAt: at, items: [{ sku: "BL-L", qty: 1, price: 299 }] });
      await writeFile(path.join(dir, `${f.order.AmazonOrderId}.json`), JSON.stringify(f));
    }
    const source = new FakeOrderSource(dir, 2);

    await withWorker(async () => {
      const first = await env.client.workflow.execute(WORKFLOWS.amazonSync, { workflowId: "amazon-sync-1", taskQueue: "test" });
      expect(first).toEqual({ orders: 3 });
      const second = await env.client.workflow.execute(WORKFLOWS.amazonSync, { workflowId: "amazon-sync-2", taskQueue: "test" });
      expect(second.orders).toBeLessThanOrEqual(1); // only the overlap window
    }, source);

    const orders = await db.select().from(schema.orders);
    expect(orders.map((o) => o.marketplace).sort()).toEqual(["CA", "US", "US"]);
    const items = await db.select().from(schema.orderItems);
    expect(items.every((i) => i.state === "recorded")).toBe(true);
    const sales = await db.select().from(schema.sales).where(eq(schema.sales.source, "amazon"));
    expect(sales).toHaveLength(3);
    const [sync] = await db.select().from(schema.channelSync);
    expect(sync).toMatchObject({ lastError: null, ordersSeen: expect.any(Number) });
    expect(sync.cursor).not.toBeNull();
  }, 120_000);

  it("a failed sync is recorded for the Orders page", async () => {
    const broken: OrderSource = {
      itemDelayMs: 0,
      listOrders: async () => {
        const { SpApiError } = await import("../src/amazon/sp-api");
        throw new SpApiError("Amazon login failed: bad refresh token.", 400, false);
      },
      getOrderItems: async () => [],
    };
    await withWorker(async () => {
      await expect(env.client.workflow.execute(WORKFLOWS.amazonSync, { workflowId: "amazon-sync-bad", taskQueue: "test" })).rejects.toThrow();
    }, broken);
    const [sync] = await db.select().from(schema.channelSync);
    expect(sync.lastError).toMatch(/bad refresh token/);
  }, 120_000);
});
