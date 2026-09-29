import { esc } from './core/dom.js';
import { fillTokens } from './shared/korean.js';
export { setMarkup, formatText } from './ui/format.js';
import { formatText } from './ui/format.js';

/** {{char}} / {{user}} 를 이름으로 바꾸고, 뒤에 붙은 조사를 받침에 맞춥니다 (서버와 같은 shared/korean.js). */
export const fillNames = (text = '', { char = '캐릭터', user = '나' } = {}) => fillTokens(text, char, user);

/**
 * 알림은 popover 로 띄웁니다. 설정 창 같은 모달은 최상위 층에 올라가서,
 * 일반 요소로 띄운 알림은 z-index 와 상관없이 그 아래에 깔려 보이지 않습니다.
 * 매번 다시 열어야 가장 나중에 열린 모달보다 위에 놓입니다.
 */
export function toast(message) {
  const el = document.getElementById('toast');
  const popover = typeof el.showPopover === 'function';
  el.textContent = message;
  el.hidden = false;
  if (popover) {
    if (el.matches(':popover-open')) el.hidePopover();
    el.showPopover();
  }
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    if (popover && el.matches(':popover-open')) el.hidePopover();
    el.hidden = true;
  }, 2600);
}

/**
 * 클립보드에 복사합니다. navigator.clipboard 는 https 나 localhost 에서만 열려 있어서,
 * http://192.168.x.x 처럼 LAN 주소로 접속하면 없습니다. 그때는 옛 방식으로 복사합니다.
 */
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 권한 거부 등 — 아래 방식으로 한 번 더 시도합니다 */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  // 모달이 열려 있으면 그 안에 넣어야 선택·복사가 됩니다.
  (document.querySelector('dialog[open]') || document.body).appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/**
 * 대화 한 줄. grouped 면 캐릭터 묶음 안이라 아이콘 대신 들여쓰기만 두고,
 * depth 는 분기한 대화를 원본 아래로 들여 쓸 깊이입니다.
 */
function chatRow(c, characters, activeId, { grouped = false, depth = 0 } = {}) {
  const ch = characters.find((x) => x.id === c.characterId);
  const icon = c.kind === 'assistant' ? '✳' : c.avatar || ch?.avatar || '◦';
  const lead = grouped
    ? (depth ? '<span class="rail-branch" aria-hidden="true">↳</span>' : '')
    : `<span class="rail-avatar">${esc(icon)}</span>`;
  const cls = ['rail-item', c.id === activeId ? 'active' : '', grouped ? `is-grouped depth-${Math.min(depth, 3)}` : '']
    .filter(Boolean).join(' ');
  return `<li><button class="${cls}" data-chat="${c.id}">
        ${lead}
        <span class="rail-body">
          <span class="rail-name">
            <span class="label">${esc(c.title)}</span>
            ${c.adult ? '<span class="badge-adult" title="성인 모드로 진행 중인 대화">19</span>' : ''}
            ${c.onceOnly ? '<span class="badge-once" title="이 대화에만 있는 1회성 캐릭터">1회</span>' : ''}
            ${c.branchOf ? '<span class="badge-branch" title="다른 대화에서 갈라져 나온 대화">분기</span>' : ''}
          </span>
          <span class="rail-note">${esc(c.preview || '아직 메시지가 없습니다')}</span>
        </span></button></li>`;
}

/** 목록 순서를 지키되, 분기한 대화를 원본 바로 아래로 옮깁니다. 원본이 이 목록에 없으면 제자리에 둡니다. */
function withBranches(list) {
  const ids = new Set(list.map((c) => c.id));
  const children = new Map();
  const roots = [];
  for (const c of list) {
    const parent = c.branchOf?.chatId;
    if (parent && parent !== c.id && ids.has(parent)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(c);
    } else {
      roots.push(c);
    }
  }
  const out = [];
  const seen = new Set();
  const walk = (c, depth) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push({ chat: c, depth });
    for (const kid of children.get(c.id) || []) walk(kid, depth + 1);
  };
  roots.forEach((c) => walk(c, 0));
  // 서로를 가리키는 기록이 있어도 빠지는 대화가 없게 합니다.
  list.forEach((c) => walk(c, 0));
  return out;
}

