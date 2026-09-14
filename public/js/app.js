import { api, generate } from './api.js';
import * as ui from './ui.js';
import { enhanceSelects } from './select.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  characters: [],
  personas: [],
  chats: [],
  chat: null,
  abort: null,
  editingCharacterId: null,
  hideAdult: localStorage.getItem('hideAdult') === '1',
  mode: localStorage.getItem('mode') === 'assistant' ? 'assistant' : 'rp'
};

const characterOf = (chat) => chat?.character || state.characters.find((c) => c.id === chat?.characterId);
const personaOf = (chat) =>
  state.personas.find((p) => p.id === chat?.personaId) ||
  state.personas.find((p) => p.id === state.settings?.activePersonaId);

/* ---------------- 부팅 ---------------- */

async function boot() {
  [state.settings, state.characters, state.personas, state.chats] = await Promise.all([
    api.settings(), api.characters(), api.personas(), api.chats()
  ]);
  applyDev(state.settings.dev);
  ui.renderCharacterList(state.characters);
  paintMode();
  paintAdultToggle();
  ui.renderChatList(visibleChats(), null, state.characters, { hideAdult: state.hideAdult, mode: state.mode });
  paintModelBadge();
  const last = localStorage.getItem('lastChat');
  const candidates = visibleChats();
  if (last && candidates.some((c) => c.id === last)) await openChat(last);
  else if (candidates.length) await openChat(candidates[0].id);
  else closeChat();
}

/** 개발자 설정(테마·표기법)을 화면에 적용합니다. */
function applyDev(dev) {
  if (!dev) return;
  ui.setMarkup(dev.markup || {});
  const t = dev.theme || {};
  const root = document.documentElement.style;
  const map = {
    '--bg': t.bg, '--panel': t.panel, '--line': t.line,
    '--text': t.text, '--muted': t.muted, '--brass': t.accent,
    '--sans': t.fontSans, '--serif': t.fontSerif
  };
  for (const [k, v] of Object.entries(map)) if (v) root.setProperty(k, v);
  if (t.fontSize) root.setProperty('--font-size', `${t.fontSize}px`);
  if (t.panel) root.setProperty('--panel-2', shade(t.panel, 8));
  if (t.accent) {
    root.setProperty('--brass-soft', shade(t.accent, -32));
    root.setProperty('--scroll-thumb-hover', shade(t.accent, -48));
  }
  if (t.line) root.setProperty('--scroll-thumb', shade(t.line, 14));
  paintFavicon(t);
}

/**
 * 파비콘을 테마 색으로 다시 그립니다. 파일 없이 SVG 를 그대로 심기 때문에
 * 오프라인에서도 뜨고, 강조색을 바꾸면 탭 아이콘도 따라 바뀝니다.
 */
function paintFavicon({ bg = '#15111a', accent = '#d9b168' } = {}) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    `<rect width="32" height="32" rx="7" fill="${bg}"/>` +
    '<path d="M7 5.5h18a4.5 4.5 0 0 1 4.5 4.5v8a4.5 4.5 0 0 1-4.5 4.5H14.5L8 28v-5.5H7A4.5 4.5 0 0 1 2.5 18v-8A4.5 4.5 0 0 1 7 5.5z"' +
    ` fill="${accent}"/>` +
    `<circle cx="10" cy="14" r="2.1" fill="${bg}"/>` +
    `<circle cx="16" cy="14" r="2.1" fill="${bg}"/>` +
    `<circle cx="22" cy="14" r="2.1" fill="${bg}"/>` +
    '</svg>';
  $('favicon').href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}


/** 패널·강조색에서 보조 색을 만들어 냅니다. */
function shade(hex, delta) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => Math.max(0, Math.min(255, v + delta)).toString(16).padStart(2, '0'));
  return `#${parts.join('')}`;
}

/** 로컬 주소인지. 성인 틀 대화에서 고를 수 있는 엔진을 가릅니다. (서버 판정과 같은 규칙) */
const isLocalUrl = (url = '') =>
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url);

function paintModelBadge() {
  const s = state.settings;
  const cfg = s.providers[s.activeProvider];
  const btn = $('active-model');
  btn.textContent = cfg.model || '모델 미설정';
  btn.classList.toggle('is-empty', !cfg.model);
  btn.title = cfg.model ? `${cfg.label} · ${cfg.model} — 누르면 설정이 열립니다` : '설정에서 모델을 선택해 주세요';
  paintQuickProvider();
}

/** 입력창 아래의 엔진 선택기. 지금 대화가 성인 모드가면 외부 엔진은 고를 수 없습니다. */
function paintQuickProvider() {
  const sel = $('quick-provider');
  const s = state.settings;
  const entry = state.chats.find((c) => c.id === state.chat?.id);
  const adultChat = Boolean(entry?.adult);

  sel.innerHTML = Object.entries(s.providers)
    .map(([key, cfg]) => {
      const blocked = adultChat && !isLocalUrl(cfg.baseUrl);
      return `<option value="${key}"${blocked ? ' disabled' : ''}>${cfg.label}${blocked ? ' (성인 틀 불가)' : ''}</option>`;
    })
    .join('');
  sel.value = s.activeProvider;
  paintWebSearch();
  paintThinking();
}

/** 어시스턴트 모드에서만 보이는 웹 검색 토글. 엔진이 못 하면 잠깁니다. */
function paintWebSearch() {
  const btn = $('btn-websearch');
  const assistant = state.chat?.kind === 'assistant';
  btn.hidden = !assistant;
  if (!assistant) return;

  const s = state.settings;
  const capable = s.webSearchCapable?.[s.activeProvider];
  const on = Boolean(s.assistant?.webSearch) && capable;

  btn.disabled = !capable;
  btn.setAttribute('aria-pressed', String(on));
  btn.title = capable
    ? (on ? '웹 검색이 켜져 있습니다. 답변 끝에 출처가 붙습니다.' : '최신 정보가 필요할 때 켜 주세요.')
    : `웹 검색을 지원하지 않는 엔진입니다 (${s.providers[s.activeProvider]?.label}).`;
}

/** 어시스턴트 모드의 생각 토글. */
function paintThinking() {
  const btn = $('btn-thinking');
  const assistant = state.chat?.kind === 'assistant';
  btn.hidden = !assistant;
  if (!assistant) return;

  const on = Boolean(state.settings.assistant?.thinking);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on
    ? '답변 전에 생각합니다. 과정은 접힌 채로 보여 줍니다. 사고 토큰도 요금에 포함됩니다.'
    : '복잡한 질문에서 정확도가 올라갑니다. 대신 느리고 토큰을 더 씁니다. 일부 모델은 완전히 끄지 못하고 최소화만 됩니다.';
}

