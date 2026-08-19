"use client";

import { createWallet } from "@/server/actions/wallets";
import { WalletForm } from "@/components/WalletForm";

/**
 * The interactive part of /onboarding — split out of page.tsx (a Server
 * Component) so the render-time auth/wallet-count gate there can run before
 * any client JS ships, per the same Server-Component-wraps-Client-Component
 * shape src/app/(auth)/login/page.tsx + login-form.tsx already use.
 *
 * The form itself now lives in src/components/WalletForm.tsx, shared with
 * /wallets — see that file for why the two screens share one component
 * rather than each keeping a copy. What stays here is what is specific to
 * onboarding: the full-height centred layout, the first-run heading, and
 * `createWallet` (the entry point that redirects to / on success, since a
 * user who has just finished onboarding must not be left on the onboarding
 * form; /wallets binds `addWallet` instead, which stays put).
 */
export function OnboardingForm() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-3xl font-semibold">Add your first account</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--ink-2)" }}>
          A card or bank account to track. You can add more later.
        </p>
      </div>
      <WalletForm action={createWallet} submitLabel="Create account" pendingLabel="Creating…" />
    </main>
  );
}
