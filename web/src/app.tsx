import type { Permission } from "@lacey-factory/shared/permissions";
import type { ReactNode } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router";

import { useApi } from "./api";
import { Nav } from "./components/nav";
import { Denied, Splash } from "./components/splash";
import { useCan } from "./me";
import { CustomerPage } from "./pages/customer";
import { CustomersPage } from "./pages/customers";
import { InboxPage } from "./pages/inbox";
import { InventoryPage } from "./pages/inventory";
import { NewRollPage } from "./pages/new-roll";
import { NotFoundPage } from "./pages/not-found";
import { OrderPage } from "./pages/order";
import { OrdersPage } from "./pages/orders";
import { RollPage } from "./pages/roll";
import { RollsPage } from "./pages/rolls";
import { SettingsPage } from "./pages/settings";
import { SummitPage } from "./pages/summit";
import { ToSewPage } from "./pages/to-sew";
import { UsersPage } from "./pages/users";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/rolls" replace />} />
        <Route path="rolls" element={<RollsPage />} />
        <Route path="rolls/new" element={<NewRollPage />} />
        <Route path="rolls/:id" element={<RollPage />} />
        <Route path="cut" element={<ToSewPage />} />
        <Route path="summit" element={<SummitPage />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="orders" element={<RequirePermission need="orders"><OrdersPage /></RequirePermission>} />
        <Route path="orders/:id" element={<RequirePermission need="orders"><OrderPage /></RequirePermission>} />
        <Route path="customers" element={<RequirePermission need="orders"><CustomersPage /></RequirePermission>} />
        <Route path="customers/:id" element={<RequirePermission need="orders"><CustomerPage /></RequirePermission>} />
        <Route path="inbox" element={<RequirePermission need="invoices:review"><InboxPage /></RequirePermission>} />
        <Route path="settings" element={<RequirePermission need="settings"><SettingsPage /></RequirePermission>} />
        <Route path="users" element={<RequirePermission need="users"><UsersPage /></RequirePermission>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

/** Loads the signed-in user (creating them on first sign-in) before any page. */
function Layout() {
  const { data: me, error } = useApi("me", { staleTime: 5 * 60 * 1000 });
  if (error?.status === 403) return <Denied />;
  if (error) return <Splash>{error.message}</Splash>;
  if (!me) return <Splash>Loading…</Splash>;
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </>
  );
}

function RequirePermission({ need, children }: { need: Permission; children: ReactNode }) {
  const can = useCan();
  if (!can(need)) return <NotFoundPage message="You don't have access to this page. Ask Eric if you need it." />;
  return <>{children}</>;
}
