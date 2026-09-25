import { api, generate, impersonate, drawImage } from './api.js';
import * as ui from './ui.js';
import { enhanceSelects } from './select.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  characters: [],
  personas: [],
  chats: [],
  chat: null,
  // 진행 중인 생성. { chatId, controller, stopped, done }
  run: null,
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
  paintAdultRules();
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

/** 개발자 설정에서 경고를 확인하고 성인 모드의 클라우드 허용을 켰는지. */
const adultCloudOn = () => state.settings?.dev?.adultCloud === true;

/** 성인 대화를 이 엔진으로 보낼 수 있는지. (서버의 adultAllowed 와 같은 규칙) */
const adultAllowed = (cfg) => isLocalUrl(cfg?.baseUrl) || adultCloudOn();

/** 설정·페르소나 창의 성인 안내 문구를 지금 규칙에 맞춥니다. */
function paintAdultRules() {
  const cloud = adultCloudOn();
  $('s-preset-adult-rule').textContent = cloud
    ? '클라우드 허용이 켜져 있어, 선택한 외부 API 엔진으로도 보냅니다.'
    : '로컬(LM Studio) 엔진으로만 보냅니다. 외부 API 로는 전송되지 않습니다.';
  $('p-adult-rule').textContent = cloud
    ? '문장 만들기는 선택한 엔진으로 보냅니다 (클라우드 허용 켜짐).'
    : '문장 만들기는 로컬(LM Studio) 엔진으로만 보냅니다.';
}

function paintModelBadge() {
  const s = state.settings;
  const cfg = s.providers[s.activeProvider];
  const btn = $('active-model');
  btn.textContent = cfg.model || '모델 미설정';
  btn.classList.toggle('is-empty', !cfg.model);
  btn.title = cfg.model ? `${cfg.label} · ${cfg.model} — 누르면 설정이 열립니다` : '설정에서 모델을 선택해 주세요';
  paintQuickProvider();
}

/** 입력창 아래의 엔진 선택기. 지금 대화가 성인 모드면 (클라우드 허용을 켜지 않은 한) 외부 엔진은 고를 수 없습니다. */
function paintQuickProvider() {
  const sel = $('quick-provider');
  const s = state.settings;
  const entry = state.chats.find((c) => c.id === state.chat?.id);
  const adultChat = Boolean(entry?.adult);

  sel.innerHTML = Object.entries(s.providers)
    .map(([key, cfg]) => {
      const blocked = adultChat && !adultAllowed(cfg);
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
    refreshContext();
    const cfg = state.settings.providers[state.settings.activeProvider];
    ui.toast(cfg.model ? `엔진을 바꿨습니다 — ${cfg.label}` : `모델을 먼저 선택해 주세요 — ${cfg.label}`);
  } catch (err) {
    e.target.value = before;
    ui.toast(`바꾸지 못했습니다 — ${err.message}`);
  }
});

$('active-model').addEventListener('click', () => openSettings('engine'));

async function refreshChatList() {
  state.chats = await api.chats();
  ui.renderChatList(visibleChats(), state.chat?.id, state.characters, { hideAdult: state.hideAdult, mode: state.mode });
}

function paintMode() {
  const rp = state.mode === 'rp';
  for (const tab of document.querySelectorAll('.mode-tab[data-mode]')) {
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

for (const tab of document.querySelectorAll('.mode-tab[data-mode]')) {
  tab.addEventListener('click', () => {
    state.mode = tab.dataset.mode;
    localStorage.setItem('mode', state.mode);
    paintMode();

    // 다른 모드의 대화가 열려 있었다면 닫습니다.
    const chatMode = state.chat?.kind === 'assistant' ? 'assistant' : 'rp';
    if (state.chat && chatMode !== state.mode) closeChat();
    // 대화를 아예 안 열어 둔 상태였다면 closeChat 이 실행되지 않으므로,
    // 가운데 안내 문구를 여기서 새 모드에 맞게 다시 그립니다.
    else if (!state.chat) ui.renderEmptyStage(state.mode);

    ui.renderChatList(visibleChats(), state.chat?.id, state.characters, { hideAdult: state.hideAdult, mode: state.mode });
  });
}

/** 열린 대화를 닫고 빈 화면으로 되돌립니다. */
function closeChat() {
  stopGeneration();
  state.chat = null;
  localStorage.removeItem('lastChat');
  $('chat-title').textContent = state.mode === 'assistant' ? '어시스턴트' : '대화를 선택해 주세요';
  $('chat-sub').textContent = '';
  $('composer').hidden = true;
  $('btn-rename').hidden = true;
  $('btn-delete-chat').hidden = true;
  $('btn-save-character').hidden = true;
  $('btn-cast').hidden = true;
  $('btn-memory').hidden = true;
  $('btn-impersonate').hidden = true;
  $('chat-preset').hidden = true;
  $('chat-persona').hidden = true;
  $('btn-websearch').hidden = true;
  $('btn-thinking').hidden = true;
  paintContext(null);
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
  // 어시스턴트 대화에는 대화 모드가 없습니다.
  if (!state.chat || state.chat.kind === 'assistant') {
    sel.hidden = true;
    return;
  }
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
  // 메신저 모드로 바꾸거나 빠져나오면 말풍선 모양이 달라집니다.
  if (!state.run) paintThread();
  refreshContext();
});

/* ---------------- 대화 ---------------- */

async function openChat(id) {
  // 다른 대화에서 생성 중이면 멈춥니다. 쓰던 내용은 그 대화에 저장됩니다.
  // 그대로 두면 끝난 답변이 새로 연 대화에 붙고, 새 대화의 전송도 잠깁니다.
  if (state.run && state.run.chatId !== id) await stopGeneration();
  state.chat = await api.chat(id);
  localStorage.setItem('lastChat', id);
  const assistant = state.chat.kind === 'assistant';
  const ch = characterOf(state.chat);
  $('chat-title').textContent = state.chat.title;
  paintChatSub();
  $('composer').hidden = false;
  $('btn-rename').hidden = false;
  $('btn-delete-chat').hidden = false;
  $('btn-save-character').hidden = !state.chat.character;
  $('btn-cast').hidden = assistant;
  $('btn-memory').hidden = assistant;
  $('btn-impersonate').hidden = assistant;
  $('input').placeholder = assistant
    ? '무엇이든 물어보세요.'
    : '무엇을 하거나 말할지 적어보세요. 행동은 *별표* 로 감쌉니다.';
  if (assistant) $('chat-preset').hidden = true;
  else paintChatPreset();
  paintChatPersona();
  paintQuickProvider();
  paintWebSearch();
  paintThinking();
  paintThread();
  refreshContext();
  ui.renderChatList(visibleChats(), id, state.characters, { hideAdult: state.hideAdult, mode: state.mode });
  closeSidebarOnNarrow();
}

/** 대화 제목 아래 한 줄. 1회성 여부 · 캐릭터 소개 · 내 페르소나 */
function paintChatSub() {
  if (!state.chat) return;
  $('chat-sub').textContent = state.chat.kind === 'assistant'
    ? '어시스턴트 모드 — 캐릭터 없이 대화합니다'
    : [
        state.chat.character ? '1회성 캐릭터' : null,
        castOf(state.chat).length ? `함께: ${castOf(state.chat).map((c) => c.name).join(', ')}` : null,
        characterOf(state.chat)?.description,
        `내 페르소나 ${personaOf(state.chat)?.name || '미설정'}`
      ].filter(Boolean).join(' · ');
}

/**
 * 대화 상단의 페르소나 선택기. 페르소나는 대화를 만들 때 정해지지만,
 * 여기서 이 대화만 따로 바꿀 수 있습니다. 다른 대화와 기본값은 그대로입니다.
 */
function paintChatPersona() {
  const sel = $('chat-persona');
  if (!state.chat || state.chat.kind === 'assistant' || !state.personas.length) {
    sel.hidden = true;
    return;
  }
  const esc = (t = '') => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  sel.innerHTML = state.personas
    .map((p) => `<option value="${p.id}">나: ${esc(p.name)}</option>`)
    .join('');
  sel.value = personaOf(state.chat)?.id || state.personas[0].id;
  sel.hidden = false;
}

$('chat-persona').addEventListener('change', async (e) => {
  if (!state.chat) return;
  const chat = state.chat;
  const personaId = e.target.value;
  try {
    await api.updateChat(chat.id, { personaId });
  } catch (err) {
    paintChatPersona();
    return ui.toast(`바꾸지 못했습니다 — ${err.message}`);
  }
  chat.personaId = personaId;
  if (state.chat !== chat) return;
  paintChatSub();
  // 내 말풍선 위의 이름도 새 페르소나로 바뀌어야 합니다. 생성 중이면 화면을 건드리지 않습니다.
  if (!state.run) paintThread();
  ui.toast(`이 대화의 페르소나를 바꿨습니다 — ${personaOf(chat)?.name}. 다음 답변부터 반영됩니다.`);
});

/** 내장 모드는 설명을 미리 적어 두고, 직접 만든 모드는 내용 첫 줄을 보여 줍니다. */
const MODE_NOTES = {
  default: '짧은 호흡으로 주고받습니다. *별표* 로 행동, "따옴표" 로 대사.',
  novelist: '한 장면을 통째로 그립니다. 상황만 던져 주면 주변 인물까지 등장시켜 서로 대화하게 합니다.',
  narrator: '내 페르소나가 등장하지 않습니다. 상황만 지시하면 AI 가 주인공까지 전부 서술합니다.',
  adult: '성인 소재를 다룹니다. 표기와 호흡은 롤플레이와 같습니다.',
  'adult-novel': '성인 소재를 다룹니다. 표기와 호흡은 소설 모드와 같아, 여러 인물이 함께 나옵니다.',
  'adult-narrator': '성인 소재를 다룹니다. 표기와 호흡은 연출 모드와 같습니다.',
  messenger: '묘사 없이 메신저 문자만 주고받습니다. 한 번에 짧은 문자 몇 개씩, 말풍선으로 보입니다.',
  'adult-messenger': '성인 소재를 다룹니다. 형식은 메신저 모드와 같습니다.'
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

  // 지난번에 고른 모드가 있는 쪽 탭으로 엽니다. 그쪽이 비어 있으면 모드가 있는 쪽으로.
  const last = s.presets.find((p) => p.id === s.activePresetId);
  let audience = last?.adult ? 'adult' : 'general';
  if (!s.presets.some((p) => p.adult === (audience === 'adult'))) {
    audience = audience === 'adult' ? 'general' : 'adult';
  }
  paintModeTab(audience);
  dlgNewChat.showModal();
}

/**
 * 새 대화 창에서 일반 / 성인 모드 중 한쪽만 보여 줍니다.
 * 섞어 두면 성인 모드를 실수로 누르기 쉽고, 목록도 길어져 한눈에 안 들어옵니다.
 */
function paintModeTab(audience) {
  const s = state.settings;
  const adult = audience === 'adult';
  for (const tab of $('nc-tabs').querySelectorAll('[data-audience]')) {
    const on = tab.dataset.audience === audience;
    tab.classList.toggle('is-on', on);
    tab.setAttribute('aria-selected', String(on));
  }

  // 성인 모드는 기본적으로 로컬 엔진으로만 나갑니다. 지금 엔진이 외부면 고르기 전에 알려 줍니다.
  const note = $('nc-audience-note');
  const cfg = s.providers[s.activeProvider];
  const label = cfg?.label || s.activeProvider;
  const local = isLocalUrl(cfg?.baseUrl);
  const cloud = adultCloudOn();
  note.hidden = !adult;
  note.classList.toggle('is-warn', adult && !local);
  note.textContent = !adult ? ''
    : local && cloud ? '지금 엔진은 로컬 주소입니다. 대화 내용이 이 PC 밖으로 나가지 않습니다.'
    : local ? '성인 모드는 로컬 엔진으로만 보냅니다. 외부 API 로는 전송되지 않습니다.'
    : cloud ? `지금 엔진(${label})은 클라우드입니다. 대화 내용이 그 회사 서버로 전송되고, 이용 약관에 따라 거부되거나 계정이 제한될 수 있습니다.`
    : `지금 엔진(${label})은 로컬 주소가 아니라 성인 모드로 보낼 수 없습니다. 입력창 아래에서 LM Studio 로 바꿔 주세요.`;

  const list = s.presets.filter((p) => Boolean(p.adult) === adult);
  $('nc-list').innerHTML = list.length
    ? list.map((p) => `<li><button type="button" class="mode-card${p.id === s.activePresetId ? ' is-last' : ''}" data-preset="${p.id}">
      <span class="m-name">
        ${ui.escapeHtml(p.name)}
        ${p.adult ? '<span class="m-tag">19</span>' : ''}
        ${p.id === s.activePresetId ? '<span class="m-last">이전 사용</span>' : ''}
      </span>
      <span class="m-desc">${ui.escapeHtml(modeNote(p))}</span>
    </button></li>`).join('')
    : `<li class="rail-empty">${adult ? '성인' : '일반'} 모드가 없습니다. 설정 → 대화 모드에서 만들 수 있습니다.</li>`;
}

$('nc-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-audience]');
  if (tab) paintModeTab(tab.dataset.audience);
});

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

