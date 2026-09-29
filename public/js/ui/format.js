/** 모델이 쓴 글을 화면용 HTML 로: 롤플레이 표기, 메신저 말풍선, 어시스턴트 마크다운. */
import { esc } from '../core/dom.js';

let markup = { asterisk: true, paren: true, speaker: true, quote: true };

/** 개발자 설정의 표기법 토글을 반영합니다. */
export function setMarkup(next) {
  markup = { ...markup, ...next };
}

/**
 * 롤플레이 표기를 살려서 HTML 로 바꿉니다. 켜고 끄는 것은 개발자 설정에서 정합니다.
 *   *별표* 또는 (괄호)  → 행동·장면 묘사
 *   이름: "대사"        → 화자 라벨 + 대사
 * plain 모드(어시스턴트)에서는 롤플레이 표기 대신 마크다운으로 그립니다.
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

/** 롤플레이 표기를 한 줄씩 HTML 로 바꿉니다. 캐릭터도 $\rightarrow$ 같은 수식 표기를 섞어 쓰므로 먼저 기호로 바꿉니다. */
function formatLines(raw = '') {
  return unwrapTex(esc(raw))
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
          .replace(/[“]([^”]+)[”]/g, '<q>$1</q>');
      }
      return s;
    });
}

/* ----------------------------------------------------------------
 * 어시스턴트 모드용 마크다운 렌더러.
 * 외부 라이브러리를 쓰지 않습니다. 로컬 모델만 켜고 오프라인으로 쓰는 경우가 많아
 * CDN 에 기대면 글이 통째로 날것으로 보이게 됩니다.
 *
 * 블록을 위에서부터 읽고, 목록 항목·인용문의 안쪽은 renderBlocks 로 다시 읽습니다.
 * 그래서 목록 안의 코드 블록, 인용문 안의 목록도 제자리에 그려집니다.
 * 답변을 쓰는 도중에는 코드 블록이 아직 닫히지 않았을 수 있어, 닫는 줄이 없으면 끝까지를 코드로 봅니다.
 * ---------------------------------------------------------------- */

// 모델이 종종 $\rightarrow$ 같은 수식 표기를 섞어 씁니다. 흔한 것만 기호로 바꿉니다.
// 롤플레이 표기(formatLines)와 마크다운(inline) 모두 이 표를 씁니다.
const TEX = {
  rightarrow: '→', to: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔',
  longrightarrow: '⟶', longleftarrow: '⟵', uparrow: '↑', downarrow: '↓', mapsto: '↦',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⇒', iff: '⇔',
  Longrightarrow: '⟹',
  ldots: '…', cdots: '⋯', dots: '…', sim: '∼', equiv: '≡', propto: '∝', circ: '∘',
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈',
  infty: '∞', sum: '∑', prod: '∏', sqrt: '√', degree: '°',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', theta: 'θ',
  lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', omega: 'ω'
};

function unwrapTex(text = '') {
  return text.replace(/\$([^$\n]{1,80})\$/g, (whole, body) => {
    // "$5 에서 $10" 같은 금액은 수식이 아닙니다. \명령 이 있을 때만 봅니다.
    if (!/\\[a-zA-Z]/.test(body)) return whole;
    const swapped = body
      // 30^\circ, 30^{\circ} 는 각도입니다.
      .replace(/\^\s*\{?\s*\\circ\s*\}?/g, '°')
      .replace(/\\([a-zA-Z]+)/g, (m, name) => TEX[name] ?? m);
    // 바꾸지 못한 명령이 남아 있으면 건드리지 않습니다. 어설프게 지우면 뜻이 달라집니다.
    return /\\/.test(swapped) ? whole : swapped.trim();
  });
}

/* ---------------- 문단 안쪽 ---------------- */

// 주소에 쓰이는 글자만 잡습니다. 한글 조사("…com을")나 닫는 괄호가 주소에 붙지 않게 합니다.
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/g;
const link = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

