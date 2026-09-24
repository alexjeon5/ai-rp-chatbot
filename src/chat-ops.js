/**
 * 대화 한 개를 다루는 규칙들. 저장소·네트워크와 무관한 순수 함수라 따로 떼어 둡니다.
 *
 *   - 답변 넘겨보기(스와이프): 재전송이 이전 답변을 버리지 않고 한 장씩 쌓습니다
 *   - 이어쓰기: 잘린 답변 끝에 이어 붙입니다
 *   - 작가 노트: 마지막 사용자 턴에 진행 지시를 덧붙입니다 (저장하지 않음)
 *   - 기억 요약: '기억할 메시지 수' 밖으로 밀려난 대화를 요약해 둡니다
 */

/* ---------------- 답변 넘겨보기 ---------------- */

/** 한 메시지에 쌓아 둘 수 있는 답변 수. 오래된 것부터 버립니다. */
export const SWIPE_LIMIT = 20;

// 답변 한 장이 따로 들고 있는 값. 본문(content) 외에 사고·출처·엔진 정보가 장마다 다릅니다.
const VARIANT_KEYS = ['thought', 'sources', 'provider', 'model'];

function snapshot(msg) {
  const v = { content: msg.content, at: msg.at };
  for (const k of VARIANT_KEYS) if (msg[k] !== undefined) v[k] = msg[k];
  return v;
}

/** 보고 있는 장을 바꿉니다. 메시지의 content 는 늘 보고 있는 장과 같습니다. */
export function showSwipe(msg, index) {
  if (!Array.isArray(msg.swipes) || !msg.swipes.length) return msg;
  const i = Math.max(0, Math.min(msg.swipes.length - 1, Number(index) || 0));
  const v = msg.swipes[i];
  msg.swipeIndex = i;
  msg.content = v.content;
  for (const k of VARIANT_KEYS) {
    if (v[k] === undefined) delete msg[k];
    else msg[k] = v[k];
  }
  return msg;
}

/** 새 답변을 한 장 더 얹고 그 장을 보여 줍니다. 처음이면 지금 본문이 첫 장이 됩니다. */
export function addSwipe(msg, variant) {
  if (!Array.isArray(msg.swipes) || !msg.swipes.length) msg.swipes = [snapshot(msg)];
  msg.swipes.push(variant);
  if (msg.swipes.length > SWIPE_LIMIT) msg.swipes.splice(0, msg.swipes.length - SWIPE_LIMIT);
  return showSwipe(msg, msg.swipes.length - 1);
}

/** 본문을 직접 고치거나 이어 쓴 뒤 부릅니다. 보고 있는 장에도 같은 내용을 남깁니다. */
export function syncSwipe(msg) {
  const v = msg.swipes?.[msg.swipeIndex];
  if (v) v.content = msg.content;
}

/* ---------------- 이어쓰기 ---------------- */

export const CONTINUE_PROMPT =
  '[진행 지시: 바로 앞 당신의 답변이 도중에 끊겼습니다. 앞 내용을 되풀이하거나 요약하지 말고, ' +
  '끊긴 글자 바로 다음부터 같은 문체로 이어서 쓰세요. 인사말이나 설명을 붙이지 마세요.]';

/**
 * 이어 쓴 조각을 붙입니다. 모델은 대개 끊긴 낱말의 나머지부터 쓰므로
 * 문장이 끝난 자리에서만 띄어 줍니다.
 */
export function joinContinuation(prev = '', next = '') {
  const tail = next.replace(/\s+$/, '');
  if (!tail.trim()) return prev;
  if (/\s$/.test(prev) || /^\s/.test(tail)) return prev + tail;
  if (/[.!?…~"'」』)\]*]$/.test(prev)) return `${prev} ${tail}`;
  return prev + tail;
}

/* ---------------- 작가 노트 ---------------- */

/**
 * 작가 노트를 마지막 사용자 턴 끝에 덧붙인 사본을 돌려줍니다.
 * 시스템 프롬프트 맨 위보다 대화 끝에 가까울수록 모델이 잘 따릅니다.
 * 저장된 메시지는 건드리지 않습니다.
 */
export function withAuthorNote(history, note) {
  const text = String(note || '').trim();
  if (!text) return history;
  const tag = `[작가 노트 — 대사가 아니라 진행 지시입니다. 답변에 드러내지 마세요: ${text}]`;
  const out = history.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== 'user') continue;
    out[i].content = `${out[i].content}\n\n${tag}`;
    return out;
  }
  out.push({ role: 'user', content: tag });
  return out;
}

