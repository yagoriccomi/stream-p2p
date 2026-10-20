// Small DOM helpers + the T05 error card. Every error carries an HTTP code and a "why".
export const $ = (id) => document.getElementById(id);

export const icon = (name, cls = 'i') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

export function setIcon(button, name) {
  button.querySelector('use')?.setAttribute('href', `#i-${name}`);
}

export const TITLES = {
  400: 'Dado inválido',
  401: 'Não autorizado',
  403: 'Sem permissão',
  404: 'Não encontrado',
  409: 'Conflito',
  410: 'Sessão encerrada',
  423: 'Sessão trancada',
  429: 'Devagar',
  503: 'Sem vaga',
};

const toasts = () => $('toasts');

// kind: 'error' | 'info' | 'ok'. actions: [{ label, run, primary }]
export function showError(code, reason, { title, actions = [], kind = 'error', timeout = 9000 } = {}) {
  const card = h('div', { class: `err${kind === 'error' ? '' : ` ${kind}`}`, role: kind === 'error' ? 'alert' : 'status' },
    h('div', { class: 't' },
      icon(kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert', 'i sm'),
      code ? h('span', { class: 'chip-code', text: String(code) }) : null,
      h('span', { text: title ?? TITLES[code] ?? 'Aviso' })),
    reason ? h('p', { class: 'why' }, kind === 'error' ? h('b', { text: 'Por quê: ' }) : null, reason) : null,
    h('div', { class: 'acts' },
      ...actions.map((a) => h('button', { class: `btn${a.primary ? ' primary' : ''}`, type: 'button', text: a.label, onclick: () => { card.remove(); a.run(); } })),
      h('button', { class: 'btn ghost', type: 'button', text: 'Fechar', onclick: () => card.remove() })));
  if (kind === 'error') dispatchEvent(new CustomEvent('sp2p:error', { detail: { code, title: title ?? TITLES[code] ?? null, reason } }));
  toasts().prepend(card);
  while (toasts().children.length > 4) toasts().lastElementChild.remove();
  if (timeout) setTimeout(() => card.remove(), timeout);
  return card;
}

export const notify = (text, kind = 'info') => showError(null, null, { title: text, kind, timeout: 4000 });

// Inline field error (aria-invalid + aria-describedby already wired in the HTML).
export function fieldError(inputId, errId, code, reason) {
  const input = $(inputId);
  const box = $(errId);
  if (!reason) {
    input.removeAttribute('aria-invalid');
    box.hidden = true;
    box.textContent = '';
    return;
  }
  input.setAttribute('aria-invalid', 'true');
  box.replaceChildren(h('span', { class: 'chip-code', text: String(code) }), h('span', { text: reason }));
  box.hidden = false;
  input.focus();
  dispatchEvent(new CustomEvent('sp2p:error', { detail: { code, title: null, reason, field: inputId } }));
}

// Password-style reveal for the session code.
export function wireEye(button, input) {
  button.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', show ? 'Ocultar código' : 'Mostrar código');
    setIcon(button, show ? 'hide-code' : 'watching');
  });
}

export function wireSwitch(button, onChange) {
  button.addEventListener('click', () => {
    const on = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', String(on));
    onChange(on);
  });
}

export const setSwitch = (button, on) => button.setAttribute('aria-checked', String(Boolean(on)));

export function screen(name) {
  for (const el of document.querySelectorAll('[data-screen]')) el.hidden = el.dataset.screen !== name;
  document.body.dataset.view = name;
}

export function closeOnX(dialog) {
  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === dialog) dialog.close();
  });
}

// Floating menu anchored to a button; Esc or outside click closes it.
let menuOwner = null;
export function openMenu(anchor, items) {
  const menu = $('menu');
  if (menuOwner === anchor && !menu.hidden) return closeMenu();
  menu.replaceChildren(...items.map((it) => h('button', { type: 'button', role: 'menuitem', class: it.red ? 'red' : '', onclick: () => { closeMenu(); it.run(); } }, icon(it.icon, 'i sm'), it.label)));
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, hgt = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
  menu.style.top = `${r.bottom + hgt + 8 > innerHeight ? Math.max(8, r.top - hgt - 4) : r.bottom + 4}px`;
  menuOwner = anchor;
  menu.querySelector('button')?.focus();
}
export function closeMenu() {
  $('menu').hidden = true;
  menuOwner?.focus?.();
  menuOwner = null;
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('menu').hidden && closeMenu());
document.addEventListener('pointerdown', (e) => {
  if (!$('menu').hidden && !e.target.closest('#menu') && e.target.closest('button') !== menuOwner) closeMenu();
});

export const initials = (name) => [...name.trim()][0]?.toUpperCase() ?? '?';
export const time = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`sp2p.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`sp2p.${key}`, JSON.stringify(value));
    } catch {}
  },
};
