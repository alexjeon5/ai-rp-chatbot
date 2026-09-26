let markup = { asterisk: true, paren: true, speaker: true, quote: true };

/** 개발자 설정의 표기법 토글을 반영합니다. */
export function setMarkup(next) {
  markup = { ...markup, ...next };
}

const esc = (s = '') =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 화면에 끼워 넣을 글을 HTML 로 해석되지 않게 바꿉니다. */
export const escapeHtml = (t = '') => esc(String(t));

/**
 * 롤플레이 표기를 살려서 HTML 로 바꿉니다. 켜고 끄는 것은 개발자 설정에서 정합니다.
 *   *별표* 또는 (괄호)  → 행동·장면 묘사
 *   이름: "대사"        → 화자 라벨 + 대사
 * plain 모드(어시스턴트)에서는 롤플레이 표기 대신 코드 블록만 살립니다.
 */
export function formatText(raw = '', { plain = false, bubbles = false } = {}) {
  if (plain) return renderMarkdown(raw);
  if (bubbles) return renderBubbles(raw);
  return formatLines(raw).join('\n');
}

/**
 * 메신저 모드: 한 줄이 문자 하나입니다. 줄마다 말풍선으로 나눠 그립니다.
 *   [사진: 바다]  [이모티콘: 하트]  → 첨부처럼 옅게
 *   [오후 11:42]                   → 시각 표시
 */
function renderBubbles(raw = '') {
  const lines = raw.split('\n');
  const html = formatLines(raw);
  return lines
    .map((line, i) => {
      const text = line.trim();
      if (!text) return '';
      if (/^\[(오전|오후)?\s*\d{1,2}:\d{2}\]$/.test(text)) return `<span class="bubble-time">${esc(text.slice(1, -1))}</span>`;
      const meta = /^\[[^\]]+\]$/.test(text);
      return `<span class="bubble${meta ? ' is-meta' : ''}">${meta ? esc(text) : html[i].trim()}</span>`;
    })
    .join('');
}

/** 롤플레이 표기를 한 줄씩 HTML 로 바꿉니다. */
function formatLines(raw = '') {
  return esc(raw)
    .split('\n')
    .map((line) => {
      /*
       * 모델이 종종 "(이름: 묘사)" 처럼 이름을 괄호 안쪽에 넣습니다.
       * 그러면 화자 표시가 묘사체 안에 묻혀 버리므로, 이름을 괄호 밖으로
       * 꺼내 "이름: (묘사)" 모양으로 바꿔 둔 뒤 아래 규칙을 그대로 태웁니다.
       */
      let s = line.replace(/^\(([^:\s()]{1,20}):\s*/, '$1: (');
      s = markup.speaker
        ? s.replace(/^([^:\s]{1,20}):(\s|$)/, '<span class="speaker">$1</span>:$2')
        : s;
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      if (markup.asterisk) s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      if (markup.paren) s = s.replace(/\(([^()]{2,})\)/g, '<em>($1)</em>');
      if (markup.quote) {
        s = s
          .replace(/&quot;([^&]*?)&quot;/g, '<q>$1</q>')
          .replace(/[\u201C]([^\u201D]+)[\u201D]/g, '<q>$1</q>');
      }
      return s;
    });
}

/* ----------------------------------------------------------------
 * 어시스턴트 모드용 마크다운 렌더러.
 * 외부 라이브러리를 쓰지 않습니다. 로컬 모델만 켜고 오프라인으로 쓰는 경우가 많아
 * CDN 에 기대면 글이 통째로 날것으로 보이게 됩니다.
 * ---------------------------------------------------------------- */

// 모델이 종종 $\rightarrow$ 같은 수식 표기를 섞어 씁니다. 흔한 것만 기호로 바꿉니다.
const TEX = {
  rightarrow: '→', to: '→', leftarrow: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈',
  infty: '∞', sum: '∑', prod: '∏', sqrt: '√', degree: '°',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', theta: 'θ',
  lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', omega: 'ω'
};

function unwrapTex(text = '') {
  return text.replace(/\$([^$\n]{1,80})\$/g, (whole, body) => {
    const swapped = body.replace(/\\([a-zA-Z]+)/g, (m, name) => TEX[name] ?? m);
    // 바꾸지 못한 명령이 남아 있으면 건드리지 않습니다. 어설프게 지우면 뜻이 달라집니다.
    return /\\/.test(swapped) ? whole : swapped.trim();
  });
}

/** 문단 안쪽 표기. 코드가 가장 강해서 먼저 떼어 둡니다. */
function inline(raw = '') {
  const codes = [];
  let t = raw.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(`<code>${esc(code)}</code>`);
    return `\u0001${codes.length - 1}\u0001`;
  });

  t = unwrapTex(esc(t))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return t.replace(/\u0001(\d+)\u0001/g, (_m, i) => codes[Number(i)]);
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBER = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_LINE = /^\s*\|.*\|\s*$/;
const TABLE_SPLIT = /^\s*\|[\s:|-]+\|\s*$/;

