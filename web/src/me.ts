import { can, type Permission } from "@lacey-factory/shared/permissions";

import { useApi } from "./api";

/** The signed-in user (loaded once by the layout, cached after). */
export function useMe() {
  const { data } = useApi("me", { staleTime: 5 * 60 * 1000 });
  return data;
}

/** Whether the signed-in user may do something. Only hides UI; the API enforces it. */
export function useCan(): (p: Permission) => boolean {
  const me = useMe();
  return (p) => can(me?.role, p);
}