/** 문단 안쪽 표기. 코드·링크를 먼저 떼어 두고, 남은 글을 이스케이프한 뒤 강조를 입힙니다. */
function inline(raw = '') {
  const stash = [];
  const keep = (html) => `\u0001${stash.push(html) - 1}\u0001`;
  let t = String(raw)
    // `코드` · ``백틱이 든 코드``. 여는 백틱 수만큼으로 닫습니다. 코드 안은 글자 그대로 둡니다.
    .replace(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, (_m, _ticks, code) => keep(`<code>${esc(code)}</code>`))
    // \* 처럼 백슬래시로 막은 글자는 그대로 보입니다.
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_m, c) => keep(esc(c)))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, href) => keep(link(href, inline(label))))
    .replace(URL_RE, (url) => {
      // 문장 끝의 마침표·쉼표는 주소가 아닙니다.
      const [, href, tail] = /^(.*?)([.,;:!?*]*)$/.exec(url);
      return keep(link(href, esc(href))) + tail;
    });

  t = unwrapTex(esc(t))
    // 표 칸 안에서 줄을 나누려고 모델이 <br> 을 쓰는 일이 잦습니다.
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![\p{L}\p{N}_])__(?!\s)(.+?)(?<!\s)__(?![\p{L}\p{N}_])/gu, '<strong>$1</strong>')
    // 곱셈처럼 양쪽이 띄어진 별표(a * b * c)는 기울임이 아닙니다.
    .replace(/(?<!\*)\*(?![\s*])(.+?)(?<![\s*])\*(?!\*)/g, '<em>$1</em>')
    // snake_case 처럼 글자 사이의 밑줄은 기울임이 아닙니다.
    .replace(/(?<![\p{L}\p{N}_])_(?![\s_])(.+?)(?<![\s_])_(?![\p{L}\p{N}_])/gu, '<em>$1</em>')
    .replace(/~~(?!\s)(.+?)(?<!\s)~~/g, '<del>$1</del>');

  return t.replace(/\u0001(\d+)\u0001/g, (_m, i) => stash[Number(i)]);
}

/* ---------------- 블록 ---------------- */

const FENCE_TICKS = /^(\s*)(`{3,})([^`]*)$/;
const FENCE_TILDES = /^(\s*)(~{3,})(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
// 번호는 세 자리까지만 봅니다. "2024. 9. 28." 같은 날짜 줄이 목록으로 바뀌지 않게.
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])(?:\s+(.*))?$/;
const QUOTE = /^\s*>\s?(.*)$/;
const SPLIT_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** 들여쓰기 폭. 탭은 네 칸으로 칩니다. */
const widthOf = (line) => /^\s*/.exec(line.replace(/\t/g, '    '))[0].length;

/** 앞의 공백을 최대 n 칸까지 걷어 냅니다. */
function dedent(line, n) {
  const expanded = line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length));
  return expanded.replace(new RegExp(`^ {0,${n}}`), '');
}

const fenceOf = (line) => FENCE_TICKS.exec(line) || FENCE_TILDES.exec(line);
const isTableStart = (lines, i) => lines[i].includes('|') && (lines[i + 1] || '').includes('|') && SPLIT_ROW.test(lines[i + 1]);