function renderMarkdown(src = '') {
  const blocks = [];
  const text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre><code data-lang="${esc(lang)}">${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  const lines = text.split('\n');
  const out = [];
  const lists = [];          // 열려 있는 목록들. 들여쓰기로 중첩을 판단합니다.
  let para = [];
  let quote = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
    quote = [];
  };
  const closeLists = (downTo = -1) => {
    while (lists.length && lists[lists.length - 1].indent > downTo) {
      out.push(`</li></${lists.pop().tag}>`);
    }
  };
  const closeAll = () => { flushPara(); flushQuote(); closeLists(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) { closeAll(); continue; }

    const held = /^\u0000(\d+)\u0000$/.exec(line.trim());
    if (held) { closeAll(); out.push(blocks[Number(held[1])]); continue; }

    if (RULE.test(line)) { closeAll(); out.push('<hr>'); continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      closeAll();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    // 표: 머리줄 다음에 |---| 구분줄이 오는 경우만 표로 봅니다.
    if (TABLE_LINE.test(line) && TABLE_SPLIT.test(lines[i + 1] || '')) {
      closeAll();
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && TABLE_LINE.test(lines[i])) body.push(cells(lines[i++]));
      i -= 1;
      out.push(
        '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }

    const quoted = QUOTE.exec(line);
    if (quoted) { flushPara(); closeLists(); quote.push(quoted[1]); continue; }
    flushQuote();

    const bullet = BULLET.exec(line);
    const numbered = !bullet && NUMBER.exec(line);
    if (bullet || numbered) {
      flushPara();
      const [, pad, body] = bullet || numbered;
      const indent = pad.replace(/\t/g, '  ').length;
      const tag = bullet ? 'ul' : 'ol';

      closeLists(indent);
      const top = lists[lists.length - 1];
      if (!top || top.indent < indent) {
        lists.push({ tag, indent });
        out.push(`<${tag}><li>`);
      } else {
        out.push(`</li><li>`);
      }
      out.push(inline(body));
      continue;
    }

    // 목록 항목에 이어지는 줄은 그 항목에 붙입니다.
    if (lists.length) { out.push(`<br>${inline(line.trim())}`); continue; }

    para.push(line.trim());
  }

  closeAll();
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
}

/* ----------------------------------------------------------------
 * 자리표시자 치환 + 한국어 조사 교정.
 * 서버의 src/prompt.js 와 같은 규칙입니다. 화면 미리보기에도 필요해서
 * 브라우저용으로 한 벌 더 둡니다. 한쪽을 고치면 다른 쪽도 맞춰 주세요.
 * ---------------------------------------------------------------- */

const PARTICLE_PAIRS = [
  ['은', '는'], ['이', '가'], ['을', '를'], ['과', '와'],
  ['으로', '로'], ['이라', '라'], ['이랑', '랑'], ['이다', '다'], ['아', '야']
];
const PARTICLE_ALT = new Map();
for (const [withB, withoutB] of PARTICLE_PAIRS) {
  PARTICLE_ALT.set(withB, [withB, withoutB]);
  PARTICLE_ALT.set(withoutB, [withB, withoutB]);
}
const PRONOUN_GA = { 나: '내가', 저: '제가', 너: '네가' };
const ALTERNATIVES = [...new Set(PARTICLE_PAIRS.flat())].sort((a, b) => b.length - a.length);

function hasBatchim(word = '') {
  const ch = word.trim().slice(-1);
  const code = ch.charCodeAt(0);
  if (Number.isNaN(code)) return null;
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[a-z]/i.test(ch)) return !'aeiouy'.includes(ch.toLowerCase());
  return null;
}

function substitute(text, token, value) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}(?:(${ALTERNATIVES.join('|')})(?![가-힣]))?`, 'g');
  return text.replace(re, (_m, particle) => {
    if (!particle) return value;
    if (particle === '가' || particle === '이') {
      const pronoun = PRONOUN_GA[value.trim()];
      if (pronoun) return pronoun;
    }
    const batchim = hasBatchim(value);
    if (batchim === null) return value + particle;
    const [withB, withoutB] = PARTICLE_ALT.get(particle);
    return value + (batchim ? withB : withoutB);
  });
}

/** {{char}} / {{user}} 를 이름으로 바꾸고, 뒤에 붙은 조사를 받침에 맞춥니다. */
export function fillNames(text = '', { char = '캐릭터', user = '나' } = {}) {
  let out = text;
  for (const token of ['{{char}}', '{{캐릭터}}']) out = substitute(out, token, char);
  for (const token of ['{{user}}', '{{유저}}']) out = substitute(out, token, user);
  return out;
}

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

export function renderChatList(chats, activeId, characters, { hideAdult = false, mode = 'rp' } = {}) {
  const ul = document.getElementById('chat-list');
  const visible = hideAdult ? chats.filter((c) => !c.adult) : chats;
  const hiddenCount = chats.length - visible.length;

  if (!visible.length) {
    const empty = mode === 'assistant'
      ? '새 채팅을 눌러 시작해 보세요.'
      : '캐릭터를 골라 대화를 시작하세요.';
    ul.innerHTML = hiddenCount
      ? `<li class="rail-empty">성인 대화 ${hiddenCount}개가 숨겨져 있습니다.</li>`
      : `<li class="rail-empty">${empty}</li>`;
    return;
  }

  ul.innerHTML = visible
    .map((c) => {
      const ch = characters.find((x) => x.id === c.characterId);
      const icon = c.kind === 'assistant' ? '✳' : c.avatar || ch?.avatar || '◦';
      return `<li><button class="rail-item ${c.id === activeId ? 'active' : ''}" data-chat="${c.id}">
        <span class="rail-avatar">${esc(icon)}</span>
        <span class="rail-body">
          <span class="rail-name">
            <span class="label">${esc(c.title)}</span>
            ${c.adult ? '<span class="badge-adult" title="성인 모드로 진행 중인 대화">19</span>' : ''}
            ${c.onceOnly ? '<span class="badge-once" title="이 대화에만 있는 1회성 캐릭터">1회</span>' : ''}
          </span>
          <span class="rail-note">${esc(c.preview || '아직 메시지가 없습니다')}</span>
        </span></button></li>`;
    })
    .join('') +
    (hiddenCount ? `<li class="rail-empty">성인 대화 ${hiddenCount}개 숨김</li>` : '');
}

export function renderCharacterList(characters) {
  const ul = document.getElementById('character-list');
  if (!characters.length) {
    ul.innerHTML = '<li class="rail-empty">아직 만든 캐릭터가 없습니다.</li>';
    return;
  }
  ul.innerHTML = characters
    .map(
      (c) => `<li><button class="rail-item" data-character="${c.id}">
        <span class="rail-avatar">${esc(c.avatar || '◦')}</span>
        <span class="rail-body">
          <span class="rail-name"><span class="label">${esc(c.name)}</span></span>
          <span class="rail-note">${esc(c.description || (c.tags || ''))}</span>
        </span></button></li>`
    )
    .join('');
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
export function imageFigure(chatId, img) {
  const src = `/api/images/${encodeURIComponent(chatId)}/${encodeURIComponent(img.file)}`;
  return `<figure class="turn-image" data-img="${esc(img.id)}">
    <a class="img-open" href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="장면 그림" loading="lazy" title="${esc(`${img.checkpoint ? `모델: ${img.checkpoint}\n` : ''}${img.prompt || ''}`)}"></a>
    <figcaption>
      <button type="button" class="tool" data-act="img-redraw" title="같은 장면을 다른 시드로">다시 그리기</button>
      <button type="button" class="tool" data-act="img-edit" title="태그를 직접 고쳐 다시 그립니다">태그 고쳐 그리기</button>
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
    <div class="turn-text${bubbles ? ' is-bubbles' : ''}">${formatText(message.content, { plain, bubbles })}</div>
    ${message.sources?.length ? `<details class="sources"><summary>출처 ${message.sources.length}곳</summary><ol class="source-list">${message.sources
      .map((src) => `<li><a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.title?.trim() || src.url)}</a></li>`)
      .join('')}</ol></details>` : ''}
    ${isUser ? '' : swipeNav(message)}
    ${isUser ? '' : imagesBlock(message)}
    <div class="turn-tools">
      <button class="tool" data-act="edit">수정</button>
      <button class="tool" data-act="copy">복사</button>
      <button class="tool" data-act="delete">삭제</button>
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
        const meta = [p.gender, p.age, ...(p.traits || [])].map((x) => String(x || '').trim()).filter(Boolean);
        return `<li class="persona-row ${p.id === activeId ? 'active' : ''}">
        <span class="grow">
          <div class="p-name">${esc(p.name)}</div>
          <div class="p-desc">${esc(p.description || '소개 없음')}</div>
          ${meta.length ? `<div class="p-meta">${meta.map(esc).join(' · ')}</div>` : ''}
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
