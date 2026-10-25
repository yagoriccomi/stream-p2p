// Stream P2P client: screens (T01–T14), session state, and wiring between VideoNet and VoiceMesh.
import { VideoNet, MODES, captureConstraints, randomId } from '/stream.js';
import { VoiceMesh } from '/voice.js';
import { nativeSystemAudio } from '/sysaudio.js';
import { playAt, release } from '/boost.js';
import { CAN } from '/session.js';
import {
  $, h, icon, setIcon, showError, notify, fieldError, wireEye, wireSwitch, setSwitch, screen,
  closeOnX, openMenu, initials, time, store,
} from '/ui.js';

const tauri = window.__TAURI__; // present only inside the Windows app (T08/T12–T14)
const params = new URLSearchParams(location.search);
const log = (m) => console.debug(`[sp2p] ${m}`);

const st = {
  me: null, // my client id
  session: null, // last snapshot
  code: null,
  name: store.get('name', ''),
  device: store.get('device', null) ?? (() => { const d = randomId(); store.set('device', d); return d; })(),
  voicePref: 'mic',
  rejoin: null, // { code, name } after a dropped socket
  pending: null, // op we are waiting an answer for
  pendingRename: null,
  codeShown: false,
  src: store.get('src', 'monitor'),
  mode: store.get('mode', '1080p60'),
  upload: store.get('upload', 20),
  audio: store.get('streamAudio', true),
  paused: false,
  nativeSources: null,
  nativePick: null,
  audioSessions: null, // last list_audio_sessions() answer, while dlg-setup is open on Monitor
  // Allowlist by process NAME (a PID is reused by nothing, by each run of the same program): a
  // name missing here means "allowed" (today's behaviour, until the person unchecks it once).
  audioAllow: store.get('audioAllow', {}),
  settings: { codec: store.get('codec', ''), latency: store.get('latency', 'auto') },
  latency: null, // { targetMs, recommendedMs, auto } from the server while a stream is on
};
window.__app = st; // read by e2e

// ── ICE: the server's STUN/TURN (/ice.json) plus an optional personal TURN from T11 ──
const ICE_REFRESH_MS = 60 * 60_000; // server TURN credentials last 6 h (coturn) to 12 h (Cloudflare)
let serverIce = [{ urls: 'stun:stun.l.google.com:19302' }]; // until /ice.json answers
async function loadIce() {
  try {
    const res = await fetch('/ice.json', { cache: 'no-store' });
    if (res.ok) serverIce = (await res.json()).iceServers;
  } catch (e) {
    log(`ice: ${e.message}`); // keep the last list; STUN alone still works on most networks
  }
}
loadIce();
setInterval(loadIce, ICE_REFRESH_MS);

// The server hands out STUN and short-lived TURN credentials (/ice.json): nothing to set up here.
const getIce = () => [...serverIce];

// ── socket with reconnect (T05: "Reconectando") ──
let ws;
let retry = 0;
const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  let queue = Promise.resolve(); // a candidate must not race ahead of its setRemoteDescription
  ws.onmessage = ({ data }) => {
    queue = queue.then(() => handle(JSON.parse(data))).catch((e) => log(`erro: ${e.stack ?? e.message}`));
  };
  ws.onclose = () => {
    if (st.session) {
      st.rejoin = { code: st.code, name: myName() };
      teardown({ keepScreen: true });
    }
    $('conn').hidden = false;
    $('conn-text').textContent = st.rejoin ? 'Reconectando à sessão…' : 'Reconectando ao servidor…';
    setTimeout(connect, Math.min(10_000, 1000 * 2 ** retry++));
  };
}

const video = new VideoNet({
  send, log, getIce,
  getCodec: () => st.settings.codec,
  onStream: (stream) => {
    $('video').srcObject = stream;
    applyStreamMix(); // the saved volume and mute from the first frame
    $('video').play().catch(() => {});
    renderStage();
  },
});

const voice = new VoiceMesh({
  send, log, getIce,
  onError: (e) => showError(403, e.name === 'NotFoundError'
    ? 'Nenhum microfone encontrado neste aparelho. Você continua ouvindo e no chat.'
    : 'O navegador bloqueou o microfone. Libere no cadeado ao lado do endereço e clique em Microfone de novo. Você continua ouvindo e no chat.',
  { title: 'Microfone bloqueado' }),
});

Object.assign(st, { send, video, voice }); // handles for e2e

const me = () => st.session?.members.find((m) => m.id === st.me);
const myName = () => me()?.name ?? st.name;
const member = (id) => st.session?.members.find((m) => m.id === id);
const sessionForCan = () => ({ ...st.session, settings: st.session.settings });

// ── server messages ──
async function handle(msg) {
  switch (msg.type) {
    case 'hello':
      st.me = msg.id;
      retry = 0;
      $('conn').hidden = true;
      autoStart?.();
      autoStart = null;
      if (st.rejoin) {
        st.pending = 'rejoin';
        send({ type: 'join', code: st.rejoin.code, name: st.rejoin.name, device: st.device });
      }
      return;
    case 'session':
      return onSession(msg.session);
    case 'assigned':
      video.assigned(msg);
      return renderStage();
    case 'jitter':
      return video.setJitter(msg.jitterMs);
    case 'latency':
      st.latency = msg;
      return renderHeader();
    case 'child':
      return video.child(msg.id);
    case 'childGone':
      return video.childGone(msg.id);
    case 'signal':
      return video.signal(msg.from, msg.data);
    case 'vsignal':
      return voice.signal(msg.from, msg.data);
    case 'streamEnded':
      st.latency = null;
      needs.length = 0;
      video.reset();
      $('video').srcObject = null;
      st.paused = false;
      return renderStage();
    case 'chat':
      return addChat(msg);
    case 'srcStats':
      st.origin = { ...msg.stats, at: performance.now() };
      return;
    case 'peerLeft':
      return voice.drop(msg.id);
    case 'yourTurn':
      showError(null, 'Você tem 1 minuto para começar. Escolha a fonte e a qualidade.', {
        title: 'Sua vez de transmitir', kind: 'ok', timeout: 60_000,
        actions: [{ label: 'Transmitir agora', primary: true, run: openSetup }],
      });
      return render();
    case 'turnRequest':
      return; // the banner is derived from the snapshot queue
    case 'forceMute':
      voice.disableMic();
      send({ type: 'mic', on: false });
      renderFooter();
      return showError(null, `${msg.by} silenciou seu microfone para todos. Você pode ligar de novo quando quiser.`, { title: 'Microfone silenciado', kind: 'info' });
    case 'notice':
      return showError(msg.code, msg.reason, { kind: 'info' });
    case 'ended':
      teardown();
      screen('home');
      return showError(msg.code, msg.reason, { timeout: 0 });
    case 'left':
      return;
    case 'error':
      return onError(msg);
  }
}

function onError({ op, code, reason }) {
  const pending = st.pending;
  if (op === 'join' || op === 'create') st.pending = null;
  if (op === 'join' && pending === 'rejoin') {
    st.rejoin = null;
    teardown();
    screen('home');
    return showError(code, `Não deu para voltar à sessão. ${reason}`, { timeout: 0 });
  }
  if (op === 'join') {
    if (code === 409) return fieldError('join-name', 'join-name-err', code, reason);
    if ([400, 404, 410].includes(code)) return fieldError('join-code', 'join-code-err', code, reason);
  }
  if (op === 'create' && code === 400) return fieldError('create-name', 'create-err', code, reason);
  if (op === 'rename') return fieldError('rename-input', 'rename-err', code, reason);
  if (op === 'startStream') {
    video.reset();
    $('video').srcObject = null;
    renderStage();
  }
  showError(code, reason);
}

