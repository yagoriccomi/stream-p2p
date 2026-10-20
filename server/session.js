// Pure session logic: members, nicknames, roles, turn passing and the permission matrix.
// No I/O so it can be unit-tested; server/index.js owns sockets and the video topology.

export const MAX_MEMBERS = 50;
export const MAX_NAME = 24;
export const MAX_CHAT = 500;
export const TURN_GRANT_MS = 60_000; // whoever receives the turn has 1 min to start

export class HttpError extends Error {
  constructor(code, reason) {
    super(reason);
    this.code = code;
  }
}

const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no 0/o/1/l: read aloud on voice chat
export function newCode(rand = Math.random) {
  const pick = (n) => Array.from({ length: n }, () => CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)]).join('');
  return `${pick(4)}-${pick(2)}`;
}

export const normalizeCode = (code) => String(code ?? '').trim().toLowerCase().replace(/\s+/g, '');

// "Ána " and "ana" are the same person for uniqueness.
export const nameKey = (name) => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function cleanName(raw) {
  const name = String(raw ?? '').replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim();
  if (!name) throw new HttpError(400, 'O apelido está vazio. Digite como quer ser chamado na sessão.');
  if ([...name].length > MAX_NAME) throw new HttpError(400, `O apelido passa de ${MAX_NAME} caracteres.`);
  return name;
}

// Single source for the "Quem pode o quê" matrix shown in T10.
// actor/target are member objects; target may be undefined for session-wide actions.
const isStaff = (m) => m.role === 'owner' || m.role === 'mod';
const outranks = (actor, target) => actor.role === 'owner' || (actor.role === 'mod' && target.role === 'member');
export const CAN = {
  passTurn: (s, a) => isStaff(a) || (s.settings.presenterCanPass && s.presenterId === a.id),
  approveRequest: (s, a) => CAN.passTurn(s, a),
  stopStream: (s, a, t) => a.id === t.id || outranks(a, t),
  muteForAll: (s, a, t) => a.id !== t.id && outranks(a, t),
  kick: (s, a, t) => a.id !== t.id && outranks(a, t),
  lock: (s, a) => isStaff(a),
  ban: (s, a, t) => a.role === 'owner' && a.id !== t.id,
  promote: (s, a, t) => a.role === 'owner' && t.role === 'member',
  demote: (s, a, t) => a.role === 'owner' && t.role === 'mod',
  transferOwner: (s, a, t) => a.role === 'owner' && a.id !== t.id,
  settings: (s, a) => a.role === 'owner',
  end: (s, a) => a.role === 'owner',
};

export function createSession(code, ownerId, rawName, device, now = Date.now()) {
  const s = {
    code,
    ownerId,
    createdAt: now,
    members: new Map(),
    presenterId: null,
    presenterState: null, // { mode, paused, audio, source }
    grant: null, // { id, until }: turn reserved for someone who hasn't started yet
    queue: [], // ids asking for the turn, in order
    banned: new Set(), // device tokens
    settings: { locked: false, autoApprove: false, presenterCanPass: true },
  };
  addMember(s, ownerId, rawName, device, now, 'owner');
  return s;
}

export function addMember(s, id, rawName, device, now = Date.now(), role = 'member') {
  if (device && s.banned.has(device)) throw new HttpError(403, 'Você foi bloqueado nesta sessão pelo dono.');
  if (role !== 'owner' && s.settings.locked) throw new HttpError(423, 'A sessão está trancada. Peça para o dono ou um moderador destrancar.');
  if (s.members.size >= MAX_MEMBERS) throw new HttpError(503, `A sessão chegou ao limite de ${MAX_MEMBERS} pessoas.`);
  const name = cleanName(rawName);
  assertNameFree(s, name);
  s.members.set(id, { id, name, role, device: device || null, joinedAt: now, mic: false });
  return s.members.get(id);
}

function assertNameFree(s, name, exceptId) {
  const key = nameKey(name);
  for (const m of s.members.values()) {
    if (m.id !== exceptId && nameKey(m.name) === key) throw new HttpError(409, `"${name}" já está nesta sessão. Escolha outro apelido.`);
  }
}

export function rename(s, id, rawName) {
  const name = cleanName(rawName);
  assertNameFree(s, name, id);
  s.members.get(id).name = name;
  return name;
}

// Returns the new owner id when the crown had to move, else null.
export function removeMember(s, id) {
  const m = s.members.get(id);
  if (!m) return null;
  s.members.delete(id);
  s.queue = s.queue.filter((q) => q !== id);
  if (s.grant?.id === id) s.grant = null;
  if (s.presenterId === id) clearPresenter(s);
  if (m.role !== 'owner' || !s.members.size) return null;
  // Crown goes to the oldest moderator, else the oldest member.
  const heirs = [...s.members.values()].sort((a, b) => (b.role === 'mod') - (a.role === 'mod') || a.joinedAt - b.joinedAt);
  heirs[0].role = 'owner';
  s.ownerId = heirs[0].id;
  return s.ownerId;
}

function member(s, id) {
  const m = s.members.get(id);
  if (!m) throw new HttpError(404, 'Essa pessoa não está mais na sessão.');
  return m;
}

