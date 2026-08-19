# Deploying

This app is a Next.js 16 App Router frontend against Supabase Postgres. Reads
happen in Server Components, writes go through Server Actions, and row-level
security is the enforcement boundary — so "deploying" means standing up two
things, a Supabase project and a Node host, and pointing one at the other.

Every route is server-rendered on demand (`ƒ` in `next build` output) and
`src/proxy.ts` runs on every request. **There is no static export.** A host
that only serves static files cannot run this.

---

## Before you start: decide about email confirmation

Do this first. It is the only step that may require a code change, and
skipping it produces a signup flow that looks broken in production.

`src/server/actions/auth.ts`'s `signUp` redirects to `/onboarding`
immediately, assuming a session exists. That holds locally because
`supabase/config.toml` sets:

```toml
[auth.email]
enable_confirmations = false
```

**Hosted Supabase projects enable email confirmation by default.** With it
on, `signUp` returns no session, the user lands on `/onboarding`, that page
finds no profile, and it redirects them to `/login` — with nothing on screen
explaining why. The account appears not to have been created.

It is also load-bearing beyond that redirect. `signUp`'s account-enumeration
mitigation is written against this setting; its own comment says so:

> account enumeration via signUp's "already registered" error under this
> project's `enable_confirmations=false`

Supabase returns a different shape for a duplicate signup when confirmation
is on, so that mitigation needs re-checking rather than assuming.

Pick one:

| Option | What it costs |
|---|---|
| Turn confirmation **off** in the hosted project | Matches the code as written. No changes. Weaker signup hygiene — anyone can register any address. |
| Keep confirmation **on** | Requires a "check your email" state in the signup UI and a re-check of the enumeration mitigation. Not just config. |

---

## 1. Create the Supabase project