function onSession(s) {
  const first = !st.session;
  const prevPresenter = st.session?.presenterId;
  st.session = s;
  st.code = s.code;
  st.pending = null;
  if (first) {
    st.rejoin = null;
    st.auto = false; // only the session the command line asked for skips the mic prompt
    store.set('name', myName());
    history.replaceState(null, '', `/?code=${s.code}`);
    screen('session');
    $('dlg-rename').close();
  }
  // Someone else took over: drop whatever video role we had; the server re-assigns us.
  if (prevPresenter !== s.presenterId && s.presenterId !== st.me && video.presenting) video.reset();
  if (prevPresenter && prevPresenter !== s.presenterId && s.presenterId !== st.me) $('video').srcObject = null;
  if (st.pendingRename && myName() === st.pendingRename) {
    st.pendingRename = null;
    store.set('name', myName());
    $('dlg-rename').close();
  }
  voice.sync(st.me, s.members.map((m) => m.id));
  tray('set_tray_live', { live: s.presenterId === st.me });
  render();
  reportStatus();
}

function teardown({ keepScreen } = {}) {
  video.reset();
  if (!keepScreen) voice.leave();
  else for (const id of [...voice.peers.keys()]) voice.drop(id);
  $('video').srcObject = null;
  st.session = null;
  st.paused = false;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('messages').replaceChildren();
  if (!keepScreen) history.replaceState(null, '', '/');
  reportStatus();
}

// ── rendering ──
function render() {
  if (!st.session) return;
  renderHeader();
  renderStage();
  renderPeople();
  renderFooter();
  renderRequest();
  if ($('dlg-audio').open) renderAudio();
}

function renderHeader() {
  const s = st.session;
  $('s-code').textContent = st.codeShown ? s.code : '•'.repeat(s.code.length);
  const live = Boolean(s.presenterId);
  $('s-live').hidden = !live || s.presenterState?.paused;
  $('s-paused').hidden = !live || !s.presenterState?.paused;
  $('s-latency').hidden = !live;
  const lat = st.latency;
  $('s-latency-ms').textContent = lat ? `${lat.targetMs} ms${lat.auto ? ' (automático)' : ''}` : '…';
}

function renderStage() {
  const s = st.session;
  if (!s) return;
  const presenter = member(s.presenterId);
  const mine = s.presenterId === st.me;
  const hasVideo = Boolean($('video').srcObject);
  $('ov-empty').hidden = Boolean(presenter);
  $('ov-connecting').hidden = !presenter || mine || hasVideo;
  $('ov-paused').hidden = !presenter || mine || !s.presenterState?.paused;
  $('ov-paused-text').textContent = presenter ? `${presenter.name} pausou. O vídeo volta sozinho.` : '';
  $('s-who').hidden = !presenter;
  $('s-who').textContent = presenter ? (mine ? 'Você está transmitindo' : `${presenter.name} transmitindo`) : '';
  $('pbar').hidden = !mine;
  const grant = s.grant && s.grant.until > Date.now() ? member(s.grant.id) : null;
  $('ov-empty-title').textContent = grant ? (grant.id === st.me ? 'Sua vez de transmitir' : `Vez de ${grant.name}`) : 'Ninguém transmitindo';
  $('ov-empty-text').textContent = grant && grant.id !== st.me
    ? `${grant.name} tem até 1 minuto para começar.`
    : 'Qualquer pessoa da sessão pode transmitir. Uma de cada vez.';
  $('ov-stream').hidden = !canCapture() || (grant && grant.id !== st.me);
  if (mine) renderPresenterBar();
}

function renderPresenterBar() {
  const ps = st.session.presenterState ?? {};
  $('p-quality').replaceChildren(...Object.keys(MODES).map((m) => h('button', {
    type: 'button', 'aria-pressed': String(ps.mode === m), text: m,
    onclick: async () => {
      await video.setMode(m);
      send({ type: 'streamState', mode: m });
    },
  })));
  const paused = Boolean(ps.paused);
  $('p-pause').setAttribute('aria-pressed', String(paused));
  $('p-pause').querySelector('span').textContent = paused ? 'Retomar' : 'Pausar';
  setIcon($('p-pause'), paused ? 'play' : 'pause');
  setSwitch($('p-audio'), ps.audio !== false);
  $('p-pass').hidden = !CAN.passTurn(sessionForCan(), me());
}

const roleLabel = { owner: 'dono(a)', mod: 'moderador(a)' };
function renderPeople() {
  const s = st.session;
  const a = me();
  $('people-count').textContent = `(${s.members.length})`;
  $('people').replaceChildren(...s.members.map((m) => {
    const tags = [];
    if (m.role === 'owner') tags.push(h('span', { class: 'badge role' }, icon('owner', 'i sm'), 'dono(a)'));
    if (m.role === 'mod') tags.push(h('span', { class: 'badge role' }, icon('moderator', 'i sm'), 'moderador(a)'));
    const actions = a && m.id !== st.me ? personActions(a, m) : [];
    return h('li', { class: 'person' },
      h('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(m.name) }),
      h('span', { class: 'who' },
        h('b', { text: `${m.name}${m.id === st.me ? ' (você)' : ''}` }),
        h('span', {},
          s.presenterId === m.id ? h('span', { class: 'live-dot', text: '● transmitindo' }) : null,
          s.queue.includes(m.id) ? h('span', { text: `pediu a vez (${s.queue.indexOf(m.id) + 1}º)` }) : null,
          ...tags),
        m.id !== st.me ? h('span', { class: 'person-vol' }, icon('volume', 'i sm'), ...personVolume(m, `pvol-${m.id}`)) : null),
      h('span', { class: 'sr-only', text: m.mic ? 'microfone ligado' : 'microfone desligado' }),
      icon(m.mic ? 'mic' : 'mic-off', 'i sm'),
      actions.length ? h('button', {
        class: 'btn ghost icon', type: 'button', 'aria-label': `Ações para ${m.name}`, 'aria-haspopup': 'menu',
        onclick: (e) => openMenu(e.currentTarget, actions),
      }, icon('more')) : null);
  }));
}

// Owner/mod/presenter powers, filtered by the same CAN matrix the server enforces.
function personActions(a, t) {
  const s = sessionForCan();
  const items = [];
  const mod = (action, label, ic, red, confirmText) => CAN[action](s, a, t) && items.push({
    label, icon: ic, red,
    run: () => (!confirmText || confirm(confirmText)) && send({ type: 'mod', action, id: t.id }),
  });
  if (t.mic) mod('muteForAll', 'Silenciar para todos', 'mic-off');
  if (CAN.passTurn(s, a) && s.presenterId !== t.id) items.push({ label: 'Passar a vez', icon: 'pass-turn', run: () => send({ type: 'passTurn', id: t.id }) });
  if (s.presenterId === t.id && CAN.stopStream(s, a, t)) items.push({ label: 'Tirar da transmissão', icon: 'stop', run: () => send({ type: 'stopStream' }) });
  mod('promote', 'Tornar moderador(a)', 'moderator');
  mod('demote', 'Tirar moderação', 'moderator');
  mod('transferOwner', 'Tornar dono(a)', 'owner', false, `Passar a coroa para ${t.name}? Você vira moderador(a).`);
  mod('kick', 'Remover da sessão', 'remove-person', true);
  mod('ban', 'Bloquear (403)', 'lock', true, `Bloquear ${t.name}? Este navegador não entra mais nesta sessão.`);
  return items;
}

function canCapture() {
  return Boolean(navigator.mediaDevices?.getDisplayMedia);
}

function renderFooter() {
  const s = st.session;
  const mic = voice.micOn;
  $('f-mic').setAttribute('aria-pressed', String(mic));
  $('f-mic').classList.toggle('off', !mic);
  $('f-mic').setAttribute('aria-label', mic ? 'Desligar microfone' : 'Ligar microfone');
  setIcon($('f-mic'), mic ? 'mic' : 'mic-off');
  $('f-deafen').setAttribute('aria-pressed', String(voice.deafened));
  $('f-deafen').classList.toggle('off', voice.deafened);
  $('f-deafen').setAttribute('aria-label', voice.deafened ? 'Voltar a ouvir' : 'Parar de ouvir todos');
  setIcon($('f-deafen'), voice.deafened ? 'deafen' : 'headphones');

  const btn = $('f-stream');
  const label = btn.querySelector('span');
  const grant = s.grant && s.grant.until > Date.now() ? s.grant.id : null;
  btn.hidden = s.presenterId === st.me;
  btn.classList.remove('primary');
  if (!s.presenterId && (!grant || grant === st.me)) {
    label.textContent = grant === st.me ? 'Transmitir agora' : 'Transmitir';
    setIcon(btn, 'screen-share');
    btn.hidden ||= !canCapture();
    if (grant === st.me) btn.classList.add('primary');
    btn.onclick = openSetup;
  } else if (s.queue.includes(st.me)) {
    label.textContent = 'Cancelar pedido';
    setIcon(btn, 'close');
    btn.onclick = () => send({ type: 'cancelRequest' });
  } else {
    label.textContent = 'Pedir a vez';
    setIcon(btn, 'request-turn');
    btn.hidden ||= !canCapture();
    btn.onclick = () => send({ type: 'requestTurn' });
  }
}

function renderRequest() {
  const s = st.session;
  const a = me();
  const nextId = s.queue.find((id) => id !== st.me);
  const show = nextId && a && CAN.approveRequest(sessionForCan(), a);
  $('req-banner').hidden = !show;
  if (!show) return;
  const who = member(nextId);
  $('req-text').textContent = `${who?.name ?? 'Alguém'} pediu a vez${s.queue.length > 1 ? ` (+${s.queue.length - 1} na fila)` : ''}.`;
  $('req-yes').onclick = () => send({ type: 'passTurn', id: nextId });
  $('req-no').onclick = () => send({ type: 'declineRequest', id: nextId });
}

function addChat({ name, text, at, system }) {
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.append(system
    ? h('p', { class: 'msg system', text })
    : h('p', { class: 'msg' }, h('b', { text: name }), h('time', { text: time(at) }), h('br'), text));
  while (box.children.length > 300) box.firstElementChild.remove();
  if (nearBottom) box.scrollTop = box.scrollHeight;
  if (!system && !sideShown()) $('f-unread').hidden = false;
}

// Chat and people panel: hidden on demand, so the stream gets the whole width. Remembered per device.
const sideShown = () => !document.querySelector('.session').classList.contains('side-off');
function showSide(on) {
  document.querySelector('.session').classList.toggle('side-off', !on);
  $('f-side').setAttribute('aria-pressed', String(on));
  $('f-side').setAttribute('aria-label', on ? 'Esconder o chat' : 'Mostrar o chat');
  if (on) $('f-unread').hidden = true;
  store.set('sideShown', on);
}
showSide(store.get('sideShown', true));
$('f-side').addEventListener('click', () => showSide(!sideShown()));

// ── T01 · Início ──
$('create-name').value = st.name;
$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  fieldError('create-name', 'create-err');
  const name = $('create-name').value.trim();
  if (!name) return fieldError('create-name', 'create-err', 400, 'Digite um apelido. Ele aparece para quem entrar.');
  st.name = name;
  st.voicePref = st.auto ? 'listen' : 'mic';
  if (!st.auto) await voice.enableMic(); // asked inside the click; a denial keeps you listen-only
  st.pending = 'create';
  send({ type: 'create', name, device: st.device });
});
wireEye(document.querySelector('[data-eye="home-code"]'), $('home-code'));
$('home-join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  openJoin($('home-code').value);
});

