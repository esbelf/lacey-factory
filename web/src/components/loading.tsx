import { Card } from "./ui";

/** Placeholder while a page's data loads, or its error if loading failed. */
export function Loading({ error }: { error?: Error | null }) {
  if (error) {
    return (
      <Card>
        <p role="alert" className="text-danger">
          {error.message}
        </p>
      </Card>
    );
  }
  return <p className="py-10 text-center text-muted">Loading…</p>;
}
