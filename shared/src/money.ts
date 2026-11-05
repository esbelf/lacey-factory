// Money is stored with 4 decimals (supplier rates like $12.3456). Do math in
// ten-thousandths of a dollar so sums and freight splits never drift.
export const toUnits = (dollars: number) => Math.round(dollars * 10_000);
export const fromUnits = (units: number) => units / 10_000;

export function sumMoney(values: number[]): number {
  return fromUnits(values.reduce((acc, v) => acc + toUnits(v), 0));
}

/** qty × price, exact to the ten-thousandth. */
export function mulMoney(qty: number, price: number): number {
  return fromUnits(Math.round(qty * toUnits(price)));
}

/** "$1,234.56" — shows up to 4 decimals only when the value has them. */
export function formatMoney(dollars: number | null | undefined): string {
  if (dollars == null) return "—";
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}