$('btn-thinking').addEventListener('click', async () => {
  const next = $('btn-thinking').getAttribute('aria-pressed') !== 'true';
  state.settings = await api.saveSettings({ assistant: { thinking: next } });
  paintThinking();
  ui.toast(next ? '생각을 켰습니다' : '생각을 껐습니다');
});

$('btn-websearch').addEventListener('click', async () => {
  const next = $('btn-websearch').getAttribute('aria-pressed') !== 'true';
  state.settings = await api.saveSettings({ assistant: { webSearch: next } });
  paintWebSearch();
  ui.toast(next ? '웹 검색을 켰습니다' : '웹 검색을 껐습니다');
});

$('quick-provider').addEventListener('change', async (e) => {
  const before = state.settings.activeProvider;
  try {
    state.settings = await api.saveSettings({ activeProvider: e.target.value });
    paintModelBadge();
    const cfg = state.settings.providers[state.settings.activeProvider];
    ui.toast(cfg.model ? `엔진을 바꿨습니다 — ${cfg.label}` : `모델을 먼저 선택해 주세요 — ${cfg.label}`);
  } catch (err) {
    e.target.value = before;
    ui.toast(`바꾸지 못했습니다 — ${err.message}`);
  }
});

$('active-model').addEventListener('click', () => $('btn-settings').click());

async function refreshChatList() {
  state.chats = await api.chats();
  ui.renderChatList(visibleChats(), state.chat?.id, state.characters, { hideAdult: state.hideAdult, mode: state.mode });
}

function paintMode() {
  const rp = state.mode === 'rp';
  for (const tab of document.querySelectorAll('.mode-tab')) {
    tab.classList.toggle('is-on', tab.dataset.mode === state.mode);
  }
  $('character-group').hidden = !rp;
  $('btn-new-chat').hidden = !rp;
  $('btn-toggle-adult').hidden = !rp;
  $('btn-new-assistant').hidden = rp;
}

function visibleChats() {
  return state.chats.filter((c) =>
    state.mode === 'assistant' ? c.kind === 'assistant' : c.kind !== 'assistant');
}

for (const tab of document.querySelectorAll('.mode-tab')) {
  tab.addEventListener('click', () => {
    state.mode = tab.dataset.mode;
    localStorage.setItem('mode', state.mode);
    paintMode();

    // 다른 모드의 대화가 열려 있었다면 닫습니다.
    const chatMode = state.chat?.kind === 'assistant' ? 'assistant' : 'rp';
    if (state.chat && chatMode !== state.mode) closeChat();

    ui.renderChatList(visibleChats(), state.chat?.id, state.characters, { hideAdult: state.hideAdult, mode: state.mode });
  });
}

/** 열린 대화를 닫고 빈 화면으로 되돌립니다. */
function closeChat() {
  state.abort?.abort();
  state.chat = null;
  localStorage.removeItem('lastChat');
  $('chat-title').textContent = state.mode === 'assistant' ? '어시스턴트' : '대화를 선택해 주세요';
  $('chat-sub').textContent = '';
  $('composer').hidden = true;
  $('btn-rename').hidden = true;
  $('btn-delete-chat').hidden = true;
  $('btn-save-character').hidden = true;
  $('chat-preset').hidden = true;
  $('btn-websearch').hidden = true;
  $('btn-thinking').hidden = true;
  setStreaming(false);
  ui.renderEmptyStage(state.mode);
}

$('btn-new-assistant').addEventListener('click', async () => {
  const chat = await api.createChat({ kind: 'assistant' });
  await refreshChatList();
  await openChat(chat.id);
});

function paintAdultToggle() {
  $('btn-toggle-adult').textContent = state.hideAdult ? '성인 표시' : '성인 숨김';
}

$('btn-toggle-adult').addEventListener('click', () => {
  state.hideAdult = !state.hideAdult;
  localStorage.setItem('hideAdult', state.hideAdult ? '1' : '0');
  paintAdultToggle();
  ui.renderChatList(visibleChats(), state.chat?.id, state.characters, { hideAdult: state.hideAdult, mode: state.mode });
});

/** 대화 상단의 틀 선택기를 현재 대화에 맞춰 그립니다. */
function paintChatPreset() {
  const sel = $('chat-preset');
  if (!state.chat) return;
  sel.innerHTML = state.settings.presets
    .map((p) => `<option value="${p.id}">${p.adult ? '🔒 ' : ''}${p.name}</option>`)
    .join('');
  const listed = state.chats.find((c) => c.id === state.chat.id);
  sel.value = state.chat.presetId || listed?.presetId || state.settings.activePresetId;
  sel.hidden = false;
}

$('chat-preset').addEventListener('change', async (e) => {
  if (!state.chat) return;
  const presetId = e.target.value;
  await api.updateChat(state.chat.id, { presetId });
  state.chat.presetId = presetId;
  const preset = state.settings.presets.find((p) => p.id === presetId);
  ui.toast(`대화 모드를 바꿨습니다 — ${preset.name}`);
  await refreshChatList();
  paintQuickProvider();
});

/* ---------------- 대화 ---------------- */

async function openChat(id) {
  state.chat = await api.chat(id);
  localStorage.setItem('lastChat', id);
  const assistant = state.chat.kind === 'assistant';
  const ch = characterOf(state.chat);
  $('chat-title').textContent = state.chat.title;
  $('chat-sub').textContent = assistant
    ? '어시스턴트 모드 — 캐릭터 없이 대화합니다'
    : [
        state.chat.character ? '1회성 캐릭터' : null,
        ch?.description,
        `내 페르소나 ${personaOf(state.chat)?.name || '미설정'}`
      ].filter(Boolean).join(' · ');
  $('composer').hidden = false;
  $('btn-rename').hidden = false;
  $('btn-delete-chat').hidden = false;
  $('btn-save-character').hidden = !state.chat.character;
  $('input').placeholder = assistant
    ? '무엇이든 물어보세요.'
    : '무엇을 하거나 말할지 적어보세요. 행동은 *별표* 로 감쌉니다.';
  if (assistant) $('chat-preset').hidden = true;
  else paintChatPreset();
  paintQuickProvider();
  paintWebSearch();
  paintThinking();
  ui.renderThread(state.chat, ch, personaOf(state.chat));
  ui.renderChatList(visibleChats(), id, state.characters, { hideAdult: state.hideAdult, mode: state.mode });
  closeSidebarOnNarrow();
}

