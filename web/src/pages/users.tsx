import { ASSIGNABLE_ROLES, ROLE_LABEL } from "@lacey-factory/shared/permissions";

import { patch, useApi } from "../api";
import { ActionForm, SubmitButton } from "../components/action-form";
import { Loading } from "../components/loading";
import { Card, Empty, PageHeader, Select, Table } from "../components/ui";
import { useTitle } from "../title";

function formatSeen(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Detroit",
  });
}

export function UsersPage() {
  useTitle("Users");
  const { data: users, error } = useApi("users");
  if (!users) return <Loading error={error} />;

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="People show up here after they first sign in, as factory workers. Promote someone to a regular worker to let them change Settings, adjust inventory, close rolls and undo entries."
      />
      <Card>
        {users.length === 0 ? (
          <Empty>No one has signed in yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>User</th>
                <th>Last seen</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="font-semibold">{u.email}</div>
                    {u.name !== u.email && <div className="text-sm text-muted">{u.name}</div>}
                    {u.roleChangedBy && (
                      <div className="text-xs text-muted">
                        Role set by {u.roleChangedBy}
                        {u.roleChangedAt && ` · ${formatSeen(u.roleChangedAt)}`}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-muted">{formatSeen(u.lastSeenAt)}</td>
                  <td>
                    {u.role === "admin" ? (
                      <span className="font-semibold">{ROLE_LABEL.admin}</span>
                    ) : (
                      <ActionForm action={patch(`/api/users/${u.id}`)} className="flex flex-wrap items-center gap-2">
                        <Select name="role" defaultValue={u.role} className="w-48">
                          {ASSIGNABLE_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </Select>
                        <SubmitButton variant="secondary">Save</SubmitButton>
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
