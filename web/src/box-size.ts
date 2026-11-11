import type { SteelData } from "./api";

/** "58 × 14 × 8 in" for a box with a size. */
export function boxSize(i: Pick<SteelData["items"][number], "lengthIn" | "widthIn" | "heightIn">) {
  return i.lengthIn && i.widthIn && i.heightIn ? `${i.lengthIn} × ${i.widthIn} × ${i.heightIn} in` : "—";
}
