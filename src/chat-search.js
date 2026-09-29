/** 대화 검색: 제목과 메시지 본문에서 검색어를 모두 포함한 곳을 찾습니다. 저장소는 건드리지 않는 순수 함수입니다. */

export const SEARCH_LIMITS = { queryChars: 100, terms: 6, hits: 60, perChat: 3, before: 30, after: 70 };

const fold = (text) => String(text ?? '').normalize('NFC').toLowerCase();

/** 공백으로 나눈 검색어들. 같은 낱말은 한 번만, 너무 많으면 앞에서 자릅니다. */
export function parseTerms(query) {
  const terms = fold(String(query ?? '').slice(0, SEARCH_LIMITS.queryChars)).split(/\s+/).filter(Boolean);
  return [...new Set(terms)].slice(0, SEARCH_LIMITS.terms);
}

/** 첫 검색어가 나오는 자리 둘레를 한 줄로 잘라 보여 줍니다. */
export function snippetAround(text, terms) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const lower = fold(flat);
  // fold 가 길이를 바꾸는 드문 문자가 있으면 자리가 어긋나므로, 그때는 앞부분만 보여 줍니다.
  const at = lower.length === flat.length ? Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0)) : 0;
  const start = Math.max(0, (Number.isFinite(at) ? at : 0) - SEARCH_LIMITS.before);
  const end = Math.min(flat.length, start + SEARCH_LIMITS.before + SEARCH_LIMITS.after);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

const hasAll = (text, terms) => {
  const lower = fold(text);
  return terms.every((t) => lower.includes(t));
};

/**
 * @param {object[]} chats 메시지를 담은 대화 전체
 * @param {string} query
 * @param {{kind?: 'rp'|'assistant'}} [opts]
 * @returns {{terms: string[], hits: object[], truncated: boolean}}
 *   hit: { chatId, messageId|null, role|null, at, snippet }  — messageId 가 null 이면 제목이 걸린 것
 */
export function searchChats(chats, query, { kind } = {}) {
  const terms = parseTerms(query);
  if (!terms.length) return { terms, hits: [], truncated: false };

  const time = (c) => c.updatedAt || c.createdAt || 0;
  const hits = [];
  let truncated = false;
  for (const chat of [...chats].sort((a, b) => time(b) - time(a))) {
    if (kind && (chat.kind || 'rp') !== kind) continue;
    const found = [];
    // 한 대화에서는 최근 메시지부터 몇 개만 보여 줍니다. 나머지는 대화를 열어 찾으면 됩니다.
    let more = false;
    for (let i = (chat.messages?.length || 0) - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (!m?.content || !hasAll(m.content, terms)) continue;
      if (found.length >= SEARCH_LIMITS.perChat) { more = true; break; }
      found.push({ chatId: chat.id, messageId: m.id, role: m.role, at: m.at || 0, snippet: snippetAround(m.content, terms) });
    }
    // 첫 메시지로 제목을 붙이는 대화가 많아, 본문이 이미 걸렸다면 제목 결과는 같은 말의 되풀이입니다.
    if (!found.length && hasAll(chat.title, terms)) found.push({ chatId: chat.id, messageId: null, role: null, at: time(chat), snippet: String(chat.title) });
    for (const hit of found) {
      if (hits.length >= SEARCH_LIMITS.hits) return { terms, hits, truncated: true };
      hits.push({ ...hit, moreInChat: more });
    }
  }
  return { terms, hits, truncated };
}
