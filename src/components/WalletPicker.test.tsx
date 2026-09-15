import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletPicker, type PickerWallet } from "./WalletPicker";

const WALLETS: PickerWallet[] = [
  { id: "w-everyday", name: "Everyday", currency_code: "SGD", kind: "card", color_slot: 1 },
  { id: "w-ocbc", name: "OCBC360", currency_code: "SGD", kind: "bank", color_slot: 3 },
  { id: "w-dbs", name: "DBS Multiplier", currency_code: "SGD", kind: "bank", color_slot: 5 },
  { id: "w-amex", name: "Amex", currency_code: "USD", kind: "card", color_slot: 7 },
];

describe("WalletPicker", () => {
  it("renders as a closed chip naming the label and the selected wallet, with no list until opened", () => {
    render(<WalletPicker label="Wallet" wallets={WALLETS} value="w-ocbc" onChange={() => {}} />);
    const chip = screen.getByRole("button", { name: "Wallet OCBC360" });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("searchbox", { name: "Search wallets" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Accounts" })).not.toBeInTheDocument();
  });

  it("opens into a searchable list split under Wallets (cards) and Accounts (banks)", async () => {
    const user = userEvent.setup();
    render(<WalletPicker label="Wallet" wallets={WALLETS} value="w-ocbc" onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Wallet OCBC360" }));

    expect(screen.getByRole("button", { name: "Wallet OCBC360" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("searchbox", { name: "Search wallets" })).toBeInTheDocument();

    const cards = screen.getByRole("list", { name: "Wallets" });
    const banks = screen.getByRole("list", { name: "Accounts" });
    expect(within(cards).getAllByRole("button").map((b) => b.textContent)).toEqual(["Everyday SGD", "Amex USD"]);
    expect(within(banks).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "OCBC360 SGD",
      "DBS Multiplier SGD",
    ]);
    // The current wallet is marked as such, and only it.
    expect(within(banks).getByRole("button", { name: "OCBC360 SGD" })).toHaveAttribute("aria-pressed", "true");
    expect(within(cards).getByRole("button", { name: "Everyday SGD" })).toHaveAttribute("aria-pressed", "false");
  });

  it("omits a group with no wallets in it rather than showing an empty heading", async () => {
    const user = userEvent.setup();
    const banksOnly = WALLETS.filter((w) => w.kind === "bank");
    render(<WalletPicker label="Wallet" wallets={banksOnly} value="w-ocbc" onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Wallet OCBC360" }));
    expect(screen.getByRole("list", { name: "Accounts" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Wallets" })).not.toBeInTheDocument();
  });

  it("selects on click, reports the id, and closes", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<WalletPicker label="Wallet" wallets={WALLETS} value="w-ocbc" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Wallet OCBC360" }));
    await user.click(screen.getByRole("button", { name: "DBS Multiplier SGD" }));

    expect(onChange).toHaveBeenCalledWith("w-dbs");
    expect(screen.queryByRole("searchbox", { name: "Search wallets" })).not.toBeInTheDocument();
  });

  it("filters both groups by name or currency, and says when nothing matches", async () => {
    const user = userEvent.setup();
    render(<WalletPicker label="Wallet" wallets={WALLETS} value="w-ocbc" onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Wallet OCBC360" }));
    const search = screen.getByRole("searchbox", { name: "Search wallets" });

    await user.type(search, "dbs");
    expect(screen.queryByRole("list", { name: "Wallets" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Accounts" })).getAllByRole("button")).toHaveLength(1);

    await user.clear(search);
    await user.type(search, "usd");
    expect(within(screen.getByRole("list", { name: "Wallets" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["Amex USD"]);

    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText("No wallets match.")).toBeInTheDocument();
  });

  it("leaves out an excluded wallet — the transfer's other leg", async () => {
    const user = userEvent.setup();
    render(<WalletPicker label="To" wallets={WALLETS} value="w-dbs" onChange={() => {}} exclude="w-ocbc" />);
    await user.click(screen.getByRole("button", { name: "To DBS Multiplier" }));
    expect(screen.queryByRole("button", { name: "OCBC360 SGD" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "DBS Multiplier SGD" })).toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the chip", async () => {
    const user = userEvent.setup();
    render(<WalletPicker label="Wallet" wallets={WALLETS} value="w-ocbc" onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Wallet OCBC360" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("searchbox", { name: "Search wallets" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Wallet OCBC360" })).toHaveFocus();
  });
});
