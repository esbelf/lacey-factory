import { Link } from "react-router";

import { Card, PageHeader } from "../components/ui";

export function NotFoundPage({ message = "That page doesn't exist." }: { message?: string }) {
  return (
    <>
      <PageHeader title="Not found" />
      <Card>
        <p>
          {message}{" "}
          <Link className="text-brand underline" to="/rolls">
            Back to rolls
          </Link>
        </p>
      </Card>
    </>
  );
}
