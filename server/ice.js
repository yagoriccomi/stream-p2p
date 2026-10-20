// ICE servers handed to every client; a personal TURN from T11 is added on top in the client.
// TURN comes from the operator's env, never from code [#37][#80]. With TURN_SECRET the
// credential follows coturn's REST scheme (use-auth-secret): it expires, so a leaked one is harmless.
import { createHmac } from 'node:crypto';

export const DEFAULT_STUN = 'stun:stun.l.google.com:19302';
export const TURN_TTL_S = 6 * 3600;
const TURN_USER_TAG = 'sp2p';

export function turnUrls(env) {
  return (env.TURN_URLS ?? '').split(',').map((u) => u.trim()).filter((u) => /^turns?:[^\s]+$/.test(u));
}

export function restCredential(secret, now = Date.now(), ttlS = TURN_TTL_S) {
  const username = `${Math.floor(now / 1000) + ttlS}:${TURN_USER_TAG}`;
  return { username, credential: createHmac('sha1', secret).update(username).digest('base64') };
}

export function iceServers(env = process.env, now = Date.now()) {
  const servers = [{ urls: DEFAULT_STUN }];
  const urls = turnUrls(env);
  if (!urls.length) return servers;
  if (env.TURN_SECRET) return [...servers, { urls, ...restCredential(env.TURN_SECRET, now) }];
  if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    return [...servers, { urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }];
  }
  return servers; // TURN without credentials would only fail the ICE checks
}
