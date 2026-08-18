import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AmountKeypad } from "./AmountKeypad";
import { formatMoney, minorUnitFor, parseAmountInput } from "@/lib/money";

// Drives a sequence of real clicks through a controlled AmountKeypad,
// rerendering after each click the way Task 19's form will (parent state
// updates from onChange, then the keypad re-renders with the new `value`).
// Explicit `cleanup()` first: tests that call this helper more than once
// (e.g. two sequential legs of the same scenario) would otherwise leave a
// prior render's DOM mounted alongside the new one — RTL's automatic
// cleanup only runs between test cases, not between renders inside one.
async function typeKeys(
  initial: string,
  currencyCode: string,
  labels: string[],
): Promise<{ calls: string[]; final: string }> {
  cleanup();
  const user = userEvent.setup();
  let current = initial;
  const calls: string[] = [];
  const onChange = (next: string) => {
    calls.push(next);
    current = next;
  };
  const view = render(
    <AmountKeypad value={current} onChange={onChange} currencyCode={currencyCode} />,
  );
  for (const label of labels) {
    await user.click(screen.getByRole("button", { name: label }));
    view.rerender(
      <AmountKeypad value={current} onChange={onChange} currencyCode={currencyCode} />,
    );
  }
  return { calls, final: current };
}

// Collapses all Unicode whitespace (including the non-breaking space Intl
// inserts between a currency code and its number, e.g. "KWD 1.234")
// to a plain " ", so DOM text content can be compared against a
// hand-assembled expected string without worrying about which whitespace
// character Intl happened to pick.
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