/** 내장 모드는 설명을 미리 적어 두고, 직접 만든 모드는 내용 첫 줄을 보여 줍니다. */
const MODE_NOTES = {
  default: '짧은 호흡으로 주고받습니다. *별표* 로 행동, "따옴표" 로 대사.',
  novelist: '한 장면을 통째로 그립니다. 상황만 던져 주면 주변 인물까지 등장시켜 서로 대화하게 합니다.',
  adult: '성인 소재를 다룹니다. 표기와 호흡은 기본 롤플레이와 같습니다.',
  'adult-novel': '성인 소재를 다룹니다. 표기와 호흡은 소설 모드와 같아, 여러 인물이 함께 나옵니다.'
};

const modeNote = (preset) =>
  MODE_NOTES[preset.id] ||
  preset.template.split('\n').find((l) => l.trim())?.slice(0, 60) ||
  '내용이 비어 있습니다.';

const dlgNewChat = $('dlg-newchat');
// 목록의 캐릭터면 { id }, 이번만 쓰는 캐릭터면 { inline: {...} } 가 담깁니다.
let pendingCharacter = null;

async function startChatWith(target, presetId) {
  const chat = await api.createChat(
    target.inline
      ? { character: target.inline, presetId }
      : { characterId: target.id, presetId }
  );
  await refreshChatList();
  await openChat(chat.id);
}

/** 모드를 물어본 뒤 대화를 엽니다. 묻지 않기로 해 뒀으면 바로 시작합니다. */
function newRpChat(target) {
  const s = state.settings;
  if (!s.askModeOnNewChat || s.presets.length < 2) {
    return startChatWith(target, s.activePresetId);
  }

  pendingCharacter = target;
  const character = target.inline || state.characters.find((c) => c.id === target.id);
  $('nc-title').textContent = character ? `${character.name} — 어떤 모드로 시작할까요` : '어떤 모드로 시작할까요';
  paintCastCard(character);
  $('nc-remember').checked = false;
  $('nc-list').innerHTML = s.presets
    .map((p) => `<li><button type="button" class="mode-card${p.id === s.activePresetId ? ' is-last' : ''}" data-preset="${p.id}">
      <span class="m-name">
        ${p.name}
        ${p.adult ? '<span class="m-tag">19</span>' : ''}
        ${p.id === s.activePresetId ? '<span class="m-last">이전 사용</span>' : ''}
      </span>
      <span class="m-desc">${modeNote(p)}</span>
    </button></li>`)
    .join('');
  dlgNewChat.showModal();
}

/** 어떤 캐릭터인지 잊고 눌렀을 때를 대비해, 설정해 둔 특징을 함께 보여 줍니다. */
function paintCastCard(character) {
  const box = $('nc-character');
  if (!character) {
    box.innerHTML = '<p class="cast-empty">캐릭터 정보를 찾지 못했습니다.</p>';
    return;
  }

  const facts = [
    ['성격', character.personality],
    ['말투', character.speech],
    ['배경', character.scenario],
    ['설정', character.notes]
  ].filter(([, v]) => v && v.trim());

  const esc = (t = '') =>
    t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const me = state.personas.find((p) => p.id === state.settings.activePersonaId)?.name
    || state.personas[0]?.name || '나';
  const fill = (t = '') => esc(ui.fillNames(t, { char: character.name, user: me }));

  box.innerHTML = `
    <div class="cast-head">
      <span class="cast-avatar">${esc(character.avatar || '◦')}</span>
      <span class="grow">
        <span class="cast-name">
          ${esc(character.name)}
          ${character.tags ? `<span class="cast-tags">${esc(character.tags)}</span>` : ''}
        </span>
        ${character.description ? `<div class="cast-desc">${fill(character.description)}</div>` : ''}
      </span>
      <button type="button" class="ghost-btn" data-edit-character>수정</button>
    </div>
    ${facts.length ? `<dl class="cast-facts">${facts
      .map(([k, v]) => `<div class="cast-fact"><dt>${k}</dt><dd>${fill(v)}</dd></div>`)
      .join('')}</dl>` : ''}`;
}

// 정보를 보다가 고칠 게 보이면 바로 편집 창으로 넘어갑니다.
$('nc-character').addEventListener('click', (e) => {
  if (!e.target.closest('[data-edit-character]')) return;
  const character = pendingCharacter?.inline
    || state.characters.find((c) => c.id === pendingCharacter?.id);
  dlgNewChat.close('edit');
  openCharacterDialog(character);
});

$('nc-cancel').addEventListener('click', () => dlgNewChat.close('cancel'));

$('nc-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-preset]');
  if (!btn) return;
  const presetId = btn.dataset.preset;
  const target = pendingCharacter;
  const remember = $('nc-remember').checked;
  dlgNewChat.close('picked');

  // 고른 모드를 다음 기본값으로 둡니다. 묻지 않기를 켰으면 그대로 쓰게 됩니다.
  state.settings = await api.saveSettings({
    activePresetId: presetId,
    ...(remember ? { askModeOnNewChat: false } : {})
  });
  await startChatWith(target, presetId);
});

async function send() {
  const input = $('input');
  const content = input.value.trim();
  if (!content || !state.chat || state.abort) return;

  input.value = '';
  input.style.height = 'auto';

  const msg = await api.addMessage(state.chat.id, { role: 'user', content });
  state.chat.messages.push(msg);
  const assistantMode = state.chat.kind === 'assistant';
  document.getElementById('thread').appendChild(
    ui.turnEl({
      message: msg,
      speaker: assistantMode ? '나' : personaOf(state.chat)?.name || '나',
      isUser: true,
      plain: assistantMode
    })
  );
  if (assistantMode && state.chat.title === '새 채팅') refreshChatList();
  ui.scrollToEnd({ force: true });
  await run({ regenerate: false });
}

