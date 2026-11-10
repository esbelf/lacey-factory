// Lambda startup: secrets from Secrets Manager and the CloudFront origin check.
import { afterEach, describe, expect, it } from "vitest";

import { fromCloudFront, loadSecrets } from "../src/lambda-env";

describe("loadSecrets", () => {
  const names = ["T_DB_URL", "T_KEY", "T_EMPTY", "T_SET"];
  afterEach(() => names.forEach((n) => delete process.env[n]));

  it("fills unset variables, skips empty values and never overwrites", async () => {
    process.env.T_SET = "from-env";
    let asked = "";
    await loadSecrets("arn:secret", async (arn) => {
      asked = arn;
      return JSON.stringify({ T_DB_URL: "postgres://x", T_KEY: "k", T_EMPTY: "", T_SET: "from-secret" });
    });
    expect(asked).toBe("arn:secret");
    expect(process.env.T_DB_URL).toBe("postgres://x");
    expect(process.env.T_KEY).toBe("k");
    expect(process.env.T_EMPTY).toBeUndefined();
    expect(process.env.T_SET).toBe("from-env");
  });

  it("does nothing without a secret ARN", async () => {
    await loadSecrets(undefined, async () => {
      throw new Error("should not be called");
    });
  });
});

describe("fromCloudFront", () => {
  it("accepts only the exact header", () => {
    expect(fromCloudFront({ "x-origin-verify": "s3cret" }, "s3cret")).toBe(true);
    expect(fromCloudFront({ "x-origin-verify": "wrong!" }, "s3cret")).toBe(false);
    expect(fromCloudFront({}, "s3cret")).toBe(false);
    expect(fromCloudFront(undefined, "s3cret")).toBe(false);
  });
});
