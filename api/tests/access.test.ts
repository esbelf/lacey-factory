import { describe, expect, it } from "vitest";

import { isAllowedEmail, parseAllowlist } from "../src/lib/access";
import { subtractFeet, sumFeet } from "@lacey-factory/shared/feet";

describe("isAllowedEmail", () => {
  const allow = parseAllowlist(" chris.crew@gmail.com,\nother@yahoo.com ");

  it("allows verified lakemat.com emails, any case", () => {
    expect(isAllowedEmail("Eric@LakeMat.com", true, allow)).toBe(true);
  });
  it("allows verified allowlisted emails", () => {
    expect(isAllowedEmail("chris.crew@gmail.com", true, allow)).toBe(true);
  });
  it("denies unverified emails, even lakemat.com", () => {
    expect(isAllowedEmail("eric@lakemat.com", false, allow)).toBe(false);
    expect(isAllowedEmail("chris.crew@gmail.com", undefined, allow)).toBe(false);
  });
  it("denies look-alike domains and strangers", () => {
    expect(isAllowedEmail("x@evil-lakemat.com", true, allow)).toBe(false);
    expect(isAllowedEmail("x@lakemat.com.evil.io", true, allow)).toBe(false);
    expect(isAllowedEmail("random@gmail.com", true, allow)).toBe(false);
    expect(isAllowedEmail(null, true, allow)).toBe(false);
  });
});

describe("feet math", () => {
  it("has no float drift", () => {
    expect(sumFeet([0.1, 0.2])).toBe(0.3);
    expect(subtractFeet(360, 26.1 * 3)).toBe(281.7);
  });
});