async function run({ regenerate }) {
  if (!state.chat || state.abort) return;
  const thread = document.getElementById('thread');

  if (regenerate) {
    while (state.chat.messages.length &&
           state.chat.messages[state.chat.messages.length - 1].role === 'assistant') {
      const dropped = state.chat.messages.pop();
      thread.querySelector(`[data-mid="${dropped.id}"]`)?.remove();
    }
  }

  const assistant = state.chat.kind === 'assistant';
  const character = characterOf(state.chat);
  const placeholder = ui.turnEl({
    message: { id: 'pending', content: '' },
    speaker: assistant ? '어시스턴트' : character?.name || '상대',
    isUser: false,
    plain: assistant
  });
  placeholder.querySelector('.turn-tools').remove();
  thread.appendChild(placeholder);
  const textEl = placeholder.querySelector('.turn-text');
  // 첫 글자가 올 때까지 빈 칸으로 두면 멈춘 것처럼 보입니다.
  textEl.innerHTML = ui.TYPING;
  ui.scrollToEnd({ force: true });

  state.abort = new AbortController();
  setStreaming(true);
  let acc = '';
  let thought = '';
  let thoughtEl = null;
  let sourcesEl = null;

  try {
    const result = await generate(state.chat.id, {
      regenerate,
      signal: state.abort.signal,
      onDelta: (d) => {
        acc += d;
        textEl.innerHTML = ui.formatText(acc, { plain: assistant });
        ui.scrollToEnd();
      },
      onThought: (t) => {
        thought += t;
        if (!thoughtEl) {
          thoughtEl = ui.thoughtEl('');
          placeholder.insertBefore(thoughtEl, textEl);
        }
        thoughtEl.querySelector('.thought-body').textContent = thought;
        ui.scrollToEnd();
      },
      onSources: (list) => {
        if (!sourcesEl) {
          sourcesEl = ui.sourcesEl(list);
          textEl.after(sourcesEl);
        } else {
          ui.fillSources(sourcesEl, list);
        }
        ui.scrollToEnd();
      }
    });
    if (result.message) {
      state.chat.messages.push(result.message);
      placeholder.dataset.mid = result.message.id;
      placeholder.appendChild(toolsRow());
      ui.scrollToEnd();
    } else {
      placeholder.remove();
      ui.showError('응답이 비어 있습니다. 모델과 프롬프트 설정을 확인해 주세요.');
    }
  } catch (e) {
    placeholder.remove();
    if (e.name !== 'AbortError') {
      ui.showError(e.message);
      // 서버가 모델을 감췄을 수 있으니 설정을 다시 읽어 둡니다.
      if (/목록에서 감췄습니다/.test(e.message)) {
        state.settings = await api.settings().catch(() => state.settings);
        paintModelBadge();
      }
    }
  } finally {
    state.abort = null;
    setStreaming(false);
    refreshChatList();
  }
}

function toolsRow() {
  const div = document.createElement('div');
  div.className = 'turn-tools';
  div.innerHTML = `<button class="tool" data-act="edit">수정</button>
    <button class="tool" data-act="copy">복사</button>
    <button class="tool" data-act="delete">삭제</button>`;
  return div;
}

function setStreaming(on) {
  $('stream-status').hidden = !on;
  $('btn-send').disabled = on;
  $('btn-regen').disabled = on;
  // 막대가 생기고 사라지면서 입력창 높이가 달라지므로 다시 맞춰 줍니다.
  ui.scrollToEnd();
}

/* ---------------- 메시지 편집 ---------------- */

document.getElementById('messages').addEventListener('click', async (e) => {
  const btn = e.target.closest('.tool');
  if (!btn) return;
  const turn = btn.closest('.turn');
  const mid = turn.dataset.mid;
  const msg = state.chat.messages.find((m) => m.id === mid);
  if (!msg) return;

  if (btn.dataset.act === 'copy') {
    await navigator.clipboard.writeText(msg.content);
    ui.toast('복사했습니다');
    return;
  }

  if (btn.dataset.act === 'delete') {
    await api.deleteMessage(state.chat.id, mid);
    state.chat.messages = state.chat.messages.filter((m) => m.id !== mid);
    turn.remove();
    refreshChatList();
    return;
  }

  if (btn.dataset.act === 'edit') {
    const body = turn.querySelector('.turn-text');
    if (turn.querySelector('.turn-edit')) return;
    const ta = document.createElement('textarea');
    ta.className = 'turn-edit';
    ta.value = msg.content;
    body.replaceWith(ta);
    ta.focus();
    let settled = false;
    const commit = async (keep) => {
      if (settled) return;
      settled = true;
      const next = document.createElement('div');
      next.className = 'turn-text';
      if (keep && ta.value.trim() !== msg.content) {
        msg.content = ta.value.trim();
        await api.editMessage(state.chat.id, mid, msg.content);
      }
      next.innerHTML = ui.formatText(msg.content, { plain: state.chat.kind === 'assistant' });
      ta.replaceWith(next);
    };
    ta.addEventListener('blur', () => commit(true));
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ta.blur(); }
    });
  }
});

/* ---------------- 사이드바 ---------------- */

$('chat-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-chat]');
  if (btn) openChat(btn.dataset.chat);
});

$('character-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-character]');
  if (!btn) return;
  const ch = state.characters.find((c) => c.id === btn.dataset.character);
  if (e.shiftKey) openCharacterDialog(ch);
  else newRpChat({ id: ch.id });
});

$('character-list').addEventListener('contextmenu', (e) => {
  const btn = e.target.closest('[data-character]');
  if (!btn) return;
  e.preventDefault();
  openCharacterDialog(state.characters.find((c) => c.id === btn.dataset.character));
});

$('btn-new-character').addEventListener('click', () => openCharacterDialog(null));

$('btn-seed-characters').addEventListener('click', async () => {
  const { added, characters } = await api.seedCharacters();
  state.characters = characters;
  ui.renderCharacterList(state.characters);
  ui.toast(added ? `기본 캐릭터 ${added}개를 넣었습니다` : '이미 다 들어 있습니다');
});

$('btn-new-chat').addEventListener('click', () => {
  if (!state.characters.length) return ui.toast('먼저 캐릭터를 만들어 주세요');
  if (state.chat?.character) newRpChat({ inline: { ...state.chat.character } });
  else if (state.chat?.characterId) newRpChat({ id: state.chat.characterId });
  else ui.toast('왼쪽에서 캐릭터를 골라 주세요');
});

$('btn-delete-chat').addEventListener('click', async () => {
  if (!state.chat || !confirm('이 대화를 삭제할까요? 되돌릴 수 없습니다.')) return;
  await api.deleteChat(state.chat.id);
  closeChat();
  await refreshChatList();
});

$('btn-save-character').addEventListener('click', async () => {
  if (!state.chat?.character) return;
  const { character } = await api.saveInlineCharacter(state.chat.id);
  state.chat.characterId = character.id;
  delete state.chat.character;
  state.characters = await api.characters();
  ui.renderCharacterList(state.characters);
  await refreshChatList();
  $('btn-save-character').hidden = true;
  ui.toast(`캐릭터 목록에 넣었습니다 — ${character.name}`);
});

