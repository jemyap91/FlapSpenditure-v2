-- supabase/migrations/0009_wallet_invites.sql
--
-- In-app invitations (spec §2). No email is ever sent: Supabase's built-in
-- mailer is rate-limited (email_sent = 2/hour) and unfit for production, so
-- an invite is a row the invitee sees when they next open the app.

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

-- One OPEN invite per address per wallet. Scoped to pending so a declined
-- invite can be re-sent, mirroring how categories_unique_active_name frees a
-- name after archiving.
create unique index wallet_invites_one_pending
  on wallet_invites (wallet_id, lower(btrim(invited_email)))
  where status = 'pending';

create index wallet_invites_invitee
  on wallet_invites (lower(btrim(invited_email))) where status = 'pending';

alter table wallet_invites enable row level security;
-- No UPDATE grant: status must never be client-writable, by anyone,
-- including the owner. If UPDATE were granted, invites_owner below (or any
-- future owner-scoped policy) could let an owner UPDATE status='accepted'
-- directly, producing an invite marked accepted with no matching
-- wallet_members row -- exactly the inconsistent state this migration
-- exists to prevent. The two SECURITY DEFINER functions bypass RLS/grants
-- entirely (they run as their owner, not as the caller), so this grant
-- change does not affect them.
grant select, insert, delete on wallet_invites to authenticated;

-- The wallet's OWNER manages its invites -- same shape as members_write,
-- but split by command (not `for all`) since no legitimate owner operation
-- needs UPDATE: sending is INSERT, listing is SELECT, revoking is DELETE
-- (there is no `revoked` value in invite_status for an UPDATE-based revoke
-- to target). Splitting the policy is defence in depth on top of the grant
-- above -- either one alone already blocks a direct owner UPDATE of status.
create policy invites_owner_select on wallet_invites
  for select to authenticated
  using (exists (select 1 from wallets w where w.id = wallet_id and w.owner_id = auth.uid()));
create policy invites_owner_insert on wallet_invites
  for insert to authenticated
  with check (exists (select 1 from wallets w where w.id = wallet_id and w.owner_id = auth.uid()));
create policy invites_owner_delete on wallet_invites
  for delete to authenticated
  using (exists (select 1 from wallets w where w.id = wallet_id and w.owner_id = auth.uid()));

-- The invitee may READ invites addressed to them, and nothing else. Status is
-- never client-writable: the functions below are the only way it changes, so
-- an invite cannot be marked accepted without the membership row appearing in
-- the same transaction.
create policy invites_invitee_select on wallet_invites
  for select to authenticated
  using (lower(btrim(invited_email)) = lower(btrim(auth.jwt() ->> 'email')));

-- SECURITY DEFINER is required, not merely convenient: members_write permits
-- an insert into wallet_members only by the wallet's owner, and the person
-- accepting is by definition not yet a member of anything.
create function accept_wallet_invite(invite uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  inv public.wallet_invites;
  caller_email text := lower(btrim(auth.jwt() ->> 'email'));
begin
  select * into inv from public.wallet_invites where id = invite for update;

  if inv is null or inv.status <> 'pending' then
    raise exception 'invite is not open';
  end if;
  -- caller_email is NULL for a caller with no email claim (reachable for
  -- phone/anonymous auth, and this codebase already tolerates a null
  -- auth.users.email -- see 0007's handle_new_user). Without the explicit
  -- NULL check, `lower(btrim(inv.invited_email)) <> caller_email` evaluates
  -- to NULL, and PL/pgSQL treats a NULL IF condition as FALSE -- the
  -- exception would NOT raise and control would fall through, letting any
  -- emailless caller accept an invite addressed to someone else.
  if caller_email is null or lower(btrim(inv.invited_email)) <> caller_email then
    raise exception 'invite is addressed to someone else';
  end if;

  insert into public.wallet_members (wallet_id, user_id, role)
  values (inv.wallet_id, auth.uid(), 'member')
  on conflict (wallet_id, user_id) do nothing;

  update public.wallet_invites
  set status = 'accepted', responded_at = now()
  where id = invite;
end $$;

create function decline_wallet_invite(invite uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  inv public.wallet_invites;
  caller_email text := lower(btrim(auth.jwt() ->> 'email'));
begin
  select * into inv from public.wallet_invites where id = invite for update;

  if inv is null or inv.status <> 'pending' then
    raise exception 'invite is not open';
  end if;
  -- See accept_wallet_invite for why the explicit NULL check is required:
  -- a caller with no email claim would otherwise fall through the
  -- comparison (NULL IF-condition is FALSE in PL/pgSQL) and decline an
  -- invite addressed to someone else.
  if caller_email is null or lower(btrim(inv.invited_email)) <> caller_email then
    raise exception 'invite is addressed to someone else';
  end if;

  update public.wallet_invites
  set status = 'declined', responded_at = now()
  where id = invite;
end $$;

revoke all on function accept_wallet_invite(uuid)  from public, anon;
revoke all on function decline_wallet_invite(uuid) from public, anon;
grant execute on function accept_wallet_invite(uuid)  to authenticated;
grant execute on function decline_wallet_invite(uuid) to authenticated;
