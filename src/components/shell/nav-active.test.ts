import { describe, expect, it } from "vitest";
import { isActive } from "./nav-active";

const SIDEBAR_HREFS = ["/", "/wallets", "/transactions", "/categories"];
const TABBAR_HREFS = ["/", "/wallets", "/transactions/new", "/transactions", "/categories"];

describe("isActive", () => {
  it("matches the home href only on an exact match", () => {
    expect(isActive("/", "/", SIDEBAR_HREFS)).toBe(true);
    expect(isActive("/wallets", "/", SIDEBAR_HREFS)).toBe(false);
  });

  it("matches a non-home href on an exact match", () => {
    expect(isActive("/wallets", "/wallets", SIDEBAR_HREFS)).toBe(true);
  });

  it("matches a non-home href on a segment boundary sub-path", () => {
    expect(isActive("/transactions/123", "/transactions", SIDEBAR_HREFS)).toBe(true);
  });

  it("does not match a path merely prefixed by the href's characters", () => {
    // Regression case: a bare `pathname.startsWith(href)` check would
    // incorrectly match "/transactions-archive" against "/transactions".
    expect(isActive("/transactions-archive", "/transactions", SIDEBAR_HREFS)).toBe(false);
  });

  it("does not activate an unrelated href", () => {
    expect(isActive("/categories", "/wallets", SIDEBAR_HREFS)).toBe(false);
  });

  it("resolves the longest matching href as active when hrefs overlap", () => {
    // Regression case: TabBar has both "/transactions" (Activity) and
    // "/transactions/new" (Add). On "/transactions/new", both hrefs pass
    // the segment-boundary test; only the longer, more specific one should
    // be reported active.
    expect(isActive("/transactions/new", "/transactions/new", TABBAR_HREFS)).toBe(true);
    expect(isActive("/transactions/new", "/transactions", TABBAR_HREFS)).toBe(false);
  });

  it("still activates the shorter href on its own exact path", () => {
    expect(isActive("/transactions", "/transactions", TABBAR_HREFS)).toBe(true);
    expect(isActive("/transactions", "/transactions/new", TABBAR_HREFS)).toBe(false);
  });

  it("activates the shorter href for a deeper sub-path that isn't under the longer href", () => {
    expect(isActive("/transactions/456/edit", "/transactions", TABBAR_HREFS)).toBe(true);
  });
});
