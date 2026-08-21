# Deploying

This app is a Next.js 16 App Router frontend against Supabase Postgres. Reads
happen in Server Components, writes go through Server Actions, and row-level
security is the enforcement boundary — so "deploying" means standing up two
things, a Supabase project and a Node host, and pointing one at the other.

Every route is server-rendered on demand (`ƒ` in `next build` output) and
`src/proxy.ts` runs on every request. **There is no static export.** A host
that only serves static files cannot run this.

---

## ⚠️ Email confirmation must stay ENABLED — the invite model depends on it

Read this before the section below, which discusses turning confirmation off.
**That option is no longer available.** Shared wallets made the verified email
claim part of the authorization model.

`accept_wallet_invite`, `decline_wallet_invite`, `get_pending_invites` and the
`invites_invitee_select` policy (migrations `0009`/`0010`) all authorize on
`auth.jwt() ->> 'email'`. An invitation is a claim about an *address*, not
about a user id — the invitee may not have signed up when it was created — so
"is this invite yours?" is answered entirely by "does your JWT carry this
address?".

That question is only meaningful if GoTrue verified the address. With **Confirm
email** off, or **Secure email change** off, a user can set their account email
to an address they do not own and their JWT will carry it. They can then:

1. call `get_pending_invites()`, which hands back the invite **id** and the
   **wallet name** for every pending invite addressed to that address — no
   guessing required; and
2. call `accept_wallet_invite(<that id>)` and become a full member of a
   stranger's household ledger, with read and write access to every
   transaction and category in it.

Both settings must be **on** in the hosted project:

- Authentication → Sign In / Providers → Email → **Confirm email**
- Authentication → Sign In / Providers → Email → **Secure email change**
  (re-confirms the *new* address before the JWT starts carrying it)

`supabase/config.toml` has confirmations **off**, because that is what makes the
local test stack usable without a mailbox. That local setting is not a template
for production — it is why this warning exists.

There is no application-side mitigation to fall back on. Nothing in `src/`
re-checks the address against a second source, because there is no second
source: the whole point of the design (spec §2) is that an invite can be
created for someone who has no account yet.

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
| ~~Turn confirmation **off** in the hosted project~~ | **NOT AVAILABLE since shared wallets shipped.** It would let anyone accept invitations addressed to an address they do not own — see the warning at the top of this file. |
| Keep confirmation **on** (the only option) | Requires a "check your email" state in the signup UI, teaching `signInErrorMessage` to distinguish `email_not_confirmed`, AND custom SMTP — Supabase's built-in email sender is rate-limited (`email_sent = 2` per hour) and is not intended for production. Not just config. |

So this section is now a work item, not a choice: the signup UI needs the
"check your email" state and custom SMTP before launch. The rest of this
section describes what the un-built state looks like today, so the symptom is
recognisable while that work is outstanding.

### What it looks like when this is wrong

Signup appears to succeed, and then signing in reports **"Invalid email or
password."** — even though the password is correct.

The chain: `signUp` creates an unconfirmed user and returns no session, so the
redirect to `/onboarding` finds nothing and bounces to `/login`; the sign-in
attempt then fails with GoTrue's `email_not_confirmed`, and
`signInErrorMessage` (`src/lib/validation/auth.ts`) deliberately collapses
every 4xx into one generic message so it cannot be used to enumerate accounts.
Correct behaviour, unhelpful symptom.

To confirm it is this and not a wrong password, call the hosted auth API
directly — a rate-limit error on signup proves emails are being sent, which
only happens when confirmation is enabled:

```bash
curl -s -X POST "https://<ref>.supabase.co/auth/v1/signup" \
  -H "apikey: <publishable-key>" -H "Content-Type: application/json" \
  -d '{"email":"probe@example.com","password":"test-password-123"}'
# {"code":429,"error_code":"over_email_send_rate_limit",...}  -> confirmation is ON
```

**Do not "fix" this by turning confirmation off.** That was the documented
answer before shared wallets existed; it is now a privilege-escalation path
into other people's ledgers. See the warning at the top of this file.

### Do not fix this with `supabase config push`