/* ---------------- 대화 화면 그리기 ---------------- */

// 줄마다 말풍선으로 보여 줄 모드. 직접 만든 모드는 해당하지 않습니다.
const MESSENGER_PRESETS = new Set(['messenger', 'adult-messenger']);

const presetOfChat = (chat) =>
  state.settings.presets.find((p) => p.id === chat?.presetId) ||
  state.settings.presets.find((p) => p.id === state.settings.activePresetId);

const isBubbles = (chat) => chat?.kind !== 'assistant' && MESSENGER_PRESETS.has(presetOfChat(chat)?.id);

/** 이 대화에 함께 등장하는 캐릭터들. 목록에서 지워진 것은 빠집니다. */
const castOf = (chat) => (chat?.castIds || [])
  .map((id) => state.characters.find((c) => c.id === id))
  .filter(Boolean);

/** 답변 위에 붙는 이름. 여럿이 함께 나오면 이름을 이어 붙입니다. */
const charLabel = (chat) =>
  [characterOf(chat)?.name, ...castOf(chat).map((c) => c.name)].filter(Boolean).join(' · ') || '상대';

/* ---------------- 컨텍스트 게이지 ---------------- */

const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));

/**
 * 입력창 아래 막대. 한도 가운데 설정·기억(회색) / 대화(금색) / 답변 여유(옅은 금색)가
 * 얼마씩 차지하는지 보여 줍니다. 대화가 한도를 넘으면 옛 메시지부터 잘려 나갑니다.
 */
function paintContext(info) {
  const gauge = $('ctx-gauge');
  state.context = info || null;
  if (!info || !state.chat) {
    gauge.hidden = true;
    return;
  }
  const { limit, system, history, extra = 0, reserve, kept, dropped, ratio, actual, over } = info;
  const pct = (n) => `${Math.min(100, (n / limit) * 100).toFixed(1)}%`;
  gauge.querySelector('.seg-sys').style.width = pct(system + extra);
  gauge.querySelector('.seg-hist').style.width = pct(history);
  gauge.querySelector('.seg-res').style.width = pct(reserve);
  const used = system + extra + history;
  $('ctx-label').textContent = `${fmtK(used)} / ${fmtK(limit)}` + (dropped ? ` · ${dropped}개 잘림` : '');
  const share = (used + reserve) / limit;
  gauge.classList.toggle('is-over', Boolean(over));
  gauge.classList.toggle('is-warn', !over && share > 0.9);
  gauge.title = [
    `컨텍스트 한도 ${limit.toLocaleString()} 토큰 (설정 → 엔진에서 바꿉니다)`,
    `· 설정·기억·노트 ${system + extra}`,
    `· 대화 ${history} — 최근 메시지 ${kept}개를 보냅니다${dropped ? `, 앞의 ${dropped}개는 잘렸습니다` : ''}`,
    `· 답변 여유 ${reserve} (응답 최대 길이)`,
    actual ? `마지막 요청의 실제 입력: ${actual.toLocaleString()} 토큰` : null,
    ratio && ratio !== 1 ? `어림 보정 ×${ratio} (엔진이 알려 준 실제 토큰 수로 맞춘 값)` : '토큰 수는 글자 수로 어림한 값입니다',
    over ? '한도를 넘습니다. 응답 최대 길이를 줄이거나 컨텍스트 길이를 늘려 주세요.' : null
  ].filter(Boolean).join('\n');
  gauge.hidden = false;
}

/** 대화가 바뀌었을 때(열기·삭제·수정·엔진 변경 등) 게이지를 새로 받습니다. */
async function refreshContext() {
  const chat = state.chat;
  if (!chat) return paintContext(null);
  const info = await api.context(chat.id).catch(() => null);
  if (state.chat === chat) paintContext(info);
}

/** 🎨 버튼과 그림 주소를 그릴 대화에 맞춥니다. 롤플레이 대화이고 설정에서 켰을 때만 보입니다. */
function syncDrawing(chat) {
  ui.setDrawing({ enabled: Boolean(state.settings.image?.enabled) && chat?.kind !== 'assistant', chatId: chat?.id || '' });
}

function paintThread() {
  if (!state.chat) return;
  syncDrawing(state.chat);
  ui.renderThread(state.chat, characterOf(state.chat), personaOf(state.chat), {
    bubbles: isBubbles(state.chat),
    charLabel: charLabel(state.chat)
  });
}

