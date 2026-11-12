// Sales-channel orders (Amazon and Shopify). Orders are saved as the channel sent
// them; applyOrder then turns each paid line into a sale through recordSale,
// and a cancel undoes it. Everything here is safe to run again.
import { todayInMichigan } from "@lacey-factory/shared/feet";
import { sumMoney } from "@lacey-factory/shared/money";
import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";

import { channelSkus, channelSync, customers, orderItems, orders, products, sales, type SyncSource } from "../db/schema";
import type { DB } from "../db/types";
import { type CustomerInput, matchCustomer } from "./customers";
import { UserError } from "./errors";
import { recordSale, type SaleSource, voidSale } from "./sales";
import { linkWaitingShipments, shipmentsForOrder, shippingForOrders } from "./shipments";

export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type ItemState = OrderItem["state"];

/** An order row as a channel's normalizer builds it. Columns left out are kept as they are. */
export type OrderValues = Omit<typeof orders.$inferInsert, "id" | "customerId" | "firstSeenAt" | "syncedAt">;
export type OrderItemValues = Omit<
  typeof orderItems.$inferInsert,
  "id" | "orderId" | "state" | "problem" | "productId" | "saleId"
>;
export type NormalizedOrder = { order: OrderValues; items: OrderItemValues[]; customer?: CustomerInput | null };

/** Who the app records channel sales as. */
export const syncActor = (source: SaleSource) => `${source}-sync`;

const CHANNEL_NAMES: Partial<Record<SaleSource, string>> = { amazon: "Amazon", shopify: "Shopify" };

/** Statuses where the buyer has paid, so the sale counts. */
const PAID: Partial<Record<SaleSource, Set<string>>> = {
  amazon: new Set(["Unshipped", "PartiallyShipped", "Shipped", "InvoiceUnconfirmed"]),
  // Shopify's displayFinancialStatus. A partial refund keeps the sale (returns aren't handled yet).
  shopify: new Set(["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED"]),
};
const CANCELED: Partial<Record<SaleSource, Set<string>>> = {
  amazon: new Set(["Canceled", "Unfulfillable"]),
  shopify: new Set(["REFUNDED", "VOIDED"]),
};

export function wantedState(source: SaleSource, status: string, canceledAt?: Date | null): "paid" | "waiting" | "canceled" {
  if (canceledAt || CANCELED[source]?.has(status)) return "canceled";
  if (PAID[source]?.has(status)) return "paid";
  return "waiting"; // Amazon Pending; Shopify PENDING, AUTHORIZED
}

export const saleRef = (o: Pick<Order, "source" | "externalId">, i: Pick<OrderItem, "externalItemId">) =>
  `${o.source}:${o.externalId}:${i.externalItemId}`;

/**
 * Insert or update an order and its lines, and link it to its customer. An
 * older copy never overwrites a newer one. Returns the order id and whether anything changed.
 */
export async function saveOrder(db: DB, n: NormalizedOrder): Promise<{ id: string; changed: boolean }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: orders.id, lastUpdatedAt: orders.lastUpdatedAt })
      .from(orders)
      .where(and(eq(orders.source, n.order.source), eq(orders.externalId, n.order.externalId)))
      .for("update");
    if (existing && existing.lastUpdatedAt.getTime() > n.order.lastUpdatedAt.getTime()) {
      return { id: existing.id, changed: false };
    }

    const customerId = n.customer ? await matchCustomer(tx, n.order.source, n.customer) : undefined;
    const values = { ...n.order, ...(customerId ? { customerId } : {}) };
    let id: string;
    if (existing) {
      id = existing.id;
      await tx.update(orders).set({ ...values, syncedAt: new Date() }).where(eq(orders.id, id));
    } else {
      [{ id }] = await tx.insert(orders).values(values).returning({ id: orders.id });
    }
    for (const item of n.items) {
      const { externalItemId, ...data } = item;
      await tx
        .insert(orderItems)
        .values({ orderId: id, externalItemId, ...data })
        .onConflictDoUpdate({ target: [orderItems.orderId, orderItems.externalItemId], set: data });
    }
    await linkWaitingShipments(tx, { id, source: n.order.source, externalId: n.order.externalId, orderName: n.order.orderName });
    return { id, changed: true };
  });
}