`config push` sends the whole local `config.toml` to the linked project,
including `site_url = "http://127.0.0.1:3000"` and
`additional_redirect_urls = ["https://127.0.0.1:3000"]` — which would
overwrite the production Site URL and wipe the `/auth/callback` allow-list
configured in step 2. Use the dashboard toggle.

---

## 1. Create the Supabase project

Create a project at [supabase.com](https://supabase.com), then link this repo
to it and apply the schema. Run these **from the repo root**:

```bash
npx supabase login                                # interactive, opens a browser
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

### ⚠️ Stop here if the project already holds real data

`0008_wallet_scoped_categories.sql` is a **data migration**, not just a schema
change. It rewrites every `categories` row and repoints every
`transactions.category_id`. Its own steps 2–4 are **not idempotent**: re-running
a half-applied copy inserts a second set of category copies. Spec §7 risk 1
requires both of the following, and they are not optional:

1. **Take a database backup.** Dashboard → Database → Backups, or
   `pg_dump`. Confirm it completed before going further — not "it was
   scheduled".
2. **Rehearse against a restored copy.** Restore that backup into a scratch
   project (or a local database loaded from the dump), run `db push` there,
   and run the app's read paths against the result. A backup you have never
   restored is a hope, not a rollback plan.

Pushing into a brand-new, empty project — the normal first-time case — has
nothing to back up and nothing to rehearse. Skip to the pre-flight below only
in that case.

#### Pre-flight: both queries must return zero rows

Run these against the **production** database before `db push`. Read-only.

```sql
select count(*) from transactions t
  join categories c on c.id = t.category_id
  join wallets w    on w.id = t.wallet_id
 where c.owner_id <> w.owner_id;

select owner_id, kind, lower(btrim(name)), count(*)
  from categories where archived_at is not null
 group by 1,2,3 having count(*) > 1;
```

- **The first must be 0.** It counts transactions already pointing at a
  category owned by someone other than the wallet's owner. `0008`'s backfill
  only repoints a transaction to a copy in *its own* wallet, so any such row
  would be left behind — and `0008`'s own step-5 guard (`raise exception
  'backfill incomplete: % transaction(s) still reference a user-scoped
  category'`) will abort the migration. Non-zero means fix the data first;
  the migration will not do it for you.
- **The second must be 0.** It flags an owner holding two or more *archived*
  categories that share a `(kind, casefolded name)`. `0008` step 4 matches
  the old and new copies on `(kind, lower(btrim(name)))` **and**
  `archived_at is not distinct from`, which is not unique across duplicate
  archived rows — so which copy a transaction gets repointed to is not
  determined. The migration still succeeds; the result is just arbitrary.
  Non-zero means decide deliberately which archived row survives, before
  pushing.

#### If `0008` aborts partway, what state is the database in?

**Each migration file runs inside its own transaction, and `db push` commits
after each file.** So an aborted `0008` leaves the database exactly as it was
before `0008` started — no half-applied backfill, no partly-dropped columns —
while every migration that already succeeded in the same push (`0001`–`0007`)
stays applied and stays recorded in `supabase_migrations.schema_migrations`.

Verified against CLI `2.114.0` (the pinned devDependency), not assumed:
a two-file probe was pushed where the first file created a table and the
second created a table and then divided by zero.

```
Applying migration ...998_txn_probe_ok.sql...
Applying migration ...999_txn_probe.sql...
{"code":"LegacyDbPushApplyError","message":"ERROR: division by zero (SQLSTATE 22012)\nAt statement: 1"}
```

Afterwards, the first file's table existed and its version was recorded; the
second file's table did **not** exist and its version was **not** recorded,
even though its first statement had run before the failure. That is a
per-file transaction with a commit between files.

**Recovery position.** Fix whatever `0008` complained about (the pre-flight
queries above cover the two known causes) and run `npx supabase db push`
again. The CLI re-offers only the files not yet in the history table, so the
failed migration is retried from a clean pre-`0008` state — which is exactly
why re-running is safe despite the backfill not being idempotent. Restoring
the backup is the fallback for a failure this does not explain, not the
routine path.

This is a property of the CLI, not of the SQL. If you apply migrations with
anything else — `psql -f`, a CI step, a migration tool — you do **not** get
this guarantee: `psql` autocommits each statement by default, so a mid-file
failure in `0008` would leave the schema genuinely half-migrated. Apply them
with `psql --single-transaction` in that case:

```bash
psql "$DB_URL" --single-transaction -v ON_ERROR_STOP=1 \
  -f supabase/migrations/0008_wallet_scoped_categories.sql
```

`ON_ERROR_STOP=1` matters as much as `--single-transaction`: without it psql
keeps going after an error and the transaction is committed in a failed state
or rolled back with the run reported as a success.

`npx` is required. The CLI is a devDependency (pinned to `2.114.0`, the same
version CI uses), not a global install — a bare `supabase` is
`command not found` unless you have separately installed it system-wide, and
if you have, it may be a different version than the migrations were written
against.

**Do not run `supabase init`.** This repo is already initialised:
`supabase/config.toml` and all eleven migrations are committed. `init` would
scaffold a fresh config over them.

> **After linking, the first local `db reset` may fail once.** `link` records
> the remote project's Postgres version in `supabase/.temp/postgres-version`,
> so the local stack switches to a matching image. If that image is not
> cached yet, Docker pulls it and recreates the DB container, and a `db reset`
> racing that startup fails with `Initialising schema... error running
> container: exit 1`. The image is cached afterwards — just run the command
> again. This also affects `npm run test:rls`, which calls `db reset`
> internally. It is a one-time race on the version swap, not a broken schema.

`db push` applies all eleven migrations in `supabase/migrations/`, in order:

| Migration | What it establishes |
|---|---|
| `0001_reference.sql` | Currencies and reference tables |
| `0002_wallets_categories.sql` | Wallets, members, categories, `add_owner_as_member()` |
| `0003_transactions.sql` | Transactions and their CHECK invariants |
| `0004_rls.sql` | Row-level security, routed through `is_wallet_member()` |
| `0005_transfer_fn.sql` | `create_transfer()` |
| `0006_aggregates.sql` | `get_wallet_balances`, `get_category_breakdown`, `get_cash_flow` |
| `0007_seed_user.sql` | New-user trigger `handle_new_user()`: seeds the profile row |
| `0008_wallet_scoped_categories.sql` | **Data migration.** Categories move from user-owned to wallet-owned, with a live backfill; `categories_own` → `categories_member`; the composite FK `transactions_category_same_wallet`; category seeding moves to the `wallets_seed_categories` trigger |
| `0009_wallet_invites.sql` | `wallet_invites`, `invite_status`, `accept_wallet_invite()`, `decline_wallet_invite()` |
| `0010_invite_and_member_visibility.sql` | `get_wallet_members()`, `get_pending_invites()`, and the EXECUTE revokes on both |
| `0011_final_review_fixes.sql` | Regroups `get_category_breakdown` so one category name is one row across wallets |

**`0007` is not optional.** It is what gives each new signup its profile row.
Without it, signup succeeds and then every screen downstream fails on a
missing profile.

**Category seeding is not `0007`'s job any more.** `0008` moved it to
`seed_wallet_categories()`, an `AFTER INSERT ON wallets` trigger, so every
wallet — first or fifth, owned or created later — starts with the same 16
defaults. A brand-new user therefore has a profile and **zero** categories
until they create their first wallet, which is correct: `(app)/layout.tsx`
redirects anyone with no active wallet to `/onboarding` before a
category-reading screen is reachable. If you are debugging "no categories
after signup", that is expected, and `supabase/tests/seed.sql` asserts it.

**`0008` is the one to be careful with.** See the pre-flight and backup
requirements above; it is the only migration in this list that rewrites
existing rows.

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
environment variables, deploy.

`vercel.json` pins `"framework": "nextjs"` deliberately. Importing into a
project whose Framework Preset is **Other** — the default for a project
created before the repo was attached to it — produces a deployment that
builds successfully, reports **Ready**, and then 404s on every route
including the production domain: "Other" serves `public/` if that directory
exists, so this repo's `public/` ships as a static site with no functions at
all. `vercel inspect <url>` showing `Builds: . [0ms]` is the tell. Keeping the
setting in `vercel.json` means it cannot silently differ per project.

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