Create a project at [supabase.com](https://supabase.com), then link this repo
to it and apply the schema. Run these **from the repo root**:

```bash
npx supabase login                                # interactive, opens a browser
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

`npx` is required. The CLI is a devDependency (pinned to `2.114.0`, the same
version CI uses), not a global install — a bare `supabase` is
`command not found` unless you have separately installed it system-wide, and
if you have, it may be a different version than the migrations were written
against.

**Do not run `supabase init`.** This repo is already initialised:
`supabase/config.toml` and all seven migrations are committed. `init` would
scaffold a fresh config over them.

> **After linking, the first local `db reset` may fail once.** `link` records
> the remote project's Postgres version in `supabase/.temp/postgres-version`,
> so the local stack switches to a matching image. If that image is not
> cached yet, Docker pulls it and recreates the DB container, and a `db reset`
> racing that startup fails with `Initialising schema... error running
> container: exit 1`. The image is cached afterwards — just run the command
> again. This also affects `npm run test:rls`, which calls `db reset`
> internally. It is a one-time race on the version swap, not a broken schema.

`db push` applies all seven migrations in `supabase/migrations/`:

| Migration | What it establishes |
|---|---|
| `0001_reference.sql` | Currencies and reference tables |
| `0002_wallets_categories.sql` | Wallets, members, categories, `add_owner_as_member()` |
| `0003_transactions.sql` | Transactions and their CHECK invariants |
| `0004_rls.sql` | Row-level security, routed through `is_wallet_member()` |
| `0005_transfer_fn.sql` | `create_transfer()` |
| `0006_aggregates.sql` | `get_wallet_balances`, `get_category_breakdown`, `get_cash_flow` |
| `0007_seed_user.sql` | New-user trigger: seeds a profile and 16 default categories |

**`0007` is not optional.** It is what gives each new signup its profile row
and starting categories. Without it, signup succeeds and then every screen
downstream fails on missing data.

`db push` reads `supabase/config.toml` and the migration directory relative to
the repo root, so run it from there rather than from inside `supabase/`.

### Verify the schema landed

The repo has three SQL suites:

```bash
npm run test:rls          # adversarial cross-tenant access attempts
npm run test:constraints  # each CHECK rejects its bad case
npm run test:seed         # the new-user trigger seeds correctly
```

> **Never point these at the hosted database.** `test:rls` plays the attacker:
> it issues unfiltered bulk `UPDATE`/`DELETE` statements and asserts RLS
> reduces them to zero affected rows. Against a database where RLS did *not*
> hold, those statements are exactly as destructive as they look.
> `scripts/test-rls.sh` refuses any `DB_URL` that is not loopback for this
> reason — do not work around that check.

Run them locally (`npx supabase start`, then the commands above) against the same
migrations you are about to push. A clean `db push` plus a green local run is
the bar before pointing the app at the hosted project.

---

## 2. Configure Auth URLs

In the Supabase dashboard, under Authentication → URL Configuration:

- **Site URL** — your deployed origin, e.g. `https://your-app.vercel.app`
- **Redirect URLs** — add `https://your-app.vercel.app/auth/callback`

`src/app/auth/callback/route.ts` derives `origin` from the incoming request,
so nothing is hardcoded and preview deployments work — but Supabase still has
to allow-list each origin you actually use.

That route serves OAuth and magic-link flows. The current email/password flow
establishes its session directly and does not pass through it.

---

## 3. Set environment variables

Exactly **two** variables are read. `src/lib/supabase/env.ts` validates both
at import time and throws immediately if either is missing, so a
misconfigured environment fails at boot rather than deep inside a request:

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<the project's anon/publishable key>
```

Both are `NEXT_PUBLIC_`, so both reach the browser. That is correct and safe
here: the anon key is meant to be public, and RLS — not key secrecy — is what
protects the data.

**Do not set `SUPABASE_SERVICE_ROLE_KEY` in production.** It appears in local
`.env.local` files but nothing under `src/` reads it. The service role bypasses
RLS entirely, so shipping it to a deployed environment adds real risk and buys
nothing.

`.env.local.example` documents the same two variables.

> **If the build fails with `Missing required environment variable`**, this is
> the step that was skipped:
>
> ```
> Error: Failed to collect configuration for /auth/callback
>   [cause]: Error: Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL
> ```
>
> `env.ts` throws at import time, and Next imports it while collecting page
> data, so the build fails rather than shipping a broken deployment. Set both
> variables for the environment being built — on Vercel, a variable scoped
> only to Production will still fail a Preview build — then **redeploy**.
> Adding variables does not rebuild an already-failed deployment on its own.

### Which key

Newer Supabase projects issue a `sb_publishable_…` key alongside the legacy
`anon` JWT. Either works with `@supabase/ssr`; prefer the publishable one, as
legacy keys are on a deprecation path. Local development uses the legacy JWT
simply because that is what `supabase start` emits for the local stack — the
two environments do not need to match in key format.

---

## 4. Deploy the app

Node 22 (what CI uses). No `engines` field is set, so nothing enforces this —
match it deliberately.

**Vercel** is the least-effort path. Import the GitHub repo, add the two
environment variables, deploy. Next 16 is detected automatically and
`next.config.ts` is empty, so there is nothing to configure.

**Any other Node host** works the same way — build with `npm run build`, serve
with `npm start`. Nothing in the codebase is Vercel-specific. The host must
run a Node server process; `src/proxy.ts` and every route need a runtime.

---

## After deploying: verify the real thing

Automated coverage runs against a local stack, so the deployed environment is
genuinely unverified until someone exercises it. Walk the core loop once:

1. Sign up — you land on `/onboarding`, not back at `/login`
   (this is where a confirmation-setting mismatch surfaces)
2. Create your first wallet — you land on the dashboard
3. Add an expense — it appears in `/transactions` with an explicit sign
4. Delete it, then Undo — the row comes back
5. Add a second wallet at `/wallets` — the Transfer option appears in
   `/transactions/new`

Step 5 is worth doing: transfers are gated on having two wallets, so a
single-wallet smoke test never touches that code path at all.

---

## Known gaps

Deferred, all additive, none blocking the core ledger:

- `/transactions/[id]` edit — create, list, delete and undo work; editing does not
- `/settings` — not built
- Desktop add-transaction modal and the `A` keyboard shortcut
- Infinite scroll on `/transactions` — currently capped at 100 rows
- Category reorder and archive UI — `archiveCategory` exists and is tested,
  the UI is not wired
- Wallet editing — `updateWallet` exists but has no consumer; `/wallets` covers
  create, list and archive only
