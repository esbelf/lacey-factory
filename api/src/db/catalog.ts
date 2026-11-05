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

/** Shipping boxes (from Eric, 2026-11-05). Outside size in inches. */
export const CATALOG_BOXES: { name: string; lengthIn: number; widthIn: number; heightIn: number }[] = [
  { name: "LAKEMAT BOX", lengthIn: 58, widthIn: 14, heightIn: 8 },
  { name: "MEDIUM LAKEMAT BOX", lengthIn: 59, widthIn: 18, heightIn: 6 },
  { name: "MUCKMAT BOX", lengthIn: 59, widthIn: 23, heightIn: 10 },
  { name: "LARGE MUCKMAT BOX", lengthIn: 59, widthIn: 23, heightIn: 7 },
  { name: "BOATLIFT BOX", lengthIn: 59, widthIn: 23, heightIn: 6 },
  { name: "DOCKMAT BOX", lengthIn: 58, widthIn: 14, heightIn: 6 },
  { name: "XL KAYAK BOX", lengthIn: 59, widthIn: 14, heightIn: 6 },
  { name: "SANDMAT 22x18x4", lengthIn: 22, widthIn: 18, heightIn: 4 },
  { name: "SANDMAT 22x18x6", lengthIn: 22, widthIn: 18, heightIn: 6 },
  { name: "SANDMAT 22x18x11", lengthIn: 22, widthIn: 18, heightIn: 11 },
  { name: "SANDMAT 22x18x16", lengthIn: 22, widthIn: 18, heightIn: 16 },
  { name: "SANDMAT 59x23x11", lengthIn: 59, widthIn: 23, heightIn: 11 },
];

/**
 * Products whose fabric/steel recipe isn't known yet; set it in Settings → Products.
 * (Recipe-less products can't be sold until then, so nothing is taken by mistake.)
 */
export const CATALOG_PRODUCTS_WITHOUT_RECIPE: { name: string; productLine: string }[] = [
  ...["Large", "XL", "Pontoon", "Half Extreme", "Extreme"].map((v) => ({ name: `Boatlift Slip ${v}`, productLine: "Boatlift Slip" })),
  ...["7x20", "7x30", "7x40", "7x50", "7x100", "12x20", "12x30", "12x40", "12x50", "12x60", "12x70", "12x80", "12x100"].map((v) => ({
    name: `SandMat ${v}`,
    productLine: "SandMat",
  })),
  ...["12x20", "12x30", "12x40"].map((v) => ({ name: `SandMat MAX ${v}`, productLine: "SandMat MAX" })),
  { name: "Lily Hammer Large", productLine: "Lily Hammer" },
  { name: "Lily Hammer XL", productLine: "Lily Hammer" },
  { name: "Kayak Mat Medium 6x5", productLine: "Kayak Mat" },
  { name: "Kayak Mat Large 6x9", productLine: "Kayak Mat" },
  { name: "Hydrilla Large 19'", productLine: "Hydrilla" },
  { name: "Hydrilla XL 24'", productLine: "Hydrilla" },
  { name: "Lake Buddy 6'", productLine: "Lake Buddy" },
  { name: "Lake Buddy 9'", productLine: "Lake Buddy" },
];

/**
 * Each product's own SKU, shipping box and packed weight (lb), from Eric's
 * shipping table (2026-11-05). "BoatLift Half Extreme" is our "Boatlift Mat
 * OneSetOfLegs"; the table's "DOCMAT BOX" is the DOCKMAT BOX.
 */