describe("AmountKeypad", () => {
  it("does not render a native number input (it would raise the OS keyboard)", () => {
    const { container } = render(
      <AmountKeypad value="0" onChange={() => {}} currencyCode="USD" />,
    );
    expect(container.querySelector('input[type="number"]')).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("appends digits through the money reducer", async () => {
    const onChange = vi.fn();
    render(<AmountKeypad value="12" onChange={onChange} currencyCode="USD" />);
    await userEvent.click(screen.getByRole("button", { name: "5" }));
    expect(onChange).toHaveBeenCalledWith("125");
  });

  it("refuses a decimal point for zero-decimal currencies", async () => {
    const onChange = vi.fn();
    render(<AmountKeypad value="1200" onChange={onChange} currencyCode="JPY" />);
    await userEvent.click(screen.getByRole("button", { name: "." }));
    expect(onChange).toHaveBeenCalledWith("1200");
  });

  it("backspace removes the last character and floors at 0", async () => {
    const onChange = vi.fn();
    render(<AmountKeypad value="12" onChange={onChange} currencyCode="USD" />);
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onChange).toHaveBeenCalledWith("1");
  });

  it("backspace on a single digit floors at 0, not empty string", async () => {
    const { final } = await typeKeys("5", "USD", ["Delete"]);
    expect(final).toBe("0");
  });

  it("backspace on 0 stays at 0 (does not go negative-length or empty)", async () => {
    const { final } = await typeKeys("0", "USD", ["Delete"]);
    expect(final).toBe("0");
  });

  it("leading zeros: typing 0 then a digit replaces the leading zero, not prepends", async () => {
    const { final } = await typeKeys("0", "USD", ["7"]);
    expect(final).toBe("7");
  });

  it("multiple decimal points: a second '.' is a no-op once one is present", async () => {
    const { calls, final } = await typeKeys("1", "USD", [".", "2", "5", "."]);
    // 1 -> "1." -> "1.2" -> "1.25" -> second "." is a no-op, still notifies
    expect(final).toBe("1.25");
    expect(calls.at(-1)).toBe("1.25");
  });

  it("exceeding the currency's precision: digits past minorUnit are refused, not truncated silently without notice", async () => {
    const { calls, final } = await typeKeys("1.23", "USD", ["4"]);
    // USD has 2 decimal places; a third fractional digit is rejected
    expect(final).toBe("1.23");
    expect(calls.at(-1)).toBe("1.23");
  });

  it("KWD (minorUnit 3): allows a third fractional digit, refuses a fourth", async () => {
    const step1 = await typeKeys("1", "KWD", [".", "2", "3", "4"]);
    expect(step1.final).toBe("1.234");
    const step2 = await typeKeys("1.234", "KWD", ["5"]);
    expect(step2.final).toBe("1.234");
  });

  it("JPY (minorUnit 0): digits accumulate with no decimal point ever accepted", async () => {
    const { final } = await typeKeys("0", "JPY", ["1", "2", "0", "0", ".", "."]);
    expect(final).toBe("1200");
  });

  it("the maximum sensible amount: growth stops once the candidate would exceed the safe-integer range parseAmountInput enforces", async () => {
    const { calls } = await typeKeys("0", "USD", Array(30).fill("9"));
    // Once digits stop being accepted, further presses still notify with
    // the same (now-stable) value rather than growing without bound or
    // throwing inside the component.
    const last = calls.at(-1)!;
    const secondLast = calls.at(-2)!;
    expect(last).toBe(secondLast);
    expect(Number.isSafeInteger(Number(last.replace(".", "")))).toBe(true);
  });

  it("a bare '.' is never reachable through any key sequence, from any starting value including an empty string", async () => {
    const sequences: Array<[string, string, string[]]> = [
      ["0", "USD", ["."]],
      ["", "USD", ["."]],
      ["", "KWD", [".", "1", "Delete", "Delete"]],
      ["0", "USD", [".", "Delete", "."]],
    ];
    for (const [initial, currency, keys] of sequences) {
      const { calls } = await typeKeys(initial, currency, keys);
      for (const call of calls) {
        expect(call).not.toBe(".");
      }
    }
  });

  it("every key has an accessible name reachable by role", () => {
    render(<AmountKeypad value="0" onChange={() => {}} currencyCode="USD" />);
    for (const label of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "."]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("the decimal key is present but marked aria-disabled for a zero-decimal currency, not removed from the tab order", () => {
    render(<AmountKeypad value="0" onChange={() => {}} currencyCode="JPY" />);
    const dot = screen.getByRole("button", { name: "." });
    expect(dot).toHaveAttribute("aria-disabled", "true");
    expect(dot).not.toBeDisabled();
  });

  it("the amount is announced through a live region carrying the full formatted amount, not raw digits", () => {
    // value "12.34" is appendDigit's format (typed digits + one '.'), which
    // is what a real Task 19 form holds — not pre-scaled minor units.
    render(<AmountKeypad value="12.34" onChange={() => {}} currencyCode="USD" />);
    const live = screen.getByLabelText("Amount");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(normalizeWhitespace(live.textContent ?? "")).toBe(
      normalizeWhitespace(formatMoney(parseAmountInput("12.34", 2), "USD")),
    );
    expect(live.textContent).toContain("$12.34");
  });

  it("formats the preview correctly at minorUnit 0 (JPY) and 3 (KWD), against money.ts itself rather than a hand-typed string", () => {
    const { rerender } = render(
      <AmountKeypad value="1200" onChange={() => {}} currencyCode="JPY" />,
    );
    expect(minorUnitFor("JPY")).toBe(0);
    expect(normalizeWhitespace(screen.getByLabelText("Amount").textContent ?? "")).toBe(
      normalizeWhitespace(formatMoney(parseAmountInput("1200", 0), "JPY")),
    );

    rerender(<AmountKeypad value="1.234" onChange={() => {}} currencyCode="KWD" />);
    expect(minorUnitFor("KWD")).toBe(3);
    expect(normalizeWhitespace(screen.getByLabelText("Amount").textContent ?? "")).toBe(
      normalizeWhitespace(formatMoney(parseAmountInput("1.234", 3), "KWD")),
    );
  });
});
