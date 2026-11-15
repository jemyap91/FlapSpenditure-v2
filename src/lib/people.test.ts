import { describe, it, expect } from "vitest";
import { peopleFor, personForWallet, sharedFor } from "./people";

const cheryl = { user_id: "u-c", display_name: "Cheryl" };
const jeremy = { user_id: "u-j", display_name: "Jeremy" };

describe("peopleFor", () => {
  it("colours members alphabetically, the same whatever order they arrive in", () => {
    for (const members of [[cheryl, jeremy], [jeremy, cheryl]]) {
      const people = peopleFor(members);
      expect(people.get("u-c")).toMatchObject({ name: "Cheryl", initials: "C", color: "var(--candy)" });
      expect(people.get("u-j")).toMatchObject({ name: "Jeremy", initials: "J", color: "var(--cobalt)" });
    }
  });

  it("counts a member listed in several households once", () => {
    expect(peopleFor([cheryl, cheryl, jeremy]).size).toBe(2);
  });

  it("gives anyone past the first two a neutral colour", () => {
    const people = peopleFor([cheryl, jeremy, { user_id: "u-z", display_name: "Zed" }]);
    expect(people.get("u-z")?.color).toBe("var(--muted)");
  });
});

describe("personForWallet", () => {
  const people = peopleFor([cheryl, jeremy]);

  it("is the owner for a private wallet", () => {
    expect(personForWallet({ owner_id: "u-j", shared_with_household: false }, people).name).toBe("Jeremy");
  });

  it("is Shared, in butter, for a household wallet whoever owns it", () => {
    expect(personForWallet({ owner_id: "u-c", shared_with_household: true }, people)).toMatchObject({
      key: "shared",
      initials: "C+J",
      color: "var(--butter)",
    });
  });

  it("does not crash on an owner outside the household", () => {
    expect(personForWallet({ owner_id: "u-x", shared_with_household: false }, people).initials).toBe("?");
  });
});

describe("sharedFor", () => {
  it("falls back when there are fewer than two people", () => {
    expect(sharedFor(peopleFor([cheryl])).initials).toBe("All");
  });
});