/**
 * 캐릭터별 묶음. 묶음 순서는 그 캐릭터의 가장 최근 대화 순입니다(목록이 이미 최근순).
 * 접어 둔 묶음이라도 지금 열린 대화가 들어 있으면 펼쳐 보입니다.
 */
function groupedRows(chats, characters, activeId, collapsed) {
  const groups = new Map();
  for (const c of chats) {
    const key = c.characterId || 'once';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups].map(([key, list]) => {
    const ch = characters.find((x) => x.id === key);
    const name = key === 'once' ? '1회성 캐릭터' : ch?.name || '지운 캐릭터';
    const icon = key === 'once' ? '◦' : ch?.avatar || list[0].avatar || '◦';
    const open = !collapsed.has(key) || list.some((c) => c.id === activeId);
    const head = `<li><button class="rail-folder" type="button" data-group-key="${esc(key)}" aria-expanded="${open}">
        <span class="rail-avatar">${esc(icon)}</span>
        <span class="label">${esc(name)}</span>
        <span class="char-count">${list.length}</span>
        <span class="rail-chev" aria-hidden="true">${open ? '▾' : '▸'}</span></button></li>`;
    if (!open) return head;
    return head + withBranches(list).map(({ chat, depth }) => chatRow(chat, characters, activeId, { grouped: true, depth })).join('');
  }).join('');
}

/**
 * 대화 목록. archiveView 면 보관한 대화를 보여 주고 맨 위에 돌아가는 줄을,
 * 아니면 보관한 대화가 있을 때만 맨 아래에 보관함으로 가는 줄을 붙입니다.
 * group 이면 캐릭터별로 묶고, 분기한 대화를 원본 아래에 들여 씁니다.
 */
export function renderChatList(chats, activeId, characters,
  { hideAdult = false, mode = 'rp', archiveView = false, archivedCount = 0, group = false, collapsed = new Set() } = {}) {
  const ul = document.getElementById('chat-list');
  const visible = hideAdult ? chats.filter((c) => !c.adult) : chats;
  const hiddenCount = chats.length - visible.length;

  const head = archiveView
    ? '<li class="rail-archive"><button class="ghost-btn" data-archive-view="off">← 대화 목록으로</button></li>'
    : '';
  const foot = !archiveView && archivedCount
    ? `<li class="rail-archive"><button class="ghost-btn" data-archive-view="on">보관함 <span class="char-count">${archivedCount}</span></button></li>`
    : '';

  if (!visible.length) {
    const empty = archiveView
      ? '보관한 대화가 없습니다.'
      : mode === 'assistant'
        ? '새 채팅을 눌러 시작해 보세요.'
        : '캐릭터를 골라 대화를 시작하세요.';
    ul.innerHTML = head + (hiddenCount
      ? `<li class="rail-empty">성인 대화 ${hiddenCount}개가 숨겨져 있습니다.</li>`
      : `<li class="rail-empty">${empty}</li>`) + foot;
    return;
  }

  const rows = group && mode === 'rp'
    ? groupedRows(visible, characters, activeId, collapsed)
    : visible.map((c) => chatRow(c, characters, activeId)).join('');
  ul.innerHTML = head + rows +
    (hiddenCount ? `<li class="rail-empty">성인 대화 ${hiddenCount}개 숨김</li>` : '') +
    foot;
}

/**
 * 캐릭터 목록을 탭 하나 분량만 그립니다. builtin 표시가 있는 캐릭터는 '기본' 탭, 나머지는 '내 캐릭터' 탭입니다.
 * missing 은 아직 넣지 않은 내장 캐릭터 수로, '기본' 탭 맨 위에 넣기 버튼을 띄울 때 씁니다.
 */