/** 메시지 하나를 그립니다. 생성이 끝났거나 답변을 넘겨볼 때 그 자리를 갈아 끼웁니다. */
function turnFor(chat, message) {
  syncDrawing(chat);
  const assistant = chat.kind === 'assistant';
  const isUser = message.role === 'user';
  return ui.turnEl({
    message,
    speaker: isUser
      ? (assistant ? '나' : personaOf(chat)?.name || '나')
      : (assistant ? '어시스턴트' : charLabel(chat)),
    isUser,
    plain: assistant,
    bubbles: isBubbles(chat)
  });
}

async function send() {
  const input = $('input');
  const content = input.value.trim();
  if (!content || !state.chat || state.run) return;

  input.value = '';
  input.style.height = 'auto';

  let msg;
  try {
    msg = await api.addMessage(state.chat.id, { role: 'user', content });
  } catch (e) {
    // 보내지 못했으면 쓴 글을 되돌려 놓습니다.
    input.value = content;
    ui.toast(`보내지 못했습니다 — ${e.message}`);
    return;
  }
  state.chat.messages.push(msg);
  const assistantMode = state.chat.kind === 'assistant';
  document.getElementById('thread').appendChild(turnFor(state.chat, msg));
  if (assistantMode && state.chat.title === '새 채팅') {
    // 서버와 같은 규칙으로 첫 질문을 제목으로 씁니다.
    state.chat.title = content.slice(0, 24) || '새 채팅';
    $('chat-title').textContent = state.chat.title;
    refreshChatList();
  }
  ui.scrollToEnd({ force: true });
  await run();
}

/**
 * 답변을 받습니다.
 *   new         마지막 턴 다음에 새 답변
 *   regenerate  마지막 답변의 다른 버전. 이전 버전은 ‹ › 로 남습니다
 *   continue    마지막 답변 끝에 이어쓰기
 */
async function run({ mode = 'new' } = {}) {
  if (!state.chat || state.run) return;
  const chat = state.chat;
  const thread = document.getElementById('thread');
  const isOpen = () => state.chat === chat;
  const assistant = chat.kind === 'assistant';
  const format = (t) => ui.formatText(t, { plain: assistant, bubbles: isBubbles(chat) });

  const last = chat.messages[chat.messages.length - 1];
  // 마지막이 내 메시지면 재전송은 그냥 새로 받기(실패한 요청 다시 보내기)입니다.
  const target = mode !== 'new' && last?.role === 'assistant' ? last : null;
  if (mode === 'continue' && !target) return ui.toast('이어 쓸 답변이 없습니다');
  const targetEl = target && thread.querySelector(`[data-mid="${target.id}"]`);

  /*
   * 다른 버전: 지금 답변은 새 버전이 올 때까지 숨겨만 둡니다. 실패하면 되살립니다.
   * 이어쓰기: 지금 답변 칸에 그대로 이어서 그립니다.
   */
  let holder;
  let textEl;
  let base = '';
  if (mode === 'continue') {
    holder = targetEl;
    textEl = targetEl.querySelector('.turn-text');
    base = target.content;
    for (const el of holder.querySelectorAll('.turn-tools, .swipe-nav')) el.hidden = true;
  } else {
    if (targetEl) targetEl.hidden = true;
    holder = turnFor(chat, { id: 'pending', role: 'assistant', content: '' });
    holder.querySelector('.turn-tools').remove();
    thread.appendChild(holder);
    textEl = holder.querySelector('.turn-text');
    // 첫 글자가 올 때까지 빈 칸으로 두면 멈춘 것처럼 보입니다.
    textEl.innerHTML = ui.TYPING;
  }
  ui.scrollToEnd({ force: true });

  let finish;
  const runState = {
    chatId: chat.id,
    controller: new AbortController(),
    stopped: false,
    done: new Promise((resolve) => { finish = resolve; })
  };
  state.run = runState;
  setStreaming(true);
  let acc = '';
  let thought = '';
  let thoughtEl = null;
  let sourcesEl = null;
  let succeeded = false;
  let reload = false;

  try {
    const result = await generate(chat.id, {
      regenerate: mode === 'regenerate',
      resume: mode === 'continue',
      signal: runState.controller.signal,
      onContext: (info) => { if (isOpen()) paintContext(info); },
      onDelta: (d) => {
        acc += d;
        textEl.innerHTML = format(base + acc);
        if (isOpen()) ui.scrollToEnd();
      },
      onThought: (t) => {
        thought += t;
        if (!thoughtEl) {
          thoughtEl = ui.thoughtEl('');
          holder.insertBefore(thoughtEl, textEl);
        }
        thoughtEl.querySelector('.thought-body').textContent = thought;
        if (isOpen()) ui.scrollToEnd();
      },
      onSources: (list) => {
        if (!sourcesEl) {
          sourcesEl = ui.sourcesEl(list);
          textEl.after(sourcesEl);
        } else {
          ui.fillSources(sourcesEl, list);
        }
        if (isOpen()) ui.scrollToEnd();
      }
    });
    if (result.message) {
      succeeded = true;
      const msg = result.message;
      const i = chat.messages.findIndex((m) => m.id === msg.id);
      if (i >= 0) chat.messages[i] = msg;
      else chat.messages.push(msg);
      // 서버가 정리한 본문(넘겨보기 번호 포함)으로 다시 그립니다.
      const fresh = turnFor(chat, msg);
      holder.replaceWith(fresh);
      if (targetEl && targetEl !== holder) targetEl.remove();
      if (isOpen()) ui.scrollToEnd();
    } else if (!runState.stopped && isOpen()) {
      ui.showError('응답이 비어 있습니다. 모델과 프롬프트 설정을 확인해 주세요.');
    }
  } catch (e) {
    // 연결을 끊어서 멈춘 경우엔 서버가 쓰던 답변을 저장했을 수 있어, 끝난 뒤 다시 읽습니다.
    if (e.name === 'AbortError' && runState.stopped) reload = true;
    if (e.name !== 'AbortError' && isOpen()) {
      ui.showError(e.message);
      // 서버가 모델을 감췄을 수 있으니 설정을 다시 읽어 둡니다.
      if (/목록에서 감췄습니다/.test(e.message)) {
        state.settings = await api.settings().catch(() => state.settings);
        paintModelBadge();
      }
    }
  } finally {
    if (!succeeded) {
      if (mode === 'continue') {
        textEl.innerHTML = format(base);
        thoughtEl?.remove();
        for (const el of holder.querySelectorAll('.turn-tools, .swipe-nav')) el.hidden = false;
      } else {
        holder.remove();
        if (targetEl) targetEl.hidden = false;
      }
    }
    if (state.run === runState) state.run = null;
    setStreaming(false);
    finish();
    if (reload && isOpen()) setTimeout(() => { if (isOpen() && !state.run) openChat(chat.id); }, 300);
    else refreshChatList();
    if (succeeded) afterReply(chat);
    if (isOpen()) refreshContext();
  }
}

/**
 * 진행 중인 생성을 멈춥니다. 연결을 끊지 않고 서버에 멈추라고 알려서,
 * 지금까지 쓴 답변이 저장되고 화면에도 그대로 남게 합니다.
 * 서버에 닿지 못하거나 오래 걸리면 연결을 끊습니다.
 */
async function stopGeneration() {
  const runState = state.run;
  if (!runState) return;
  runState.stopped = true;
  const stopped = await api.stopChat(runState.chatId).then((r) => r?.stopped).catch(() => false);
  if (!stopped) runState.controller.abort();
  const timeout = new Promise((resolve) => setTimeout(resolve, 5000, 'timeout'));
  if (await Promise.race([runState.done, timeout]) === 'timeout') runState.controller.abort();
  await runState.done;
}

function setStreaming(on) {
  $('stream-status').hidden = !on;
  $('btn-send').disabled = on;
  $('btn-regen').disabled = on;
  $('btn-continue').disabled = on;
  $('btn-impersonate').disabled = on;
  if (!on) $('stream-label').textContent = '응답 생성 중';
  // 막대가 생기고 사라지면서 입력창 높이가 달라지므로 다시 맞춰 줍니다.
  ui.scrollToEnd();
}

/* ---------------- 장면 그리기 ---------------- */

// 지금 그리는 중인 메시지. 같은 메시지를 두 번 겹쳐 그리지 않게 합니다.
const drawingNow = new Set();

/**
 * 메시지 하나의 장면을 ComfyUI 로 그립니다. 답변 아래에 자리를 잡고 진행 단계를 보여 줍니다.
 * @param {object} [o]
 * @param {string} [o.prompt] 고친 태그 (주면 LLM 을 건너뜀)
 * @param {boolean} [o.random] 무작위 시드 (다시 그리기)
 */
