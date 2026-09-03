-- supabase/migrations/0020_transaction_wallet_move.sql

-- Lets a transaction be re-filed into another wallet, without granting
-- UPDATE on `wallet_id`.
--
-- ## The first draft of this migration was wrong, and the suite caught it
--
-- It granted `update (wallet_id)` outright, arguing that a member moving a
-- transaction between two wallets they already belong to takes nothing from
-- anyone, since `transactions_member` already lets them SOFT-DELETE the same
-- row. That argument is false, and supabase/tests/rls.sql has guarded the
-- counterexample since its first round: Bob, a member of Alice's shared
-- wallet who also owns a private one of his own, moving Alice's transaction
-- into his private wallet.
--
-- The difference is recovery. `deleted_at` is a flag every member of the
-- wallet can still see and undo -- `restoreTransaction` exists for exactly
-- that. A move puts the row somewhere the other members cannot see OR reach.
-- It is strictly worse than the delete Bob could already do, not equivalent
-- to it.
--
-- So `wallet_id` stays ungrantable and that test keeps passing unchanged. A
-- raw `PATCH /rest/v1/transactions?...` with a new wallet_id is refused by
-- the missing column privilege, exactly as before.
--
-- ## The rule
--
-- A move must not take a transaction away from anyone who can currently see
-- it. Stated as a membership test: every member of the SOURCE wallet must
-- also be a member of the DESTINATION.
--
--   personal -> personal   both wallets have one member, you    -> allowed
--   private  -> shared     nobody loses it; others gain it      -> allowed
--   shared   -> private    every other member loses it entirely -> refused
--   shared   -> shared     allowed only if nobody is dropped
--
-- That covers the case this feature exists for -- "I filed it in the wrong
-- wallet" -- while making Bob's attack impossible rather than merely
-- unlikely.
--
-- ## Why a function, and why `security definer`
--
-- The rule is a set comparison over `wallet_members`. No CHECK constraint or
-- foreign key can express it, and RLS cannot either: a policy sees one row,
-- not the membership of two wallets. It has to be procedural.
--
-- `security definer` because the caller deliberately has no UPDATE privilege
-- on `wallet_id` -- that is the whole point -- so the function must supply
-- it. Everything a definer function skips is therefore re-checked here by
-- hand, explicitly:
--
--   * membership of the source wallet (RLS would have done this)
--   * membership of the destination (RLS's `with check` would have)
--   * the row is live, and is not a transfer leg
--   * `set search_path = ''`, so every reference is schema-qualified and
--     none can be captured by a caller-controlled search_path
--
-- The other three rules stay where they already are, as composite foreign
-- keys on `transactions` -- currency must match the destination, the
-- category must live there, a recorded occurrence cannot leave its rule's
-- wallet. This function does not re-implement them; it lets them fire.
--
-- Every editable field travels with the move rather than being applied by a
-- second statement afterwards, so a re-file and the edit that accompanies it
-- land atomically. `update_transfer_pair` (0016) is the precedent.

-- Parameter order puts the three nullable fields last, all with defaults.
-- Postgres requires every parameter after a defaulted one to be defaulted
-- too, and Supabase's type generator marks a parameter without a default as
-- required AND non-nullable -- so `p_category_id uuid` sitting third would
-- have made "clear the category while moving" unexpressible in TypeScript
-- despite being perfectly legal SQL.
create function move_transaction(
  p_id           uuid,
  p_wallet_id    uuid,
  p_amount_minor bigint,
  p_occurred_on  date,
  p_category_id  uuid default null,
  p_note         text default null,
  p_merchant     text default null
) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  v_caller  uuid := auth.uid();
  v_source  uuid;
  v_kind    public.txn_kind;
  v_orphans int;
begin
  if v_caller is null then
    raise exception 'not signed in';
  end if;

  -- Live, non-deleted, and visible to nobody but through this lookup: the
  -- function runs as its owner, so `transactions_member` does NOT filter
  -- this. Membership is checked explicitly below instead.
  select wallet_id, kind into v_source, v_kind
    from public.transactions
   where id = p_id and deleted_at is null;
  if v_source is null then
    raise exception 'transaction not found';
  end if;

  -- A transfer's two legs ARE the transfer. Moving one would leave a pair
  -- claiming money left a wallet it never touched, and no constraint in the
  -- schema expresses that -- `transfer_id` is tied to neither leg's wallet.
  if v_kind = 'transfer' then
    raise exception 'a transfer cannot be moved between wallets';
  end if;

  if not public.is_wallet_member(v_source) then
    raise exception 'transaction not found';
  end if;
  if not public.is_wallet_member(p_wallet_id) then
    raise exception 'not a member of the destination wallet';
  end if;

  -- The rule. Counted rather than expressed as `except` + `exists` so the
  -- failure message can say how many people would lose the row.
  select count(*) into v_orphans
    from public.wallet_members src
   where src.wallet_id = v_source
     and not exists (
       select 1 from public.wallet_members dst
        where dst.wallet_id = p_wallet_id
          and dst.user_id = src.user_id
     );
  if v_orphans > 0 then
    raise exception
      'moving this would hide it from % other member(s) of the wallet it is in', v_orphans;
  end if;

  update public.transactions
     set wallet_id    = p_wallet_id,
         category_id  = p_category_id,
         amount_minor = p_amount_minor,
         occurred_on  = p_occurred_on,
         note         = p_note,
         merchant     = p_merchant,
         updated_at   = now()
   where id = p_id and deleted_at is null;
end $$;

-- EXECUTE only. The function's own checks are the boundary; no column
-- privilege is granted to anyone by this migration.
grant execute on function move_transaction(uuid, uuid, bigint, date, uuid, text, text)
  to authenticated;
