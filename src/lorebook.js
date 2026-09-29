/**
 * 로어북(세계관 설정집). 키워드가 최근 대화에 나올 때만 프롬프트에 끼워 넣는 설정 조각 모음입니다.
 * 저장소를 모르는 순수 규칙만 둡니다 — 값 다듬기(cleanEntry·cleanLorebook), 발동 판정(LoreScanner), 글 만들기(renderLore).
 */
import { uid } from './db.js';
import { estimateTokens } from './context.js';
import { SAFE_ID, isObj, str } from './services/records.js';

export const LORE_LIMITS = {
  entries: 300, keys: 20, keyChars: 60, titleChars: 80, contentChars: 4000, nameChars: 80, descChars: 400, books: 100
};
export const LORE_DEFAULTS = { scanDepth: 4, tokenBudget: 1200 };
const SCAN_RANGE = [1, 20];
const BUDGET_RANGE = [100, 8000];

const clampInt = (v, [lo, hi], fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** 쉼표·줄바꿈으로 적은 글이나 배열을 짧은 낱말 목록으로. 겹치는 것은 한 번만 남깁니다. */
function wordList(v, max, chars) {
  const items = Array.isArray(v) ? v : str(v).split(/[,\n]/);
  const words = items.map((x) => str(x).trim().slice(0, chars)).filter(Boolean);
  return [...new Set(words)].slice(0, max);
}

/** 항목 하나. 내용이 비어 있으면 쓸모가 없으므로 null. */
export function cleanEntry(raw) {
  if (!isObj(raw)) return null;
  const content = str(raw.content).trim().slice(0, LORE_LIMITS.contentChars);
  if (!content) return null;
  return {
    id: SAFE_ID.test(str(raw.id)) ? raw.id : uid(),
    title: str(raw.title).trim().slice(0, LORE_LIMITS.titleChars),
    keys: wordList(raw.keys, LORE_LIMITS.keys, LORE_LIMITS.keyChars),
    secondaryKeys: wordList(raw.secondaryKeys, LORE_LIMITS.keys, LORE_LIMITS.keyChars),
    content,
    enabled: raw.enabled !== false,
    constant: raw.constant === true,
    caseSensitive: raw.caseSensitive === true,
    priority: clampInt(raw.priority, [0, 100], 50)
  };
}

/**
 * 로어북 값 정리. 들어온 칸만 돌려주므로 PUT 에서 일부만 보내도 됩니다.
 * 항목의 id 가 겹치면 뒤엣것에 새 id 를 붙입니다.
 */
export function cleanLorebook(raw) {
  const out = {};
  if ('name' in raw) out.name = str(raw.name).trim().slice(0, LORE_LIMITS.nameChars);
  if ('description' in raw) out.description = str(raw.description).trim().slice(0, LORE_LIMITS.descChars);
  if ('global' in raw) out.global = raw.global === true;
  if ('characterIds' in raw) {
    out.characterIds = [...new Set((Array.isArray(raw.characterIds) ? raw.characterIds : []).filter((id) => SAFE_ID.test(str(id))))];
  }
  if ('entries' in raw) {
    const seen = new Set();
    out.entries = (Array.isArray(raw.entries) ? raw.entries : [])
      .slice(0, LORE_LIMITS.entries)
      .map(cleanEntry)
      .filter(Boolean)
      .map((e) => {
        if (seen.has(e.id)) e.id = uid();
        seen.add(e.id);
        return e;
      });
  }
  return out;
}

/** 설정 창에서 온 스캔 깊이·토큰 상한을 범위 안으로. 들어온 칸만 고칩니다. */
export function cleanLoreSettings(raw, current = LORE_DEFAULTS) {
  return {
    scanDepth: 'scanDepth' in raw ? clampInt(raw.scanDepth, SCAN_RANGE, current.scanDepth) : current.scanDepth,
    tokenBudget: 'tokenBudget' in raw ? clampInt(raw.tokenBudget, BUDGET_RANGE, current.tokenBudget) : current.tokenBudget
  };
}

/** 최근 대화에서 발동할 항목을 고릅니다. */
export class LoreScanner {
  constructor({ scanDepth = LORE_DEFAULTS.scanDepth, tokenBudget = LORE_DEFAULTS.tokenBudget } = {}) {
    this.scanDepth = scanDepth;
    this.tokenBudget = tokenBudget;
  }

  /** 검사할 글: 보이는 메시지 중 마지막 scanDepth 개. */
  haystack(messages) {
    return messages
      .filter((m) => !m.hidden && m.content?.trim())
      .slice(-this.scanDepth)
      .map((m) => m.content)
      .join('\n');
  }

  static hit(words, text, lowered, caseSensitive) {
    return words.some((w) => (caseSensitive ? text.includes(w) : lowered.includes(w.toLowerCase())));
  }

  /** 이 항목이 지금 발동하는가. 항상 넣기는 늘, 아니면 키 하나가 나오고(보조 키가 있으면 그것도 하나 나와야) 발동합니다. */
  triggers(entry, text, lowered) {
    if (!entry.enabled) return false;
    if (entry.constant) return true;
    if (!entry.keys.length) return false;
    if (!LoreScanner.hit(entry.keys, text, lowered, entry.caseSensitive)) return false;
    return !entry.secondaryKeys?.length || LoreScanner.hit(entry.secondaryKeys, text, lowered, entry.caseSensitive);
  }

  /**
   * 발동한 항목을 우선순위 순(높은 것 먼저, 같으면 책·항목 순서대로)으로 늘어놓고, 토큰 상한 안에 드는 것만 남깁니다.
   * 상한에 못 드는 항목은 건너뛰고 더 작은 항목을 계속 살핍니다.
   * @param {object[]} books 적용할 로어북들
   * @param {object[]} messages 대화 메시지
   * @returns {{book: object, entry: object, tokens: number}[]}
   */
  select(books, messages) {
    const text = this.haystack(messages);
    const lowered = text.toLowerCase();
    const hits = [];
    for (const book of books) {
      for (const entry of book.entries || []) {
        if (this.triggers(entry, text, lowered)) {
          hits.push({ book, entry, tokens: estimateTokens(`${entry.title}\n${entry.content}`) + 4 });
        }
      }
    }
    hits.sort((a, b) => b.entry.priority - a.entry.priority);
    const chosen = [];
    let used = 0;
    for (const hit of hits) {
      if (used + hit.tokens > this.tokenBudget) continue;
      used += hit.tokens;
      chosen.push(hit);
    }
    return chosen;
  }
}

/** 발동한 항목들을 시스템 프롬프트에 붙일 한 덩어리로. 없으면 빈 글입니다. */
export function renderLore(selected) {
  if (!selected.length) return '';
  const parts = selected.map(({ entry }) => (entry.title ? `### ${entry.title}\n${entry.content}` : entry.content));
  return `# 세계관 설정\n이 이야기의 세계관과 배경 설정입니다. 장면에 관련될 때 참고하고, 어긋나지 않게 하세요.\n\n${parts.join('\n\n')}`;
}