$('btn-rename').addEventListener('click', async () => {
  const title = prompt('대화 이름', state.chat.title);
  if (!title?.trim()) return;
  await api.updateChat(state.chat.id, { title: title.trim() });
  state.chat.title = title.trim();
  $('chat-title').textContent = state.chat.title;
  refreshChatList();
});

const sidebar = $('sidebar');
$('btn-open-sidebar').addEventListener('click', () => sidebar.classList.add('open'));
$('btn-close-sidebar').addEventListener('click', () => sidebar.classList.remove('open'));
function closeSidebarOnNarrow() { sidebar.classList.remove('open'); }

/* ---------------- 입력 ---------------- */

const input = $('input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
$('btn-send').addEventListener('click', send);
$('btn-regen').addEventListener('click', () => run({ regenerate: true }));
$('btn-stop').addEventListener('click', () => state.abort?.abort());

/* ---------------- 캐릭터 시트 ---------------- */

const CHAR_FIELDS = ['avatar', 'name', 'tags', 'description', 'personality',
  'speech', 'scenario', 'greeting', 'exampleDialogue', 'notes'];
const dlgChar = $('dlg-character');

function openCharacterDialog(ch) {
  state.editingCharacterId = ch?.id || null;
  $('char-dlg-title').textContent = ch ? `${ch.name} 고치기` : '캐릭터 만들기';
  $('c-delete').hidden = !ch;
  // 이미 저장된 캐릭터를 고칠 때는 '이번만 쓰기' 가 뜻이 없습니다.
  $('c-once').hidden = Boolean(ch?.id);
  for (const f of CHAR_FIELDS) $(`c-${f}`).value = ch?.[f] || '';
  dlgChar.showModal();
}

$('c-once').addEventListener('click', () => {
  const draft = Object.fromEntries(CHAR_FIELDS.map((f) => [f, $(`c-${f}`).value.trim()]));
  if (!draft.name) return ui.toast('이름을 입력해 주세요');
  dlgChar.close('cancel');
  newRpChat({ inline: draft });
});

$('c-cancel').addEventListener('click', () => dlgChar.close('cancel'));

$('c-delete').addEventListener('click', () => {
  if (!state.editingCharacterId) return;
  if (!confirm('이 캐릭터를 삭제할까요? 이미 나눈 대화는 그대로 남습니다.')) return;
  dlgChar.close('delete');
});

dlgChar.addEventListener('close', async () => {
  const action = dlgChar.returnValue;
  const id = state.editingCharacterId;

  if (action === 'delete' && id) {
    await api.deleteCharacter(id);
  } else if (action === 'save') {
    const body = Object.fromEntries(CHAR_FIELDS.map((f) => [f, $(`c-${f}`).value.trim()]));
    if (!body.name) return ui.toast('이름을 입력해 주세요');
    if (id) await api.updateCharacter(id, body);
    else await api.createCharacter(body);
  } else return;

  state.characters = await api.characters();
  ui.renderCharacterList(state.characters);
  await refreshChatList();
  if (state.chat) {
    const ch = characterOf(state.chat);
    $('chat-sub').textContent = [ch?.description, `내 페르소나 ${personaOf(state.chat)?.name || '미설정'}`]
      .filter(Boolean).join(' · ');
  }
});

/* ---------------- 페르소나 시트 ---------------- */

const dlgPersona = $('dlg-persona');

$('btn-personas').addEventListener('click', () => {
  ui.renderPersonaList(state.personas, state.settings.activePersonaId);
  dlgPersona.showModal();
});

$('p-add').addEventListener('click', async () => {
  const name = $('p-name').value.trim();
  if (!name) return ui.toast('이름을 입력해 주세요');
  await api.createPersona({ name, description: $('p-description').value.trim() });
  $('p-name').value = '';
  $('p-description').value = '';
  state.personas = await api.personas();
  ui.renderPersonaList(state.personas, state.settings.activePersonaId);
});

$('persona-list').addEventListener('click', async (e) => {
  const use = e.target.closest('[data-use]');
  const del = e.target.closest('[data-del]');
  if (use) {
    state.settings = await api.saveSettings({ activePersonaId: use.dataset.use });
    ui.toast('사용할 페르소나를 바꿨습니다');
  } else if (del) {
    if (!confirm('이 페르소나를 삭제할까요?')) return;
    await api.deletePersona(del.dataset.del);
    state.personas = await api.personas();
  } else return;
  ui.renderPersonaList(state.personas, state.settings.activePersonaId);
});

/* ---------------- 설정 시트 ---------------- */

const dlgSettings = $('dlg-settings');
let draftProviders = null;
let shownProvider = null;
let draftPresets = null;
let shownPreset = null;

/** API 키는 기본으로 가려 두고, 버튼을 눌렀을 때만 보여 줍니다. */
function setKeyVisible(on) {
  $('s-apikey').type = on ? 'text' : 'password';
  $('s-key-toggle').textContent = on ? '가리기' : '보기';
  $('s-key-toggle').setAttribute('aria-pressed', String(on));
}

$('s-key-toggle').addEventListener('click', () => {
  setKeyVisible($('s-apikey').type === 'password');
});

function paintProviderOptions() {
  $('s-provider').innerHTML = Object.entries(draftProviders)
    .map(([key, cfg]) => `<option value="${key}">${cfg.label}${key === 'lmstudio' ? ' (로컬)' : ''}</option>`)
    .join('');
  $('s-provider').value = shownProvider || state.settings.activeProvider;
}

function fillProviderBox(key) {
  shownProvider = key;
  setKeyVisible(false);
  const cfg = draftProviders[key];
  $('s-baseurl').value = cfg.baseUrl || '';
  /*
   * 서버는 키를 내려보내지 않습니다. 칸은 늘 비어 있고, 뭔가 입력했을 때만 교체됩니다.
   * 저장된 키가 있는지는 placeholder 로 알려 줍니다.
   */
  $('s-apikey').value = '';
  $('s-apikey').placeholder = cfg.keyFromEnv
    ? '환경변수로 지정되어 있습니다 (여기서 바꿀 수 없음)'
    : cfg.hasApiKey
      ? '저장됨 — 바꾸려면 새 키를 입력하세요'
      : 'API 키를 입력하세요';
  $('s-apikey').disabled = Boolean(cfg.keyFromEnv);
  $('s-model').value = cfg.model || '';
  $('s-key-field').hidden = key === 'lmstudio';
  $('s-model-msg').textContent = key === 'lmstudio'
    ? 'LM Studio 의 Developer 탭에서 서버를 켠 뒤 불러오기를 눌러 주세요.'
    : '';
  modelOptions = [];
  closeCombo();
  paintProviderOptions();
}

/* ---------- 모델 고르기 (직접 만든 드롭다운) ---------- */

let modelOptions = [];
let comboIndex = -1;

const comboInput = $('s-model');
const comboList = $('model-list');

const escapeHtml = (t = '') =>
  t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 입력한 글자와 겹치는 부분을 강조해 보여 줍니다. */
function markHit(name, query) {
  if (!query) return escapeHtml(name);
  const at = name.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return escapeHtml(name);
  return escapeHtml(name.slice(0, at)) +
    `<span class="hit">${escapeHtml(name.slice(at, at + query.length))}</span>` +
    escapeHtml(name.slice(at + query.length));
}

function filteredModels() {
  const q = comboInput.value.trim().toLowerCase();
  if (!q) return modelOptions;
  return modelOptions.filter((m) => m.toLowerCase().includes(q));
}

function openCombo() {
  const items = filteredModels();
  const q = comboInput.value.trim();

  if (!modelOptions.length) {
    comboList.innerHTML = '<div class="combo-empty">먼저 불러오기를 눌러 주세요.</div>';
  } else if (!items.length) {
    comboList.innerHTML = `<div class="combo-empty">'${escapeHtml(q)}' 와 일치하는 모델이 없습니다. 직접 입력한 이름을 그대로 써도 됩니다.</div>`;
  } else {
    const head = `<div class="combo-head">${items.length}개${q ? ` · '${escapeHtml(q)}' 검색` : ''}</div>`;
    comboList.innerHTML = head + items
      .map((m, i) => `<button type="button" class="combo-item${i === comboIndex ? ' is-active' : ''}" data-model="${escapeHtml(m)}" role="option">${markHit(m, q)}</button>`)
      .join('');
  }
  comboList.hidden = false;
  comboInput.setAttribute('aria-expanded', 'true');
  placeCombo();
}

/**
 * 설정 시트는 세로로 스크롤되므로, 아래로 펼치면 잘릴 수 있습니다.
 * 남는 공간을 재서 모자라면 위로 펼칩니다.
 */
function placeCombo() {
  const holder = comboList.closest('.sheet-body');
  if (!holder) return;
  comboList.classList.remove('is-up');
  const box = comboList.getBoundingClientRect();
  const limit = holder.getBoundingClientRect();
  if (box.bottom > limit.bottom - 8) comboList.classList.add('is-up');
}

function closeCombo() {
  comboList.hidden = true;
  comboIndex = -1;
  comboInput.setAttribute('aria-expanded', 'false');
}

function moveCombo(step) {
  const items = filteredModels();
  if (!items.length) return;
  comboIndex = (comboIndex + step + items.length) % items.length;
  openCombo();
  comboList.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
}

function pickModel(name) {
  comboInput.value = name;
  closeCombo();
  $('s-model-msg').textContent = `선택한 모델: ${name}`;
}

comboInput.addEventListener('focus', openCombo);
comboInput.addEventListener('input', () => { comboIndex = -1; openCombo(); });

comboInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (comboList.hidden) openCombo(); else moveCombo(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveCombo(-1); }
  else if (e.key === 'Escape' && !comboList.hidden) { e.preventDefault(); closeCombo(); }
  else if (e.key === 'Enter') {
    const items = filteredModels();
    if (!comboList.hidden && comboIndex >= 0 && items[comboIndex]) {
      e.preventDefault();
      pickModel(items[comboIndex]);
    } else {
      closeCombo();
    }
  }
});