// ── T09 · Entrar ──
function openJoin(code, name) {
  $('join-code').value = code ?? '';
  $('join-name').value = name ?? st.name ?? '';
  fieldError('join-code', 'join-code-err');
  fieldError('join-name', 'join-name-err');
  screen('join');
  ($('join-code').value ? $('join-name') : $('join-code')).focus();
}
wireEye(document.querySelector('[data-eye="join-code"]'), $('join-code'));
for (const opt of document.querySelectorAll('.voice-opt')) {
  opt.addEventListener('click', () => {
    st.voicePref = opt.dataset.voice;
    for (const o of document.querySelectorAll('.voice-opt')) o.setAttribute('aria-checked', String(o === opt));
    $('perm-mic').textContent = st.voicePref === 'mic' ? 'ao entrar' : 'depois';
  });
}
$('join-back').addEventListener('click', () => {
  history.replaceState(null, '', '/');
  screen('home');
});
$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  fieldError('join-code', 'join-code-err');
  fieldError('join-name', 'join-name-err');
  const code = $('join-code').value.trim();
  const name = $('join-name').value.trim();
  if (!code) return fieldError('join-code', 'join-code-err', 400, 'Cole o código do convite.');
  if (!name) return fieldError('join-name', 'join-name-err', 400, 'O apelido é obrigatório para entrar. Ele precisa ser diferente dos que já estão na sessão.');
  st.name = name;
  if (st.voicePref === 'mic' && !voice.raw && !st.auto) await voice.enableMic();
  st.pending = 'join';
  send({ type: 'join', code, name, device: st.device });
});

// ── T03 · Sessão ──
$('s-eye').addEventListener('click', () => {
  st.codeShown = !st.codeShown;
  $('s-eye').setAttribute('aria-pressed', String(st.codeShown));
  $('s-eye').setAttribute('aria-label', st.codeShown ? 'Ocultar código' : 'Mostrar código');
  setIcon($('s-eye'), st.codeShown ? 'hide-code' : 'watching');
  renderHeader();
});
const inviteLink = () => `${location.origin}/?code=${st.code}`;
async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteLink());
    notify('Convite copiado. O código vai junto, sem aparecer na tela.', 'ok');
  } catch {
    showError(null, `Copie manualmente: ${inviteLink()}`, { title: 'Não deu para copiar', kind: 'info', timeout: 0 });
  }
}
$('s-copy').addEventListener('click', copyInvite);
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  $('chat-input').value = '';
});
for (const tab of document.querySelectorAll('.side .tabs [role=tab]')) {
  tab.addEventListener('click', () => {
    document.querySelector('.side').dataset.tab = tab.dataset.tab;
    for (const t of document.querySelectorAll('.side .tabs [role=tab]')) t.setAttribute('aria-selected', String(t === tab));
  });
}
$('s-rename').addEventListener('click', () => {
  $('rename-input').value = myName();
  fieldError('rename-input', 'rename-err');
  $('dlg-rename').showModal();
});
$('rename-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('rename-input').value.trim();
  if (!name) return fieldError('rename-input', 'rename-err', 400, 'O apelido não pode ficar vazio.');
  if (name === myName()) return $('dlg-rename').close();
  st.pendingRename = name;
  send({ type: 'rename', name });
});
closeOnX($('dlg-rename'));

