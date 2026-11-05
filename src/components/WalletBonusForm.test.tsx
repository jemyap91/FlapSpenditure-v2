import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletBonusForm } from "./WalletBonusForm";
import { setWalletBonus } from "@/server/actions/wallet-bonus";

// Carries "use server" and reaches the Supabase env helpers, which `npm test`
// runs without.
vi.mock("@/server/actions/wallet-bonus", () => ({ setWalletBonus: vi.fn() }));

const WALLET_ID = "33333333-3333-4333-8333-333333333333";

const wallet = (over: Partial<Parameters<typeof WalletBonusForm>[0]["wallet"]> = {}) => ({
  id: WALLET_ID,
  name: "Visa",
  currency_code: "SGD",
  bonus_channel: "online" as const,
  cycle_start_day: 19,
  bonus_cap_minor: 100000 as number | null,
  ...over,
});

beforeEach(() => {
  vi.mocked(setWalletBonus).mockReset().mockResolvedValue({ ok: true });
});

describe("WalletBonusForm", () => {
  it("seeds from the wallet, showing the max as a decimal", () => {
    render(<WalletBonusForm wallet={wallet()} />);

    expect(screen.getByLabelText("Bonus channel")).toHaveValue("online");
    expect(screen.getByLabelText("Cycle start day")).toHaveValue(19);
    expect(screen.getByLabelText("Max")).toHaveValue("1000.00");
  });

  it("saves the terms through setWalletBonus", async () => {
    const user = userEvent.setup();
    render(<WalletBonusForm wallet={wallet()} />);

    await user.click(screen.getByRole("button", { name: "Save card terms" }));

    expect(setWalletBonus).toHaveBeenCalledWith({
      wallet_id: WALLET_ID,
      bonus_channel: "online",
      cycle_start_day: 19,
      max: "1000.00",
    });
  });

  it("sends nulls for No channel and cleared fields", async () => {
    const user = userEvent.setup();
    render(<WalletBonusForm wallet={wallet()} />);

    await user.selectOptions(screen.getByLabelText("Bonus channel"), "");
    await user.clear(screen.getByLabelText("Cycle start day"));
    await user.clear(screen.getByLabelText("Max"));
    await user.click(screen.getByRole("button", { name: "Save card terms" }));

    expect(setWalletBonus).toHaveBeenCalledWith({
      wallet_id: WALLET_ID,
      bonus_channel: null,
      cycle_start_day: null,
      max: null,
    });
  });

  it("renders an error result in an alert", async () => {
    vi.mocked(setWalletBonus).mockResolvedValue({ error: "Set a channel and cycle start day to use a max" });
    const user = userEvent.setup();
    render(<WalletBonusForm wallet={wallet()} />);

    await user.click(screen.getByRole("button", { name: "Save card terms" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Set a channel and cycle start day to use a max",
    );
  });
});
