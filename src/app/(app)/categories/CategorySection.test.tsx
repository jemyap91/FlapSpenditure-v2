// src/app/(app)/categories/CategorySection.test.tsx
//
// `@/server/actions/categories` carries a file-level "use server" and
// transitively reaches `@/lib/supabase/server` -> `next/headers` /
// `server-only`. `npm test` runs with NO `.env.local`, so that import chain
// must never execute — `vi.mock` below intercepts it before the real module
// loads, the same technique src/components/CategoryPicker.test.tsx uses.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CategorySection } from "./CategorySection";
import { createCategory } from "@/server/actions/categories";
import { CATEGORY_ICONS } from "@/lib/validation/category";
import { CATEGORY_ICON_GROUPS } from "@/lib/category-icons";
import { SLOT_COUNT } from "@/lib/palette";

vi.mock("@/server/actions/categories", () => ({
  createCategory: vi.fn(),
  archiveCategory: vi.fn(),
}));

const WALLET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const renderSection = () =>
  render(<CategorySection kind="expense" label="Expense" initial={[]} walletId={WALLET} />);

beforeEach(() => {
  vi.mocked(createCategory).mockReset();
  vi.mocked(createCategory).mockResolvedValue({
    category: { id: "new", name: "Vet", kind: "expense", color_slot: 1, icon: "circle", wallet_id: WALLET },
  } as Awaited<ReturnType<typeof createCategory>>);
});

describe("CategorySection — adding a category", () => {
  /**
   * The regression this file exists for. The Add button used to carry
   * `disabled={creating || !name.trim()}`, so with an empty name it was
   * inert and the ONLY cue was `disabled:opacity-60` — indistinguishable
   * from an ordinary button in the dark theme. Pressing it did nothing and
   * said nothing, which is what "the add button doesn't work" meant.
   *
   * Two separate assertions because they fail for different reasons: the
   * first breaks if the `disabled` prop comes back, the second if the early
   * return in `create()` stops setting an error. Restoring the old line
   * fails both.
   */
  it("leaves Add pressable when the name is empty", () => {
    renderSection();
    expect(screen.getByRole("button", { name: /add/i })).toBeEnabled();
  });

  it("says why instead of doing nothing when the name is empty", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(screen.getByRole("alert")).toHaveTextContent("Name is required");
    expect(createCategory).not.toHaveBeenCalled();
  });

  it("clears the message once a real name is submitted", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: /add/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Name is required");

    await user.type(screen.getByLabelText(/new expense category name/i), "Vet");
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(screen.getByRole("alert")).toHaveTextContent("");
    expect(createCategory).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Vet", kind: "expense", wallet_id: WALLET }),
    );
  });

  it("trims the name rather than storing surrounding whitespace", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByLabelText(/new expense category name/i), "  Vet  ");
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(createCategory).toHaveBeenCalledWith(expect.objectContaining({ name: "Vet" }));
  });

  it("treats a whitespace-only name as empty", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByLabelText(/new expense category name/i), "   ");
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(screen.getByRole("alert")).toHaveTextContent("Name is required");
    expect(createCategory).not.toHaveBeenCalled();
  });
});

describe("CategorySection — pickers", () => {
  it(`offers all ${SLOT_COUNT} colour slots`, () => {
    renderSection();
    const swatches = screen.getAllByRole("radio", { name: /^Colour \d+$/ });
    expect(swatches).toHaveLength(SLOT_COUNT);
  });

  it("offers every icon the schema accepts, under a group heading", () => {
    renderSection();
    // One radio per icon, no more and no fewer: an icon in CATEGORY_ICONS
    // that no group lists would be accepted by `createCategory` and yet be
    // unreachable in the UI, and a group listing something outside the enum
    // would render a control whose value the action rejects.
    for (const group of CATEGORY_ICON_GROUPS) {
      expect(screen.getByText(group.label)).toBeInTheDocument();
    }
    for (const iconName of CATEGORY_ICONS) {
      expect(
        screen.getByRole("radio", { name: iconName.replace(/-/g, " ") }),
      ).toBeInTheDocument();
    }
    expect(screen.getAllByRole("radio", { name: /^(?!Colour \d+$).*/ })).toHaveLength(
      CATEGORY_ICONS.length,
    );
  });

  it("keeps every icon in ONE radio group, so only one can be chosen", () => {
    renderSection();
    const icons = CATEGORY_ICONS.map((i) =>
      screen.getByRole("radio", { name: i.replace(/-/g, " ") }),
    ) as HTMLInputElement[];
    const names = new Set(icons.map((i) => i.name));
    // Grouping is visual only. If each section got its own `name`, a user
    // could select one icon per group and the form would submit whichever
    // React happened to hold — eight simultaneous "selected" icons on screen.
    expect(names.size).toBe(1);
  });

  it("sends the chosen icon, not the default", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByLabelText(/new expense category name/i), "Vet");
    await user.click(screen.getByRole("radio", { name: "paw print" }));
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(createCategory).toHaveBeenCalledWith(expect.objectContaining({ icon: "paw-print" }));
  });

  it("sends the chosen colour slot, including one only reachable after the widening", async () => {
    const user = userEvent.setup();
    renderSection();

    // Slot 12 did not exist before 0017_palette_16.sql widened the CHECK
    // from 8; choosing it proves the picker reaches past the old ceiling.
    await user.type(screen.getByLabelText(/new expense category name/i), "Vet");
    await user.click(screen.getByRole("radio", { name: "Colour 12" }));
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(createCategory).toHaveBeenCalledWith(expect.objectContaining({ color_slot: 12 }));
  });
});

describe("CATEGORY_ICON_GROUPS", () => {
  it("is a partition of CATEGORY_ICONS — nothing missing, nothing duplicated", () => {
    const grouped = CATEGORY_ICON_GROUPS.flatMap((g) => [...g.icons]);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...CATEGORY_ICONS].sort());
  });

  it("keeps every icon the seeded default categories already use", () => {
    // Dropping one of these would leave existing rows holding a value the
    // zod enum rejects, so editing an untouched field on such a category
    // would fail validation. supabase/migrations/0007_seed_user.sql is the
    // source of the list.
    const seeded = [
      "shopping-basket", "utensils", "bus", "house", "plug", "heart-pulse",
      "clapperboard", "shopping-bag", "plane", "graduation-cap", "repeat",
      "circle-ellipsis", "wallet", "gift", "piggy-bank", "circle-plus", "circle",
    ];
    for (const icon of seeded) expect(CATEGORY_ICONS).toContain(icon);
  });
});

describe("CategorySection — existing rows", () => {
  it("renders a category that uses a newly added colour slot", () => {
    render(
      <CategorySection
        kind="expense"
        label="Expense"
        initial={[
          { id: "c1", name: "Travel", kind: "expense", color_slot: 16, icon: "plane", wallet_id: WALLET },
        ]}
        walletId={WALLET}
      />,
    );
    // slotVar throws a RangeError above SLOT_COUNT, so a row on slot 16 would
    // crash the whole section if the palette had not actually widened.
    expect(within(screen.getByRole("list")).getByText("Travel")).toBeInTheDocument();
  });
});