$('f-mic').addEventListener('click', async () => {
  if (voice.micOn) voice.disableMic();
  else if (!(await voice.enableMic())) return renderFooter();
  send({ type: 'mic', on: voice.micOn });
  renderFooter();
});
$('f-deafen').addEventListener('click', () => {
  voice.setDeafened(!voice.deafened);
  renderFooter();
});
$('f-full').addEventListener('click', () => {
  const stage = document.querySelector('.stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else (stage.requestFullscreen ?? $('video').webkitEnterFullscreen)?.call(stage.requestFullscreen ? stage : $('video'));
});
function leaveSession() {
  send({ type: 'leave' });
  teardown();
  screen('home');
  reportStatus();
}
$('f-leave').addEventListener('click', leaveSession);
$('ov-stream').addEventListener('click', openSetup);


// ── T02 · Escolher fonte e qualidade ──
// `swap`: switching the source of a live stream; in the app the grid is the picker for that too,
// so the dialog opens with only the source section.
let swapping = false;
function openSetup({ swap = false } = {}) {
  swapping = swap;
  $('setup-form').classList.toggle('swap', swap);
  $('setup-h').textContent = swap ? 'Trocar fonte' : 'Transmitir';
  $('q-start').lastChild.textContent = swap ? 'Trocar fonte' : 'Começar a transmitir';
  $('q-upload').value = st.upload;
  uploadTouched = false;
  renderSetup();
  $('dlg-setup').showModal();
  loadNativeSources();
  startAudioPoll();
  if (!swap && !store.get('uploadMeasured', false)) measureUpload(); // first time on this device: measure instead of guessing
}
closeOnX($('dlg-setup'));
$('dlg-setup').addEventListener('close', stopAudioPoll); // every way the dialog closes fires this

// The app only (list_audio_sessions/pids are native commands): while the dialog is open and the
// Monitor tab is the active one, poll for who has sound right now. No event exists for "a session
// appeared/disappeared", and apps open/close rarely compared to the dialog being open.
const AUDIO_POLL_MS = 2000;
let audioPollTimer = null;
function startAudioPoll() {
  if (!tauri?.core?.invoke || audioPollTimer) return;
  loadAudioSessions();
  audioPollTimer = setInterval(loadAudioSessions, AUDIO_POLL_MS);
}
function stopAudioPoll() {
  clearInterval(audioPollTimer);
  audioPollTimer = null;
}
async function loadAudioSessions() {
  if (st.src !== 'monitor') return; // Janela has no list; avoid a pointless native call
  try {
    st.audioSessions = await tauri.core.invoke('list_audio_sessions');
    renderSetup();
  } catch (e) {
    log(`list_audio_sessions: ${e}`);
  }
}
// One line per process with sound right now; a process that drops off the list keeps its saved
// choice (by name: a PID is only good for the run that had it), so a brief hiccup never forgets it.
function renderAudioApps() {
  const sessions = st.audioSessions ?? [];
  $('apps-hint').hidden = sessions.length > 0;
  $('apps-list').replaceChildren(...sessions.map((s) => {
    const on = st.audioAllow[s.name] ?? true; // unseen name: allowed, same as today's behaviour
    const btn = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on) },
      h('span', { text: s.name }), h('span', { class: 'track' }));
    wireSwitch(btn, (allow) => { st.audioAllow = { ...st.audioAllow, [s.name]: allow }; store.set('audioAllow', st.audioAllow); });
    return btn;
  }));
}
function renderSetup() {
  for (const tab of $('src-tabs').children) {
    tab.setAttribute('aria-selected', String(tab.dataset.src === st.src));
    const n = st.nativeSources?.filter((x) => x.kind === tab.dataset.src).length;
    tab.querySelector('.count').textContent = st.nativeSources ? `(${n})` : '';
  }
  $('src-grid').hidden = !st.nativeSources;
  $('src-hint').hidden = Boolean(st.nativeSources);
  if (st.nativeSources) {
    const list = st.nativeSources.filter((x) => x.kind === st.src);
    // The grid is the only picker in the app: something is always chosen in the open tab.
    if (!list.some((x) => x.id === st.nativePick)) st.nativePick = list[0]?.id ?? null;
    $('src-grid').replaceChildren(...(list.length ? list.map((x) => h('button', {
      type: 'button', class: 'src', 'aria-pressed': String(st.nativePick === x.id),
      onclick: () => { st.nativePick = x.id; renderSetup(); },
    }, x.thumb ? h('img', { src: x.thumb, alt: '' }) : h('span', { class: 'thumb' }, icon(x.kind)), h('span', { text: x.name }))) : [h('p', { class: 'small muted', text: 'Nada aberto nessa categoria.' })]));
  }
  $('q-modes').replaceChildren(...Object.keys(MODES).map((m) => h('button', {
    type: 'button', 'aria-pressed': String(st.mode === m), text: m,
    onclick: () => { st.mode = m; store.set('mode', m); renderSetup(); },
  })));
  const upload = Number($('q-upload').value) || 0;
  const quota = Math.max(1, Math.floor((upload * 1000 * 0.8) / MODES[st.mode].kbps));
  const others = Math.max(0, (st.session?.members.length ?? 1) - 1);
  $('q-quota').textContent = upload > 0
    ? `${MODES[st.mode].kbps / 1000} Mbps por pessoa. Seu upload envia direto para ${quota} ${quota === 1 ? 'pessoa' : 'pessoas'}; ${others > quota ? `as outras ${others - quota} recebem via retransmissão (+30 ms por salto, compensado no buffer).` : 'todo mundo recebe direto.'}`
    : 'Informe o upload para calcular quantas pessoas recebem direto.';
  $('q-quota').classList.toggle('warn', upload > 0 && quota === 1 && others > 1);
  setSwitch($('q-audio'), st.audio);
  // Only Monitor leaks other apps' sound; Janela already isolates by HWND (see focusWindowAudio).
  $('apps-section').hidden = !tauri?.core?.invoke || st.src !== 'monitor';
  renderAudioApps();
}
for (const tab of $('src-tabs').children) tab.addEventListener('click', () => {
  st.src = tab.dataset.src;
  store.set('src', st.src);
  renderSetup();
  if (st.src === 'monitor') loadAudioSessions(); // switching into Monitor: show the list right away
});
$('q-upload').addEventListener('input', () => {
  uploadTouched = true;
  st.upload = Number($('q-upload').value) || st.upload;
  store.set('upload', st.upload);
  renderSetup();
});
wireSwitch($('q-audio'), (on) => { st.audio = on; store.set('streamAudio', on); });

// ── T02 · upload measurement: a small probe sizes the real test to ~3 s on this connection ──
const SPEEDTEST_PROBE_BYTES = 1 << 20;
const SPEEDTEST_TARGET_S = 3;
const SPEEDTEST_MAX_BYTES = 24 << 20; // the server accepts up to 32 MB
const MAX_UPLOAD_MBPS = 1000; // same max as the field
let uploadTouched = false; // a value the person typed always wins over a measurement
let measuring = false;

function postBlob(bytes, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); // fetch has no upload progress
    xhr.open('POST', '/speedtest');
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* reason below */ }
      if (xhr.status === 200) return resolve(body);
      reject({ code: xhr.status, reason: body.reason ?? 'O servidor recusou o teste de upload.' });
    };
    xhr.onerror = () => reject({ code: 503, reason: 'Não deu para falar com o servidor. Confira a internet e meça de novo.' });
    xhr.send(new Uint8Array(bytes));
  });
}

function showMeasured(text, { ok = false, use = null } = {}) {
  const line = $('q-measured');
  line.classList.toggle('ok', ok);
  line.replaceChildren(h('span', { text }), ...(use ? [h('button', { type: 'button', text: 'Usar este valor', onclick: use })] : []));
  line.hidden = false;
}

function setUpload(mbps) {
  st.upload = mbps;
  store.set('upload', mbps);
  $('q-upload').value = mbps;
  fieldError('q-upload', 'q-upload-err', null, null);
  renderSetup();
}

async function measureUpload() {
  if (measuring) return;
  measuring = true;
  const btn = $('q-measure');
  btn.disabled = true;
  btn.textContent = 'Medindo…';
  $('q-upload-err').hidden = true;
  try {
    showMeasured('Medindo seu upload…');
    const probe = await postBlob(SPEEDTEST_PROBE_BYTES);
    const probeBps = probe.ms > 0 ? (probe.bytes * 1000) / probe.ms : Infinity;
    const size = Math.round(Math.min(SPEEDTEST_MAX_BYTES, Math.max(SPEEDTEST_PROBE_BYTES, probeBps * SPEEDTEST_TARGET_S)));
    const mb = (n) => Math.round(n / (1 << 20));
    const run = await postBlob(size, (sent) => showMeasured(`Enviando ${mb(sent)} de ${mb(size)} MB…`));
    const raw = run.ms > 0 ? (run.bytes * 8) / run.ms / 1000 : Infinity;
    const mbps = Math.max(1, Math.min(MAX_UPLOAD_MBPS, Math.round(raw)));
    store.set('uploadMeasured', true);
    const label = raw > MAX_UPLOAD_MBPS ? `mais de ${MAX_UPLOAD_MBPS} Mbps` : `${mbps} Mbps`;
    if (uploadTouched && mbps !== Number($('q-upload').value)) {
      showMeasured(`Medido agora: ${label}.`, { ok: true, use: () => { setUpload(mbps); showMeasured(`Medido agora: ${label}`, { ok: true }); } });
    } else {
      setUpload(mbps);
      showMeasured(`Medido agora: ${label}`, { ok: true });
    }
  } catch (e) {
    console.error('[sp2p] speedtest', e);
    $('q-measured').hidden = true;
    fieldError('q-upload', 'q-upload-err', e.code ?? 503, e.reason ?? 'O teste de upload falhou. Meça de novo ou digite o valor.');
  } finally {
    measuring = false;
    btn.disabled = false;
    btn.textContent = 'Medir de novo';
  }
}
$('q-measure').addEventListener('click', measureUpload);