async function drawScene(chat, msg, turn, { prompt, random = false } = {}) {
  if (!chat || drawingNow.has(msg.id)) return;
  drawingNow.add(msg.id);
  const box = turn.querySelector('.turn-images') || (() => {
    const div = document.createElement('div');
    div.className = 'turn-images';
    (turn.querySelector('.swipe-nav') || turn.querySelector('.turn-text')).after(div);
    return div;
  })();
  const slot = document.createElement('figure');
  slot.className = 'turn-image is-pending';
  slot.textContent = prompt ? '그리는 중' : '장면을 읽는 중';
  box.prepend(slot);
  const started = Date.now();
  let label = slot.textContent;
  const tick = setInterval(() => { slot.textContent = `${label} · ${Math.round((Date.now() - started) / 1000)}초`; }, 1000);

  try {
    const result = await drawImage(chat.id, msg.id, {
      prompt,
      random,
      onEvent: (e) => {
        if (e.stage) { label = e.text; slot.textContent = e.text; }
        if (e.prompt) slot.title = e.prompt;
        if (e.removed?.length) ui.toast(`필터로 뺀 태그: ${e.removed.join(', ')}`);
      }
    });
    if (!result.images) throw new Error('그림을 받지 못했습니다.');
    msg.images = result.images;
    // 그리는 동안 다른 대화로 옮겼다면 화면은 건드리지 않습니다.
    const live = state.chat === chat && document.querySelector(`#thread [data-mid="${msg.id}"]`);
    if (live) live.replaceWith(turnFor(chat, msg));
  } catch (e) {
    slot.className = 'turn-image is-error';
    slot.textContent = `${e.message}\n(눌러서 닫기)`;
    slot.addEventListener('click', () => slot.remove(), { once: true });
  } finally {
    clearInterval(tick);
    drawingNow.delete(msg.id);
  }
}

/* --- 이미지 설정 (설정 창의 이미지 탭) --- */

// undefined: 건드리지 않음, null: 기본으로 되돌림, object: 새로 올린 것
let draftWorkflow;

function paintWorkflowStatus() {
  const wf = draftWorkflow === undefined ? state.settings.image?.workflow : draftWorkflow;
  $('i-workflow-status').textContent = wf
    ? `올린 워크플로 사용 중 — 노드 ${Object.keys(wf).length}개${draftWorkflow ? ' (저장 전)' : ''}`
    : '기본 SDXL 워크플로 사용 중 — 체크포인트만 고르면 됩니다';
}

function fillImageSheet() {
  const img = state.settings.image || {};
  draftWorkflow = undefined;
  $('i-enabled').checked = Boolean(img.enabled);
  $('i-baseurl').value = img.baseUrl || '';
  $('i-checkpoint').value = img.checkpoint || '';
  const size = `${img.width}x${img.height}`;
  const sel = $('i-size');
  if (![...sel.options].some((o) => o.value === size)) sel.add(new Option(`지금 값 ${img.width}×${img.height}`, size));
  sel.value = size;
  $('i-steps').value = img.steps;
  $('i-cfg').value = img.cfg;
  $('i-sampler').value = img.sampler || '';
  $('i-prefix').value = img.prefix || '';
  $('i-negative').value = img.negative || '';
  $('i-free').checked = img.freeAfter !== false;
  $('i-force').value = img.adult?.forceTags || '';
  $('i-block').value = img.adult?.blockTags || '';
  $('i-extra-neg').value = img.adult?.extraNegative || '';
  $('i-core-terms').textContent = `차단: ${(state.settings.imageCore?.blockTerms || []).join(', ')} · 17세 이하 나이 표기`;
  $('i-core-neg').textContent = `늘 붙는 네거티브: ${state.settings.imageCore?.negative || ''}`;
  paintWorkflowStatus();
}

$('i-check').addEventListener('click', async () => {
  const baseUrl = $('i-baseurl').value.trim();
  $('i-status').textContent = '연결하는 중…';
  try {
    const { checkpoints } = await api.imageCheckpoints(baseUrl);
    $('i-ckpts').innerHTML = checkpoints.map((c) => `<option value="${ui.escapeHtml(c)}">`).join('');
    if (!$('i-checkpoint').value && checkpoints.length) $('i-checkpoint').value = checkpoints[0];
    $('i-status').textContent = checkpoints.length
      ? `연결됐습니다 — 체크포인트 ${checkpoints.length}개. 입력칸을 누르면 목록이 나옵니다.`
      : '연결됐지만 체크포인트가 없습니다. ComfyUI 의 models/checkpoints 폴더를 확인해 주세요.';
  } catch (e) {
    $('i-status').textContent = `연결하지 못했습니다 — ${e.message}`;
  }
});

$('i-workflow-upload').addEventListener('click', () => {
  $('i-workflow-file').value = '';
  $('i-workflow-file').click();
});

$('i-workflow-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const nodes = Object.values(json || {});
    if (!nodes.length || !nodes.every((n) => n?.class_type && n?.inputs)) {
      return ui.toast('API 형식 워크플로가 아닙니다. ComfyUI 에서 Save (API Format) 으로 내보내 주세요.');
    }
    const text = JSON.stringify(json);
    if (!text.includes('{{prompt}}')) {
      ui.toast('워크플로에 {{prompt}} 자리가 없습니다. 긍정 프롬프트 칸에 {{prompt}} 를 적어 두어야 장면이 들어갑니다.');
    }
    draftWorkflow = json;
    paintWorkflowStatus();
  } catch {
    ui.toast('JSON 파일을 읽지 못했습니다.');
  }
});

$('i-workflow-reset').addEventListener('click', () => {
  draftWorkflow = null;
  paintWorkflowStatus();
});

function readImageSheet() {
  const [width, height] = $('i-size').value.split('x').map(Number);
  const image = {
    enabled: $('i-enabled').checked,
    baseUrl: $('i-baseurl').value.trim(),
    checkpoint: $('i-checkpoint').value.trim(),
    width,
    height,
    steps: Number($('i-steps').value),
    cfg: Number($('i-cfg').value),
    sampler: $('i-sampler').value.trim() || 'euler_ancestral',
    prefix: $('i-prefix').value.trim(),
    negative: $('i-negative').value.trim(),
    freeAfter: $('i-free').checked,
    adult: {
      forceTags: $('i-force').value.trim(),
      blockTags: $('i-block').value.trim(),
      extraNegative: $('i-extra-neg').value.trim()
    }
  };
  if (draftWorkflow !== undefined) image.workflow = draftWorkflow;
  return image;
}

/* ---------------- 대신 쓰기 ---------------- */

/**
 * 내 다음 차례를 AI 가 초안으로 씁니다. 입력창에 흘려 넣기만 하고 보내지는 않습니다.
 * 입력창에 미리 적어 둔 글은 '이런 방향으로' 라는 힌트로 넘깁니다.
 */
async function draftMyTurn() {
  const chat = state.chat;
  if (!chat || chat.kind === 'assistant' || state.run) return;
  const input = $('input');
  const hint = input.value.trim();

  let finish;
  const runState = {
    chatId: chat.id,
    controller: new AbortController(),
    stopped: false,
    done: new Promise((resolve) => { finish = resolve; })
  };
  state.run = runState;
  setStreaming(true);
  $('stream-label').textContent = hint ? '적어 둔 방향으로 초안 쓰는 중' : '내 차례 초안 쓰는 중';
  input.readOnly = true;

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  };
  // 모델이 앞에 붙이는 '내이름:' 은 보여 주지 않습니다. 서버도 끝에서 같은 정리를 합니다.
  const me = personaOf(chat)?.name || '';
  const tidy = (t) => (me
    ? t.replace(new RegExp(`^\\s*(\\*\\*)?${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\*\\*)?\\s*[:：]\\s*`), '')
    : t).trimStart();
  let acc = '';
  try {
    const result = await impersonate(chat.id, {
      hint,
      signal: runState.controller.signal,
      onDelta: (d) => {
        acc += d;
        if (state.chat === chat) { input.value = tidy(acc); grow(); }
      }
    });
    if (state.chat !== chat) return;
    if (result.draft) {
      input.value = result.draft;
      ui.toast('초안을 넣었습니다. 고친 뒤 보내세요');
    } else {
      input.value = hint;
      if (!runState.stopped) ui.toast('초안이 비어 있습니다. 다시 눌러 보세요');
    }
  } catch (e) {
    if (state.chat === chat) {
      // 멈췄으면 쓰던 데까지 두고, 실패했으면 원래 적어 둔 글로 되돌립니다.
      input.value = e.name === 'AbortError' && acc.trim() ? tidy(acc).trim() : hint;
      if (e.name !== 'AbortError') ui.toast(`초안을 쓰지 못했습니다 — ${e.message}`);
    }
  } finally {
    input.readOnly = false;
    grow();
    if (state.run === runState) state.run = null;
    setStreaming(false);
    finish();
    if (state.chat === chat) input.focus();
  }
}

