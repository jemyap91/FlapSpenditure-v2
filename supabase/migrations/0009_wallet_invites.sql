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
grant select, insert, update, delete on wallet_invites to authenticated;

-- The wallet's OWNER manages its invites -- same shape as members_write.
create policy invites_owner on wallet_invites
  for all to authenticated
  using (exists (select 1 from wallets w where w.id = wallet_id and w.owner_id = auth.uid()))
  with check (exists (select 1 from wallets w where w.id = wallet_id and w.owner_id = auth.uid()));

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
  if lower(btrim(inv.invited_email)) <> caller_email then
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
  if lower(btrim(inv.invited_email)) <> caller_email then
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
