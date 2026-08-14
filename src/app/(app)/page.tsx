/**
 * Placeholder home route. Task 21 ("Category breakdown") owns the real
 * dashboard content and will replace this file's body — this task (14) only
 * needs *some* page to exist at `(app)/`'s root so the shell (Sidebar,
 * TabBar, ThemeToggle) has somewhere reachable to render and so `signIn`'s
 * `redirect("/")` and the (auth) layout's authenticated-user redirect land
 * on real content instead of the create-next-app scaffold that used to live
 * at src/app/page.tsx (a landmine for this exact task: `(app)/page.tsx` and
 * the old `app/page.tsx` would otherwise both resolve to `/`).
 */
export default function AppHomePage() {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold" style={{ color: "var(--ink)" }}>
        Ledger
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--ink-2)" }}>
        Your dashboard will live here.
      </p>
    </div>
  );
}
