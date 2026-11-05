/**
 * Lacey's real materials, cut sizes and products (from Eric, 2026-10-28).
 * Loaded by Settings → "Load LakeMat catalog". Loading only adds what's
 * missing; it never changes rows that already exist.
 *
 * Cut lengths: Eric said extra is cut for hems but hasn't given the amounts
 * yet. So sizes start at the finished length and are loaded switched OFF —
 * nobody can record a cut on them until the real cut length is entered in
 * Settings and the size is turned on.
 */

export type CatalogMaterial = {
  name: string;
  requiresSewing: boolean;
  defaultWidthFt: number | null; // usual roll width; null = not given yet
  sizes: { label: string; widthFt: number; finishedLengthFt: number; usedFor: string }[];
};

export const N06 = "TerraTex N06";
export const RX1100 = "TerraGrid RX1100";
export const HD_NTPEP = "TerraTex HD NTPEP";
export const HPG57 = "TerraTex HPG-57";

export const CATALOG_MATERIALS: CatalogMaterial[] = [
  {
    name: N06,
    requiresSewing: true,
    defaultWidthFt: null,
    sizes: [
      { label: "12x24", widthFt: 12, finishedLengthFt: 24, usedFor: "LakeMat / MuckMat XL" },
      { label: "12x19", widthFt: 12, finishedLengthFt: 19, usedFor: "LakeMat / MuckMat L" },
      { label: "12x14", widthFt: 12, finishedLengthFt: 14, usedFor: "LakeMat / MuckMat M" },
    ],
  },
  {
    // Geogrid: not sewn, cut pieces go straight to inventory.
    name: RX1100,
    requiresSewing: false,
    defaultWidthFt: null,
    sizes: [
      { label: "12x24", widthFt: 12, finishedLengthFt: 24, usedFor: "MuckMat XL" },
      { label: "12x19", widthFt: 12, finishedLengthFt: 19, usedFor: "MuckMat L" },
      { label: "12x14", widthFt: 12, finishedLengthFt: 14, usedFor: "MuckMat M" },
    ],
  },
  {
    name: HD_NTPEP,
    requiresSewing: true,
    defaultWidthFt: null,
    sizes: [
      { label: `11'6"x24'`, widthFt: 11.5, finishedLengthFt: 24, usedFor: "Hydrilla Mat / LilyHammer" },
      { label: `11'6"x19'`, widthFt: 11.5, finishedLengthFt: 19, usedFor: "Hydrilla Mat / LilyHammer" },
    ],
  },
  {
    // 14' wide roll; each size takes its first number off the roll length.
    name: HPG57,
    requiresSewing: true,
    defaultWidthFt: 14,
    sizes: [
      { label: "6x14", widthFt: 14, finishedLengthFt: 6, usedFor: "DockMat Regular / Kayak Mat XL / Boatlift Extreme (×2) / OneSetOfLegs" },
      { label: "9x14", widthFt: 14, finishedLengthFt: 9, usedFor: "DockMat Extra Wide / PWC Boatlift" },
      { label: "14x14", widthFt: 14, finishedLengthFt: 14, usedFor: "Boatlift Large" },
      { label: "19x14", widthFt: 14, finishedLengthFt: 19, usedFor: "Boatlift XL" },
      { label: "24x14", widthFt: 14, finishedLengthFt: 24, usedFor: "Boatlift Pontoon" },
    ],
  },
];

export type CatalogProduct = {
  name: string;
  productLine: string;
  uses: { material: string; size: string; qty: number }[];
};

const SIZES_LMX = [
  ["M", "12x14"],
  ["L", "12x19"],
  ["XL", "12x24"],
] as const;

export const CATALOG_PRODUCTS: CatalogProduct[] = [
  ...SIZES_LMX.map(([v, s]) => ({ name: `LakeMat ${v}`, productLine: "LakeMat", uses: [{ material: N06, size: s, qty: 1 }] })),
  ...SIZES_LMX.map(([v, s]) => ({
    name: `MuckMat ${v}`,
    productLine: "MuckMat",
    uses: [
      { material: N06, size: s, qty: 1 },
      { material: RX1100, size: s, qty: 1 },
    ],
  })),
  { name: "DockMat Regular", productLine: "DockMat", uses: [{ material: HPG57, size: "6x14", qty: 1 }] },
  { name: "DockMat Extra Wide", productLine: "DockMat", uses: [{ material: HPG57, size: "9x14", qty: 1 }] },
  { name: "Kayak Mat XL", productLine: "Kayak Mat", uses: [{ material: HPG57, size: "6x14", qty: 1 }] },
  { name: "Boatlift Mat PWC", productLine: "Boatlift Mat", uses: [{ material: HPG57, size: "9x14", qty: 1 }] },
  { name: "Boatlift Mat Extreme", productLine: "Boatlift Mat", uses: [{ material: HPG57, size: "6x14", qty: 2 }] },
  { name: "Boatlift Mat OneSetOfLegs", productLine: "Boatlift Mat", uses: [{ material: HPG57, size: "6x14", qty: 1 }] },
  { name: "Boatlift Mat Large", productLine: "Boatlift Mat", uses: [{ material: HPG57, size: "14x14", qty: 1 }] },
  { name: "Boatlift Mat XL", productLine: "Boatlift Mat", uses: [{ material: HPG57, size: "19x14", qty: 1 }] },
  { name: "Boatlift Mat Pontoon", productLine: "Boatlift Mat", uses: [{ material: HPG57, size: "24x14", qty: 1 }] },
];

/**
 * Roll suppliers and how their product codes map to our rolls. Sender email
 * addresses are entered in Settings → Suppliers (not known here).
 */
export const CATALOG_SUPPLIERS = [
  {
    name: "Hanes Geo Components",
    kind: "rolls" as const,
    products: [{ productCode: "38151", descriptionMatch: "TERRATEX N06", material: N06, widthFt: 12.5, lengthFt: 360 }],
  },
];