$('btn-impersonate').addEventListener('click', draftMyTurn);

/* ---------------- 기억 요약 ---------------- */

/**
 * 컨텍스트 밖으로 밀려났는데 아직 요약에 안 들어간 메시지 수.
 * 어디까지 들어가는지는 토큰 예산으로 서버가 정하므로, 게이지와 함께 받은 값을 씁니다.
 */
function pendingCount(chat) {
  if (state.chat === chat && state.context) return state.context.pendingSummary ?? 0;
  return 0;
}

/** 답변이 끝난 뒤 뒤에서 기억을 정리합니다. 로컬 엔진이 한 번에 하나씩만 받으므로 차례로 돌립니다. */
async function afterReply(chat) {
  await autoFacts(chat);
  await autoSummarize(chat);
}

/** 마지막 기억 확인 뒤로 쌓인 답변 수. 서버와 같은 규칙입니다. */
function turnsSinceFacts(chat) {
  const since = Number(chat.factsUntilAt) || 0;
  return chat.messages.filter((m) => m.role === 'assistant' && m.content?.trim() && (m.at || 0) > since).length;
}

/** 답변 4개마다 최근 대화에서 오래 남길 사실을 뽑습니다. 새 항목이 생기면 알려 줍니다. */
async function autoFacts(chat) {
  if (chat.kind === 'assistant' || state.settings.memory?.autoFacts === false) return;
  if (turnsSinceFacts(chat) < 4) return;
  try {
    const r = await api.extractFacts(chat.id, true);
    if (r.skipped) return;
    chat.facts = r.facts;
    chat.factsUntilAt = r.factsUntilAt;
    if (state.chat === chat && r.added.length) {
      const more = r.added.length > 1 ? ` 외 ${r.added.length - 1}개` : '';
      ui.toast(`기억함: ${r.added[0].text}${more}`);
    }
  } catch { /* 자동 기억은 실패해도 대화를 막지 않습니다 */ }
}

/** 답변이 끝난 뒤 조용히 돕니다. 밀린 메시지가 기준보다 적으면 요청도 보내지 않습니다. */
async function autoSummarize(chat) {
  if (chat.kind === 'assistant' || !state.settings.memory?.autoSummarize) return;
  // 답변이 붙으며 잘리는 범위가 바뀌었으니 새로 받아 봅니다.
  if (state.chat === chat) await refreshContext();
  if (pendingCount(chat) < 10) return;
  try {
    const r = await api.summarize(chat.id, true);
    if (!r.summarized) return;
    chat.memory = r.memory;
    chat.summaryUntilAt = r.summaryUntilAt;
    if (state.chat === chat) {
      ui.toast(`오래된 대화 ${r.summarized}개를 기억에 요약했습니다`);
      refreshContext();
    }
  } catch { /* 자동 요약은 실패해도 대화를 막지 않습니다 */ }
}

const dlgMemory = $('dlg-memory');

function paintMemoryStatus(chat) {
  const pending = pendingCount(chat);
  $('m-status').textContent = pending
    ? `아직 요약하지 않은 옛 메시지 ${pending}개`
    : chat.summaryUntilAt ? '밀려난 대화를 모두 요약했습니다' : '아직 기억할 메시지 수를 넘지 않았습니다';
  $('m-summarize').disabled = !pending;
}

/* 창에서 고치는 동안의 사실 목록 사본. 저장을 눌러야 서버에 들어갑니다. */
let draftFacts = [];

function paintFacts() {
  const esc = ui.escapeHtml;
  $('f-list').innerHTML = draftFacts.length
    ? draftFacts.map((f) => `<li class="fact-row${f.pinned ? ' is-pinned' : ''}" data-fact="${esc(f.id)}">
        <input class="fact-text" value="${esc(f.text)}" maxlength="240" aria-label="기억 항목">
        <span class="fact-tag" title="${f.auto ? 'AI 가 뽑은 항목' : '직접 적거나 고친 항목'}">${f.auto ? '자동' : '직접'}</span>
        <button type="button" class="tool" data-pin aria-pressed="${f.pinned}" title="고정하면 AI 가 고치거나 지우지 않습니다">📌</button>
        <button type="button" class="tool" data-del title="삭제">✕</button>
      </li>`).join('')
    : '<li class="rail-empty">아직 없습니다. 대화가 쌓이면 자동으로 채워집니다.</li>';
}

function paintFactStatus(chat) {
  const left = Math.max(0, 4 - turnsSinceFacts(chat));
  $('f-status').textContent = `${draftFacts.length}개 · ` +
    (left ? `답변 ${left}개 뒤 자동 확인` : '다음 답변 뒤 자동 확인');
}

$('f-list').addEventListener('input', (e) => {
  const row = e.target.closest('[data-fact]');
  const fact = draftFacts.find((f) => f.id === row?.dataset.fact);
  if (!fact) return;
  fact.text = e.target.value;
  // 사람이 고친 항목은 AI 가 다시 바꾸지 않도록 '직접' 으로 돌립니다.
  if (fact.auto) {
    fact.auto = false;
    row.querySelector('.fact-tag').textContent = '직접';
  }
});

$('f-list').addEventListener('click', (e) => {
  const row = e.target.closest('[data-fact]');
  const fact = draftFacts.find((f) => f.id === row?.dataset.fact);
  if (!fact) return;
  if (e.target.closest('[data-pin]')) fact.pinned = !fact.pinned;
  else if (e.target.closest('[data-del]')) draftFacts = draftFacts.filter((f) => f !== fact);
  else return;
  paintFacts();
  paintFactStatus(state.chat);
});

function addFact() {
  const text = $('f-new').value.trim();
  if (!text) return;
  draftFacts.push({ id: `u${Date.now().toString(36)}`, text, pinned: false, auto: false, sourceIds: [] });
  $('f-new').value = '';
  paintFacts();
  paintFactStatus(state.chat);
}
$('f-add').addEventListener('click', addFact);
$('f-new').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addFact(); }
});

const keptFacts = () => draftFacts.filter((f) => f.text.trim());