// In the app the system audio comes from WASAPI (sysaudio.js), so the picker only gives the video:
// Chromium's own loopback fails on some devices ("Could not start audio source", e.g. a 7.1
// headset) and drops the screen with it. An older app without the command falls back to Chromium.
function allowedAudioPids() {
  if (st.src !== 'monitor') return null; // Janela isolates by HWND already, no allowlist to send
  const sessions = st.audioSessions ?? [];
  return sessions.filter((s) => st.audioAllow[s.name] ?? true).map((s) => s.pid);
}

async function appSystemAudio() {
  if (!tauri) return null;
  try {
    return await nativeSystemAudio(tauri, allowedAudioPids());
  } catch (e) {
    log(`áudio do sistema pelo app: ${e?.message ?? e}; usando o do navegador`);
    return null;
  }
}

// A shared window sends only its program's sound. The label of a window track carries the HWND
// ("window:<hwnd>:0"); a screen keeps the whole PC minus the app, and an app without the window
// parameter ignores it and does the same.
async function focusWindowAudio(sysAudio, videoTrack) {
  const hwnd = /^window:(\d+):/.exec(videoTrack.label)?.[1];
  if (!hwnd || !sysAudio.focusWindow) return;
  try {
    await sysAudio.focusWindow(Number(hwnd));
  } catch (e) {
    console.warn('[sp2p] som só da janela', String(e));
    showError(null, 'Não deu para pegar só o som dessa janela; a transmissão leva o som do PC inteiro, então quem fala no Discord pode se ouvir.', { title: 'Som do PC inteiro', kind: 'info' });
  }
}

// In the app the source comes from the grid above; the app answers Chromium's picker with it out
// of sight (picker.rs). Without a pick, or in an older app, that picker simply shows up.
async function armPicker() {
  if (!tauri || !st.nativePick) return;
  try {
    await tauri.core.invoke('pick_source', { id: st.nativePick });
  } catch (e) {
    log(`pick_source: ${e?.message ?? e}; o seletor do navegador aparece`);
  }
}

async function capture() {
  if (!window.isSecureContext) {
    showError(403, 'A captura de tela só funciona em HTTPS ou em localhost. Abra pelo endereço seguro ou use o app.', { title: 'Captura bloqueada' });
    return null;
  }
  const sysAudio = await appSystemAudio();
  await armPicker();
  try {
    const constraints = captureConstraints(st.mode, st.src);
    const stream = await navigator.mediaDevices.getDisplayMedia(sysAudio ? { ...constraints, audio: false, systemAudio: 'exclude' } : constraints);
    if (sysAudio) {
      stream.addTrack(sysAudio);
      await focusWindowAudio(sysAudio, stream.getVideoTracks()[0]);
    }
    stream.getVideoTracks()[0].addEventListener('ended', () => st.session?.presenterId === st.me && send({ type: 'stopStream' }));
    return stream;
  } catch (e) {
    sysAudio?.stop();
    // Closing the picker is a choice, not an error. A system/policy block is.
    if (e.name === 'NotAllowedError' && !/system/i.test(e.message)) return null;
    showError(403, e.name === 'NotAllowedError'
      ? 'O sistema bloqueou a gravação de tela. No Windows: Configurações › Privacidade › Captura de tela. No macOS: Ajustes › Privacidade › Gravação de Tela.'
      : e.name === 'NotReadableError' && /audio/i.test(e.message)
        ? 'O navegador não conseguiu abrir o som do PC (acontece com alguns fones 7.1). Desligue "Compartilhar áudio do sistema" no seletor, ou use o app, que pega o som do PC por conta própria.'
        : `O navegador não conseguiu capturar: ${e.message}`, { title: 'Captura bloqueada' });
    return null;
  }
}

$('q-start').addEventListener('click', async () => {
  const stream = await capture();
  if (!stream) return;
  $('dlg-setup').close();
  if (swapping) return swapSource(stream);
  video.present(stream, st.mode, st.upload * 1000);
  video.setAudio(st.audio);
  $('video').srcObject = stream;
  $('video').muted = true; // no echo of my own stream
  send({ type: 'startStream', mode: st.mode, uploadKbps: st.upload * 1000, audio: st.audio, source: st.src, latency: st.settings.latency });
  if (st.audio && !video.hasAudio()) audioHint();
});

function audioHint() {
  showError(null, st.src === 'window'
    ? 'Janelas não trazem áudio no navegador. Use Monitor com "Compartilhar áudio do sistema" ou o app.'
    : 'Essa fonte veio sem áudio. Troque a fonte e marque "Compartilhar áudio do sistema" no seletor.', { title: 'Sem áudio nessa fonte', kind: 'info' });
}

// ── T04 · Controles de quem transmite ──
$('p-source').addEventListener('click', async () => {
  if (tauri) return openSetup({ swap: true });
  const next = await capture();
  if (next) await swapSource(next);
});
async function swapSource(next) {
  await video.replaceSource(next);
  $('video').srcObject = next;
  send({ type: 'streamState', source: st.src });
  if (st.session.presenterState?.audio !== false && !video.hasAudio()) audioHint();
}
$('p-pause').addEventListener('click', () => {
  const paused = !st.session.presenterState?.paused;
  video.setPaused(paused);
  send({ type: 'streamState', paused });
});
wireSwitch($('p-audio'), (on) => {
  video.setAudio(on);
  send({ type: 'streamState', audio: on });
  if (on && !video.hasAudio()) audioHint();
});
$('p-stop').addEventListener('click', () => send({ type: 'stopStream' }));
$('p-pass').addEventListener('click', () => {
  const s = st.session;
  const list = s.members.filter((m) => m.id !== st.me).sort((a, b) => (s.queue.includes(b.id) - s.queue.includes(a.id)));
  $('pass-list').replaceChildren(...(list.length ? list.map((m) => h('button', {
    class: 'btn', type: 'button', style: 'justify-content: flex-start',
    onclick: () => { $('dlg-pass').close(); send({ type: 'passTurn', id: m.id }); },
  }, h('span', { class: 'avatar', text: initials(m.name) }), m.name, s.queue.includes(m.id) ? h('span', { class: 'badge role', text: 'pediu a vez' }) : null)) : [h('p', { class: 'muted', text: 'Ninguém mais na sessão.' })]));
  $('dlg-pass').showModal();
});
closeOnX($('dlg-pass'));

// ── T10 · Áudio, papéis e moderação ──
$('f-audio').addEventListener('click', async () => {
  renderAudio();
  $('dlg-audio').showModal();
  await fillDevices();
});
closeOnX($('dlg-audio'));

