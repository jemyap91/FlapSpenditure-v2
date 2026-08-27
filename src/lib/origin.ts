import { z } from "zod";

const uuid = z.uuid();

/**
 * Turns an origin IDENTIFIER into an in-app path. The identifier comes from a
 * query string, so it is untrusted — and this function is the only reason a
 * user-supplied string can influence where the app navigates after a save.
 *
 * It never returns its input. It matches a known shape, validates the id, and
 * BUILDS the path itself. A value that is already a path or a URL is refused
 * precisely because accepting one is how open redirects happen: a same-origin
 * check on a supplied path filters a bad class, whereas constructing the path
 * removes it.
 */
export function parseOrigin(from: string | null | undefined): string {
  if (!from) return "/transactions";
  const [kind, ...rest] = from.split(":");
  if (kind !== "wallet") return "/transactions";
  const id = rest.join(":");
  if (!uuid.safeParse(id).success) return "/transactions";
  return `/wallets/${id}`;
}