// blur 보다 먼저 잡아야 클릭이 먹습니다.
comboList.addEventListener('mousedown', (e) => {
  const btn = e.target.closest('[data-model]');
  if (!btn) return;
  e.preventDefault();
  pickModel(btn.dataset.model);
});

comboInput.addEventListener('blur', () => setTimeout(closeCombo, 120));

/** 화면에 떠 있던 엔진의 입력값을 임시본에 담아둡니다. */
function stashProvider() {
  if (!draftProviders?.[shownProvider]) return;
  const typedKey = $('s-apikey').value.trim();
  Object.assign(draftProviders[shownProvider], {
    baseUrl: $('s-baseurl').value.trim(),
    model: $('s-model').value.trim()
  });
  // 빈 칸은 '건드리지 않음' 입니다. 서버가 저장해 둔 키를 그대로 씁니다.
  if (typedKey) draftProviders[shownProvider].apiKey = typedKey;
}

/** 화면에 떠 있던 모드의 내용을 임시본에 담아둡니다. */
function stashPreset() {
  const p = draftPresets?.find((x) => x.id === shownPreset);
  if (!p) return;
  p.template = $('s-template').value;
  p.adult = $('s-preset-adult').checked;
}

function paintPresetOptions() {
  $('s-preset').innerHTML = draftPresets
    .map((p) => `<option value="${p.id}">${p.adult ? '🔒 ' : ''}${p.name}</option>`)
    .join('');
  $('s-preset').value = shownPreset;
  $('s-preset-delete').disabled = draftPresets.length < 2;
}

function showPreset(id) {
  shownPreset = id;
  const p = draftPresets.find((x) => x.id === id);
  $('s-template').value = p?.template || '';
  $('s-preset-adult').checked = Boolean(p?.adult);
  paintPresetOptions();

  // 내장 모드를 편집 중이면 같은 모드의 원본이 기본으로 잡히게 합니다.
  const sources = state.settings.builtinTemplates || [];
  if (sources.some((t) => t.id === id)) $('s-template-source').value = id;
}

function paintTemplateSources() {
  const sources = state.settings.builtinTemplates || [];
  $('s-template-source').innerHTML = sources.length
    ? sources.map((t) => `<option value="${t.id}">${t.adult ? '🔒 ' : ''}${t.name} 원본</option>`).join('')
    : '<option value="">기본 모드을 불러오지 못했습니다</option>';
}

$('s-preset').addEventListener('change', (e) => {
  stashPreset();
  showPreset(e.target.value);
});

$('s-preset-new').addEventListener('click', () => {
  const name = prompt('새 모드 이름');
  if (!name?.trim()) return;
  stashPreset();
  draftPresets.push({ id: `p${Date.now().toString(36)}`, name: name.trim(), template: '', adult: false });
  showPreset(draftPresets[draftPresets.length - 1].id);
});

