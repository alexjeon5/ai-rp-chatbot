/**
 * 컨텍스트(토큰) 예산.
 *
 * 모델마다 한 번에 받을 수 있는 토큰 수가 정해져 있습니다(LM Studio 의 Context Length).
 * 메시지 개수로 자르면 긴 답변이 몇 개만 쌓여도 한도를 넘어 앞부분이 조용히 잘리거나
 * 오류가 납니다. 그래서 토큰으로 어림해 한도 안에 들어가는 만큼만 최근 메시지부터 보냅니다.
 *
 * 토크나이저를 싣지 않으므로 글자 종류로 어림합니다. 엔진이 실제 토큰 수를 알려 주면
 * 그 비율(보정값)을 기억해 다음 어림에 곱합니다.
 */

/** 엔진에 따로 적어 두지 않았을 때의 기본 한도. */
export const DEFAULT_CONTEXT = { local: 16384, remote: 128000 };
/** 메시지 하나에 붙는 역할 표시 등 틀 값. */
const MESSAGE_OVERHEAD = 6;
/** 어림이 조금 틀려도 넘치지 않게 남겨 두는 여유. */
const SAFETY = 64;

/**
 * 토큰 수 어림. 한글 음절은 1토큰 안팎, 영문·숫자는 3~4글자에 1토큰쯤입니다.
 * 모델 토크나이저마다 다르므로 정확한 값이 아니라 출발점입니다.
 */
export function estimateTokens(text = '') {
  let hangul = 0;
  let ascii = 0;
  let other = 0;
  let space = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f)) hangul += 1;
    else if (c === 32 || c === 10 || c === 9 || c === 13) space += 1;
    else if (c < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(hangul * 0.9 + ascii * 0.3 + other * 0.8 + space * 0.05);
}

/** 보정값을 곱한 어림. */
export const tokensOf = (text, ratio = 1) => Math.ceil(estimateTokens(text) * ratio);

/** 엔진 설정에서 한도를 읽습니다. 말이 안 되는 값이면 기본값을 씁니다. */
export function contextLimitOf(config = {}, local = false) {
  const n = Number(config.contextTokens);
  if (Number.isFinite(n) && n >= 1024) return Math.min(n, 2_000_000);
  return local ? DEFAULT_CONTEXT.local : DEFAULT_CONTEXT.remote;
}

/**
 * 한도 안에 들어가는 만큼 최근 메시지를 고릅니다.
 *
 * @param {object[]} messages 대화의 전체 메시지
 * @param {object} o
 * @param {string} o.system      시스템 프롬프트 (기억·사실 포함)
 * @param {number} o.limit       컨텍스트 한도(토큰)
 * @param {number} o.reserve     답변에 남겨 둘 토큰 (응답 최대 길이)
 * @param {number} o.maxMessages 개수 상한 (설정의 '최대 메시지 수')
 * @param {string} [o.extra]     히스토리 뒤에 붙는 글(작가 노트 등)
 * @param {number} [o.ratio]     보정값
 */
export function planContext(messages, { system = '', limit, reserve = 0, maxMessages = 40, extra = '', ratio = 1 }) {
  const visible = messages.filter((m) => !m.hidden && m.content?.trim());
  const systemTokens = tokensOf(system, ratio);
  const extraTokens = extra ? tokensOf(extra, ratio) : 0;
  const budget = Math.max(0, limit - systemTokens - extraTokens - reserve - SAFETY);

  const kept = [];
  let used = 0;
  for (let i = visible.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    const cost = Math.ceil((estimateTokens(visible[i].content) + MESSAGE_OVERHEAD) * ratio);
    // 마지막 한 개는 넘치더라도 보냅니다. 아무것도 안 보내면 대답할 거리가 없습니다.
    if (kept.length && used + cost > budget) break;
    kept.unshift(visible[i]);
    used += cost;
  }

  return {
    history: kept.map((m) => ({ role: m.role, content: m.content })),
    keptIds: kept.map((m) => m.id),
    usage: {
      limit,
      system: systemTokens,
      history: used,
      extra: extraTokens,
      reserve,
      kept: kept.length,
      dropped: visible.length - kept.length,
      total: visible.length,
      ratio: Math.round(ratio * 100) / 100,
      over: systemTokens + extraTokens + used + reserve > limit
    }
  };
}

/**
 * 엔진이 알려 준 실제 프롬프트 토큰 수로 보정값을 갱신합니다.
 * 한 번에 확 바뀌지 않게 이전 값과 섞습니다.
 */
export function nextRatio(previous, actualTokens, rawEstimate) {
  if (!(actualTokens > 0) || !(rawEstimate > 50)) return previous || 1;
  const seen = Math.min(3, Math.max(0.3, actualTokens / rawEstimate));
  if (!previous) return seen;
  return Math.round((previous * 0.6 + seen * 0.4) * 1000) / 1000;
}
