# Household Sharing — Design

**Date:** 2026-09-06
**Status:** Implemented on feat/household-sharing (2026-09-07)
**Builds on:** `2026-09-05-space-scoped-categories-design.md` (migrations 0022–0024)

## 1. Problem

A household (`spaces`, 0022) exists only as a derived grouping: you join one
by accepting a wallet invite, and the only screen that shows it is read-only.
Sharing is still per wallet, per person, by email. There is no way to:

- add someone to the household without picking a wallet to invite them to,
- remove someone from the household,
- share a wallet with everyone in the household in one step, or keep it
  private to yourself,
- see, in one place, who can see which wallet.

## 2. Decisions

| Decision | Choice |
|---|---|
| Access model | **Materialised membership.** `wallet_members` stays the single source of truth for who can read a wallet. A new `via` column records why a row exists. Nothing under `is_wallet_member` changes. |
| Share modes | A wallet is **private**, **shared with the whole household**, or shared with **specific housemates**; the last two combine. |
| Per-person shares | Only to people already in the household. An emailed wallet invite to an outsider still works and means "join the household, and get this one wallet directly", which is what acceptance already does. |
| Household roles | Exactly **one owner** per household. The owner invites and removes people. Any member can leave. |
| Wallet reach | Only a wallet's **owner** changes its sharing. The household owner manages people, not other people's wallets. |
| Removal / leaving | **Their wallets go with them**: wallets they own move to a fresh household of their own, with the categories those wallets use copied across. Transactions they recorded in shared wallets stay, attributed to them. |
| Out of scope | Transferring household ownership; merging households; sharing with an outsider without joining. |

## 3. Data model

### 3.1 New and changed columns

```
create type member_via as enum ('owner', 'household', 'direct');

wallet_members + via member_via not null
                 backfill: 'owner' where user_id = wallets.owner_id, else 'direct'

wallets        + shared_with_household boolean not null default false
                 backfill: false  (every existing share is a 'direct' row; nothing changes)

space_invites (id, space_id, invited_email, invited_by, status invite_status,
               created_at, responded_at)
               unique (space_id, lower(btrim(invited_email))) where status = 'pending'
```

`wallet_invites` is unchanged in shape and meaning.

### 3.2 One owner per household

`space_members.role` already exists. 0022 marked everyone who owned any
wallet in the household as `owner`. The migration keeps the earliest-joined
`owner` and demotes the rest to `member`. **On the hosted database the real
household has two owners; the rule's pick must be confirmed with both people
before the migration is pushed** (§9).

`handle_new_user` already creates the new user as `owner` of their own
household. `set_wallet_space` (0022) already files a new wallet into the
household the creator owns first; with one owner per household that lookup
is now deterministic for the ordinary case.

### 3.3 Invariants

Enforced in the database, never left to the app:

1. **Household-row invariant.** For every wallet W and user U:
   a `wallet_members` row with `via = 'household'` exists ⇒
   `W.shared_with_household` and U is a member of W's household and U is not
   W's owner — and the converse holds for anyone who **joined the household
   through `accept_space_invite`, or was already a member when W's owner
   last called `set_wallet_sharing`**.
   The converse is deliberately *not* universal: someone who joined the
   household by accepting a **wallet** invite (0022's
   `sync_wallet_member_space`) gets that one wallet and the household's
   category names, and no `household` rows at all. Any wallet owner can send
   a wallet invite — including a member who is not the household's owner —
   so a blanket "in the household ⇒ holds every shared wallet" rule would let
   one member hand an outsider the household owner's wallets. The grant
   therefore lives inside `accept_space_invite` (the household owner's own
   invitation) and `set_wallet_sharing` (the wallet owner's own decision,
   made with the member list in view), and in no trigger on `space_members`.
   The removal half is a cascade, not a trigger: `wallet_members_in_space`
   (0022) is `ON DELETE CASCADE`, so leaving the household drops that user's
   `household` and `direct` rows on every wallet still in it.
2. **A `direct` row is only ever granted by the wallet's owner** and is never
   touched by a household share or unshare.
3. **0022's chain is untouched.** `wallet_members_in_space`,
   `wallet_members_wallet_same_space`, and the transaction/rule/budget
   composite keys stay exactly as they are. The only change to any of them is
   `DEFERRABLE INITIALLY IMMEDIATE` (§6), which alters *when* they are checked
   inside a transaction, not what they check.
4. **One `via = 'owner'` row per wallet**, for `wallets.owner_id`. A CHECK
   cannot express this; `add_owner_as_member` writes it and nothing else may
   insert an `owner` row (grant, §5).

