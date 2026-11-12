// ShipStation labels and the orders they ship. A label is linked to our order
// by the order number the store gave ShipStation; one that arrives before its
// order waits unlinked until the order is saved. An order's shipping cost and
// ship date are derived from its labels, never stored on the order.
import { sumMoney } from "@lacey-factory/shared/money";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { orders, shipments } from "../db/schema";
import type { DB, Tx } from "../db/types";
import type { SaleSource } from "./sales";

export type Shipment = typeof shipments.$inferSelect;
export type ShipmentValues = Omit<typeof shipments.$inferInsert, "id" | "orderId" | "createdAt" | "syncedAt">;

/** How to find our order for a label: which channel, its order ids, and its customer-facing names. */
export type MatchKeys = { source: SaleSource | null; externalIds: string[]; orderNames: string[] };

const clean = (s: string | null | undefined) => (s ?? "").trim();
const shopifyGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/Order/${id}`);
const withAndWithoutHash = (n: string) => (n ? [n.replace(/^#/, ""), `#${n.replace(/^#/, "")}`] : []);

/**
 * Amazon labels carry the Amazon order number (112-…). Shopify labels carry the
 * numeric order id (our external_id is its gid) and the order number (#1001).
 */
export function matchKeys(orderSourceCode: string | null | undefined, externalOrderId: string | null | undefined, shipmentNumber: string | null | undefined): MatchKeys {
  const code = clean(orderSourceCode).toLowerCase();
  const ext = clean(externalOrderId);
  const num = clean(shipmentNumber);
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  if (code.startsWith("amazon")) return { source: "amazon", externalIds: uniq([ext, num]), orderNames: [] };
  if (code === "shopify") {
    return {
      source: "shopify",
      externalIds: uniq([ext && /^(\d+|gid:\/\/.+)$/.test(ext) ? shopifyGid(ext) : ""]),
      orderNames: uniq([...withAndWithoutHash(num), ...withAndWithoutHash(ext)]),
    };
  }
  // Unknown store type: try it as either channel.
  return {
    source: null,
    externalIds: uniq([ext, num, ext && /^\d+$/.test(ext) ? shopifyGid(ext) : ""]),
    orderNames: uniq(withAndWithoutHash(num)),
  };
}

/** Our order for these keys, or null when there's none (or more than one, so we don't guess). */
export async function findOrderFor(db: DB | Tx, k: MatchKeys): Promise<string | null> {
  if (!k.externalIds.length && !k.orderNames.length) return null;
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        k.source ? eq(orders.source, k.source) : undefined,
        or(
          k.externalIds.length ? inArray(orders.externalId, k.externalIds) : undefined,
          k.orderNames.length ? inArray(orders.orderName, k.orderNames) : undefined,
        ),
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * Save a label (insert or update by label id) and link it to its order. A label
 * already linked keeps its order; `shippedAt` is only ever filled in, never cleared.
 */
export async function upsertShipment(db: DB, v: ShipmentValues): Promise<{ id: string; orderId: string | null }> {
  const orderId = await findOrderFor(db, matchKeys(v.orderSourceCode, v.externalOrderId, v.shipmentNumber));
  const { shippedAt, ...rest } = v;
  const [row] = await db
    .insert(shipments)
    .values({ ...v, orderId })
    .onConflictDoUpdate({
      target: shipments.labelId,
      set: {
        ...rest,
        orderId: sql`coalesce(${shipments.orderId}, ${orderId})`,
        shippedAt: shippedAt ? sql`coalesce(${shipments.shippedAt}, ${shippedAt.toISOString()}::timestamptz)` : sql`${shipments.shippedAt}`,
        syncedAt: new Date(),
      },
    })
    .returning({ id: shipments.id, orderId: shipments.orderId });
  return row;
}

/** Mark every label of a ShipStation shipment as shipped (first time only). */
export async function markShipped(db: DB, shipmentId: string, at: Date) {
  await db
    .update(shipments)
    .set({ shippedAt: at })
    .where(and(eq(shipments.shipmentId, shipmentId), isNull(shipments.shippedAt)));
}

/** Labels saved before their order arrived: link the ones that match now. Looks back `days`. */
export async function rematchShipments(db: DB, days = 60, now = new Date()): Promise<number> {
  const waiting = await db
    .select()
    .from(shipments)
    .where(and(isNull(shipments.orderId), gt(shipments.createdAt, new Date(now.getTime() - days * 86_400_000))));
  let linked = 0;
  for (const s of waiting) {
    const orderId = await findOrderFor(db, matchKeys(s.orderSourceCode, s.externalOrderId, s.shipmentNumber));
    if (!orderId) continue;
    await db.update(shipments).set({ orderId }).where(and(eq(shipments.id, s.id), isNull(shipments.orderId)));
    linked++;
  }
  return linked;
}

/** Called when an order is saved: link labels that were waiting for it. */
export async function linkWaitingShipments(tx: Tx, order: { id: string; source: SaleSource; externalId: string; orderName?: string | null }) {
  const ids = order.source === "shopify" ? [order.externalId.split("/").pop() ?? order.externalId, order.externalId] : [order.externalId];
  const names = order.orderName ? withAndWithoutHash(order.orderName) : [];
  const sourceOk =
    order.source === "amazon"
      ? sql`coalesce(${shipments.orderSourceCode}, 'amazon') ilike 'amazon%'`
      : sql`coalesce(${shipments.orderSourceCode}, '') not ilike 'amazon%'`;
  await tx
    .update(shipments)
    .set({ orderId: order.id })
    .where(
      and(
        isNull(shipments.orderId),
        sourceOk,
        or(
          inArray(shipments.externalOrderId, ids),
          names.length ? inArray(shipments.shipmentNumber, names) : undefined,
          names.length ? inArray(shipments.externalOrderId, names) : undefined,
        ),
      ),
    );
}

/** Labels that count toward cost: bought (completed) and not voided. */
export const counts = (s: Pick<Shipment, "status" | "voidedAt">) => s.status === "completed" && !s.voidedAt;

export type OrderShipping = {
  /** What we paid carriers for this order (null: no label yet). */
  shippingCost: number | null;
  shippingCurrency: string | null;
  /** First ship date of a label that counts. */
  shippedOn: string | null;
};

/** Shipping cost and ship date per order, from its labels. */
export async function shippingForOrders(db: DB, orderIds: string[]): Promise<Map<string, OrderShipping>> {
  const out = new Map<string, OrderShipping>();
  if (!orderIds.length) return out;
  const rows = await db
    .select()
    .from(shipments)
    .where(inArray(shipments.orderId, orderIds))
    .orderBy(asc(shipments.shipDate), asc(shipments.createdAt));
  for (const id of orderIds) {
    const live = rows.filter((s) => s.orderId === id && counts(s));
    if (!live.length) continue;
    const day = (s: Shipment) => s.shipDate ?? (s.shippedAt ? s.shippedAt.toISOString().slice(0, 10) : null);
    out.set(id, {
      shippingCost: sumMoney(live.map((s) => s.cost)),
      shippingCurrency: live[0].currency,
      shippedOn: live.map(day).filter((d): d is string => !!d).sort()[0] ?? null,
    });
  }
  return out;
}

/** Every label of one order, newest first, for the order page. */
export async function shipmentsForOrder(db: DB, orderId: string) {
  const rows = await db.select().from(shipments).where(eq(shipments.orderId, orderId)).orderBy(sql`${shipments.createdAt} desc`);
  return rows.map(({ raw, ...s }) => {
    void raw;
    return { ...s, counts: counts(s) };
  });
}
