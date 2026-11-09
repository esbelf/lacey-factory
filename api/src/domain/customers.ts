// Customers across orders. A repeat buyer is one customer: an order finds its
// customer by the channel's customer id first, then by email (so guest
// checkouts and new accounts with a known email join the same person).
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";

import { customerLinks, customers, orders } from "../db/schema";
import type { DB, Tx } from "../db/types";
import type { SaleSource } from "./sales";

/** Who placed an order, as the channel sent it. */
export type CustomerInput = {
  /** The channel's customer id (Shopify GID); null for guest checkouts. */
  externalId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
};

export const normalizeEmail = (email: string | null | undefined) => email?.trim().toLowerCase() || null;

/**
 * The customer for an order, creating one if needed. Runs inside the order's
 * transaction. Returns null when the order has neither an email nor a customer id.
 */
export async function matchCustomer(tx: Tx, source: SaleSource, input: CustomerInput): Promise<string | null> {
  const email = normalizeEmail(input.email);
  const externalId = input.externalId?.trim() || null;
  if (!email && !externalId) return null;

  let id: string | undefined;
  if (externalId) {
    [{ customerId: id } = { customerId: undefined }] = await tx
      .select({ customerId: customerLinks.customerId })
      .from(customerLinks)
      .where(and(eq(customerLinks.source, source), eq(customerLinks.externalId, externalId)));
  }
  if (!id && email) id = await byEmail(tx, email);
  if (!id) {
    const [created] = await tx
      .insert(customers)
      .values({ email, firstName: input.firstName, lastName: input.lastName, phone: input.phone })
      .onConflictDoNothing({ target: customers.email, where: sql`${customers.email} is not null` })
      .returning({ id: customers.id });
    // Another order with this email got there first.
    id = created?.id ?? (email ? await byEmail(tx, email) : undefined);
    if (!id) throw new Error(`Couldn't create a customer for ${email ?? externalId}.`);
  }

  if (externalId) {
    await tx.insert(customerLinks).values({ source, externalId, customerId: id }).onConflictDoNothing();
  }

  // Keep the details current. An email is only added if the customer has none
  // and no other customer uses it.
  const [current] = await tx.select().from(customers).where(eq(customers.id, id)).for("update");
  const emailFree = email && !current.email && !(await byEmail(tx, email));
  await tx
    .update(customers)
    .set({
      firstName: input.firstName ?? current.firstName,
      lastName: input.lastName ?? current.lastName,
      phone: input.phone ?? current.phone,
      ...(emailFree ? { email } : {}),
      updatedAt: new Date(),
    })
    .where(eq(customers.id, id));
  return id;
}

async function byEmail(tx: Tx | DB, email: string) {
  const [row] = await tx.select({ id: customers.id }).from(customers).where(eq(customers.email, email));
  return row?.id;
}

// ── Reads ──

/** Totals per customer, from their orders that weren't canceled. */
const stats = {
  orderCount: sql<number>`count(${orders.id})::int`,
  firstOrderAt: sql<string | null>`min(${orders.purchasedAt})`,
  lastOrderAt: sql<string | null>`max(${orders.purchasedAt})`,
  /** { USD: 123.45, CAD: 67.8 } */
  spent: sql<Record<string, number> | null>`(
    select jsonb_object_agg(t.currency, t.total) from (
      select coalesce(o2.currency, '?') as currency, sum(o2.order_total)::float8 as total
      from ${orders} o2
      where o2.customer_id = ${customers.id} and o2.canceled_at is null and o2.order_total is not null
      group by 1
    ) t
  )`,
};

export async function listCustomers(db: DB, input: { q?: string; limit?: number } = {}) {
  const q = input.q?.trim();
  const like = `%${q}%`;
  return db
    .select({ customer: customers, ...stats })
    .from(customers)
    .leftJoin(orders, eq(orders.customerId, customers.id))
    .where(
      q
        ? or(
            ilike(customers.email, like),
            ilike(customers.phone, like),
            ilike(sql`coalesce(${customers.firstName}, '') || ' ' || coalesce(${customers.lastName}, '')`, like),
          )
        : undefined,
    )
    .groupBy(customers.id)
    .orderBy(sql`max(${orders.purchasedAt}) desc nulls last`, customers.id)
    .limit(Math.min(input.limit ?? 200, 500));
}

export async function getCustomer(db: DB, id: string) {
  const [row] = await db
    .select({ customer: customers, ...stats })
    .from(customers)
    .leftJoin(orders, eq(orders.customerId, customers.id))
    .where(eq(customers.id, id))
    .groupBy(customers.id);
  if (!row) return null;
  const history = await db
    .select({
      id: orders.id,
      source: orders.source,
      externalId: orders.externalId,
      orderName: orders.orderName,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      canceledAt: orders.canceledAt,
      purchasedAt: orders.purchasedAt,
      currency: orders.currency,
      orderTotal: orders.orderTotal,
      taxTotal: orders.taxTotal,
      shipCity: orders.shipCity,
      shipState: orders.shipState,
      shipCountry: orders.shipCountry,
      items: sql<number>`(select coalesce(sum(qty_ordered), 0)::int from order_items where order_id = ${orders.id})`,
    })
    .from(orders)
    .where(eq(orders.customerId, id))
    .orderBy(desc(orders.purchasedAt));
  return { ...row, orders: history };
}