export function renderCharacterList(characters, { tab = 'mine', missing = 0 } = {}) {
  const mine = characters.filter((c) => !c.builtin);
  const builtin = characters.filter((c) => c.builtin);

  for (const btn of document.querySelectorAll('#char-tabs [data-tab]')) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', String(on));
  }
  document.querySelector('#char-tabs [data-count="mine"]').textContent = mine.length || '';
  document.querySelector('#char-tabs [data-count="builtin"]').textContent = builtin.length || '';

  const shown = tab === 'builtin' ? builtin : mine;
  const rows = shown.map(
    (c) => `<li><button class="rail-item" data-character="${c.id}">
        <span class="rail-avatar">${esc(c.avatar || '◦')}</span>
        <span class="rail-body">
          <span class="rail-name"><span class="label">${esc(c.name)}</span></span>
          <span class="rail-note">${esc(c.description || (c.tags || ''))}</span>
        </span></button></li>`
  );
  if (tab === 'builtin' && missing) {
    const label = builtin.length ? `빠진 기본 캐릭터 ${missing}명 넣기` : `기본 캐릭터 ${missing}명 넣기`;
    rows.unshift(`<li class="rail-seed"><button class="ghost-btn" data-seed-builtins
      title="앱에 들어 있는 기본 캐릭터 중 목록에 없는 것만 추가합니다">${label}</button></li>`);
  }
  if (!shown.length && !(tab === 'builtin' && missing)) {
    rows.push(tab === 'builtin'
      ? '<li class="rail-empty">기본 캐릭터가 없습니다.</li>'
      : '<li class="rail-empty">아직 만든 캐릭터가 없습니다. <b>새로 만들기</b> 로 시작하거나 <b>기본</b> 탭의 캐릭터를 복사해 고쳐 보세요.</li>');
  }
  document.getElementById('character-list').innerHTML = rows.join('');
}

/** 첫 글자가 오기 전까지 자리를 지키는 점 세 개. */
export const TYPING = '<span class="typing" role="status" aria-label="응답을 쓰는 중"><i></i><i></i><i></i></span>';

/** 사고 과정은 접어 둡니다. 펼쳐야만 보이므로 답변을 가리지 않습니다. */
export function thoughtEl(text = '') {
  const details = document.createElement('details');
  details.className = 'thought';
  details.innerHTML = `<summary>생각 과정</summary><div class="thought-body"></div>`;
  details.querySelector('.thought-body').textContent = text;
  return details;
}

/**
 * 출처 목록. 구글 근거 링크는 vertexaisearch 리다이렉트라 주소가 길고 읽히지 않습니다.
 * 그래서 주소 대신 제목(대개 출처 사이트 이름)을 보여 주고, 주소는 링크로만 답니다.
 */
export function sourcesEl(sources = []) {
  const details = document.createElement('details');
  details.className = 'sources';
  details.innerHTML = `<summary>출처 ${sources.length}곳</summary><ol class="source-list"></ol>`;
  fillSources(details, sources);
  return details;
}

export function fillSources(details, sources = []) {
  details.querySelector('summary').textContent = `출처 ${sources.length}곳`;
  details.querySelector('.source-list').innerHTML = sources
    .map((src) => {
      const label = src.title?.trim() || hostOf(src.url) || src.url;
      return `<li><a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a></li>`;
    })
    .join('');
}