/** Saved copy of an order, for skipping unchanged ones during sync. */
export async function findOrder(db: DB, source: SaleSource, externalId: string) {
  const [o] = await db
    .select({ id: orders.id, lastUpdatedAt: orders.lastUpdatedAt })
    .from(orders)
    .where(and(eq(orders.source, source), eq(orders.externalId, externalId)));
  return o ?? null;
}

const setItem = (db: DB, id: string, values: Partial<OrderItem>) => db.update(orderItems).set(values).where(eq(orderItems.id, id));

/**
 * Bring stock in line with the order: paid lines become sales, canceled lines
 * undo theirs, unpaid lines wait. Lines that can't be recorded yet say why.
 */
export async function applyOrder(db: DB, orderId: string, actorOverride?: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new UserError("Order not found.");
  const actor = actorOverride ?? syncActor(order.source);
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const want = wantedState(order.source, order.status, order.canceledAt);

  for (const item of items) {
    if (want === "canceled" || item.qtyOrdered < 1) {
      if (item.saleId) {
        const [sale] = await db.select({ voidedAt: sales.voidedAt }).from(sales).where(eq(sales.id, item.saleId));
        if (sale && !sale.voidedAt) await voidSale(db, actor, item.saleId);
      }
      if (item.state !== "canceled") await setItem(db, item.id, { state: "canceled", problem: null });
      continue;
    }
    if (want === "waiting") {
      if (item.state !== "waiting" && item.state !== "recorded") await setItem(db, item.id, { state: "waiting", problem: null });
      continue;
    }
    if (item.state === "recorded") continue;

    const [mapping] = item.sku
      ? await db
          .select()
          .from(channelSkus)
          .where(and(eq(channelSkus.source, order.source), eq(channelSkus.sku, item.sku)))
      : [];
    if (!mapping) {
      await setItem(db, item.id, {
        state: "needs_mapping",
        problem: item.sku ? `SKU ${item.sku} isn't linked to a product.` : "This line has no SKU.",
      });
      continue;
    }
    if (!mapping.productId) {
      if (item.state !== "ignored") await setItem(db, item.id, { state: "ignored", problem: null });
      continue;
    }
    try {
      const { sale } = await recordSale(db, actor, {
        productId: mapping.productId,
        qty: item.qtyOrdered * mapping.qtyPerUnit,
        soldOn: todayInMichigan(order.purchasedAt),
        source: order.source,
        externalRef: saleRef(order, item),
        note: saleNote(order),
      });
      await setItem(db, item.id, { state: "recorded", problem: null, productId: mapping.productId, saleId: sale.id });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      await setItem(db, item.id, { state: "needs_recipe", problem: err.message, productId: mapping.productId });
    }
  }
}

function saleNote(o: Order) {
  if (o.source === "amazon") return `${o.marketplace ?? ""} order ${o.externalId}`.trim();
  return `${CHANNEL_NAMES[o.source] ?? o.source} order ${o.orderName ?? o.externalId}`;
}

/** Try again on every order with a line waiting for a SKU link or a recipe. */
export async function retryProblems(db: DB, sku?: string) {
  const rows = await db
    .selectDistinct({ orderId: orderItems.orderId })
    .from(orderItems)
    .where(
      and(
        inArray(orderItems.state, sku ? ["needs_mapping", "needs_recipe", "ignored"] : ["needs_mapping", "needs_recipe"]),
        sku ? eq(orderItems.sku, sku) : undefined,
      ),
    );
  for (const r of rows) await applyOrder(db, r.orderId);
  return rows.length;
}

// ── SKU links ──

export async function listChannelSkus(db: DB) {
  return db
    .select({ sku: channelSkus, productName: products.name })
    .from(channelSkus)
    .leftJoin(products, eq(channelSkus.productId, products.id))
    .orderBy(channelSkus.source, channelSkus.sku);
}

/**
 * Link a channel SKU to a product (or mark it "not a factory product"), then
 * record any orders that were waiting on it. Already-recorded sales stay as they are.
 */
export async function mapSku(
  db: DB,
  actor: string,
  input: { source: SaleSource; sku: string; productId: string | null; qtyPerUnit: number; note?: string | null },
) {
  const sku = input.sku.trim();
  if (!sku) throw new UserError("Enter the SKU.");
  if (!Number.isInteger(input.qtyPerUnit) || input.qtyPerUnit < 1) throw new UserError("Products per unit must be 1 or more.");
  if (input.productId) {
    const [p] = await db.select({ id: products.id }).from(products).where(eq(products.id, input.productId));
    if (!p) throw new UserError("Product not found.");
  }
  const values = { productId: input.productId, qtyPerUnit: input.qtyPerUnit, note: input.note?.trim() || null };
  await db
    .insert(channelSkus)
    .values({ source: input.source, sku, ...values, createdBy: actor })
    .onConflictDoUpdate({ target: [channelSkus.source, channelSkus.sku], set: values });
  return retryProblems(db, sku);
}