$('s-preset-rename').addEventListener('click', () => {
  const p = draftPresets.find((x) => x.id === shownPreset);
  const name = prompt('모드 이름', p.name);
  if (!name?.trim()) return;
  p.name = name.trim();
  paintPresetOptions();
});

$('s-preset-delete').addEventListener('click', () => {
  if (draftPresets.length < 2) return;
  if (!confirm('이 모드를 삭제할까요?')) return;
  draftPresets = draftPresets.filter((p) => p.id !== shownPreset);
  showPreset(draftPresets[0].id);
});

$('btn-settings').addEventListener('click', async () => {
  // 내장 틀 원본이 비어 있으면 설정을 다시 읽어 둡니다. 없으면 '가져오기' 가 헛돕니다.
  if (!state.settings.builtinTemplates?.length) {
    state.settings = await api.settings().catch(() => state.settings);
  }
  const s = state.settings;
  draftProviders = structuredClone(s.providers);
  draftPresets = structuredClone(s.presets);
  paintTemplateSources();
  shownProvider = s.activeProvider;
  fillProviderBox(s.activeProvider);
  showPreset(s.activePresetId);
  $('s-temp').value = s.params.temperature;
  $('v-temp').textContent = s.params.temperature;
  $('s-topk').value = s.params.topK ?? 0;
  $('s-repeat').value = s.params.repeatPenalty ?? 1;
  $('s-maxtokens').value = s.params.maxTokens;
  $('s-history').value = s.historyLimit;
  $('s-ask-mode').checked = s.askModeOnNewChat !== false;
  $('s-assistant-prompt').value = s.assistant.systemPrompt;
  $('s-atemp').value = s.assistant.params.temperature;
  $('v-atemp').textContent = s.assistant.params.temperature;
  $('s-atopk').value = s.assistant.params.topK ?? 0;
  $('s-arepeat').value = s.assistant.params.repeatPenalty ?? 1;
  $('s-amaxtokens').value = s.assistant.params.maxTokens;
  dlgSettings.showModal();
});

$('s-provider').addEventListener('change', (e) => {
  stashProvider();
  fillProviderBox(e.target.value);
});

$('s-temp').addEventListener('input', (e) => { $('v-temp').textContent = e.target.value; });
$('s-atemp').addEventListener('input', (e) => { $('v-atemp').textContent = e.target.value; });

$('s-fetch-models').addEventListener('click', async () => {
  stashProvider();
  const key = $('s-provider').value;
  $('s-model-msg').textContent = '모델을 불러오는 중…';
  try {
    // 아직 저장 전이므로 임시로 저장한 뒤 조회합니다.
    await api.saveSettings({ providers: draftProviders });
    const { models } = await api.models(key);
    modelOptions = models;
    $('s-model-msg').textContent = models.length
      ? `${models.length}개를 찾았습니다. 입력창을 누르면 목록이 나옵니다.`
      : '응답은 왔지만 대화에 쓸 수 있는 모델이 없습니다. 키가 이 API 에 대해 활성화돼 있는지 확인해 주세요.';
    if (models.length) {
      $('s-model').focus();
      openCombo();
    }
    paintWebSearch();
  } catch (e) {
    $('s-model-msg').textContent = `불러오지 못했습니다 — ${e.message}`;
  }
});

$('s-cancel').addEventListener('click', () => dlgSettings.close('cancel'));

$('s-reset-template').addEventListener('click', () => {
  const pick = (state.settings.builtinTemplates || []).find((t) => t.id === $('s-template-source').value);
  if (!pick) return ui.toast('가져올 기본 모드이 없습니다');

  const current = draftPresets.find((p) => p.id === shownPreset);
  if (current?.template.trim() && current.template !== pick.template &&
      !confirm(`'${current.name}' 의 지금 내용을 '${pick.name}' 원본으로 덮어씁니다. 계속할까요?`)) {
    return;
  }
  $('s-template').value = pick.template;
  ui.toast(`기본 내용을 가져왔습니다 — ${pick.name}`);
});

dlgSettings.addEventListener('close', async () => {
  if (dlgSettings.returnValue !== 'save') return;
  stashProvider();
  stashPreset();
  state.settings = await api.saveSettings({
    activeProvider: $('s-provider').value,
    historyLimit: Number($('s-history').value),
    askModeOnNewChat: $('s-ask-mode').checked,
    presets: draftPresets,
    activePresetId: shownPreset,
    params: {
      temperature: Number($('s-temp').value),
      maxTokens: Number($('s-maxtokens').value),
      topP: state.settings.params.topP,
      topK: Number($('s-topk').value),
      repeatPenalty: Number($('s-repeat').value)
    },
    providers: draftProviders,
    assistant: {
      systemPrompt: $('s-assistant-prompt').value,
      params: {
        temperature: Number($('s-atemp').value),
        maxTokens: Number($('s-amaxtokens').value),
        topP: state.settings.assistant.params.topP,
        topK: Number($('s-atopk').value),
        repeatPenalty: Number($('s-arepeat').value)
      }
    }
  });
  paintModelBadge();
  paintChatPreset();
  await refreshChatList();
  ui.toast('설정을 저장했습니다');
});

enhanceSelects();
ui.watchScroll();
boot().catch((e) => ui.showError(`앱을 시작하지 못했습니다 — ${e.message}`));

/* ---------------- 개발자 설정 ---------------- */

const dlgDev = $('dlg-dev');
let draftDev = null;
let draftDevProviders = null;
let removedProviders = [];

const THEME_FIELDS = {
  'd-bg': 'bg', 'd-panel': 'panel', 'd-line': 'line',
  'd-text': 'text', 'd-muted': 'muted', 'd-accent': 'accent'
};
const MARKUP_FIELDS = {
  'd-mk-asterisk': 'asterisk', 'd-mk-paren': 'paren',
  'd-mk-speaker': 'speaker', 'd-mk-quote': 'quote'
};

function paintDevProviders() {
  const list = Object.entries(draftDevProviders);
  $('d-provider-list').innerHTML = list
    .map(([key, cfg]) => `<li class="persona-row">
      <span class="grow">
        <div class="p-name">${cfg.label}</div>
        <div class="p-desc">${cfg.type} · ${cfg.baseUrl || '주소 없음'}</div>
      </span>
      ${cfg.builtin
        ? '<span class="p-desc">내장</span>'
        : `<button type="button" class="ghost-btn danger" data-del-provider="${key}">삭제</button>`}
    </li>`)
    .join('');
}