## 4. Functions

All writes go through SECURITY DEFINER functions with `set search_path = ''`,
matching `set_budget`, `accept_wallet_invite` and `move_transaction`. Each
guard below is the whole boundary for that function, as 0013's `set_budget`
comment explains: RLS is bypassed, so nothing else catches a bad caller.

| Function | Caller | Behaviour |
|---|---|---|
| `set_wallet_sharing(p_wallet uuid, p_household boolean, p_direct uuid[])` | wallet owner | Sets `shared_with_household`; reconciles `household` rows to every current household member (or none); reconciles `direct` rows to exactly `p_direct`. Refuses: caller not owner; any `p_direct` id not in the wallet's household; owner's own id in `p_direct`. |
| `invite_to_space(p_space uuid, p_email text)` | household owner | Inserts a pending `space_invites` row. Refuses an address already a member. |
| `revoke_space_invite(p_invite uuid)` | household owner | Deletes a pending invite of their household. |
| `accept_space_invite(p_invite uuid)` | invitee, matched on `auth.jwt() ->> 'email'` exactly as `accept_wallet_invite` does | Inserts `space_members (role 'member')`, then grants every household-shared wallet in that household (§3.3(1) — the grant is here, not in a trigger). Marks the invite accepted. |
| `decline_space_invite(p_invite uuid)` | invitee | Marks declined. |
| `get_pending_space_invites()` | invitee | `(id, space_id, space_name, invited_by_name, created_at)` for the caller's email, same shape as `get_pending_invites`. |
| `leave_space(p_space uuid)` | any non-owner member | §6. |
| `remove_space_member(p_space uuid, p_user uuid)` | household owner, `p_user <> auth.uid()` | Calls the same routine as `leave_space` for `p_user`. |
| `get_wallet_sharing()` | any member | `(wallet_id, user_id, via)` for every wallet the caller is a member of, so the grid can be drawn without a second RLS-scoped read of `wallet_members` (which already returns the same rows; this exists only to carry `via` alongside `display_name`). Reuses `get_space_members` for names. |

`accept_wallet_invite` (0022) is unchanged; the member row it inserts is
`via = 'direct'`.

## 5. Grants and policies

- `wallet_members`: `members_write` (0004, owner-scoped `for all`) is
  **revoked to select only** for `authenticated`. Every insert and delete now
  goes through `set_wallet_sharing`, `accept_wallet_invite`,
  `accept_space_invite`, and `add_owner_as_member`. This is what makes
  invariant 3.3(1) hold: no path can create a `household` row by hand or an
  `owner` row for the wrong user.
- `space_invites`: `select` to `authenticated` under two policies mirroring
  0009's — the household owner sees their household's invites; an invitee
  sees invites addressed to their email. No insert/update/delete.
- `space_members`: still no direct writes (0022). Delete happens only inside
  `leave_space`.
- `wallets`: `shared_with_household` is **not** added to the column-scoped
  UPDATE grant from 0022; only `set_wallet_sharing` writes it.
- New functions: `revoke all … from public, anon; grant execute … to
  authenticated`, as 0010 argues.

## 6. Leaving a household

`leave_space` (and `remove_space_member`, which delegates) runs as one
transaction with `SET CONSTRAINTS ALL DEFERRED`. For that to be possible the
composite foreign keys below become `DEFERRABLE INITIALLY IMMEDIATE`;
outside this function they behave exactly as today.

```
wallet_members_wallet_same_space, wallet_members_in_space,
transactions_wallet_same_space, transactions_category_same_space,
recurring_rules_wallet_same_space, recurring_rules_category_same_space,
budgets_category_same_space, budget_wallets_wallet_same_space,
budget_wallets_budget_same_space
```

Steps, for user U leaving household S:

1. Refuse if U is S's owner ("transfer ownership first" is out of scope, so
   the owner simply cannot leave). Refuse if U is not a member.
2. Create household S′ named `<display_name> household`; the seed trigger
   fills its sixteen defaults. Insert `space_members (S′, U, 'owner')`.
3. For each wallet W owned by U with `W.space_id = S`:
   - Collect distinct `category_id` from W's transactions, recurring rules,
     and budgets whose wallet set is entirely U's moving wallets.
   - For each, find an active category in S′ with the same `kind` and
     `lower(btrim(name))`; else insert one copying `name, kind, color_slot,
     icon` (append `sort_order`, `is_default = false`).
   - Repoint those rows' `category_id`; set `space_id = S′` on W, its
     transactions, its rules, and U's own `wallet_members` row.
   - Delete every other `wallet_members` row on W. Sharing does not survive
     the move; the wallet is private in S′.
