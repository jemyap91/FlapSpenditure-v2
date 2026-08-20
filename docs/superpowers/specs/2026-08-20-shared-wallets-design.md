# Shared Household Wallets — Design

**Status:** approved in conversation 2026-08-20, pending implementation plan.

**Goal.** Let two people share a wallet as a joint household ledger: both add,
edit and delete transactions in it; the owner controls who is in it.

**Why this is mostly already built.** `wallet_members` and the
`is_wallet_member()` predicate have existed since migration `0002`/`0004` —
every wallet and transaction policy routes through them, and a trigger already
makes each wallet's creator an `owner` member. Sharing is not a new
authorization model; it is the model the schema was built on. What is missing
is (a) any way to add a second member, and (b) a category model that survives
two people looking at the same wallet.

---

## Decisions

| Question | Decision | Why |
|---|---|---|
| How are people invited? | In-app pending invite, keyed on email | Supabase's built-in mailer is rate-limited (`email_sent = 2`/hour) and not for production. An in-app invite needs no SMTP at all. The invitee must already have an account. |
| What can a member do? | Equal on money; owner manages people | A household ledger where one partner cannot fix the other's typo is friction, not safety. `is_wallet_member` already grants exactly this, so no transaction-policy change is needed. |
| Who owns categories? | The wallet | A joint wallet needs one agreed list. Chosen over "personal lists, readable across members" with the fragmentation cost below understood and accepted. |

**Accepted cost of wallet-scoped categories.** Categories no longer follow a
user across their own wallets. Someone with three wallets maintains three
lists, and a custom category added to one does not appear in the others. Each
new wallet is seeded with the 16 defaults so no list ever starts empty.

---

## 1. Categories become wallet-scoped — migration `0008`

Today:

```sql
categories (id, owner_id -> auth.users, name, kind, color_slot, icon,
            sort_order, is_default, archived_at, created_at)

create unique index categories_unique_active_name
  on categories (owner_id, kind, lower(btrim(name))) where archived_at is null;
create index categories_owner on categories (owner_id, kind) where archived_at is null;

create policy categories_own on categories
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
```

Changes:

1. `owner_id` → `wallet_id uuid not null references wallets(id) on delete cascade`.
2. Both indexes re-scope from `owner_id` to `wallet_id`, keeping their partial
   `where archived_at is null` clause and case-insensitive name collation. A
   name therefore has to be unique per wallet per kind, not per user.
3. `categories_own` is replaced by `categories_member`, using
   `is_wallet_member(wallet_id)` — the same predicate `transactions_member`
   and `members_select` already use. This is what removes the "Uncategorised"
   bug: a co-member can read the category rows their partner's transactions
   point at.
4. **New invariant.** Add `unique (id, wallet_id)` to categories, then on
   transactions:

   ```sql
   alter table transactions
     add constraint transactions_category_same_wallet
     foreign key (category_id, wallet_id) references categories (id, wallet_id);
   ```

   A transaction can no longer reference a category belonging to a different
   wallet. Nothing enforces this today; wallet-scoping is what makes the
   violation reachable, so the constraint ships in the same migration.

### Backfill

Ordering matters and the data is live:

1. Add `wallet_id` as nullable.
2. For every wallet `W` owned by user `U`, insert a copy of each of `U`'s
   categories with `wallet_id = W`, preserving `name`, `kind`, `color_slot`,
   `icon`, `sort_order`, `is_default`, `archived_at`.
3. Repoint every transaction: for each transaction in wallet `W` whose
   `category_id` is one of `U`'s originals, set it to the `W` copy matched on
   `(kind, lower(btrim(name)))`.
4. Delete the originals, set `wallet_id NOT NULL`, swap the indexes, swap the
   policy, add the composite FK last (it cannot be satisfied until step 3 has
   run).

A user with one wallet sees no visible change. A user with three wallets ends
up with three copies of each category, which is the accepted cost above.

### Seeding moves

`handle_new_user()` (migration `0007`) currently inserts the profile **and** 16
categories on `auth.users` insert. The category half moves to a new
`AFTER INSERT ON wallets` trigger, so every wallet — first or fifth — is seeded.
`handle_new_user` keeps the profile insert.

Safe because no screen that reads categories is reachable without a wallet:
`src/app/(app)/layout.tsx` redirects any user with zero active wallets to
`/onboarding`. `scripts/test-seed.sh` asserts the current behaviour and must be
rewritten to assert wallet-triggered seeding instead.

---

## 2. Invitations — migration `0009`

```sql
create type invite_status as enum ('pending', 'accepted', 'declined');

create table wallet_invites (
  id            uuid primary key default gen_random_uuid(),
  wallet_id     uuid not null references wallets(id) on delete cascade,
  invited_email text not null check (length(btrim(invited_email)) between 3 and 320),
  invited_by    uuid not null references auth.users(id) on delete cascade,
  status        invite_status not null default 'pending',
  created_at    timestamptz not null default now(),
  responded_at  timestamptz
);

create unique index wallet_invites_one_pending
  on wallet_invites (wallet_id, lower(btrim(invited_email)))
  where status = 'pending';
```

Email is stored lower-cased and trimmed for matching. An invite is a claim
about an address, not a user id — the invitee may not have signed up when it is
created.