// Mixer and mic settings outlive the session: restored on load, saved on every change.
const audioPrefs = { stream: 1, streamMuted: false, voice: 1, voiceMuted: false, gain: 1, ns: true, ec: true, ptt: false, in: '', out: '', ...store.get('audio', {}) };
const saveAudio = (patch) => { Object.assign(audioPrefs, patch); store.set('audio', audioPrefs); };
const streamMix = { volume: audioPrefs.stream, muted: audioPrefs.streamMuted };
function applyStreamMix() {
  const v = $('video');
  if (st.session?.presenterId === st.me) return release(v); // my own preview stays muted
  playAt(v, streamMix.volume, streamMix.muted);
}
// Listening sliders: 50 is the sound as it arrives (level 1), 100 doubles it. Levels are what is
// saved, so a volume chosen before the scale changed still sounds the same.
const LISTEN_SCALE = 50;
function wireRange(id, value, onValue, scale = 100) {
  const input = $(id);
  const out = input.nextElementSibling;
  input.value = out.textContent = Math.round(value * scale);
  input.addEventListener('input', () => {
    out.textContent = input.value;
    onValue(Number(input.value) / scale);
  });
}
const paintMute = (id, on) => {
  $(id).setAttribute('aria-pressed', String(on));
  $(id).classList.toggle('off', on);
  setIcon($(id), on ? 'mute' : 'volume');
};
function wireMute(id, get, set) {
  paintMute(id, get());
  $(id).addEventListener('click', () => {
    const on = !get();
    set(on);
    paintMute(id, on);
  });
}
const voiceLevel = () => (audioPrefs.voiceMuted ? 0 : audioPrefs.voice);
wireRange('mx-stream', audioPrefs.stream, (v) => { streamMix.volume = v; applyStreamMix(); saveAudio({ stream: v }); }, LISTEN_SCALE);
wireRange('mx-voice', audioPrefs.voice, (v) => { saveAudio({ voice: v }); voice.setMaster(voiceLevel()); }, LISTEN_SCALE);
wireRange('mic-gain', audioPrefs.gain, (v) => { voice.setGain(v); saveAudio({ gain: v }); });
wireMute('mx-stream-mute', () => streamMix.muted, (on) => { streamMix.muted = on; applyStreamMix(); saveAudio({ streamMuted: on }); });
wireMute('mx-voice-mute', () => audioPrefs.voiceMuted, (on) => { saveAudio({ voiceMuted: on }); voice.setMaster(voiceLevel()); });
Object.assign(voice.opts, { noiseSuppression: audioPrefs.ns, echoCancellation: audioPrefs.ec, deviceId: audioPrefs.in, gain: audioPrefs.gain });
voice.setMaster(voiceLevel());
voice.setPtt(audioPrefs.ptt);
voice.sinkId = audioPrefs.out;
if (audioPrefs.out) $('video').setSinkId?.(audioPrefs.out).catch(() => {});
setSwitch($('opt-ns'), audioPrefs.ns);
setSwitch($('opt-ec'), audioPrefs.ec);
setSwitch($('opt-ptt'), audioPrefs.ptt);
wireSwitch($('opt-ns'), (on) => { voice.reconfigure({ noiseSuppression: on }); saveAudio({ ns: on }); });
wireSwitch($('opt-ec'), (on) => { voice.reconfigure({ echoCancellation: on }); saveAudio({ ec: on }); });
wireSwitch($('opt-ptt'), (on) => { voice.setPtt(on); saveAudio({ ptt: on }); });
const typing = (e) => e.target.closest?.('input, textarea, select, [contenteditable]');
addEventListener('keydown', (e) => e.code === 'KeyV' && !e.repeat && !typing(e) && voice.setPttDown(true));
addEventListener('keyup', (e) => e.code === 'KeyV' && voice.setPttDown(false));
addEventListener('blur', () => voice.setPttDown(false));

async function fillDevices() {
  const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
  const fill = (sel, kind, empty) => {
    const list = devices.filter((d) => d.kind === kind);
    sel.replaceChildren(h('option', { value: '', text: 'Padrão do sistema' }),
      ...list.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => h('option', { value: d.deviceId, text: d.label || `${empty} ${i + 1}` })));
  };
  fill($('dev-in'), 'audioinput', 'Microfone');
  fill($('dev-out'), 'audiooutput', 'Saída');
  $('dev-in').value = voice.opts.deviceId;
  $('dev-out').value = voice.sinkId;
  $('dev-out').disabled = !('setSinkId' in HTMLMediaElement.prototype);
}
$('dev-in').addEventListener('change', () => { voice.reconfigure({ deviceId: $('dev-in').value }); saveAudio({ in: $('dev-in').value }); });
$('dev-out').addEventListener('change', async () => {
  saveAudio({ out: $('dev-out').value });
  await voice.setSink($('dev-out').value);
  await $('video').setSinkId?.($('dev-out').value).catch(() => {});
});

// One person's voice volume, only for me: in the mixer and under their name in the people list.
function personVolume(m, id) {
  const vol = Math.round((voice.volumes.get(m.id) ?? 1) * LISTEN_SCALE);
  return [
    h('input', {
      type: 'range', min: 0, max: 100, value: vol, id, 'aria-label': `Volume de ${m.name} só para mim`,
      oninput: (e) => { e.target.nextElementSibling.textContent = e.target.value; voice.setVolume(m.id, e.target.value / LISTEN_SCALE); },
    }),
    h('output', { for: id, text: String(vol) }),
  ];
}

function renderAudio() {
  const s = st.session;
  if (!s) return;
  $('mx-people').replaceChildren(...s.members.filter((m) => m.id !== st.me).map((m) => {
    const muted = voice.localMute.has(m.id);
    const id = `vol-${m.id}`;
    return h('div', { class: 'mix-row' },
      h('label', { class: 'name', for: id, text: m.name }),
      ...personVolume(m, id),
      h('button', {
        class: `btn icon${muted ? ' off' : ''}`, type: 'button', 'aria-pressed': String(muted), 'aria-label': `Silenciar ${m.name} só para mim`,
        onclick: () => { voice.setLocalMute(m.id, !muted); renderAudio(); },
      }, icon(muted ? 'mute' : 'volume')));
  }));
  if (!$('mx-people').children.length) $('mx-people').append(h('p', { class: 'small muted', text: 'Quando alguém entrar, o volume de cada pessoa aparece aqui.' }));

  const a = me();
  const cs = sessionForCan();
  $('rules').hidden = !CAN.lock(cs, a);
  for (const key of ['locked', 'autoApprove', 'presenterCanPass']) {
    const sw = $(`rule-${key}`);
    setSwitch(sw, s.settings[key]);
    sw.disabled = key === 'locked' ? !CAN.lock(cs, a) : !CAN.settings(cs, a);
  }
  $('end-all').hidden = !CAN.end(cs, a);
  renderMatrix();
}
for (const key of ['locked', 'autoApprove', 'presenterCanPass']) {
  $(`rule-${key}`).addEventListener('click', () => send({ type: 'settings', patch: { [key]: !st.session.settings[key] } }));
}
$('end-all').addEventListener('click', () => confirm('Encerrar a sessão para todos? O código deixa de funcionar (410).') && send({ type: 'end' }));

// The matrix is computed from CAN itself, so the table can never drift from what the server enforces.
function renderMatrix() {
  const actor = (role, id) => ({ id, role });
  const target = actor('member', 't');
  const cols = [['Dono', actor('owner', 'o')], ['Moderador', actor('mod', 'm')], ['Transmitindo', actor('member', 'p')], ['Participante', actor('member', 'x')]];
  const fake = { presenterId: 'p', settings: st.session.settings };
  const presenting = { ...fake, presenterId: 't' };
  const rows = [
    ['Passar a vez / aprovar pedido', (a) => CAN.passTurn(fake, a)],
    ['Tirar alguém da transmissão', (a) => CAN.stopStream(presenting, a, target)],
    ['Silenciar para todos', (a) => CAN.muteForAll(fake, a, target)],
    ['Remover da sessão', (a) => CAN.kick(fake, a, target)],
    ['Trancar a sessão', (a) => CAN.lock(fake, a)],
    ['Bloquear (403)', (a) => CAN.ban(fake, a, target)],
    ['Nomear moderadores', (a) => CAN.promote(fake, a, target)],
    ['Passar a coroa', (a) => CAN.transferOwner(fake, a, target)],
    ['Mudar regras', (a) => CAN.settings(fake, a)],
    ['Encerrar para todos', (a) => CAN.end(fake, a)],
  ];
  $('matrix').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Ação' }), ...cols.map(([n]) => h('th', { scope: 'col', text: n })))),
    h('tbody', {}, ...rows.map(([label, fn]) => h('tr', {}, h('th', { scope: 'row', text: label, style: 'font-weight: 400' }),
      ...cols.map(([, a]) => (fn(a) ? h('td', { class: 'yes' }, icon('check', 'i sm'), h('span', { class: 'sr-only', text: 'sim' })) : h('td', { class: 'no', text: '—' })))))));
}