export async function removeChannelSku(db: DB, id: string) {
  await db.delete(channelSkus).where(eq(channelSkus.id, id));
}

// ── Reads ──

export type OrderFilters = {
  source?: SaleSource;
  customerId?: string;
  marketplace?: string;
  status?: string;
  problemsOnly?: boolean;
  q?: string;
  /** Orders purchased before this time (paging). */
  before?: string;
  limit?: number;
};

const PROBLEM_STATES: ItemState[] = ["needs_mapping", "needs_recipe"];

async function itemsFor(db: DB, orderIds: string[]) {
  if (!orderIds.length) return [];
  return db
    .select({
      item: orderItems,
      productName: products.name,
      steelCost: sales.steelCost,
      boxCost: sales.boxCost,
      partsCost: sales.partsCost,
      fabricCost: sales.fabricCost,
      sewingCost: sales.sewingCost,
      costMissing: sql<boolean>`${sales.fabricCostMissing} or ${sales.sewingCostMissing}`,
      short: sales.short,
      saleVoided: sql<boolean>`${sales.voidedAt} is not null`,
    })
    .from(orderItems)
    .leftJoin(products, eq(orderItems.productId, products.id))
    .leftJoin(sales, eq(orderItems.saleId, sales.id))
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(orderItems.externalItemId);
}

const customerName = sql<string | null>`nullif(trim(coalesce(${customers.firstName}, '') || ' ' || coalesce(${customers.lastName}, '')), '')`;

export async function listOrders(db: DB, f: OrderFilters = {}) {
  const limit = Math.min(f.limit ?? 50, 200);
  const q = f.q?.trim();
  const rows = await db
    .select({ order: orders, customerName: customerName })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .where(
      and(
        f.source ? eq(orders.source, f.source) : undefined,
        f.customerId ? eq(orders.customerId, f.customerId) : undefined,
        f.marketplace ? eq(orders.marketplace, f.marketplace) : undefined,
        f.status ? eq(orders.status, f.status) : undefined,
        f.before ? lt(orders.purchasedAt, new Date(f.before)) : undefined,
        f.problemsOnly
          ? sql`exists (select 1 from ${orderItems} where ${orderItems.orderId} = ${orders.id} and ${inArray(orderItems.state, PROBLEM_STATES)})`
          : undefined,
        q
          ? or(
              ilike(orders.externalId, `%${q}%`),
              ilike(orders.orderName, `%${q}%`),
              ilike(orders.email, `%${q}%`),
              ilike(sql`coalesce(${customers.firstName}, '') || ' ' || coalesce(${customers.lastName}, '')`, `%${q}%`),
              sql`exists (select 1 from ${orderItems} where ${orderItems.orderId} = ${orders.id} and (${ilike(orderItems.sku, `%${q}%`)} or ${ilike(orderItems.title, `%${q}%`)}))`,
            )
          : undefined,
      ),
    )
    .orderBy(desc(orders.purchasedAt), desc(orders.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.order.id);
  const [items, shipping] = await Promise.all([itemsFor(db, ids), shippingForOrders(db, ids)]);
  return {
    orders: page.map(({ order: o, customerName }) => ({
      ...withoutRaw(o),
      ...(shipping.get(o.id) ?? NO_SHIPPING),
      customerName,
      items: items.filter((i) => i.item.orderId === o.id).map(slimItem),
    })),
    more: rows.length > limit,
  };
}

/** Lists leave out the channel's full JSON; the order page shows it. */
function withoutRaw<T extends { raw: unknown }>(row: T): Omit<T, "raw"> {
  const copy: Partial<T> = { ...row };
  delete copy.raw;
  return copy as Omit<T, "raw">;
}

const slimItem = ({ item, ...rest }: Awaited<ReturnType<typeof itemsFor>>[number]) => ({ ...withoutRaw(item), ...rest });

export async function getOrder(db: DB, id: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) return null;
  const items = await itemsFor(db, [id]);
  let customer = null;
  if (order.customerId) {
    const [c] = await db
      .select({ id: customers.id, email: customers.email, name: customerName, phone: customers.phone })
      .from(customers)
      .where(eq(customers.id, order.customerId));
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(orders).where(eq(orders.customerId, order.customerId));
    customer = c ? { ...c, orderCount: n } : null;
  }
  const [shipping, shipmentRows] = await Promise.all([shippingForOrders(db, [id]), shipmentsForOrder(db, id)]);
  return {
    ...order,
    ...(shipping.get(id) ?? NO_SHIPPING),
    customer,
    shipments: shipmentRows,
    cogs: orderCogs(items),
    items: items.map(({ item, ...rest }) => ({ ...item, ...rest })),
  };
}