function hostOf(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/* 장면 그리기가 켜져 있으면 답변마다 🎨 버튼을 붙입니다. 대화 id 는 그림 주소에 씁니다. */
let drawing = { enabled: false, chatId: '' };
export function setDrawing(next) { drawing = { ...drawing, ...next }; }

/** 그림 한 장. 누르면 대화 창 안의 보기 창으로 크게 엽니다 (Ctrl·가운데 클릭은 새 탭). */
function imageFigure(chatId, img) {
  const src = `/api/images/${encodeURIComponent(chatId)}/${encodeURIComponent(img.file)}`;
  return `<figure class="turn-image" data-img="${esc(img.id)}">
    <a class="img-open" href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="장면 그림" loading="lazy" title="${esc(`${img.checkpoint ? `모델: ${img.checkpoint}\n` : ''}${img.prompt || ''}`)}"></a>
    <figcaption>
      <button type="button" class="tool" data-act="img-redraw" title="같은 장면을 다른 시드로">다시 그리기</button>
      ${img.backend === 'gemini' || img.backend === 'openai' || img.style === 'prose'
        ? '<button type="button" class="tool" data-act="img-edit" title="장면 묘사를 직접 고쳐 다시 그립니다">묘사 고쳐 그리기</button>'
        : '<button type="button" class="tool" data-act="img-edit" title="태그를 직접 고쳐 다시 그립니다">태그 고쳐 그리기</button>'}
      <button type="button" class="tool" data-act="img-del">삭제</button>
    </figcaption>
  </figure>`;
}

function imagesBlock(message) {
  if (!message.images?.length || !drawing.chatId) return '';
  // 최근 그림이 앞에 오게 합니다.
  return `<div class="turn-images">${[...message.images].reverse().map((img) => imageFigure(drawing.chatId, img)).join('')}</div>`;
}

/** 답변 넘겨보기. 두 장 이상일 때만 보입니다. */
function swipeNav(message) {
  const total = message.swipes?.length || 0;
  if (total < 2) return '';
  const at = (message.swipeIndex ?? total - 1) + 1;
  return `<div class="swipe-nav" role="group" aria-label="다른 답변 넘겨보기">
    <button type="button" class="tool" data-act="swipe-prev" ${at <= 1 ? 'disabled' : ''} aria-label="이전 답변">‹</button>
    <span class="swipe-count">${at} / ${total}</span>
    <button type="button" class="tool" data-act="swipe-next" aria-label="${at >= total ? '새 답변 쓰기' : '다음 답변'}">›</button>
  </div>`;
}

export function turnEl({ message, speaker, isUser, plain = false, bubbles = false }) {
  const li = document.createElement('article');
  li.className = `turn ${isUser ? 'user' : 'char'}`;
  li.dataset.mid = message.id;
  li.innerHTML = `
    <div class="turn-name">${esc(speaker)}</div>
    ${message.thought ? `<details class="thought"><summary>생각 과정</summary><div class="thought-body">${esc(message.thought)}</div></details>` : ''}
    <div class="turn-text${bubbles ? ' is-bubbles' : ''}${plain ? ' is-md' : ''}">${formatText(message.content, { plain, bubbles })}</div>
    ${message.sources?.length ? `<details class="sources"><summary>출처 ${message.sources.length}곳</summary><ol class="source-list">${message.sources
      .map((src) => `<li><a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.title?.trim() || src.url)}</a></li>`)
      .join('')}</ol></details>` : ''}
    ${isUser ? '' : swipeNav(message)}
    ${isUser ? '' : imagesBlock(message)}
    <div class="turn-tools">
      <button class="tool" data-act="edit">수정</button>
      <button class="tool" data-act="copy">복사</button>
      <button class="tool" data-act="delete">삭제</button>
      <button class="tool" data-act="branch" title="이 메시지까지 복사해 새 대화로 갈라집니다. 원본은 그대로 남습니다">분기</button>
      ${!isUser && !plain && drawing.enabled ? '<button class="tool" data-act="draw" title="이 장면을 ComfyUI 로 그립니다">🎨 그리기</button>' : ''}
    </div>`;
  return li;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.bubbles] 메신저 모드 — 줄마다 말풍선
 * @param {string} [opts.charLabel] 답변 위에 붙는 이름. 여럿이 함께 나오는 장면이면 이름을 이어 붙입니다
 */
export function renderThread(chat, character, persona, { bubbles = false, charLabel } = {}) {
  const box = document.getElementById('messages');
  const plain = chat.kind === 'assistant';
  box.innerHTML = '';
  const thread = document.createElement('div');
  thread.className = 'thread';
  thread.id = 'thread';
  for (const m of chat.messages) {
    thread.appendChild(
      turnEl({
        message: m,
        speaker: m.role === 'user'
          ? (plain ? '나' : persona?.name || '나')
          : (plain ? '어시스턴트' : charLabel || character?.name || '상대'),
        isUser: m.role === 'user',
        plain,
        bubbles
      })
    );
  }
  box.appendChild(thread);
  scrollToEnd({ force: true });
}

/* ----------------------------------------------------------------
 * 아래 고정(pin) 상태를 들고 다닙니다.
 *
 * 거리로만 판단하면 어긋납니다. 생성이 시작될 때 '응답 생성 중' 막대가 나타나
 * 입력창이 커지고, 그만큼 메시지 영역이 줄어 바닥에서 밀려나기 때문입니다.
 * 그래서 "사용자가 직접 위로 올렸는가" 만 보고, 그게 아니면 계속 따라갑니다.
 * ---------------------------------------------------------------- */

let pinned = true;
let scroller = null;

const messagesBox = () => (scroller ||= document.getElementById('messages'));

/** 앱이 시작할 때 한 번 부릅니다. */
export function watchScroll() {
  const box = messagesBox();
  box.addEventListener('scroll', () => {
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    pinned = distance < 80;
  }, { passive: true });
}

/**
 * 맨 아래로 내립니다.
 * force 면 고정을 다시 켭니다. 아니면 고정돼 있을 때만 움직입니다.
 */
export function scrollToEnd({ force = false } = {}) {
  const box = messagesBox();
  if (force) pinned = true;
  if (!pinned) return;

  box.scrollTop = box.scrollHeight;
  // 입력창 높이가 바뀌는 등 레이아웃이 한 박자 늦게 잡히는 경우가 있습니다.
  requestAnimationFrame(() => {
    if (pinned) box.scrollTop = box.scrollHeight;
  });
}

export function renderPersonaList(personas, activeId) {
  const ul = document.getElementById('persona-list');
  if (!personas.length) {
    ul.innerHTML = '<li class="rail-empty">페르소나를 하나 추가해 주세요.</li>';
    return;
  }
  ul.innerHTML = personas
    .map(
      (p) => {
        // 목록에서는 {{user}}/{{char}} 를 읽히는 이름으로 바꿔 보여 줍니다. 긴 글은 CSS 가 두 줄로 줄이고, 전체는 title 로 봅니다.
        const named = (t) => fillNames(String(t || '').trim(), { user: p.name });
        const desc = named(p.description) || '소개 없음';
        const meta = [p.gender, p.age, ...(p.traits || [])].map(named).filter(Boolean).join(' · ');
        return `<li class="persona-row ${p.id === activeId ? 'active' : ''}">
        <span class="grow">
          <div class="p-name">${esc(p.name)}</div>
          <div class="p-desc" title="${esc(desc)}">${esc(desc)}</div>
          ${meta ? `<div class="p-meta" title="${esc(meta)}">${esc(meta)}</div>` : ''}
        </span>
        <button type="button" class="ghost-btn" data-use="${p.id}" ${p.id === activeId ? 'disabled' : ''}>
          ${p.id === activeId ? '사용 중' : '사용'}
        </button>
        <button type="button" class="ghost-btn" data-edit="${p.id}">수정</button>
        <button type="button" class="ghost-btn danger" data-del="${p.id}">삭제</button>
      </li>`;
      }
    )
    .join('');
}

/**
 * 랜덤 페르소나의 씨앗 태그를 칩으로 그립니다.
 * 칩 하나를 누르면 그 항목만 다시 굴리므로 data-key 를 남겨 둡니다.
 * fields 는 서버가 내려준 [{ key, label }] 순서를 그대로 씁니다.
 */
export function renderSeedChips(seeds, fields = []) {
  const ul = document.getElementById('p-seeds');
  if (!seeds) {
    ul.hidden = true;
    ul.innerHTML = '';
    return;
  }
  ul.hidden = false;
  ul.innerHTML = fields
    .map(({ key, label }) => {
      const value = seeds[key];
      const text = Array.isArray(value) ? value.join(' · ') : value;
      if (!text) return '';
      return `<li><button type="button" class="seed-chip" data-key="${esc(key)}" title="다시 굴리기">
        <span class="seed-label">${esc(label)}</span>
        <span class="seed-value">${esc(text)}</span>
      </button></li>`;
    })
    .join('');
}

/** 대화를 하나도 열지 않았을 때 가운데에 뜨는 안내를 모드에 맞게 씁니다. */
export function renderEmptyStage(mode) {
  const box = document.getElementById('messages');
  const [line, help] = mode === 'assistant'
    ? ['무엇이든 물어보세요.', '새 채팅을 누르면 시작합니다.']
    : ['아직 시작한 대화가 없습니다.', '왼쪽에서 캐릭터를 고르면 대화가 시작됩니다.'];
  box.innerHTML = `<div class="empty-stage">
    <p class="empty-line">${line}</p>
    <p class="empty-help">${help}</p>
  </div>`;
}

export function showError(text) {
  const thread = document.getElementById('thread') || document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'error-line';
  div.textContent = text;
  thread.appendChild(div);
  scrollToEnd();
}
