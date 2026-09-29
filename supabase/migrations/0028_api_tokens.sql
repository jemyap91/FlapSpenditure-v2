-- supabase/migrations/0028_api_tokens.sql
--
-- Personal access tokens, so a user can hand Claude (or any MCP client) a
-- credential for the ledger without handing over their password or a
-- browser session. The MCP endpoint (src/app/api/mcp/route.ts) resolves a
-- token to its user, then signs a short-lived JWT for that user so every
-- read and write still runs as `authenticated` under the same RLS the app
-- uses. Nothing about a token bypasses RLS; it only stands in for signing in.
--
-- Only a SHA-256 of the token is stored. The plaintext is shown once, when
-- it is created, and is never readable again -- not by the owner, not by the
-- server. `token_prefix` is the first few characters, kept so the list of
-- tokens can tell one from another.

create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null check (length(token_prefix) between 1 and 16),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index api_tokens_user on api_tokens (user_id);

alter table api_tokens enable row level security;

-- A token is its owner's alone. There is no household sharing of tokens:
-- a token acts as one person, so only that person may see or revoke it.
create policy api_tokens_owner on api_tokens
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 0004's default-privileges revoke means a new table starts with no DML for
-- `authenticated`. Grant only what the settings screen needs: list, create,
-- and revoke. `revoked_at` is the ONLY updatable column -- a token's hash,
-- owner and name are fixed at creation -- and there is no DELETE, so a
-- revoked token stays listed as revoked rather than vanishing.
grant select, insert on api_tokens to authenticated;
grant update (revoked_at) on api_tokens to authenticated;

-- Resolves a presented token to the user it acts as, for the MCP endpoint.
--
-- Called with the anon key and no session (the caller has no JWT yet -- that
-- is what it is trying to get), so it must be SECURITY DEFINER to read
-- api_tokens past RLS. It takes the PLAINTEXT and hashes it here rather than
-- accepting a hash: if it accepted a hash, anyone holding a copy of the
-- stored hashes would hold working credentials. `set search_path = ''`
-- closes the pg_temp hijack 0004 documents.
--
-- Returns nothing for an unknown or revoked token -- one outcome for both,
-- so the endpoint cannot be used to learn which tokens once existed.
-- `email` is returned because invite RPCs authorize on the JWT's email
-- claim (0009/0010); the minted JWT carries the same claim a real sign-in
-- would.
create function resolve_api_token(p_token text)
  returns table(user_id uuid, email text)
  language sql volatile security definer set search_path = '' as $$
  update public.api_tokens t
     set last_used_at = now()
    from auth.users u
   where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
     and t.revoked_at is null
     and u.id = t.user_id
  returning t.user_id, u.email::text
$$;

revoke all on function resolve_api_token(text) from public;
grant execute on function resolve_api_token(text) to anon, authenticated;