4. Budgets: a budget whose wallet set is entirely moving wallets gets
   `space_id = S′` and a repointed `category_id`, and its `budget_wallets`
   rows follow. A budget mixing moving and staying wallets loses the moving
   wallets from its set; if the set becomes empty the budget is deleted.
   The function returns `(wallets_moved int, budgets_moved int,
   budgets_trimmed int, budgets_deleted int)`.
5. Delete U's `household` and `direct` rows on wallets still in S.
6. Delete `space_members (S, U)`. The delete trigger's work is already done by
   step 5 and it finds nothing.

Transactions U recorded in wallets that stay behind are not touched:
`created_by` still names U. Their name stops rendering beside those rows,
because `get_wallet_members` returns current members only and the
transactions page resolves attribution through it; that is already what
happens today when someone is removed from a wallet, and it is accepted.

## 7. Screens

### 7.1 `/household`

One section per household, as now. Per section:

- **Members.** Each row: name, "(you)", role. For the owner: "Remove" on
  every other row, opening a confirm dialog that states what moves with the
  person ("Their 2 wallets go with them; 1 budget will lose a wallet"). For a
  non-owner: one "Leave household" button with the same dialog about
  themselves. Both call the function and then `revalidatePath("/household")`
  and `/wallets`.
- **Invitations** (owner only): "Invite by email" form; pending invitations
  with "Revoke". Same components and copy as the wallet invite form, lifted
  into a shared component.
- **Sharing grid.** Rows: wallets in this household the viewer is a member
  of. Columns: household members. Cell text: "Owner", "Household", "Direct",
  or "—". A row the viewer owns is editable: a "Share with whole household"
  switch and one checkbox per other member for a direct share (enabled even
  when the switch is on, so a direct share outlives a later unshare). A
  "Save" per row calls `set_wallet_sharing` with the row's full state. Rows
  for wallets the viewer does not own are read-only, with a one-line note.
- Explanatory copy at the top changes from "invite them to a wallet" to
  "invite them here; then choose which wallets they see".

### 7.2 `/wallets`

- The members section under each wallet becomes the same row control as
  the grid (switch + checkboxes) for the owner, replacing per-person
  "Remove". Non-owners keep the read-only list.
- "Invite by email" stays, unchanged in wording and behaviour.
- `PendingInvites` lists household invitations alongside wallet ones, each
  saying which it is ("Join alice's household" vs "Join wallet Everyday").

### 7.3 Navigation

`/household` already has its Sidebar entry and the link from `/categories`.
The `PendingInvites` block on `/wallets` gains a link to `/household` when a
household invitation is present.

## 8. Testing

