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

// Cloudflare Realtime TURN: the key (CF_TURN_KEY_ID + CF_TURN_API_TOKEN) is a long-term secret
// that stays on the server; clients get short-lived credentials from Cloudflare's API. One set is
// shared and renewed well before it expires (clients reload /ice.json every hour).
export const CF_TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
export const CF_TTL_S = 24 * 3600;
const CF_RENEW_AFTER_S = 12 * 3600;
const BROWSER_BLOCKED_PORT = /:53(\?|$)/; // browsers block port 53: that URL only times out

// With both set, the own TURN (TURN_URLS) goes first and Cloudflare after it: Chrome ranks relay
// candidates by server order, so Cloudflare only carries media when the own TURN fails.
export function iceSource(env = process.env, fetchFn = fetch) {
  const id = env.CF_TURN_KEY_ID;
  const token = env.CF_TURN_API_TOKEN;
  if (!id || !token) return async (now = Date.now()) => iceServers(env, now);
  let cache = null; // { turn, renewAt, expiresAt }
  return async (now = Date.now()) => {
    const own = iceServers(env, now); // fresh REST credential every call
    if (cache && now < cache.renewAt) return [...own, ...cache.turn];
    try {
      const res = await fetchFn(`${CF_TURN_API}/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: CF_TTL_S }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const turn = (await res.json()).iceServers
        .filter((s) => s.username)
        .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !BROWSER_BLOCKED_PORT.test(u)) }));
      if (!turn.length) throw new Error('resposta sem servidor TURN');
      cache = { turn, renewAt: now + CF_RENEW_AFTER_S * 1000, expiresAt: now + CF_TTL_S * 1000 };
      return [...own, ...turn];
    } catch (e) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'turn cloudflare', err: e.message }));
      if (cache && now < cache.expiresAt) return [...own, ...cache.turn]; // the last set still works
      return own;
    }
  };
}
