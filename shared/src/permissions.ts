// Who can do what. The API enforces this on every route; the web app uses the
// same table only to hide buttons the user can't use.

export const ADMIN_EMAIL = "eric@lakemat.com";

export const ROLES = ["admin", "regular", "factory"] as const;
export type Role = (typeof ROLES)[number];

/** Roles the admin can hand out. Admin itself is fixed to ADMIN_EMAIL. */
export const ASSIGNABLE_ROLES = ["factory", "regular"] as const satisfies readonly Role[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  regular: "Regular worker",
  factory: "Factory worker",
};

const PERMISSIONS = {
  /** Register rolls, record cuts, mark sewn, send to / receive from Summit. */
  floor: ["admin", "regular", "factory"],
  /** Materials, cut sizes, loading the catalog. */
  settings: ["admin", "regular"],
  "inventory:adjust": ["admin", "regular"],
  /** Close out / reopen a roll. */
  "rolls:close": ["admin", "regular"],
  /** Undo cuts, sewing, shipments and receipts. */
  undo: ["admin", "regular"],
  /** User dashboard: see users and change their role. */
  users: ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return !!role && (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}