// ── T11 · Configurações ──
const LATENCY_FIXED = [[80, 'menor atraso, pede rede boa (cabo ou Wi-Fi perto)'], [150, 'equilibrado'], [300, 'rede ruim ou celular']];
$('f-settings').addEventListener('click', () => {
  const caps = window.RTCRtpSender?.getCapabilities?.('video')?.codecs ?? [];
  const names = [...new Set(caps.map((c) => c.mimeType.split('/')[1].toLowerCase()).filter((c) => ['vp8', 'vp9', 'h264', 'av1', 'h265'].includes(c)))];
  // Automatic says what it lands on: the codec on air now, or the browser's first choice.
  const live = window.__stats?.codec?.toUpperCase();
  const auto = live ? `Automático (agora: ${live})` : names.length ? `Automático (normalmente ${names[0].toUpperCase()})` : 'Automático';
  $('set-codec').replaceChildren(h('option', { value: '', text: auto }), ...names.map((n) => h('option', { value: n, text: n.toUpperCase() })));
  $('set-codec').value = names.includes(st.settings.codec) ? st.settings.codec : '';
  $('set-codec-hint').textContent = 'Vale para a próxima transmissão ou retransmissão. H.264 costuma usar a placa de vídeo; AV1 e VP9 dão mais qualidade por Mbps, com mais CPU.';
  const enc = window.__stats?.encoder;
  $('set-encoder').textContent = enc
    ? `Codificando agora com ${enc.name}, ${enc.hw ? 'na placa de vídeo' : 'no processador (CPU)'}.`
    : 'Ao transmitir, aqui aparece se o vídeo é codificado na placa de vídeo ou no processador.';
  const lat = st.latency;
  const opts = [['auto', lat ? `Automático (agora: ${lat.recommendedMs} ms)` : 'Automático (recomendado)'], ...LATENCY_FIXED.map(([ms, text]) => [String(ms), `${ms} ms: ${text}`])];
  $('set-latency').replaceChildren(...opts.map(([value, text]) => h('option', { value, text })));
  $('set-latency').value = String(st.settings.latency);
  $('set-latency-now').textContent = !lat
    ? 'Durante uma transmissão, aqui aparece o atraso recomendado para a rede de quem está assistindo.'
    : lat.auto
      ? `Esta transmissão está no automático: ${lat.targetMs} ms, o menor que a rede de todo mundo aguenta agora.`
      : `Esta transmissão está fixa em ${lat.targetMs} ms. Pela rede de quem assiste, o recomendado agora é ${lat.recommendedMs} ms.`;
  $('set-upload').value = st.upload;
  const yes = (ok, text) => h('li', { text: `${ok ? '✓' : '✗'} ${text}` });
  $('set-support').replaceChildren(
    yes(canCapture(), 'Transmitir a tela (getDisplayMedia)'),
    yes(window.isSecureContext, 'Contexto seguro (HTTPS ou localhost)'),
    yes('jitterBufferTarget' in (window.RTCRtpReceiver?.prototype ?? {}), 'Atraso igual para todos (jitterBufferTarget)'),
    yes('setSinkId' in HTMLMediaElement.prototype, 'Escolher a saída de áudio'),
    yes('setCodecPreferences' in (window.RTCRtpTransceiver?.prototype ?? {}), 'Escolher o codec'),
  );
  $('set-app').hidden = !tauri?.updater;
  if (tauri?.updater) tauri.app?.getVersion?.().then((v) => { $('set-app-version').textContent = `Você está na versão ${v} do app.`; }).catch(() => {});
  $('set-app-status').textContent = '';
  $('dlg-settings').showModal();
});
$('set-app-check').addEventListener('click', async () => {
  $('set-app-check').disabled = true;
  $('set-app-status').textContent = 'Procurando…';
  const r = await checkAppUpdate();
  $('set-app-check').disabled = false;
  $('set-app-status').textContent = r.state === 'current' ? 'Esta é a versão mais recente.'
    : r.state === 'available' ? `Versão ${r.version} disponível: clique em Atualizar no aviso do topo.`
      : `Não deu para procurar agora: ${r.reason ?? 'o app não tem atualização automática'}.`;
});
closeOnX($('dlg-settings'));
$('set-save').addEventListener('click', () => {
  st.settings.codec = $('set-codec').value;
  st.settings.latency = $('set-latency').value === 'auto' ? 'auto' : Number($('set-latency').value);
  store.set('latency', st.settings.latency);
  if (st.session?.presenterId === st.me) send({ type: 'setLatency', latency: st.settings.latency }); // live: applies now
  st.upload = Number($('set-upload').value) || st.upload;
  store.set('codec', st.settings.codec);
  store.set('upload', st.upload);
  $('dlg-settings').close();
  notify('Configurações salvas neste navegador.', 'ok');
});