### RLS

- `invites_owner`: the wallet's owner may do anything with that wallet's
  invites — same `exists (select 1 from wallets ...)` shape `members_write`
  already uses.
- `invites_invitee_select`: a user may read invites whose `invited_email`
  matches their own `auth.jwt() ->> 'email'`, lower-cased. Read-only; status is
  never changed by direct UPDATE.

### Accepting

Acceptance is the one operation that earns a SQL function, by the same rule the
Phase 1 plan applied to `create_transfer`: the invariant is multi-part and must
hold regardless of caller.

```sql
create function accept_wallet_invite(invite uuid) returns void
  language plpgsql security definer set search_path = '' as $$
```

It must, in one transaction: confirm the invite is `pending`; confirm the
caller's email matches `invited_email`; insert into `wallet_members` with role
`member`; and mark the invite `accepted` with `responded_at`. `SECURITY
DEFINER` is required rather than convenient — `members_write` permits inserts
only by the wallet owner, and the person accepting is by definition not yet a
member.

Declining gets its own `decline_wallet_invite(uuid)` function with the same
caller-email check. Deliberately not a plain UPDATE: no policy anywhere should
let a client write `status` directly, or an invitee could mark an invite
`accepted` without the matching `wallet_members` row ever being created.

---

## 3. Server actions

All re-derive the caller from the session and re-validate with zod, per the
convention documented at the top of `src/server/actions/wallets.ts`. All return
`WalletState`-shaped results rather than throwing, because Next replaces thrown
server errors with an opaque digest in production.

- `inviteToWallet(walletId, email)` — owner only. Rejects inviting an existing
  member, and inviting oneself. Returns the same shape whether or not the
  address has an account, so the form cannot be used to test who is registered.
- `respondToInvite(inviteId, accept)` — calls the RPC above.
- `removeMember(walletId, userId)` — owner only; refuses to remove the owner.
  A removed member immediately loses read access via `is_wallet_member`.

**Enumeration.** `inviteToWallet` must not reveal whether an email belongs to a
registered user, matching the reasoning already applied to signup in
`src/lib/validation/auth.ts`.

---

## 4. UI

- `/wallets` gains, per wallet: a members list (display name, `owner` badge),
  a **Remove** control visible only to the owner, and an invite-by-email form.
- A **Pending invitations** section at the top of `/wallets`, listing invites
  addressed to the signed-in user with Accept / Decline. This is the only place
  an invite surfaces, so it must be reachable without a notification.
- `/categories` gains a wallet selector, since categories now belong to a
  wallet rather than to the user.
- Transaction rows show attribution ("added by Sam") **only in wallets with
  more than one member**. `created_by` is already populated by
  `createTransaction` and `create_transfer`, and RLS already excludes it from
  updates to prevent re-attribution, so this is presentation only. Suppressed
  in single-member wallets, where "added by you" on every row is noise — which
  is also why it cannot simply always render.

---

## 5. What does not change

- `transactions_member`, `members_select`, `members_write` — already correct.
- `get_wallet_balances` — `SECURITY INVOKER`, already member-scoped.
- `get_category_breakdown` / `get_cash_flow` — already check
  `is_wallet_member` for every id passed in.
- `archiveWallet` — scoped by `owner_id`, so a member cannot archive a wallet
  they were invited to. This asymmetry is intended and matches the decision
  that the owner manages the wallet itself.
- The dashboard's wallet set, which is derived from readable wallets and so
  picks up shared ones with no change.

---

## 6. Testing

**SQL (`scripts/test-rls.sh`, extended).** A non-member cannot read a wallet's
invites, transactions or categories. An invitee can read only their own invite.
`accept_wallet_invite` refuses an invite addressed to somebody else. The
composite FK rejects a transaction pointing at another wallet's category.

**`scripts/test-seed.sh`, rewritten.** Categories are seeded per wallet, not
per user; a second wallet also gets 16.

**Unit.** The three actions' validation and owner-only branches; the
enumeration-safe invite response.

**End-to-end — two browser contexts.** A signs up, creates a wallet, adds a
transaction, invites B. B signs up, sees the pending invite, accepts, and then:
sees A's transaction *with its category name resolved, not "Uncategorised"* —
the specific bug this design exists to fix; adds their own transaction; A sees
it. Finally A removes B and B loses access.

---

## 7. Risks

1. **The backfill runs against live production data.** Take a database backup
   first, and run the migration against a restored copy before `db push`.
   Steps 2 and 3 are not idempotent as written and must be guarded.
2. **The composite FK will fail loudly** if step 3 misses any transaction. That
   is the desired behaviour — a failed migration beats silently mismatched
   category references — but it means the backfill must be complete, not
   best-effort.
3. **Category fragmentation is user-visible** for anyone with several wallets.
   Accepted, documented above.
4. **Removing a member is immediate and total.** They keep nothing; their
   `created_by` attribution on past transactions remains, which is intended —
   the ledger should not rewrite who recorded what.

## 8. Out of scope

Email-delivered invites (needs SMTP), roles beyond owner/member, per-member
spending limits, leaving a wallet you were invited to, transferring ownership,
and household-level grouping of wallets.
