import config from "$config";
import { db } from "$lib/db";
import jwt from "jsonwebtoken";

// Session tokens used to be eternal: jwt.sign(payload, config.jwt) with no
// expiry and no way to revoke one. A token leaked through a log, a backup, an
// XSS or a lost phone stayed valid forever, and "log out" only deleted the
// cookie — the token itself kept working from the Authorization header. The
// only remedy was rotating config.jwt, which signs EVERY session and also keys
// @fastify/secure-session, so one compromised account meant logging out all of
// them and invalidating every session cookie.
//
// Two changes close that:
//   - every token carries an expiry, so a leak has a deadline
//   - every token carries the account's session generation `v`; bumping
//     tokenver:<uid> invalidates that account's tokens and nobody else's

export const TOKEN_TTL = config.tokenTtl || "30d";

// Read-only tokens are minted as `<uid>-ro`; the generation counter is per
// account, so both kinds share one key and one revoke kills both.
export const baseId = (id: string): string =>
  typeof id === "string" && id.endsWith("-ro") ? id.slice(0, -3) : id;

const verKey = (id: string) => `tokenver:${baseId(id)}`;

export const currentVersion = async (id: string): Promise<number> =>
  Number.parseInt((await db.get(verKey(id))) ?? "0", 10) || 0;

// Invalidates every token issued for this account so far. Unlike the `evicted`
// set (a permanent hard ban), this only ends the current sessions — the user
// can log in again immediately with their password.
export const revokeSessions = async (id: string): Promise<number> =>
  await db.incr(verKey(id));

export const issue = async (id: string, ttl = TOKEN_TTL): Promise<string> => {
  const v = await currentVersion(id);
  return jwt.sign({ id, v }, config.jwt, { expiresIn: ttl });
};

// Tokens minted before this existed carry no `v`. Treating a missing value as
// generation 0 means the upgrade itself doesn't log anyone out; the first
// revoke bumps the counter past them and they stop verifying.
export const versionOk = async (payload: any): Promise<boolean> => {
  if (!payload?.id) return false;
  return (payload.v ?? 0) === (await currentVersion(payload.id));
};