// ── stats ──
window.__stats = null; // read by e2e
let last = { bytes: 0, at: 0, lost: 0, received: 0, jbMin: 0, jbCount: 0 };
// Buffer this viewer's network needs: the jitter buffer's own minimum over the last 2 s,
// or 3× the RTP jitter where that stat is missing. The server gets the worst of the last 30 s,
// so the shared latency rises at once and only comes down after a calm half minute.
const NEED_WINDOW = 15;
const needs = [];
function measureNeed(s) {
  const dCount = s.jbCount - last.jbCount, dMin = s.jbMin - last.jbMin;
  const ms = dCount > 0 && dMin >= 0 && s.jbMin > 0 ? (1000 * dMin) / dCount : s.rtpJitter > 0 ? 3000 * s.rtpJitter : null;
  if (ms === null) return null;
  needs.push(ms);
  if (needs.length > NEED_WINDOW) needs.shift();
  return Math.round(Math.max(...needs));
}
const SRC_STALE_MS = 6000; // three missed reports: the origin column goes blank
const LIMITS = { none: 'nenhum', cpu: 'CPU', bandwidth: 'rede', other: 'outro' };
const rate = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`);

// Viewer's table: what leaves the presenter (sent by them every 2 s) next to what arrives here.
// The presenter sees only the origin column, from their own encoder.
function renderMetrics(s, kbps, lossPct) {
  const mine = !s.viewer;
  const src = mine ? { ...s, kbps: Math.round(kbps / Math.max(1, s.children)) }
    : st.origin && performance.now() - st.origin.at < SRC_STALE_MS ? st.origin : null;
  const dash = '—';
  const rows = [
    ['Resolução', src ? `${src.w}×${src.h}` : dash, `${s.w}×${s.h}`, src && s.w < src.w],
    ['Captura', src?.capture.w ? `${src.capture.w}×${src.capture.h} · ${src.capture.fps} fps` : dash, ''],
    ['FPS', src ? String(src.fps) : dash, String(s.fps), src && s.fps < src.fps - 5],
    ['Bitrate', src ? rate(src.kbps) : dash, rate(kbps), src && kbps < src.kbps * 0.7],
    ['Codec', src?.codec || dash, s.codec || dash],
    ['Limitado por', src ? LIMITS[src.limit] ?? src.limit : dash, ''],
    ['Perda', '', `${lossPct.toFixed(1)}%`, lossPct >= 2],
    ['Congelamentos', '', String(s.freezes), s.freezes > 0],
    ['Atraso', '', s.rttMs === null ? `buffer ${video.jitterMs} ms` : `${Math.round(s.rttMs / 2)} ms rede + ${video.jitterMs} ms buffer`],
  ];
  $('metrics-here').hidden = mine;
  $('metrics-body').replaceChildren(...rows.filter(([, from]) => !mine || from).map(([name, from, here, worse]) => h('tr', {},
    h('th', { scope: 'row', text: name }), h('td', { text: from }), mine ? null : h('td', { class: worse ? 'worse' : '', text: here }))));
  const relayed = st.session?.presenterId && video.parentId && video.parentId !== st.session.presenterId;
  const note = mine ? `Saindo para ${s.children} pessoa(s) direto.` : !src ? 'Esperando os números de quem transmite…' : relayed ? 'Chega por outra pessoa (retransmissor), que codifica o vídeo de novo.' : '';
  $('metrics-note').textContent = note;
  $('metrics-note').hidden = !note;
}
function showMetrics(on) {
  $('metrics').hidden = !on;
  $('m-toggle').setAttribute('aria-pressed', String(on));
  store.set('metricsShown', on);
}
$('m-toggle').addEventListener('click', () => showMetrics($('metrics').hidden));
setInterval(async () => {
  const s = await video.stats();
  if (!s) {
    $('s-stats').textContent = '';
    $('m-toggle').hidden = $('metrics').hidden = true;
    st.origin = null;
    window.__stats = null;
    reportStatus(); // also the heartbeat: --status calls the app closed after 10 s of silence
    return;
  }
  const now = performance.now();
  const kbps = last.at ? Math.max(0, Math.round(((s.bytes - last.bytes) * 8) / (now - last.at))) : 0;
  const lossPct = (s.lost - last.lost) > 0 ? (100 * (s.lost - last.lost)) / Math.max(1, s.lost - last.lost + s.received - last.received) : 0;
  const needMs = s.viewer ? measureNeed(s) : null;
  last = { bytes: s.bytes, at: now, lost: s.lost, received: s.received, jbMin: s.jbMin, jbCount: s.jbCount };
  if (!s.viewer && s.children) send({ type: 'srcStats', capture: s.capture, w: s.w, h: s.h, fps: s.fps, kbps: Math.round(kbps / s.children), codec: s.codec, limit: s.limit });
  $('m-toggle').hidden = false;
  if ($('m-toggle').getAttribute('aria-pressed') !== String(store.get('metricsShown', false))) showMetrics(store.get('metricsShown', false));
  if (!$('metrics').hidden) renderMetrics(s, kbps, lossPct);
  if (s.rttMs !== null) send({ type: 'hopRtt', ms: Math.round(s.rttMs), ...(needMs !== null && { needMs }) }); // server turns it into buffers
  window.__stats = { kbps, fps: s.fps, w: s.w, h: s.h, codec: s.codec, encoder: s.encoder, jitterMs: video.jitterMs, rttMs: s.rttMs, needMs, parent: video.parentId };
  reportStatus();
  const route = s.viewer ? `buffer ${video.jitterMs} ms` : `${s.children} direto(s)`;
  $('s-stats').textContent = `${s.w}×${s.h} · ${s.fps} fps · ${kbps} kbps${s.codec ? ` · ${s.codec}` : ''} · ${route}`;
  if (s.w && !$('ov-connecting').hidden) renderStage();
  applyStreamMix();
}, 2000);

// ── T07 · PWA: install banner ──
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
let installEvent = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  if (!store.get('installDismissed', false)) $('banner-install').hidden = false;
});
if (isIos && !standalone && !store.get('installDismissed', false)) {
  $('banner-install').hidden = false;
  $('install-hint').textContent = 'No iPhone: toque em Compartilhar › Adicionar à Tela de Início.';
  $('install-go').hidden = true;
}
$('install-go').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  $('banner-install').hidden = true;
});
$('install-x').addEventListener('click', () => {
  $('banner-install').hidden = true;
  store.set('installDismissed', true);
});
addEventListener('appinstalled', () => { $('banner-install').hidden = true; });

// ── T14 · Atualização (PWA via service worker; app via tauri-plugin-updater) ──
let applyUpdate = null;
function offerUpdate(text, run, label = 'Recarregar') {
  $('update-text').textContent = text;
  $('update-go').textContent = label;
  $('update-go').disabled = false;
  applyUpdate = run;
  $('banner-update').hidden = false;
}
$('update-go').addEventListener('click', () => applyUpdate?.());
$('update-x').addEventListener('click', () => { $('banner-update').hidden = true; });
if ('serviceWorker' in navigator && !tauri) {
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    const watch = (w) => w?.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) {
        offerUpdate('Nova versão do Stream P2P disponível.', () => w.postMessage('skipWaiting'));
      }
    });
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate('Nova versão do Stream P2P disponível.', () => reg.waiting.postMessage('skipWaiting'));
    reg.addEventListener('updatefound', () => watch(reg.installing));
    setInterval(() => reg.update().catch(() => {}), 30 * 60_000);
  }).catch((e) => log(`sw: ${e.message}`));
  let reloading = false;
  // First visit: clients.claim() also fires controllerchange, but this page is already current.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading || st.session) return; // never reload in the middle of a session
    reloading = true;
    location.reload();
  });
}
// The app looks for a new release on start and every 30 min; one click downloads, installs
// (signed: the updater rejects anything not signed with our key) and reopens.
const APP_UPDATE_EVERY_MS = 30 * 60_000;
let appUpdate = null; // the release on offer, so the 30-min check doesn't offer it twice
async function checkAppUpdate() {
  const updater = tauri?.updater;
  if (!updater?.check) return { state: 'unsupported' };
  let upd;
  try {
    upd = await updater.check();
  } catch (e) {
    log(`updater check: ${e}`);
    return { state: 'error', reason: String(e) };
  }
  if (!upd) return { state: 'current' };
  if (appUpdate?.version !== upd.version) {
    appUpdate = upd;
    offerUpdate(`Versão ${upd.version} do app disponível.`, () => installAppUpdate(upd), 'Atualizar');
  }
  return { state: 'available', version: upd.version };
}
async function installAppUpdate(upd) {
  if (st.session && !confirm('Atualizar agora tira você da sessão por alguns segundos. O app reabre sozinho. Continuar?')) return;
  $('update-go').disabled = true;
  let total = 0, got = 0;
  try {
    await upd.downloadAndInstall((e) => {
      if (e.event === 'Started') total = e.data.contentLength ?? 0;
      if (e.event === 'Progress') got += e.data.chunkLength;
      $('update-text').textContent = e.event === 'Finished' ? 'Instalando…' : total ? `Baixando ${Math.round((100 * got) / total)}%…` : 'Baixando…';
    });
    await tauri.process?.relaunch();
  } catch (e) {
    log(`updater install: ${e}`);
    offerUpdate(`Versão ${upd.version} do app disponível.`, () => installAppUpdate(upd), 'Tentar de novo');
    showError(null, `A atualização não terminou: ${e}. O app continua na versão atual.`, { title: 'Atualização falhou' });
  }
}
if (tauri?.updater) setInterval(checkAppUpdate, APP_UPDATE_EVERY_MS);

// ── T12 · Seletor de fonte nativo (app) ──
async function loadNativeSources() {
  if (!tauri?.core?.invoke) return;
  try {
    st.nativeSources = await tauri.core.invoke('list_sources');
    renderSetup();
  } catch (e) {
    log(`list_sources: ${e}`);
  }
}

// ── T13 · Bandeja do sistema (app) ──
function tray(cmd, args) {
  tauri?.core?.invoke(cmd, args).catch(() => {});
}
// Tray menu and the command line (--stop-stream, --mute, --copy-invite, --leave) land here.
tauri?.event?.listen('tray', ({ payload }) => {
  if (!st.session) return;
  if (payload === 'stop' && st.session.presenterId === st.me) send({ type: 'stopStream' });
  if (payload === 'mute') $('f-mic').click();
  if (payload === 'copy') copyInvite();
  if (payload === 'leave') leaveSession();
});

// ── App · estado para `stream-p2p --status` ──
let lastError = null;
addEventListener('sp2p:error', ({ detail }) => { lastError = { ...detail, at: new Date().toISOString() }; });
function reportStatus() {
  if (!tauri?.core?.invoke) return;
  const s = st.session;
  const presenter = s?.presenterId ? member(s.presenterId) : null;
  const status = {
    screen: document.body.dataset.view ?? null,
    connected: ws?.readyState === 1,
    session: s ? {
      code: s.code,
      me: myName(),
      role: me()?.role ?? null,
      members: s.members.map((m) => m.name),
      presenter: presenter?.name ?? null,
      presenting: s.presenterId === st.me,
    } : null,
    mic: voice.micOn,
    stats: window.__stats,
    lastError,
  };
  tauri.core.invoke('set_status', { status }).catch((e) => log(`set_status: ${e}`));
}

// ── boot ──
// The app's command line opens ?create=1&name= or ?code=&name=&auto=1 (see app/src-tauri/src/cli.rs).
let autoStart = null;
const code = params.get('code') ?? params.get('room');
if (params.get('create') === '1' && params.get('name')) {
  screen('home');
  $('create-name').value = params.get('name');
  st.auto = true;
  autoStart = () => $('create-form').requestSubmit();
} else if (code) {
  openJoin(code, params.get('name') ?? undefined);
  if (params.get('auto') === '1' && params.get('name')) {
    st.auto = true;
    autoStart = () => $('join-form').requestSubmit();
  }
} else screen('home');
$('conn').hidden = false;
connect();
checkAppUpdate();
