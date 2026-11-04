// Feet are stored with 2 decimals. Do math in hundredths so 12.5 + 0.1 style
// float errors never make a valid cut look like an over-cut.
const toHundredths = (ft: number) => Math.round(ft * 100);

export function sumFeet(values: number[]): number {
  return values.reduce((acc, v) => acc + toHundredths(v), 0) / 100;
}

export function subtractFeet(a: number, b: number): number {
  return (toHundredths(a) - toHundredths(b)) / 100;
}

export function formatFeet(ft: number | null | undefined): string {
  if (ft == null) return "—";
  return `${Number.isInteger(ft) ? ft : ft.toFixed(2).replace(/0$/, "")}'`;
}

/** Today's date in Michigan (YYYY-MM-DD), for date field defaults. */
export function todayInMichigan(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Detroit" }).format(now);
}