- **`supabase/tests/constraints.sql`**
  - `accept_space_invite` adds `household` rows on every shared wallet for
    the new member and nothing on unshared ones; a bare `space_members`
    insert (0022's wallet-invite path) adds nothing at all.
  - The `ON DELETE CASCADE` removes a departing member's rows and no one
    else's.
  - `set_wallet_sharing` refuses a non-owner, a non-housemate id, and the
    owner's own id; an unshare leaves `direct` rows in place; a re-share is
    idempotent.
  - Direct insert into `wallet_members` is refused at the privilege boundary.
- **`supabase/tests/rls.sql`**
  - A new joiner reads a household-shared wallet's transactions with no
    extra rows; after unshare they cannot; a direct share granted alongside
    survives the unshare.
  - The household owner cannot call `set_wallet_sharing` on a wallet they do
    not own.
  - After `remove_space_member`, the removed user reads nothing from the old
    household: wallets, transactions, or category names.
  - `accept_space_invite` refuses a mismatched email; `invite_to_space`
    refuses a non-owner.
  - `get_wallet_sharing` returns only the caller's wallets.
- **`supabase/tests/leave_space.sql`**, run by a script like
  `test-migration-0022.sh`: a member with two wallets, transactions on
  both, a recurring rule, a budget over only their wallets and a budget
  mixing theirs with the owner's, leaves. Assert: the new household has the
  copied categories and no others beyond the defaults; every moved row
  points at a category in the new household; the mixed budget lost exactly
  the moved wallet; the owner's data is untouched; the function's counts
  match.
- **Vitest**: the sharing-row control (switch/checkbox state and the payload
  it submits), `/household` page rendering for owner vs member, the shared
  invite form, `PendingInvites` with both invite kinds.
- **e2e** (`sharing.spec.ts`): B is invited to A's household by email,
  accepts, sees A's household-shared wallet but not A's private one; A
  shares the private one directly with B; B leaves and A's ledger is intact.

## 9. Migration and rollout

One migration, `0025_household_sharing.sql`: enum, columns, backfill,
one-owner demotion, `space_invites`, deferrable keys, triggers, functions,
grants. Additive except for the `members_write` revoke and the demotion.

Before pushing to hosted, run the read-only check `select user_id, joined_at
from space_members where role = 'owner'` per household and confirm the
earliest-joined owner is the intended one. The migration prints who it kept
and who it demoted.

The app deploys with the migration as 0022 did: merge, push migrations
during the build, accept the minute of overlap.

## 10. Risks

| Risk | Mitigation |
|---|---|
| `leave_space` is the largest write path in the schema. | One transaction, deferred keys, a fixture test that asserts both sides, and a returned summary the UI shows before and after. |
| Revoking `members_write` could strand a code path that still writes `wallet_members` directly. | `removeMember` is rewritten onto `set_wallet_sharing`; grep for `.from("wallet_members")` writes is part of the plan, and the constraints suite proves the revoke. |
| Demoting a co-owner is a real change for the two people in the hosted household. | Confirmed by hand before push; the migration reports it. |
| Deferrable keys change error timing inside any future function. | Only `leave_space` defers; the default remains immediate, and the suites run unchanged. |

## 11. Implementation notes

Departures from this design, all ruled by the controller during execution.

| # | Departure | Why | Task |
|---|---|---|---|
| 1 | `set_wallet_space` prefers the household the creator joined most recently, not the one they own. | With one owner per household (§3.3), "owns" is always the creator's signup household, so a member could never create a wallet inside a household they only joined. Preferring most-recently-joined lets a member's new wallet land where they actually are. | Task 2 |
| 2 | `leave_space` / `remove_space_member` return three counts (`wallets_moved, budgets_moved, budgets_trimmed`), not four. | A mixed budget (some wallets moving, some staying) always keeps at least one staying wallet — `budget_wallets` rows on moving wallets are trimmed, never all of them — so a budget's "deleted" outcome is unreachable and was dropped from the return shape. | Task 4 |
| 3 | `leave_space` reuses a household the person already owns (their signup household) rather than minting a new one, creating one only if none exists; wallets that move arrive private. | Signup (0022) already gives everyone a dormant owned household. Minting a fresh one on every leave-and-rejoin would pile up empty owned households with no purpose. Moved wallets land unshared so the person re-shares deliberately in the new household rather than inheriting stale sharing state. | Task 4 |
| 4 | The leave/remove confirm dialog states the rule (what moves with the person) rather than predicted counts; the actual counts arrive in the status line after the action completes. | The counts depend on server-side matching (categories, budgets) that isn't known until the mutation runs; stating the rule up front is honest, and the after-the-fact status line reports what actually happened. | Task 7 |
| 5 | Pending household invitations render in their own list, `<household> invitations`, separate from the members list. | Members and not-yet-members are different kinds of rows (one has a role, the other only an email and a Revoke control); a shared list would have needed a variant-typed row instead of two small, single-purpose lists. | Task 7 |
| 6 | There is no delete trigger on `space_members`. | `wallet_members_in_space` (0022) is already `ON DELETE CASCADE`, so deleting a `space_members` row removes the departing member's `wallet_members` rows on every wallet in that household for free. `leave_space` moves wallets the person owns out first, so the cascade only ever removes rows on wallets that stay behind. A trigger would have duplicated that cascade. | Task 2 |
| 7 | There is no insert trigger on `space_members` either: the household-share grant lives inside `accept_space_invite`. | A trigger fires on every path that inserts a membership row, and one of them is 0022's `sync_wallet_member_space` — reached whenever *any* wallet owner's emailed wallet invite is accepted, a member's as much as the household owner's. With the grant in a trigger, a member could invite an outsider to their own wallet and the outsider would be handed a `household` row on every household-shared wallet in the household, the owner's included. In `accept_space_invite` the grant follows the one join the household owner actually authorised. A wallet shared after someone joins still reaches them through `set_wallet_sharing`, which its owner runs deliberately. | Final fix wave |
| 8 | The household `leave_space` moves a person into may already have other members, who can then read the category **names** copied out of the household they left. | Departure 3 reuses the person's own signup household, and that household can have had members added to it. Only category names travel — the moved wallets arrive `shared_with_household = false` with every non-owner `wallet_members` row dropped, so no transaction, balance or budget is visible. Names of the person's own categories are the same thing any housemate could already see. | Final fix wave |
