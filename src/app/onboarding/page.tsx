import { redirect } from "next/navigation";
import { getCurrentUserProfile } from "@/lib/supabase/current-user";
import { createClient } from "@/lib/supabase/server";
import { OnboardingForm } from "./onboarding-form";

/**
 * A brand-new signup lands here — see (app)/layout.tsx's wallet-count gate
 * and src/server/actions/auth.ts's signUp, which redirects straight to
 * /onboarding. This route is deliberately a sibling of the `(app)` route
 * group, not nested inside it: (app)/layout.tsx redirects any wallet-less
 * user to /onboarding, so if this page rendered under that layout the
 * redirect would loop forever (see the layout's doc comment).
 *
 * Server Component so the auth + wallet-count checks below run before any
 * client JS ships, per the same shape src/app/(app)/layout.tsx and
 * src/app/(auth)/layout.tsx already use — this page previously had no
 * render-time gate of its own and relied solely on src/proxy.ts, which
 * (app)/layout.tsx's own doc comment quotes Next's docs as calling "an
 * optimistic check, not the authorization boundary."
 *
 *  1. No session -> /login. Belt-and-suspenders with the proxy, same
 *     reasoning as (app)/layout.tsx's identical check.
 *  2. Already has an active wallet -> /. Mirrors (app)/layout.tsx's gate in
 *     the opposite direction: that layout sends a wallet-less user here, so
 *     this page returns the favor for a user who already completed
 *     onboarding and navigates back (directly, via history, or a stale
 *     bookmark) instead of showing them the form again.
 */
export default async function OnboardingPage() {
  const profile = await getCurrentUserProfile();
  if (!profile) redirect("/login");

  const supabase = await createClient();
  const { count, error } = await supabase
    .from("wallets")
    .select("id", { count: "exact", head: true })
    .is("archived_at", null);
  // Same reasoning as (app)/layout.tsx: a query error is not "no wallets"
  // (count is null for both), so throw rather than let a transient DB blip
  // read as "onboarding not yet done."
  if (error) throw new Error("Failed to load wallets");
  if (count) redirect("/");

  return <OnboardingForm />;
}
