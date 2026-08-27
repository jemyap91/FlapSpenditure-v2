import { describe, expect, it } from "vitest";
import { parseOrigin } from "@/lib/origin";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("parseOrigin", () => {
  it("turns a wallet origin into that wallet's path", () => {
    expect(parseOrigin(`wallet:${UUID}`)).toBe(`/wallets/${UUID}`);
  });

  it("falls back when absent", () => {
    expect(parseOrigin(null)).toBe("/transactions");
    expect(parseOrigin(undefined)).toBe("/transactions");
  });

  it("falls back on a malformed uuid rather than trusting it", () => {
    expect(parseOrigin("wallet:not-a-uuid")).toBe("/transactions");
    expect(parseOrigin("wallet:")).toBe("/transactions");
  });

  // The reason this function exists. Each of these is a redirect target a
  // caller could supply; none may ever become a destination.
  it("refuses an absolute URL", () => {
    expect(parseOrigin("https://evil.example")).toBe("/transactions");
  });

  it("refuses a protocol-relative URL", () => {
    expect(parseOrigin("//evil.example")).toBe("/transactions");
  });

  it("refuses a path, even an in-app one", () => {
    expect(parseOrigin("/wallets/abc")).toBe("/transactions");
    expect(parseOrigin("/admin")).toBe("/transactions");
  });

  it("refuses traversal", () => {
    expect(parseOrigin(`wallet:${UUID}/../admin`)).toBe("/transactions");
  });

  it("refuses an unknown origin kind", () => {
    expect(parseOrigin(`budget:${UUID}`)).toBe("/transactions");
  });

  // Additional adversarial cases beyond the brief's minimum.
  it("refuses an empty string", () => {
    expect(parseOrigin("")).toBe("/transactions");
  });

  it("refuses a javascript: URL smuggled as an origin kind", () => {
    expect(parseOrigin("javascript:alert(1)")).toBe("/transactions");
  });

  it("refuses a wallet id with embedded whitespace/newline (header/URL injection)", () => {
    expect(parseOrigin(`wallet:${UUID}\n/evil`)).toBe("/transactions");
    expect(parseOrigin(`wallet: ${UUID}`)).toBe("/transactions");
  });

  it("refuses a second wallet: prefix (id fails uuid validation as a whole)", () => {
    expect(parseOrigin(`wallet:wallet:${UUID}`)).toBe("/transactions");
  });

  // This is the case that actually discriminates `rest.join(":")` from
  // `rest[0]`: a buggy implementation using only the first colon-delimited
  // segment would silently accept the valid uuid prefix and strip the
  // trailing ":extra", returning a valid-looking wallet path. The correct
  // implementation must treat everything after the first colon as the id
  // and reject it as a whole.
  it("refuses a valid uuid with trailing colon-delimited garbage", () => {
    expect(parseOrigin(`wallet:${UUID}:extra`)).toBe("/transactions");
  });

  it("refuses an uppercase-cased kind (no case-insensitive match)", () => {
    expect(parseOrigin(`Wallet:${UUID}`)).toBe("/transactions");
    expect(parseOrigin(`WALLET:${UUID}`)).toBe("/transactions");
  });

  it("refuses a uuid with trailing garbage or extra path segments", () => {
    expect(parseOrigin(`wallet:${UUID}extra`)).toBe("/transactions");
    expect(parseOrigin(`wallet:${UUID}/`)).toBe("/transactions");
  });
});
