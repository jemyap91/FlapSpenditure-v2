"use client";

import { useId, useState, useTransition } from "react";
import { setWalletBonus } from "@/server/actions/wallet-bonus";
import { CHANNELS, CHANNEL_LABELS, type Channel } from "@/lib/channels";
import { formatAmountInput, minorUnitFor } from "@/lib/money";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

const FIELD = `rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`;
const FIELD_STYLE = {
  borderColor: "var(--ink-2)",
  background: "var(--surface)",
  color: "var(--ink)",
};

/**
 * A card's bonus terms: which channel earns the bonus, the day its billing
 * cycle starts, and the most that counts toward it. Saved through its own
 * action, never `updateWallet`, because any member of a wallet may set these
 * and `updateWallet` is owner-only. Leaving every field empty clears them.
 */
export function WalletBonusForm({
  wallet,
  onSuccess,
}: {
  wallet: {
    id: string;
    name: string;
    currency_code: string;
    bonus_channel: Channel | null;
    cycle_start_day: number | null;
    bonus_cap_minor: number | null;
  };
  /** Called once after a save that returned no error. Leave it out where the
   *  form sits beside other unsaved fields: the form then just says "Saved". */
  onSuccess?: () => void;
}) {
  const [channel, setChannel] = useState<string>(wallet.bonus_channel ?? "");
  const [day, setDay] = useState(wallet.cycle_start_day === null ? "" : String(wallet.cycle_start_day));
  const [max, setMax] = useState(
    wallet.bonus_cap_minor === null
      ? ""
      : formatAmountInput(wallet.bonus_cap_minor, minorUnitFor(wallet.currency_code)),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const channelId = useId();
  const dayId = useId();
  const maxId = useId();

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await setWalletBonus({
        wallet_id: wallet.id,
        bonus_channel: channel === "" ? null : channel,
        cycle_start_day: day.trim() === "" ? null : Number(day),
        max: max.trim() === "" ? null : max.trim(),
      });
      if ("error" in result) setError(result.error);
      else {
        setSaved(true);
        onSuccess?.();
      }
    });
  }

  const label = "text-sm";
  const targetLabel = channel === "" ? "Min spend" : "Max";
  return (
    <form onSubmit={save} className="mt-4 flex flex-col gap-3" noValidate>
      <div className="flex flex-col gap-1">
        <label htmlFor={channelId} className={label} style={{ color: "var(--ink-2)" }}>
          Bonus channel
        </label>
        <select
          id={channelId}
          aria-label={`Bonus channel for ${wallet.name}`}
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value);
            setSaved(false);
          }}
          className={FIELD}
          style={FIELD_STYLE}
        >
          <option value="">Any channel</option>
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABELS[c]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={dayId} className={label} style={{ color: "var(--ink-2)" }}>
          Cycle start day
        </label>
        <input
          id={dayId}
          aria-label={`Cycle start day for ${wallet.name}`}
          type="number"
          min={1}
          max={31}
          inputMode="numeric"
          value={day}
          onChange={(e) => {
            setDay(e.target.value);
            setSaved(false);
          }}
          className={FIELD}
          style={FIELD_STYLE}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={maxId} className={label} style={{ color: "var(--ink-2)" }}>
          {targetLabel}
        </label>
        <input
          id={maxId}
          aria-label={`${targetLabel} for ${wallet.name}`}
          type="text"
          inputMode="decimal"
          value={max}
          onChange={(e) => {
            setMax(e.target.value);
            setSaved(false);
          }}
          className={FIELD}
          style={FIELD_STYLE}
        />
        <p className="text-xs" style={{ color: "var(--ink-2)" }}>
          {channel === ""
            ? `The spend in ${wallet.currency_code} needed each cycle. All spend counts.`
            : `The most spend in ${wallet.currency_code} that earns the bonus each cycle.`}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm" style={{ color: "var(--neg)" }}>
          {error}
        </p>
      )}
      <p role="status" className="text-sm empty:hidden" style={{ color: "var(--ink)" }}>
        {saved ? "Saved" : ""}
      </p>
      <button
        type="submit"
        disabled={pending}
        aria-label={pending ? undefined : `Save card terms for ${wallet.name}`}
        className={`self-start rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
        style={{ background: "var(--cat-1)", color: "var(--surface)" }}
      >
        {pending ? "Saving…" : "Save card terms"}
      </button>
    </form>
  );
}
