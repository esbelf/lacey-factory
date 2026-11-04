import { todayInMichigan } from "@lacey-factory/shared/feet";
import { useState } from "react";
import { Link, useNavigate } from "react-router";

import { post, useApi } from "../api";
import { ActionForm, SubmitButton } from "../components/action-form";
import { Loading } from "../components/loading";
import { Card, Empty, Field, Input, PageHeader, Select } from "../components/ui";
import { useCan } from "../me";
import { useTitle } from "../title";

export function NewRollPage() {
  useTitle("Register roll");
  const navigate = useNavigate();
  const can = useCan();
  const { data, error } = useApi("materials");
  if (!data) return <Loading error={error} />;
  const materials = data.filter((m) => m.active);

  return (
    <>
      <PageHeader title="Register a roll" subtitle="It shows up as not cut, with today's received date." />
      <Card className="max-w-2xl">
        {materials.length === 0 ? (
          <Empty>
            {can("settings") ? (
              <>
                Add a material in{" "}
                <Link className="underline" to="/settings">
                  Settings
                </Link>{" "}
                first.
              </>
            ) : (
              "No materials yet. Ask a regular worker to add one in Settings."
            )}
          </Empty>
        ) : (
          <ActionForm
            action={post("/api/rolls")}
            onSuccess={(r) => r.id && navigate(`/rolls/${r.id}`)}
            className="grid gap-4 sm:grid-cols-2"
          >
            <MaterialWidthPicker materials={materials} />
            <Field label="Length (ft)">
              <Input name="lengthFt" type="number" step="0.01" min="0" inputMode="decimal" placeholder="360" required />
            </Field>
            <Field label="Received on">
              <Input name="receivedOn" type="date" defaultValue={todayInMichigan()} required />
            </Field>
            <Field label="Supplier roll # (from the label)">
              <Input name="supplierRollNo" placeholder="e.g. 2YZ" />
            </Field>
            <Field label="Supplier">
              <Input name="supplier" placeholder="e.g. Hanes" />
            </Field>
            <Field label="Notes">
              <Input name="notes" />
            </Field>
            <div className="sm:col-span-2">
              <SubmitButton>Register roll</SubmitButton>
            </div>
          </ActionForm>
        )}
      </Card>
    </>
  );
}

type M = { id: string; name: string; defaultWidthFt: number | null };

/** Picking a material pre-fills its usual roll width. */
function MaterialWidthPicker({ materials }: { materials: M[] }) {
  const [width, setWidth] = useState(materials[0]?.defaultWidthFt?.toString() ?? "");
  return (
    <>
      <Field label="Material">
        <Select
          name="materialId"
          required
          defaultValue={materials[0]?.id}
          onChange={(e) => {
            const m = materials.find((x) => x.id === e.target.value);
            if (m?.defaultWidthFt != null) setWidth(String(m.defaultWidthFt));
          }}
        >
          {materials.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Width (ft)">
        <Input
          name="widthFt"
          type="number"
          step="0.01"
          min="0"
          inputMode="decimal"
          value={width}
          onChange={(e) => setWidth(e.target.value)}
          required
        />
      </Field>
    </>
  );
}
