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
