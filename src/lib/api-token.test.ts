// @vitest-environment node
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { bearerToken, displayPrefix, generateApiToken, hashApiToken, signSupabaseJwt, TOKEN_PREFIX } from "./api-token";

describe("hashApiToken", () => {
  it("matches resolve_api_token's encode(sha256(convert_to(p_token, 'UTF8')), 'hex')", () => {
    // Vector taken from Postgres itself:
    //   select encode(sha256(convert_to('flap_testtoken123', 'UTF8')), 'hex');
    // If these ever disagree, no token created by the app can be resolved.
    expect(hashApiToken("flap_testtoken123")).toBe(
      "f1836b207b5856d04be6fe5af59c975636adde62f488f3edde17191c73f0fd9b",
    );
  });
});

describe("generateApiToken", () => {
  it("is prefixed, long, URL-safe and different every time", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(a).toMatch(/^flap_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("shows only a short prefix in lists", () => {
    expect(displayPrefix("flap_abcdefghij")).toBe("flap_abcd");
  });
});

describe("bearerToken", () => {
  it.each([
    ["Bearer flap_x", "flap_x"],
    ["bearer flap_x", "flap_x"],
    ["Bearer   flap_x  ", "flap_x"],
  ])("reads %j", (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });

  it.each([null, "", "Basic abc", "Bearer", "Bearer a b", "flap_x"])("rejects %j", (header) => {
    expect(bearerToken(header)).toBeNull();
  });
});

describe("signSupabaseJwt", () => {
  const secret = "super-secret-jwt-token-with-at-least-32-characters-long";

  it("signs an HS256 JWT carrying the claims RLS and GoTrue read", () => {
    const jwt = signSupabaseJwt({ sub: "user-1", email: "a@example.com", iat: 100, exp: 400 }, secret);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      sub: "user-1",
      email: "a@example.com",
      iat: 100,
      exp: 400,
      aud: "authenticated",
      role: "authenticated",
      is_anonymous: false,
    });
    expect(signature).toBe(createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url"));
  });

  it("omits email rather than sending null when the user has none", () => {
    const jwt = signSupabaseJwt({ sub: "user-1", email: null, iat: 1, exp: 2 }, secret);
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
    expect("email" in payload).toBe(false);
  });
});