function paintHiddenModels() {
  const rows = Object.entries(state.settings.providers)
    .map(([key, cfg]) => [key, cfg, cfg.unavailableModels || []])
    .filter(([, , list]) => list.length);

  $('d-hidden-models').innerHTML = rows.length
    ? rows.map(([key, cfg, list]) => `<li class="persona-row">
        <span class="grow">
          <div class="p-name">${cfg.label}</div>
          <div class="p-desc">${list.join(', ')}</div>
        </span>
        <button type="button" class="ghost-btn" data-clear="${key}">삭제</button>
      </li>`).join('')
    : '<li class="rail-empty">아직 없습니다.</li>';
}

$('d-hidden-models').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-clear]');
  if (!btn) return;
  const { cleared } = await api.clearUnavailable(btn.dataset.clear);
  state.settings = await api.settings();
  paintHiddenModels();
  ui.toast(`${cleared}개를 목록에 되돌렸습니다`);
});

function fillDevSheet() {
  draftDev = structuredClone(state.settings.dev);
  draftDevProviders = structuredClone(state.settings.providers);
  removedProviders = [];

  for (const [id, key] of Object.entries(MARKUP_FIELDS)) $(id).checked = Boolean(draftDev.markup[key]);
  $('d-particle').checked = Boolean(draftDev.particleFix);
  for (const [id, key] of Object.entries(THEME_FIELDS)) $(id).value = draftDev.theme[key];
  $('d-fontsize').value = draftDev.theme.fontSize;
  $('d-fontsans').value = draftDev.theme.fontSans;
  $('d-fontserif').value = draftDev.theme.fontSerif;
  paintDevProviders();
  paintHiddenModels();
}

function readDevSheet() {
  const markup = {};
  for (const [id, key] of Object.entries(MARKUP_FIELDS)) markup[key] = $(id).checked;
  const theme = { ...draftDev.theme };
  for (const [id, key] of Object.entries(THEME_FIELDS)) theme[key] = $(id).value;
  theme.fontSize = Number($('d-fontsize').value);
  theme.fontSans = $('d-fontsans').value.trim();
  theme.fontSerif = $('d-fontserif').value.trim();
  return { particleFix: $('d-particle').checked, markup, theme };
}

$('btn-open-dev').addEventListener('click', () => {
  fillDevSheet();
  dlgDev.showModal();
});

// 색을 고르는 즉시 화면에 반영해 결과를 바로 볼 수 있게 합니다.
for (const id of [...Object.keys(THEME_FIELDS), 'd-fontsize', 'd-fontsans', 'd-fontserif']) {
  $(id).addEventListener('input', () => applyDev(readDevSheet()));
}
for (const id of [...Object.keys(MARKUP_FIELDS)]) {
  $(id).addEventListener('change', () => {
    applyDev(readDevSheet());
    if (state.chat) ui.renderThread(state.chat, characterOf(state.chat), personaOf(state.chat));
  });
}

$('d-theme-reset').addEventListener('click', () => {
  draftDev.theme = {
    bg: '#15111a', panel: '#1d1822', line: '#372f42',
    text: '#ede7ee', muted: '#9c90a8', accent: '#d9b168',
    fontSans: "'Pretendard Variable', Pretendard, system-ui, sans-serif",
    fontSerif: "'Gowun Batang', 'Nanum Myeongjo', serif",
    fontSize: 15
  };
  for (const [id, key] of Object.entries(THEME_FIELDS)) $(id).value = draftDev.theme[key];
  $('d-fontsize').value = draftDev.theme.fontSize;
  $('d-fontsans').value = draftDev.theme.fontSans;
  $('d-fontserif').value = draftDev.theme.fontSerif;
  applyDev(readDevSheet());
});

$('d-p-add').addEventListener('click', () => {
  const label = $('d-p-label').value.trim();
  const baseUrl = $('d-p-baseurl').value.trim();
  if (!label || !baseUrl) return ui.toast('이름과 주소를 입력해 주세요');
  const key = `custom_${Date.now().toString(36)}`;
  draftDevProviders[key] = {
    label,
    type: $('d-p-type').value,
    builtin: false,
    baseUrl,
    apiKey: $('d-p-apikey').value.trim(),
    model: ''
  };
  $('d-p-label').value = '';
  $('d-p-baseurl').value = '';
  $('d-p-apikey').value = '';
  paintDevProviders();
  ui.toast('저장을 눌러야 반영됩니다');
});

$('d-provider-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-del-provider]');
  if (!btn) return;
  const key = btn.dataset.delProvider;
  if (!confirm(`'${draftDevProviders[key].label}' 엔진을 삭제할까요?`)) return;
  delete draftDevProviders[key];
  removedProviders.push(key);
  paintDevProviders();
});

const dlgSystem = $('dlg-system');

$('d-show-system').addEventListener('click', async () => {
  if (!state.chat) return ui.toast('대화를 먼저 열어 주세요');

  $('sys-text').textContent = '불러오는 중…';
  $('sys-count').textContent = '';
  $('sys-source').textContent = '';
  dlgSystem.showModal();

  try {
    const { system, turns } = await api.systemPreview(state.chat.id);
    $('sys-text').textContent = system;

    const entry = state.chats.find((c) => c.id === state.chat.id);
    const cfg = state.settings.providers[state.settings.activeProvider];
    $('sys-source').textContent =
      `${state.chat.title} · ${entry?.presetName || '틀 없음'} · ${cfg.label}`;
    // 한국어는 대략 글자 수의 0.6~1배가 토큰이라 정확한 수치가 아니라 어림값입니다.
    $('sys-count').textContent =
      `${system.length.toLocaleString()}자 · 대략 ${Math.round(system.length * 0.8).toLocaleString()}토큰 · 최근 대화 ${turns}턴을 함께 보냅니다`;
  } catch (err) {
    $('sys-text').textContent = `불러오지 못했습니다 — ${err.message}`;
  }
});

$('sys-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('sys-text').textContent);
  ui.toast('복사했습니다');
});

$('d-cancel').addEventListener('click', () => {
  applyDev(state.settings.dev);
  if (state.chat) ui.renderThread(state.chat, characterOf(state.chat), personaOf(state.chat));
  dlgDev.close('cancel');
});

dlgDev.addEventListener('close', async () => {
  if (dlgDev.returnValue !== 'save') return;
  state.settings = await api.saveSettings({
    dev: readDevSheet(),
    providers: draftDevProviders,
    removeProviders: removedProviders
  });
  applyDev(state.settings.dev);
  paintModelBadge();
  ui.toast('개발자 설정을 저장했습니다');
});