$('f-extract').addEventListener('click', async () => {
  const chat = state.chat;
  if (!chat) return;
  const btn = $('f-extract');
  btn.disabled = true;
  btn.textContent = '확인하는 중…';
  try {
    // 창에서 고친 목록을 먼저 저장해야 AI 가 그걸 보고 판단합니다.
    await api.updateChat(chat.id, { facts: keptFacts() });
    const r = await api.extractFacts(chat.id, false);
    chat.facts = r.facts;
    chat.factsUntilAt = r.factsUntilAt;
    draftFacts = structuredClone(r.facts);
    paintFacts();
    const changes = r.added.length + r.updated.length + r.removed.length;
    ui.toast(r.skipped ? '확인할 새 대화가 없습니다'
      : changes ? `추가 ${r.added.length} · 수정 ${r.updated.length} · 삭제 ${r.removed.length}` : '바뀐 것이 없습니다');
  } catch (err) {
    ui.toast(`확인하지 못했습니다 — ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '지금 확인하기';
    paintFactStatus(chat);
  }
});

$('btn-memory').addEventListener('click', async () => {
  if (!state.chat) return;
  const chat = state.chat;
  // 뒤에서 기억이 바뀌었거나 메시지를 지워 항목이 치워졌을 수 있어 새로 읽습니다.
  const fresh = await api.chat(chat.id).catch(() => null);
  if (fresh) {
    for (const k of ['facts', 'factsUntilAt', 'memory', 'summaryUntilAt', 'authorNote']) chat[k] = fresh[k];
  }
  await refreshContext();
  draftFacts = structuredClone(chat.facts || []);
  paintFacts();
  paintFactStatus(chat);
  $('f-auto').checked = state.settings.memory?.autoFacts !== false;
  $('m-memory').value = chat.memory || '';
  $('m-note').value = chat.authorNote || '';
  $('m-auto').checked = state.settings.memory?.autoSummarize !== false;
  paintMemoryStatus(chat);
  dlgMemory.showModal();
});

$('m-cancel').addEventListener('click', () => dlgMemory.close('cancel'));

$('m-summarize').addEventListener('click', async () => {
  const chat = state.chat;
  if (!chat) return;
  const btn = $('m-summarize');
  btn.disabled = true;
  btn.textContent = '요약하는 중…';
  try {
    // 손으로 고친 기억이 있으면 먼저 저장해야 요약이 그 위에 쌓입니다.
    await api.updateChat(chat.id, { memory: $('m-memory').value });
    chat.memory = $('m-memory').value;
    const r = await api.summarize(chat.id, false);
    chat.memory = r.memory;
    chat.summaryUntilAt = r.summaryUntilAt;
    $('m-memory').value = r.memory;
    ui.toast(r.summarized ? `옛 메시지 ${r.summarized}개를 요약했습니다` : '요약할 메시지가 없습니다');
    await refreshContext();
  } catch (e) {
    ui.toast(`요약하지 못했습니다 — ${e.message}`);
  } finally {
    btn.textContent = '지금 요약하기';
    paintMemoryStatus(chat);
  }
});

dlgMemory.addEventListener('close', async () => {
  if (dlgMemory.returnValue !== 'save' || !state.chat) return;
  const chat = state.chat;
  const patch = { memory: $('m-memory').value.trim(), authorNote: $('m-note').value.trim(), facts: keptFacts() };
  const memory = { autoSummarize: $('m-auto').checked, autoFacts: $('f-auto').checked };
  try {
    const saved = await api.updateChat(chat.id, patch);
    Object.assign(chat, patch, { facts: saved.facts });
    const now = state.settings.memory || {};
    if (memory.autoSummarize !== (now.autoSummarize !== false) || memory.autoFacts !== (now.autoFacts !== false)) {
      state.settings = await api.saveSettings({ memory });
    }
    ui.toast('기억과 작가 노트를 저장했습니다');
    refreshContext();
  } catch (e) {
    dlgMemory.returnValue = '';
    dlgMemory.showModal();
    ui.toast(`저장하지 못했습니다 — ${e.message}`);
  }
});

/* ---------------- 함께 등장하는 인물 ---------------- */

const dlgCast = $('dlg-cast');

$('btn-cast').addEventListener('click', () => {
  if (!state.chat) return;
  const chosen = new Set(state.chat.castIds || []);
  const others = state.characters.filter((c) => c.id !== state.chat.characterId);
  const esc = ui.escapeHtml;
  $('cast-list').innerHTML = others.length
    ? others.map((c) => `<li class="persona-row">
        <label class="check-row grow">
          <input type="checkbox" value="${c.id}" ${chosen.has(c.id) ? 'checked' : ''}>
          <span><span class="p-name">${esc(c.avatar || '◦')} ${esc(c.name)}</span>
          <span class="p-desc">${esc(c.description || c.tags || '')}</span></span>
        </label>
      </li>`).join('')
    : '<li class="rail-empty">함께 부를 다른 캐릭터가 없습니다. 먼저 캐릭터를 만들어 주세요.</li>';
  dlgCast.showModal();
});

$('cast-list').addEventListener('change', () => {
  // 서버도 8명에서 자릅니다. 넘기지 못하게 미리 막습니다.
  const boxes = [...$('cast-list').querySelectorAll('input[type=checkbox]')];
  const full = boxes.filter((b) => b.checked).length >= 8;
  for (const b of boxes) b.disabled = full && !b.checked;
});

$('cast-cancel').addEventListener('click', () => dlgCast.close('cancel'));

dlgCast.addEventListener('close', async () => {
  if (dlgCast.returnValue !== 'save' || !state.chat) return;
  const chat = state.chat;
  const castIds = [...$('cast-list').querySelectorAll('input:checked')].map((b) => b.value);
  try {
    const saved = await api.updateChat(chat.id, { castIds });
    chat.castIds = saved.castIds || [];
  } catch (e) {
    return ui.toast(`저장하지 못했습니다 — ${e.message}`);
  }
  if (state.chat !== chat) return;
  paintChatSub();
  if (!state.run) paintThread();
  refreshContext();
  const names = castOf(chat).map((c) => c.name);
  ui.toast(names.length ? `함께 등장: ${names.join(', ')}` : '함께 등장하는 인물을 모두 뺐습니다');
});

/* ---------------- 메시지 편집 ---------------- */

document.getElementById('messages').addEventListener('click', async (e) => {
  const btn = e.target.closest('.tool');
  if (!btn) return;
  const turn = btn.closest('.turn');
  const mid = turn.dataset.mid;
  const msg = state.chat.messages.find((m) => m.id === mid);
  if (!msg) return;

  if (btn.dataset.act === 'draw') return drawScene(state.chat, msg, turn);
  if (btn.dataset.act.startsWith('img-')) {
    const imgId = btn.closest('[data-img]')?.dataset.img;
    const img = msg.images?.find((x) => x.id === imgId);
    if (!img) return;
    if (btn.dataset.act === 'img-redraw') return drawScene(state.chat, msg, turn, { prompt: img.prompt, random: true });
    if (btn.dataset.act === 'img-edit') {
      const edited = window.prompt('그림 태그 (쉼표로 구분). 품질 태그·필터는 저장 시 다시 적용됩니다.', img.prompt);
      if (edited?.trim()) drawScene(state.chat, msg, turn, { prompt: edited.trim(), random: true });
      return;
    }
    if (btn.dataset.act === 'img-del') {
      if (!confirm('이 그림을 지울까요?')) return;
      try {
        await api.deleteImage(state.chat.id, mid, imgId);
        msg.images = msg.images.filter((x) => x !== img);
        turn.replaceWith(turnFor(state.chat, msg));
      } catch (err) {
        ui.toast(`지우지 못했습니다 — ${err.message}`);
      }
    }
    return;
  }

  if (btn.dataset.act === 'swipe-prev' || btn.dataset.act === 'swipe-next') {
    if (state.run) return;
    const chat = state.chat;
    const total = msg.swipes?.length || 0;
    const next = (msg.swipeIndex ?? total - 1) + (btn.dataset.act === 'swipe-next' ? 1 : -1);
    // 마지막 장에서 › 를 누르면 새 버전을 씁니다. 마지막 답변일 때만.
    if (next >= total) {
      if (chat.messages[chat.messages.length - 1] === msg) run({ mode: 'regenerate' });
      return;
    }
    if (next < 0) return;
    try {
      const updated = await api.swipe(chat.id, mid, next);
      Object.assign(msg, updated);
      if (!updated.thought) delete msg.thought;
      if (!updated.sources) delete msg.sources;
      if (state.chat === chat) turn.replaceWith(turnFor(chat, msg));
      refreshChatList();
      refreshContext();
    } catch (err) {
      ui.toast(`넘기지 못했습니다 — ${err.message}`);
    }
    return;
  }

  if (btn.dataset.act === 'copy') {
    ui.toast(await ui.copyText(msg.content) ? '복사했습니다' : '복사하지 못했습니다. 직접 선택해 복사해 주세요.');
    return;
  }

  if (btn.dataset.act === 'delete') {
    await api.deleteMessage(state.chat.id, mid);
    state.chat.messages = state.chat.messages.filter((m) => m.id !== mid);
    turn.remove();
    refreshChatList();
    refreshContext();
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
      next.className = isBubbles(state.chat) ? 'turn-text is-bubbles' : 'turn-text';
      if (keep && ta.value.trim() !== msg.content) {
        msg.content = ta.value.trim();
        await api.editMessage(state.chat.id, mid, msg.content);
        refreshContext();
      }
      next.innerHTML = ui.formatText(msg.content, { plain: state.chat.kind === 'assistant', bubbles: isBubbles(state.chat) });
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
  // 1회성 캐릭터는 목록에 없어도 되므로, 목록이 비었는지는 그다음에 봅니다.
  if (state.chat?.character) newRpChat({ inline: { ...state.chat.character } });
  else if (state.chat?.characterId) newRpChat({ id: state.chat.characterId });
  else if (!state.characters.length) ui.toast('먼저 캐릭터를 만들어 주세요');
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
$('btn-regen').addEventListener('click', () => run({ mode: 'regenerate' }));
$('btn-continue').addEventListener('click', () => run({ mode: 'continue' }));
$('btn-stop').addEventListener('click', () => stopGeneration());

/* ---------------- 캐릭터 시트 ---------------- */

const CHAR_FIELDS = ['avatar', 'name', 'tags', 'description', 'appearance', 'personality',
  'speech', 'scenario', 'greeting', 'exampleDialogue', 'notes'];
const dlgChar = $('dlg-character');

function openCharacterDialog(ch) {
  state.editingCharacterId = ch?.id || null;
  $('char-dlg-title').textContent = ch ? `${ch.name} 고치기` : '캐릭터 만들기';
  $('c-delete').hidden = !ch;
  // 이미 저장된 캐릭터를 고칠 때는 '이번만 쓰기' 가 뜻이 없습니다.
  $('c-once').hidden = Boolean(ch?.id);
  for (const f of CHAR_FIELDS) $(`c-${f}`).value = ch?.[f] || '';
  $('c-brief').value = '';
  draftNote('');
  dlgChar.showModal();
}

/* --- 줄글 → 캐릭터 시트 --- */

const draftNote = (text = '') => { $('c-draft-note').textContent = text; };

$('c-draft').addEventListener('click', async () => {
  const brief = $('c-brief').value.trim();
  if (!brief) return ui.toast('어떤 캐릭터인지 적어 주세요');

  // 이미 채워 둔 칸은 모델에게 '정해진 것' 으로 넘기고, 응답에서도 덮어쓰지 않습니다.
  const current = Object.fromEntries(
    CHAR_FIELDS.map((f) => [f, $(`c-${f}`).value.trim()]).filter(([, v]) => v)
  );

  const btn = $('c-draft');
  btn.disabled = true;
  btn.textContent = '쓰는 중…';
  draftNote('모델에 따라 30초 남짓 걸립니다. 형식이 안 맞으면 한 번 더 시도합니다.');
  try {
    const { character, fallback, reason } = await api.draftCharacter(brief, current);
    for (const f of CHAR_FIELDS) if (character[f]) $(`c-${f}`).value = character[f];
    // fallback 이어도 에러가 아니라, 채워진 만큼만 온 것입니다 — 계속 진행합니다.
    draftNote(fallback ? `일부만 채워졌습니다 — ${reason}` : '채웠습니다. 고친 뒤 저장하세요.');
  } catch (e) {
    draftNote('');
    ui.toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 로 채우기';
  }
});

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
  // 서버가 지운 캐릭터의 대화를 1회성 캐릭터로 바꿔 두었으니, 열린 대화를 다시 읽습니다.
  // 고친 경우에도 이름·소개가 화면 곳곳에 반영되도록 같은 길로 다시 그립니다.
  if (state.chat && !state.run && state.chat.kind !== 'assistant') await openChat(state.chat.id);
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
  showSeeds(null);
  seedNote('');
  state.personas = await api.personas();
  ui.renderPersonaList(state.personas, state.settings.activePersonaId);
  paintChatPersona();
});

/* --- 랜덤 페르소나 --- */

// 지금 화면에 떠 있는 씨앗 태그. 칩을 눌러 항목 하나만 다시 굴릴 때 기준이 됩니다.
let seedDraft = null;
let seedFields = [];

function showSeeds(seeds, fields) {
  seedDraft = seeds;
  if (fields?.length) seedFields = fields;
  ui.renderSeedChips(seedDraft, seedFields);
  $('p-seed-actions').hidden = !seedDraft;
  if (seedDraft?.name) $('p-name').value = seedDraft.name;
}

const seedNote = (text = '') => { $('p-seed-note').textContent = text; };
const isAdultPersona = () => $('p-adult').checked;

async function rollSeeds(only = null) {
  try {
    const { seeds, fields } = await api.rollPersonaSeeds(only ? seedDraft : {}, only, isAdultPersona());
    showSeeds(seeds, fields);
    seedNote('');
  } catch (e) {
    ui.toast(e.message);
  }
}

$('p-roll').addEventListener('click', () => rollSeeds());

// 성인 여부를 바꾸면 풀이 통째로 달라지므로, 지금 뽑힌 태그는 버리고 다시 시작합니다.
$('p-adult').addEventListener('change', () => {
  showSeeds(null);
  seedNote('');
});

$('p-seeds').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-key]');
  if (chip) rollSeeds([chip.dataset.key]);
});

$('p-write').addEventListener('click', async () => {
  if (!seedDraft) return;
  const btn = $('p-write');
  btn.disabled = true;
  btn.textContent = '쓰는 중…';
  seedNote('');
  try {
    const out = await api.generatePersona(seedDraft, isAdultPersona());
    showSeeds(out.seeds);
    $('p-name').value = out.name || $('p-name').value;
    $('p-description').value = out.description;
    // 모델을 못 쓰면 태그만으로 만든 문장이 옵니다. 왜 그런지 알려 줘야 고칠 수 있습니다.
    seedNote(out.fallback ? `태그만으로 만들었습니다 — ${out.reason}` : '마음에 들면 아래 버튼으로 추가하세요.');
  } catch (e) {
    ui.toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '문장 만들기';
  }
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
  // 지운 페르소나를 쓰던 대화는 기본 페르소나로 돌아가므로 상단도 다시 그립니다.
  paintChatPersona();
  paintChatSub();
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
  $('s-context').value = cfg.contextTokens || '';
  $('s-context').placeholder = key === 'lmstudio' || /localhost|127\.0\.0\.1|192\.168\./.test(cfg.baseUrl || '') ? '16384' : '128000';
  $('s-key-field').hidden = key === 'lmstudio';
  $('s-model-msg').textContent = key === 'lmstudio'
    ? 'LM Studio 의 Developer 탭에서 서버를 켠 뒤 불러오기를 눌러 주세요.'
    : key === 'ollama'
      ? 'ollama.com/settings/keys 에서 만든 API 키를 넣고 불러오기를 누르세요. 로컬 Ollama 는 주소를 http://localhost:11434/v1 로 바꾸면 키 없이 됩니다.'
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
  const contextTokens = Number($('s-context').value);
  Object.assign(draftProviders[shownProvider], {
    baseUrl: $('s-baseurl').value.trim(),
    model: $('s-model').value.trim(),
    // 비워 두면 서버가 엔진 종류에 맞는 기본값을 씁니다.
    contextTokens: contextTokens >= 1024 ? contextTokens : null
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

/* ---------- 설정 탭 ---------- */

const SETTINGS_TABS = [...$('s-tabs').querySelectorAll('[data-tab]')].map((t) => t.dataset.tab);

/** 마지막으로 본 탭. 다시 열 때 그 탭으로 엽니다. 브라우저에 저장 못 해도 동작에는 지장 없습니다. */
function lastSettingsTab() {
  try {
    const tab = localStorage.getItem('settingsTab');
    return SETTINGS_TABS.includes(tab) ? tab : SETTINGS_TABS[0];
  } catch {
    return SETTINGS_TABS[0];
  }
}

function showSettingsTab(tab) {
  if (!SETTINGS_TABS.includes(tab)) tab = SETTINGS_TABS[0];
  for (const btn of $('s-tabs').querySelectorAll('[data-tab]')) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    // 좁은 화면에서는 탭이 가로로 흐르므로, 고른 탭이 가려져 있으면 보이는 곳으로 당깁니다.
    if (on) btn.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  for (const pane of dlgSettings.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== tab;
  closeCombo();
  try { localStorage.setItem('settingsTab', tab); } catch { /* 저장 못 해도 괜찮습니다 */ }
}

$('s-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) showSettingsTab(btn.dataset.tab);
});

// 탭 목록 안에서는 화살표로 옮겨 다닙니다.
$('s-tabs').addEventListener('keydown', (e) => {
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const now = SETTINGS_TABS.indexOf($('s-tabs').querySelector('.is-on')?.dataset.tab);
  const next = SETTINGS_TABS[(now + step + SETTINGS_TABS.length) % SETTINGS_TABS.length];
  showSettingsTab(next);
  $('s-tabs').querySelector(`[data-tab="${next}"]`).focus();
});

$('btn-settings').addEventListener('click', () => openSettings());

/** 설정 창을 엽니다. 모든 탭의 입력칸을 지금 설정으로 채운 뒤 tab 을 보여 줍니다. */
async function openSettings(tab = lastSettingsTab()) {
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
  fillImageSheet();
  fillDevSheet();
  showSettingsTab(tab);
  dlgSettings.showModal();
  // 창이 뜨기 전에는 스크롤이 먹지 않으므로, 연 뒤에 고른 탭을 한 번 더 보이게 합니다.
  // 좁은 화면에서는 가로로 스크롤되는 탭 줄 자체가 첫 포커스를 받아 테두리가 생기므로, 고른 탭에 포커스를 둡니다.
  const current = $('s-tabs').querySelector('.is-on');
  current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  current?.focus({ preventScroll: true });
}

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

/* ---------- 백업 불러오기 ---------- */

$('s-import').addEventListener('click', () => {
  $('s-import-file').value = '';
  $('s-import-file').click();
});

$('s-import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return ui.toast('JSON 파일을 읽지 못했습니다. 백업 내려받기로 받은 파일인지 확인해 주세요.');
  }
  const count = (k) => (Array.isArray(data?.[k]) ? data[k].length : 0);
  const summary = `캐릭터 ${count('characters')}개, 페르소나 ${count('personas')}개, 대화 ${count('chats')}개`;
  if (!confirm(`${file.name}\n${summary}\n\n지금 데이터에 합칩니다. 이미 있는 항목은 건너뜁니다. 계속할까요?`)) return;
  const includeSettings = Boolean(data?.settings) && confirm(
    '설정(샘플링 값·어시스턴트 프롬프트·테마·표기법)도 백업의 값으로 덮어쓸까요?\n' +
    '취소를 누르면 지금 설정을 그대로 둡니다. 엔진 주소와 API 키는 어느 쪽이든 바뀌지 않습니다.'
  );

  let result;
  try {
    result = await api.importBackup(data, includeSettings);
  } catch (err) {
    return ui.toast(`불러오지 못했습니다 — ${err.message}`);
  }

  // 설정 창에 떠 있던 입력값은 옛 값이므로 저장하지 않고 닫은 뒤 전부 다시 읽습니다.
  dlgSettings.close('cancel');
  [state.settings, state.characters, state.personas] = await Promise.all([
    api.settings(), api.characters(), api.personas()
  ]);
  applyDev(state.settings.dev);
  paintAdultRules();
  ui.renderCharacterList(state.characters);
  paintModelBadge();
  await refreshChatList();
  if (state.chat && !state.run) await openChat(state.chat.id);

  const { characters, personas, chats } = result;
  const skipped = characters.skipped + personas.skipped + chats.skipped;
  ui.toast(
    `불러왔습니다 — 캐릭터 ${characters.added}, 페르소나 ${personas.added}, 대화 ${chats.added}` +
    (skipped ? ` (이미 있거나 읽을 수 없는 ${skipped}개 건너뜀)` : '') +
    (result.settings ? ' · 설정 반영' : '')
  );
});

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

/** 서버가 거부한 이유를 보고, 고칠 칸이 있는 탭을 짐작합니다. */
const tabForError = (message = '') =>
  /ComfyUI|워크플로/.test(message) ? 'image' : /엔진 주소/.test(message) ? 'engine' : null;

dlgSettings.addEventListener('close', async () => {
  if (dlgSettings.returnValue !== 'save') {
    // 테마·표기법은 고르는 즉시 미리 보여 주므로, 저장하지 않고 닫으면 원래대로 돌립니다.
    applyDev(state.settings.dev);
    if (!state.run) paintThread();
    return;
  }
  stashProvider();
  stashPreset();
  const wasImageOn = Boolean(state.settings.image?.enabled);
  let imageOn;
  try {
    const body = settingsFromSheet();
    imageOn = body.image.enabled;
    state.settings = await api.saveSettings(body);
  } catch (e) {
    // 저장이 거부되면 입력한 그대로 창을 다시 열어 고칠 수 있게 합니다.
    dlgSettings.returnValue = '';
    dlgSettings.showModal();
    const tab = tabForError(e.message);
    if (tab) showSettingsTab(tab);
    ui.toast(`저장하지 못했습니다 — ${e.message}`);
    return;
  }
  removedProviders = [];
  applyDev(state.settings.dev);
  paintAdultRules();
  paintModelBadge();
  paintChatPreset();
  await refreshChatList();
  refreshContext();
  // 🎨 버튼과 표기법이 바뀌었을 수 있어 다시 그립니다.
  if (!state.run) paintThread();
  ui.toast(imageOn && !wasImageOn
    ? '설정을 저장했습니다 — 답변 아래 🎨 그리기로 장면을 그려 보세요'
    : '설정을 저장했습니다');
});

/** 모든 탭의 입력을 한 번에 저장할 요청 본문으로 모읍니다. */
function settingsFromSheet() {
  return {
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
    },
    removeProviders: removedProviders,
    image: readImageSheet(),
    dev: readDevSheet()
  };
}

enhanceSelects();
ui.watchScroll();
boot().catch((e) => ui.showError(`앱을 시작하지 못했습니다 — ${e.message}`));

/* ---------------- 화면·개발자 탭, 엔진 추가 ---------------- */

let draftDev = null;
// 엔진 추가·삭제는 엔진 탭의 draftProviders 에 바로 반영하고, 지운 것은 저장할 때 서버에 알립니다.
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
  const list = Object.entries(draftProviders);
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
  removedProviders = [];

  for (const [id, key] of Object.entries(MARKUP_FIELDS)) $(id).checked = Boolean(draftDev.markup[key]);
  $('d-particle').checked = Boolean(draftDev.particleFix);
  $('d-adult-cloud').checked = draftDev.adultCloud === true;
  paintAdultCloudRow(draftDev.adultCloud === true);
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
  return { particleFix: $('d-particle').checked, adultCloud: $('d-adult-cloud').checked, markup, theme };
}

/**
 * 성인 모드 클라우드 허용 칸은 평소에 숨겨 둡니다. 켜져 있거나 경고를 확인했을 때만 보입니다.
 * 끄고 저장하면 다음에 열 때 다시 숨겨집니다.
 */
function paintAdultCloudRow(shown) {
  $('d-adult-cloud-row').hidden = !shown;
  $('d-adult-cloud-unlock').hidden = shown;
}

const dlgAdultCloud = $('dlg-adult-cloud');

$('d-adult-cloud-unlock').addEventListener('click', () => {
  $('ac-agree').checked = false;
  $('ac-confirm').disabled = true;
  dlgAdultCloud.returnValue = '';
  dlgAdultCloud.showModal();
});

$('ac-agree').addEventListener('change', () => {
  $('ac-confirm').disabled = !$('ac-agree').checked;
});

dlgAdultCloud.addEventListener('close', () => {
  if (dlgAdultCloud.returnValue !== 'unlock' || !$('ac-agree').checked) return;
  $('d-adult-cloud').checked = true;
  paintAdultCloudRow(true);
  ui.toast('설정 창에서 저장을 눌러야 반영됩니다');
});

// 색을 고르는 즉시 화면에 반영해 결과를 바로 볼 수 있게 합니다.
for (const id of [...Object.keys(THEME_FIELDS), 'd-fontsize', 'd-fontsans', 'd-fontserif']) {
  $(id).addEventListener('input', () => applyDev(readDevSheet()));
}
for (const id of [...Object.keys(MARKUP_FIELDS)]) {
  $(id).addEventListener('change', () => {
    applyDev(readDevSheet());
    paintThread();
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
  draftProviders[key] = {
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
  paintProviderOptions();
  ui.toast('추가했습니다 — 위의 사용할 엔진에서 고를 수 있고, 저장을 눌러야 반영됩니다');
});

$('d-provider-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-del-provider]');
  if (!btn) return;
  const key = btn.dataset.delProvider;
  if (!confirm(`'${draftProviders[key].label}' 엔진을 삭제할까요?`)) return;
  delete draftProviders[key];
  removedProviders.push(key);
  paintDevProviders();
  // 지운 엔진을 보고 있었다면 남은 엔진으로 옮깁니다. 입력 중이던 값은 버립니다.
  if (shownProvider === key) {
    const next = draftProviders[state.settings.activeProvider] ? state.settings.activeProvider : 'lmstudio';
    fillProviderBox(next);
  } else {
    paintProviderOptions();
  }
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
  ui.toast(await ui.copyText($('sys-text').textContent) ? '복사했습니다' : '복사하지 못했습니다. 직접 선택해 복사해 주세요.');
});


/* ---------------- 통신 로그 ---------------- */

const dlgLogs = $('dlg-logs');
const escLog = (t = '') =>
  String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour12: false });
}

function paintLogs(logs) {
  $('log-count').textContent = logs.length ? `최근 ${logs.length}건 (최신 순)` : '기록이 없습니다';
  $('log-list').innerHTML = logs.length ? logs.map((l) => {
    const ok = !l.error;
    const statusText = l.status ?? (ok ? '' : '연결 실패');
    return `<li class="log-row ${ok ? 'log-ok' : 'log-fail'}">
      <div class="log-row-head">
        <span class="log-dot"></span>
        <span class="log-time">${fmtTime(l.at)}</span>
        <span class="log-provider">${escLog(l.provider || '?')}</span>
        <span class="log-path">${escLog(l.path || '')}</span>
        ${l.retry ? '<span class="log-tag">재시도</span>' : ''}
        <span class="spacer"></span>
        <span class="log-status">${escLog(statusText)}</span>
        <span class="log-ms">${l.durationMs != null ? `${l.durationMs}ms` : ''}</span>
      </div>
      ${l.detail ? `<div class="log-detail">${escLog(l.detail)}</div>` : ''}
      ${l.error ? `<pre class="log-error">${escLog(l.error)}</pre>` : ''}
    </li>`;
  }).join('') : '<li class="rail-empty">아직 통신 기록이 없습니다. 대화를 한 번 보내 보세요.</li>';
}

async function loadLogs() {
  $('log-list').innerHTML = '<li class="rail-empty">불러오는 중…</li>';
  try {
    const { logs } = await api.logs();
    paintLogs(logs);
  } catch (err) {
    $('log-list').innerHTML = `<li class="rail-empty">불러오지 못했습니다 — ${escLog(err.message)}</li>`;
  }
}

$('d-show-logs').addEventListener('click', () => {
  dlgLogs.showModal();
  loadLogs();
});
$('log-refresh').addEventListener('click', loadLogs);
$('log-clear').addEventListener('click', async () => {
  if (!confirm('통신 로그를 모두 지울까요?')) return;
  await api.clearLogs();
  loadLogs();
});