function authorize(s, action, actorId, targetId) {
  const a = member(s, actorId);
  const t = targetId === undefined ? undefined : member(s, targetId);
  if (!CAN[action](s, a, t)) throw new HttpError(403, DENIED[action] ?? 'Seu papel na sessão não permite essa ação.');
  return { a, t };
}
const DENIED = {
  passTurn: 'Só o dono, os moderadores ou quem está transmitindo podem passar a vez.',
  ban: 'Só o dono pode bloquear pessoas.',
  promote: 'Só o dono nomeia moderadores.',
  demote: 'Só o dono tira moderadores.',
  transferOwner: 'Só o dono pode passar a coroa.',
  end: 'Só o dono pode encerrar a sessão para todos.',
  settings: 'Só o dono muda as regras da sessão.',
  stopStream: 'Só o dono e os moderadores tiram alguém da transmissão.',
  kick: 'Moderadores não removem o dono nem outros moderadores.',
  muteForAll: 'Moderadores não silenciam o dono nem outros moderadores.',
};

export function startStream(s, id, state, now = Date.now()) {
  member(s, id);
  if (s.presenterId === id) throw new HttpError(409, 'Você já está transmitindo. Use Trocar fonte para mudar a tela.');
  if (s.presenterId) throw new HttpError(409, `${s.members.get(s.presenterId).name} está transmitindo. Peça a vez.`);
  if (s.grant && s.grant.until > now && s.grant.id !== id) {
    throw new HttpError(409, `A vez foi passada para ${s.members.get(s.grant.id)?.name ?? 'outra pessoa'}. Aguarde ou peça a vez.`);
  }
  s.presenterId = id;
  s.presenterState = { paused: false, audio: true, ...state };
  s.grant = null;
  s.queue = s.queue.filter((q) => q !== id);
}

function clearPresenter(s) {
  s.presenterId = null;
  s.presenterState = null;
}

// Stops the current stream. With autoApprove the first in line gets the turn.
// Returns the id that received the turn (or null).
export function stopStream(s, actorId, now = Date.now()) {
  if (!s.presenterId) throw new HttpError(409, 'Ninguém está transmitindo agora.');
  authorize(s, 'stopStream', actorId, s.presenterId);
  clearPresenter(s);
  if (s.settings.autoApprove && s.queue.length) return grantTurn(s, s.queue.shift(), now);
  return null;
}

export function requestTurn(s, id) {
  member(s, id);
  if (s.presenterId === id) throw new HttpError(409, 'Você já está transmitindo.');
  if (!s.queue.includes(id)) s.queue.push(id);
  return s.queue.indexOf(id) + 1;
}

export function cancelRequest(s, id) {
  s.queue = s.queue.filter((q) => q !== id);
}

function grantTurn(s, targetId, now) {
  s.queue = s.queue.filter((q) => q !== targetId);
  s.grant = { id: targetId, until: now + TURN_GRANT_MS };
  return targetId;
}

// Hands the turn to targetId; the current stream (if any) stops.
export function passTurn(s, actorId, targetId, now = Date.now()) {
  authorize(s, 'passTurn', actorId, targetId);
  if (targetId === s.presenterId) throw new HttpError(409, 'Essa pessoa já está transmitindo.');
  clearPresenter(s);
  return grantTurn(s, targetId, now);
}

export function declineRequest(s, actorId, targetId) {
  authorize(s, 'approveRequest', actorId, targetId);
  cancelRequest(s, targetId);
}

// Moderation actions from the T10 menu. Returns what the server must do: { effect, ... }.
export function moderate(s, actorId, action, targetId) {
  switch (action) {
    case 'muteForAll':
      authorize(s, action, actorId, targetId);
      s.members.get(targetId).mic = false;
      return { effect: 'mute' };
    case 'kick':
      authorize(s, action, actorId, targetId);
      removeMember(s, targetId);
      return { effect: 'kick' };
    case 'ban': {
      const { t } = authorize(s, action, actorId, targetId);
      if (t.device) s.banned.add(t.device);
      removeMember(s, targetId);
      return { effect: 'ban' };
    }
    case 'promote':
      authorize(s, action, actorId, targetId).t.role = 'mod';
      return { effect: 'roles' };
    case 'demote':
      authorize(s, action, actorId, targetId).t.role = 'member';
      return { effect: 'roles' };
    case 'transferOwner': {
      const { a, t } = authorize(s, action, actorId, targetId);
      a.role = 'mod'; // former owner keeps session powers, loses the crown-only ones
      t.role = 'owner';
      s.ownerId = t.id;
      return { effect: 'roles' };
    }
    default:
      throw new HttpError(400, `Ação desconhecida: ${action}.`);
  }
}

export function updateSettings(s, actorId, patch) {
  const keys = Object.keys(patch ?? {});
  if (!keys.length || keys.some((k) => !(k in s.settings) || typeof patch[k] !== 'boolean')) {
    throw new HttpError(400, 'Regra inválida.');
  }
  // Locking is a session-management power moderators share; the rest is owner-only.
  authorize(s, keys.every((k) => k === 'locked') ? 'lock' : 'settings', actorId);
  Object.assign(s.settings, patch);
}

export function snapshot(s) {
  return {
    code: s.code,
    ownerId: s.ownerId,
    presenterId: s.presenterId,
    presenterState: s.presenterState,
    grant: s.grant && { id: s.grant.id, until: s.grant.until },
    queue: [...s.queue],
    settings: { ...s.settings },
    members: [...s.members.values()].map(({ id, name, role, mic }) => ({ id, name, role, mic })),
  };
}