/* ---------------- 기억 요약 ---------------- */

/** 자동 요약을 돌리는 기준. 밀려난 메시지가 이만큼 쌓여야 한 번 돕니다. */
export const SUMMARY_MIN = 10;
/** 한 번에 요약할 대화 분량(글자). 로컬 모델 컨텍스트를 넘지 않게 잡습니다. */
export const SUMMARY_CHUNK_CHARS = 8000;
/** 요약 결과의 상한. 시스템 프롬프트에 늘 들어가므로 길면 맥락을 잡아먹습니다. */
export const MEMORY_MAX_CHARS = 2400;

const visibleOf = (chat) => chat.messages.filter((m) => !m.hidden && m.content?.trim());

/**
 * 기억할 메시지 수 밖으로 밀려났는데 아직 요약에 들어가지 않은 메시지들.
 * 어디까지 요약했는지는 메시지 시각으로 기억합니다. id 로 기억하면
 * 그 메시지를 지웠을 때 처음부터 다시 요약하게 됩니다.
 */
export function pendingForSummary(chat, limit) {
  const visible = visibleOf(chat);
  const dropped = visible.slice(0, Math.max(0, visible.length - limit));
  const since = Number(chat.summaryUntilAt) || 0;
  return dropped.filter((m) => (m.at || 0) > since);
}

/** 요약 한 번에 넘길 만큼만 앞에서부터 자릅니다. 최소 한 개는 넣습니다. */
export function takeChunk(pending, budget = SUMMARY_CHUNK_CHARS) {
  const out = [];
  let used = 0;
  for (const m of pending) {
    const size = m.content.length + 20;
    if (out.length && used + size > budget) break;
    out.push(m);
    used += size;
  }
  return out;
}

export const SUMMARY_SYSTEM = `당신은 롤플레이 기록을 정리하는 편집자입니다.
이전 요약과 새로 밀려난 대화를 받아, 이야기를 이어 가는 데 필요한 것만 남긴 새 요약을 씁니다.

[규칙]
- 한국어로, 짧은 항목(- 로 시작) 위주로 씁니다. 전체 1500자를 넘기지 않습니다.
- 다음을 우선해 남깁니다: 일어난 사건, 관계와 감정의 변화, 약속·비밀·복선, 인물이 새로 알게 된 사실, 지금 장소와 상황.
- 이전 요약에 있던 내용은 새 대화와 어긋나지 않는 한 유지합니다. 사람이 직접 적어 둔 메모로 보이는 줄은 지우지 않습니다.
- 대사를 그대로 옮기지 말고 사실만 적습니다. 평가나 감상, 앞으로의 전개 추측은 쓰지 않습니다.
- 요약 외의 말(인사, 설명, 제목)은 붙이지 않습니다.`;

/** 요약 요청 본문. 이름은 화면과 같게 채워 넣어 누가 한 말인지 헷갈리지 않게 합니다. */
export function buildSummaryPrompt(previous, chunk, { char, user }) {
  const lines = chunk.map((m) => `${m.role === 'user' ? user : m.speaker || char}: ${m.content.trim()}`);
  return [
    '# 이전 요약',
    previous?.trim() || '(없음)',
    '',
    '# 새로 밀려난 대화',
    lines.join('\n\n'),
    '',
    '위 두 가지를 합쳐 새 요약을 쓰세요.'
  ].join('\n');
}

/** 모델이 붙이는 머리말·코드 블록을 걷어내고 길이를 맞춥니다. */
export function cleanSummary(text = '') {
  let out = text.trim()
    .replace(/^```\w*\n?/, '').replace(/```$/, '')
    .replace(/^#+\s*(새\s*)?요약\s*\n/, '')
    .trim();
  if (out.length > MEMORY_MAX_CHARS) out = `${out.slice(0, MEMORY_MAX_CHARS).replace(/\n[^\n]*$/, '')}`;
  return out;
}
