/**
 * 엔진과 주고받은 HTTP 통신 기록.
 *
 * 대화 내용(시스템 프롬프트, 메시지 본문)은 담지 않습니다.
 * 담는 것: 언제, 어느 엔진의, 어떤 경로에, 어떤 파라미터로 보냈고, 상태 코드가 뭐였고,
 * (실패했다면) 서버가 뭐라고 응답했는지 — 딱 "어디가 잘못됐는지" 알아보는 데 필요한 만큼만.
 *
 * 메모리에만 두는 링버퍼입니다. 컨테이너를 재시작하면 비워집니다.
 */

const MAX_LOGS = 300;
const logs = [];
let seq = 0;

/**
 * @param {object} entry
 * @param {string} entry.provider   엔진 키 (lmstudio, openai, anthropic, gemini, custom_...)
 * @param {string} entry.host       요청 주소의 host 부분만 (예: api.openai.com)
 * @param {string} entry.path       요청 경로 (예: /chat/completions)
 * @param {string} entry.kind       'chat' | 'models'
 * @param {number} [entry.status]   응답 상태 코드. 응답을 못 받았으면 생략
 * @param {number} entry.durationMs
 * @param {boolean} entry.retry     같은 요청을 자동으로 한 번 더 보낸 것인지 (파라미터 보정 등)
 * @param {string} [entry.detail]   요청에서 뽑아낸, 키를 포함하지 않는 안전한 요약 (모델명 등)
 * @param {string} [entry.error]    실패했을 때 서버가 돌려준 메시지 (잘라낸 길이)
 */
export function logHttp(entry) {
  seq += 1;
  logs.push({ id: seq, at: Date.now(), ...entry });
  if (logs.length > MAX_LOGS) logs.shift();

  // docker compose logs 로도 보이게. 한 줄로 눈에 잘 띄게.
  const mark = entry.error ? '✗' : '✓';
  const status = entry.status ?? '—';
  console.log(
    `[통신] ${mark} ${entry.provider} ${status} ${entry.durationMs}ms ${entry.path}` +
    (entry.error ? ` — ${entry.error}` : '')
  );
}

export function listLogs() {
  return logs.slice().reverse(); // 최신이 먼저
}

export function clearLogs() {
  logs.length = 0;
}

/** 응답 본문에서 로그에 남겨도 안전한 만큼만 잘라냅니다. */
export const trimBody = (text = '', n = 600) =>
  text.length > n ? `${text.slice(0, n)}… (${text.length}자 중 일부)` : text;
