"use client";

import { useActionState, useState, useTransition } from "react";
import { createApiToken, revokeApiToken, type CreateTokenState } from "@/server/actions/api-tokens";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

export type ApiTokenRow = {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });
}

export function ApiTokens({ tokens, endpoint }: { tokens: ApiTokenRow[]; endpoint: string }) {
  const [state, formAction, creating] = useActionState<CreateTokenState, FormData>(createApiToken, {});
  const [revokeError, setRevokeError] = useState<string>();
  const [revoking, startRevoke] = useTransition();

  const revoke = (id: string, name: string) => {
    if (!window.confirm(`Revoke "${name}"? Anything using it will stop working.`)) return;
    startRevoke(async () => {
      const result = await revokeApiToken(id);
      setRevokeError("error" in result ? result.error : undefined);
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <form action={formAction} className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Token name
          </span>
          <input
            name="name"
            required
            maxLength={60}
            placeholder="Claude"
            autoComplete="off"
            className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)" }}
          />
        </label>
        <button
          type="submit"
          disabled={creating}
          className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium ${FOCUS_RING}`}
          style={{ background: "var(--cat-1)", color: "var(--surface)" }}
        >
          Create token
        </button>
      </form>

      <p role="status" className="text-sm" style={{ color: "var(--neg)" }}>
        {state.error ?? revokeError}
      </p>

      {state.token && (
        <section
          aria-label="New token"
          className="flex flex-col gap-3 rounded-md border p-4"
          style={{ borderColor: "var(--cat-1)" }}
        >
          <p className="text-sm font-medium" style={{ color: "var(--ink)" }}>
            Copy this token now. You won&apos;t be able to see it again.
          </p>
          <CopyField label="Token" value={state.token} />
          <CopyField label="MCP server URL" value={endpoint} />
          <CopyField
            label="Claude Code"
            value={`claude mcp add --transport http flapspenditure ${endpoint} --header "Authorization: Bearer ${state.token}"`}
          />
        </section>
      )}

      <section aria-labelledby="tokens-heading">
        <h2 id="tokens-heading" className="mb-2 text-lg font-semibold" style={{ color: "var(--ink)" }}>
          Your tokens
        </h2>
        {tokens.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--ink-2)" }}>
            No tokens yet.
          </p>
        ) : (
          <ul className="flex flex-col">
            {tokens.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-3 border-t py-3 first:border-t-0"
                style={{ borderColor: "var(--grid)" }}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" style={{ color: "var(--ink)" }}>
                    {t.name} <code className="text-xs font-normal">{t.token_prefix}…</code>
                  </p>
                  <p className="text-xs" style={{ color: "var(--ink-2)" }}>
                    Created {formatDate(t.created_at)} ·{" "}
                    {t.revoked_at
                      ? `Revoked ${formatDate(t.revoked_at)}`
                      : t.last_used_at
                        ? `Last used ${formatDate(t.last_used_at)}`
                        : "Never used"}
                  </p>
                </div>
                {!t.revoked_at && (
                  <button
                    type="button"
                    disabled={revoking}
                    onClick={() => revoke(t.id, t.name)}
                    className={`shrink-0 rounded-md border px-3 py-1.5 text-sm ${FOCUS_RING}`}
                    style={{ borderColor: "var(--ink-2)", color: "var(--neg)" }}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs" style={{ color: "var(--ink-2)" }}>
        {label}
      </span>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded border px-2 py-1.5 text-xs"
          style={{ borderColor: "var(--grid)", color: "var(--ink)" }}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true));
          }}
          aria-label={`Copy ${label}`}
          className={`shrink-0 rounded-md border px-2 py-1 text-xs ${FOCUS_RING}`}
          style={{ borderColor: "var(--ink-2)", color: "var(--ink)" }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
