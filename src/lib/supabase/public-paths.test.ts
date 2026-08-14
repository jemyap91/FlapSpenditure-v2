import { describe, expect, it } from "vitest";
import { isPublicPath, PUBLIC_PATHS } from "./public-paths";

describe("isPublicPath", () => {
  it.each(PUBLIC_PATHS)("treats %s itself as public", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it("treats sub-paths of a public path as public", () => {
    expect(isPublicPath("/auth/callback")).toBe(true);
    expect(isPublicPath("/login/reset")).toBe(true);
  });

  it("treats an unrelated path as protected", () => {
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
  });

  it("does not treat a path merely prefixed by a public path's characters as public", () => {
    // Regression cases: a bare `path.startsWith(p)` check would incorrectly
    // let these through, quietly fail-opening the auth gate.
    expect(isPublicPath("/login-help")).toBe(false);
    expect(isPublicPath("/signups")).toBe(false);
    expect(isPublicPath("/authorize")).toBe(false);
  });
});