/** 문단을 끊고 새 블록을 시작하는 줄인지. 목록 항목에 이어 쓴 줄을 가를 때도 씁니다. */
const startsBlock = (lines, i) => {
  const line = lines[i];
  return Boolean(fenceOf(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(lines, i));
};

function codeBlock(info, body) {
  const lang = info.trim().split(/\s+/)[0] || '';
  return '<div class="code-block"><div class="code-head">' +
    `<span class="code-lang">${esc(lang)}</span>` +
    '<button type="button" class="tool code-copy" data-act="copy-code">복사</button></div>' +
    `<pre><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${esc(body.join('\n'))}</code></pre></div>`;
}

/** ``` 부터 닫는 ``` 까지. 닫는 줄이 아직 없으면(쓰는 중) 끝까지를 코드로 봅니다. */
function readFence(lines, start) {
  const [, pad, marker, info] = fenceOf(lines[start]);
  const close = new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
  const body = [];
  let i = start + 1;
  // 목록 안에서 들여 쓴 코드 블록은 그만큼 내용 들여쓰기를 걷어 냅니다.
  for (; i < lines.length && !close.test(lines[i]); i++) body.push(dedent(lines[i], widthOf(pad)));
  return { html: codeBlock(info, body), next: i + 1 };
}

/** 표 한 줄을 칸으로. 코드 안의 | 와 \| 는 칸을 나누지 않습니다. */
function cellsOf(row) {
  const cells = [];
  let cell = '';
  let ticks = false;
  const text = row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (c === '`') ticks = !ticks;
    if (c === '|' && !ticks) { cells.push(cell.trim()); cell = ''; continue; }
    cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

/** 머리줄 다음에 --- 구분줄이 오는 표. 바깥 | 는 없어도 됩니다. 구분줄의 : 로 정렬을 정합니다. */
function readTable(lines, start) {
  const head = cellsOf(lines[start]);
  const align = cellsOf(lines[start + 1]).map((c) =>
    (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  const cls = (k) => (align[k] ? ` class="al-${align[k]}"` : '');
  let i = start + 2;
  const rows = [];
  for (; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cellsOf(lines[i]));
  const html = '<table><thead><tr>' + head.map((c, k) => `<th${cls(k)}>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + head.map((_h, k) => `<td${cls(k)}>${inline(r[k] ?? '')}</td>`).join('') + '</tr>').join('') +
    '</tbody></table>';
  return { html, next: i };
}

/**
 * 목록 하나. 같은 들여쓰기의 항목을 모으고, 더 들여 쓴 줄은 그 항목의 안쪽으로 봅니다.
 * 항목 사이의 빈 줄로는 목록이 끊기지 않아서, "1. … (빈 줄) 2. …" 가 1, 1 로 다시 시작하지 않습니다.
 */
function readList(lines, start) {
  const first = ITEM.exec(lines[start]);
  const indent = widthOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || widthOf(m[1]) !== indent || /\d/.test(m[2]) !== ordered || RULE.test(lines[i])) break;
    // 안쪽 줄은 표지 뒤 글자 위치까지 걷어 냅니다. 모델이 두 칸만 들여 써도 안쪽으로 봅니다.
    const inner = Math.min(indent + m[2].length + 1, indent + 4);
    const body = [m[3] || ''];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // 빈 줄 다음에 더 들여 쓴 줄이나 다음 항목이 오면 목록이 이어집니다.
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && widthOf(lines[j]) > indent) { body.push(''); i++; continue; }
        break;
      }
      if (widthOf(line) > indent) { body.push(dedent(line, inner)); i++; continue; }
      // 들여 쓰지 않았어도 바로 앞 줄에 이어 쓴 글은 그 항목에 붙입니다.
      if (body[body.length - 1] !== '' && !startsBlock(lines, i)) { body.push(line.trim()); i++; continue; }
      break;
    }
    items.push(body);
    // 항목 사이의 빈 줄은 건너뛰고, 다음 항목이 같은 목록인지 봅니다.
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    const next = ITEM.exec(lines[j] || '');
    if (!next || widthOf(next[1]) !== indent || /\d/.test(next[2]) !== ordered) break;
    i = j;
  }

  const tag = ordered ? 'ol' : 'ul';
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const html = `<${tag}${ordered && startNum !== 1 ? ` start="${startNum}"` : ''}>` + items.map((body) => {
    const task = /^\[([ xX])\]\s+/.exec(body[0]);
    if (task) body[0] = body[0].slice(task[0].length);
    const inside = renderBlocks(body);
    return task
      ? `<li class="task-item"><span class="task-box" aria-hidden="true">${task[1] === ' ' ? '☐' : '☑'}</span>${inside}</li>`
      : `<li>${inside}</li>`;
  }).join('') + `</${tag}>`;
  return { html, next: i };
}

/** 이 줄에서 시작하는 블록을 읽어 { html, next } 로. 문단 줄이면 null 입니다. */
function readBlock(lines, i) {
  const line = lines[i];
  if (fenceOf(line)) return readFence(lines, i);
  if (RULE.test(line)) return { html: '<hr>', next: i + 1 };
  const heading = HEADING.exec(line);
  if (heading) {
    const level = heading[1].length;
    return { html: `<h${level}>${inline(heading[2].replace(/\s+#+\s*$/, ''))}</h${level}>`, next: i + 1 };
  }
  if (isTableStart(lines, i)) return readTable(lines, i);
  if (QUOTE.test(line)) {
    const inner = [];
    let j = i;
    for (; j < lines.length && QUOTE.test(lines[j]); j++) inner.push(QUOTE.exec(lines[j])[1]);
    return { html: `<blockquote>${renderBlocks(inner)}</blockquote>`, next: j };
  }
  if (ITEM.test(line)) return readList(lines, i);
  return null;
}

function renderBlocks(lines) {
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { flushPara(); i++; continue; }
    const block = readBlock(lines, i);
    if (block) {
      flushPara();
      out.push(block.html);
      i = block.next;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join('');
}

function renderMarkdown(src = '') {
  return renderBlocks(String(src).replace(/\r\n?/g, '\n').split('\n'));
}