const NO_SHIPPING = { shippingCost: null, shippingCurrency: null, shippedOn: null };

/** What the order's recorded sales cost us: steel + box + parts + fabric + sewing. Null when nothing is recorded yet. */
function orderCogs(items: Awaited<ReturnType<typeof itemsFor>>): number | null {
  const sold = items.filter((i) => i.item.saleId && !i.saleVoided);
  if (!sold.length) return null;
  return sumMoney(sold.flatMap((i) => [i.steelCost, i.boxCost, i.partsCost, i.fabricCost, i.sewingCost].map((n) => n ?? 0)));
}

/** What needs a person: unknown SKUs and products without a recipe. */
export async function orderProblems(db: DB) {
  const [unmapped, noRecipe] = await Promise.all([
    db
      .select({
        source: orders.source,
        sku: orderItems.sku,
        title: sql<string | null>`max(${orderItems.title})`,
        orders: sql<number>`count(distinct ${orderItems.orderId})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(eq(orderItems.state, "needs_mapping"))
      .groupBy(orders.source, orderItems.sku)
      .orderBy(orderItems.sku),
    db
      .select({
        productId: orderItems.productId,
        productName: products.name,
        lines: sql<number>`count(*)::int`,
      })
      .from(orderItems)
      .innerJoin(products, eq(orderItems.productId, products.id))
      .where(eq(orderItems.state, "needs_recipe"))
      .groupBy(orderItems.productId, products.name)
      .orderBy(products.name),
  ]);
  return { unmapped, noRecipe };
}

// ── Sync bookkeeping ──

export async function syncState(db: DB, source: SyncSource) {
  const [row] = await db.select().from(channelSync).where(eq(channelSync.source, source));
  return row ?? null;
}

export async function markSyncStarted(db: DB, source: SyncSource) {
  await db
    .insert(channelSync)
    .values({ source, lastRunAt: new Date() })
    .onConflictDoUpdate({ target: channelSync.source, set: { lastRunAt: new Date() } });
}

export async function markSyncDone(db: DB, source: SyncSource, input: { cursor: Date | null; ordersSeen: number }) {
  await db
    .insert(channelSync)
    .values({ source, cursor: input.cursor, lastOkAt: new Date(), ordersSeen: input.ordersSeen })
    .onConflictDoUpdate({
      target: channelSync.source,
      set: {
        ...(input.cursor ? { cursor: sql`greatest(${channelSync.cursor}, ${input.cursor.toISOString()}::timestamptz)` } : {}),
        lastOkAt: new Date(),
        lastError: null,
        ordersSeen: sql`${channelSync.ordersSeen} + ${input.ordersSeen}`,
      },
    });
}

export async function markSyncFailed(db: DB, source: SyncSource, message: string) {
  await db
    .insert(channelSync)
    .values({ source, lastRunAt: new Date(), lastError: message })
    .onConflictDoUpdate({ target: channelSync.source, set: { lastError: message } });
}

/** Sales on the Inventory page link back to their order. */
export async function orderIdsForSales(db: DB, saleIds: string[]) {
  if (!saleIds.length) return new Map<string, { orderId: string; marketplace: string | null; externalId: string }>();
  const rows = await db
    .select({ saleId: orderItems.saleId, orderId: orders.id, marketplace: orders.marketplace, externalId: orders.externalId })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(inArray(orderItems.saleId, saleIds), sql`${orderItems.saleId} is not null`));
  return new Map(rows.map((r) => [r.saleId as string, r]));
}

/** A channel webhook arrived (shown as "last webhook received"). */
export async function markEventReceived(db: DB, source: SyncSource) {
  await db
    .insert(channelSync)
    .values({ source, lastEventAt: new Date() })
    .onConflictDoUpdate({ target: channelSync.source, set: { lastEventAt: new Date() } });
}