export const CATALOG_SHIPPING: { product: string; sku: string; box: string; weightLb: number | null }[] = [
  { product: "LakeMat XL", sku: "LM 24", box: "LAKEMAT BOX", weightLb: 63 },
  { product: "LakeMat L", sku: "LM 19", box: "LAKEMAT BOX", weightLb: 55 },
  { product: "LakeMat M", sku: "LM 14", box: "MEDIUM LAKEMAT BOX", weightLb: 44 },
  { product: "MuckMat XL", sku: "MM 24", box: "MUCKMAT BOX", weightLb: 70 },
  { product: "MuckMat L", sku: "MM 19", box: "LARGE MUCKMAT BOX", weightLb: 66 },
  { product: "MuckMat M", sku: "MM 14", box: "BOATLIFT BOX", weightLb: 55 },
  { product: "Boatlift Mat Large", sku: "BL 14", box: "BOATLIFT BOX", weightLb: 69 },
  { product: "Boatlift Mat XL", sku: "BL 19", box: "BOATLIFT BOX", weightLb: 85 },
  { product: "Boatlift Mat Pontoon", sku: "BL 24", box: "MUCKMAT BOX", weightLb: 96 },
  { product: "Boatlift Mat OneSetOfLegs", sku: "BL HALF EXTREME", box: "DOCKMAT BOX", weightLb: 40 },
  { product: "Boatlift Mat Extreme", sku: "BL EXTREME", box: "BOATLIFT BOX", weightLb: 85 },
  { product: "Boatlift Mat PWC", sku: "BL PWC", box: "DOCKMAT BOX", weightLb: 44 },
  { product: "Boatlift Slip Large", sku: "BLS 14", box: "BOATLIFT BOX", weightLb: 69 },
  { product: "Boatlift Slip XL", sku: "BLS 19", box: "BOATLIFT BOX", weightLb: 85 },
  { product: "Boatlift Slip Pontoon", sku: "BLS 24", box: "MUCKMAT BOX", weightLb: 96 },
  { product: "Boatlift Slip Half Extreme", sku: "BLS HALF EXTREME", box: "DOCKMAT BOX", weightLb: 40 },
  { product: "Boatlift Slip Extreme", sku: "BLS EXTREME", box: "BOATLIFT BOX", weightLb: 85 },
  { product: "DockMat Regular", sku: "DM 6", box: "DOCKMAT BOX", weightLb: 32 },
  { product: "DockMat Extra Wide", sku: "DM 9", box: "DOCKMAT BOX", weightLb: 44 },
  { product: "SandMat 7x20", sku: "SM 7x20", box: "SANDMAT 22x18x4", weightLb: 6 },
  { product: "SandMat 7x30", sku: "SM 7x30", box: "SANDMAT 22x18x4", weightLb: 9 },
  { product: "SandMat 7x40", sku: "SM 7x40", box: "SANDMAT 22x18x4", weightLb: 12 },
  { product: "SandMat 7x50", sku: "SM 7x50", box: "SANDMAT 22x18x6", weightLb: 13 },
  { product: "SandMat 7x100", sku: "SM 7x100", box: "SANDMAT 22x18x16", weightLb: 25 },
  { product: "SandMat 12x20", sku: "SM 12x20", box: "SANDMAT 22x18x6", weightLb: 12 },
  { product: "SandMat 12x30", sku: "SM 12x30", box: "SANDMAT 22x18x11", weightLb: 18 },
  { product: "SandMat 12x40", sku: "SM 12x40", box: "SANDMAT 22x18x11", weightLb: 24 },
  { product: "SandMat 12x50", sku: "SM 12x50", box: "SANDMAT 22x18x16", weightLb: 30 },
  { product: "SandMat 12x60", sku: "SM 12x60", box: "SANDMAT 22x18x16", weightLb: 34 },
  { product: "SandMat 12x70", sku: "SM 12x70", box: "BOATLIFT BOX", weightLb: 38 },
  { product: "SandMat 12x80", sku: "SM 12x80", box: "MUCKMAT BOX", weightLb: 45 },
  { product: "SandMat 12x100", sku: "SM 12x100", box: "MUCKMAT BOX", weightLb: 60 },
  { product: "SandMat MAX 12x20", sku: "SMM 20", box: "BOATLIFT BOX", weightLb: 25 },
  { product: "SandMat MAX 12x30", sku: "SMM 30", box: "MUCKMAT BOX", weightLb: 25 },
  { product: "SandMat MAX 12x40", sku: "SMM 40", box: "SANDMAT 59x23x11", weightLb: 30 },
  { product: "Lily Hammer Large", sku: "LH 19", box: "LAKEMAT BOX", weightLb: 69 },
  { product: "Lily Hammer XL", sku: "LH 24", box: "LAKEMAT BOX", weightLb: 77 },
  { product: "Kayak Mat Medium 6x5", sku: "KM 6", box: "DOCKMAT BOX", weightLb: 22 },
  { product: "Kayak Mat Large 6x9", sku: "KM 9", box: "DOCKMAT BOX", weightLb: 32 },
  { product: "Kayak Mat XL", sku: "KM 14", box: "XL KAYAK BOX", weightLb: 35 },
  { product: "Hydrilla Large 19'", sku: "HK 19", box: "LAKEMAT BOX", weightLb: null },
  { product: "Hydrilla XL 24'", sku: "HK 24", box: "LAKEMAT BOX", weightLb: 63 },
  { product: "Lake Buddy 6'", sku: "LB 6", box: "DOCKMAT BOX", weightLb: 28 },
  { product: "Lake Buddy 9'", sku: "LB 9", box: "DOCKMAT BOX", weightLb: 39 },
];
