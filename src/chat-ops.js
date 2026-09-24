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
 * 컨텍스트 밖으로 밀려났는데 아직 요약에 들어가지 않은 메시지들.
 * kept 는 이번에 모델에게 보내는(최근) 메시지 수입니다 — 토큰 예산으로 정해집니다.
 * 어디까지 요약했는지는 메시지 시각으로 기억합니다. id 로 기억하면
 * 그 메시지를 지웠을 때 처음부터 다시 요약하게 됩니다.
 */
export function pendingForSummary(chat, kept) {
  const visible = visibleOf(chat);
  const dropped = visible.slice(0, Math.max(0, visible.length - kept));
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

/* ---------------- 자동 기억(사실 목록) ---------------- */

/*
 * 기억 요약이 '밀려난 옛 대화' 를 줄글로 압축한다면, 이쪽은 대화 중에 나온
 * 오래 남겨야 할 사실을 한 줄씩 뽑아 목록으로 둡니다. 약속·별명·취향처럼
 * 밀려나기 전에 이미 중요한 것들입니다.
 *
 * 항목: { id, text, pinned, auto, sourceIds, at }
 *   auto       모델이 뽑은 것. 직접 적은 항목(auto: false)과 고정한 항목은 모델이 고치거나 지우지 못합니다
 *   sourceIds  근거가 된 메시지. 그 메시지를 지우거나 다른 답변으로 넘기면 항목도 치웁니다
 */

/** 이만큼 답변이 쌓이면 한 번 확인합니다. */
export const FACT_EVERY = 4;
/** 목록 상한. 시스템 프롬프트에 매번 들어가므로 길면 맥락을 잡아먹습니다. */
export const FACT_LIMIT = 30;
/** 한 번에 읽힐 최근 메시지 수와 분량. */
export const FACT_WINDOW = 12;
export const FACT_WINDOW_CHARS = 6000;
const FACT_TEXT_MAX = 120;

const factId = () => Math.random().toString(36).slice(2, 8);
const normalize = (t) => String(t).replace(/\s+/g, ' ').trim();
const sameText = (a, b) => normalize(a).replace(/[.。]$/, '') === normalize(b).replace(/[.。]$/, '');

/** 마지막 확인 뒤에 쌓인 메시지. 너무 많이 밀렸으면 최근 것만 봅니다. */
export function factsWindow(chat) {
  const since = Number(chat.factsUntilAt) || 0;
  const fresh = visibleOf(chat).filter((m) => (m.at || 0) > since);
  const out = [];
  let used = 0;
  for (let i = fresh.length - 1; i >= 0 && out.length < FACT_WINDOW; i--) {
    used += fresh[i].content.length;
    if (out.length && used > FACT_WINDOW_CHARS) break;
    out.unshift(fresh[i]);
  }
  return out;
}

/** 마지막 확인 뒤로 쌓인 답변 수. 자동 확인을 돌릴지 정할 때 씁니다. */
export function turnsSinceFacts(chat) {
  const since = Number(chat.factsUntilAt) || 0;
  return visibleOf(chat).filter((m) => m.role === 'assistant' && (m.at || 0) > since).length;
}

export const FACTS_SYSTEM = `당신은 롤플레이의 설정 기록 담당입니다.
최근 대화를 읽고, 앞으로 이야기를 이어 가는 데 꼭 기억해야 할 사실만 기억 목록에 반영합니다.

[기억할 것]
- 인물의 이름·별명·서로 부르는 호칭
- 관계와 감정의 뚜렷한 변화 (고백, 다툼, 화해 등)
- 약속·계획·비밀·복선
- 신상과 취향 (나이, 직업, 좋아하는 것, 싫어하는 것, 알레르기 등)
- 이야기 속에서 확정된 사건, 장소, 소지품

[기억하지 않을 것]
- 그 순간의 행동 묘사나 금방 지나가는 기분
- 이미 목록에 있는 내용, 대화에서 확정되지 않은 추측

[규칙]
- 항목 하나는 한 문장, 60자 안팎. 누구에 대한 사실인지 이름을 넣어 씁니다.
- 기존 항목과 어긋나는 새 사실이 나오면 update 로 고칩니다. 더는 사실이 아닌 항목만 remove 합니다.
- 바뀔 것이 없으면 모두 빈 배열로 둡니다. 억지로 만들지 마세요.
- add 의 from 에는 근거가 된 메시지 번호를 적습니다.
- 반드시 아래 모양의 JSON 하나만 출력합니다. 다른 말이나 코드 블록 표시는 쓰지 않습니다.
{"add":[{"text":"...","from":[1]}],"update":[{"id":"기존 항목 id","text":"..."}],"remove":["기존 항목 id"]}`;

/** 최근 대화에 번호를 붙여 넘깁니다. 모델은 그 번호로 근거를 댑니다. */
export function buildFactsPrompt(facts, window, { char, user }) {
  const list = (facts || []).map((f) => `- [${f.id}] ${f.text}`).join('\n') || '(비어 있음)';
  const lines = window.map((m, i) =>
    `#${i + 1} ${m.role === 'user' ? user : char}: ${m.content.trim()}`);
  return [
    '# 지금 기억 목록',
    list,
    '',
    '# 최근 대화',
    lines.join('\n\n'),
    '',
    '기억 목록에 반영할 변경을 JSON 으로만 답하세요.'
  ].join('\n');
}

/** 모델 응답에서 JSON 을 꺼냅니다. 못 읽으면 아무것도 바꾸지 않습니다. */
export function parseFactOps(text = '') {
  const empty = { add: [], update: [], remove: [] };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return empty;
  let raw;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return empty; }
  const arr = (v) => (Array.isArray(v) ? v : []);
  const clip = (t) => normalize(t).slice(0, FACT_TEXT_MAX);
  return {
    add: arr(raw.add)
      .map((a) => (typeof a === 'string' ? { text: a } : a))
      .filter((a) => a && typeof a.text === 'string' && normalize(a.text))
      .slice(0, 5)
      .map((a) => ({ text: clip(a.text), from: arr(a.from).map(Number).filter(Number.isInteger) })),
    update: arr(raw.update)
      .filter((u) => u && typeof u.id === 'string' && typeof u.text === 'string' && normalize(u.text))
      .map((u) => ({ id: u.id, text: clip(u.text) })),
    remove: arr(raw.remove).filter((id) => typeof id === 'string')
  };
}

const editable = (f) => f.auto && !f.pinned;

/**
 * 모델이 제안한 변경을 목록에 반영합니다. 직접 적은 항목과 고정한 항목은 건드리지 않습니다.
 * 돌려주는 값은 화면 알림용입니다.
 */
export function applyFactOps(chat, ops, window, now = Date.now()) {
  const facts = Array.isArray(chat.facts) ? chat.facts : (chat.facts = []);
  const result = { added: [], updated: [], removed: [] };

  for (const id of ops.remove) {
    const i = facts.findIndex((f) => f.id === id);
    if (i >= 0 && editable(facts[i])) result.removed.push(...facts.splice(i, 1));
  }
  for (const u of ops.update) {
    const f = facts.find((x) => x.id === u.id);
    if (!f || !editable(f) || sameText(f.text, u.text)) continue;
    f.text = u.text;
    f.at = now;
    result.updated.push(f);
  }
  for (const a of ops.add) {
    if (facts.some((f) => sameText(f.text, a.text))) continue;
    const sourceIds = a.from.map((n) => window[n - 1]?.id).filter(Boolean);
    // 번호를 못 댔으면 이번에 읽은 마지막 메시지를 근거로 둡니다.
    if (!sourceIds.length && window.length) sourceIds.push(window[window.length - 1].id);
    const fact = { id: factId(), text: a.text, pinned: false, auto: true, sourceIds, at: now };
    facts.push(fact);
    result.added.push(fact);
  }

  // 상한을 넘으면 가장 오래된 자동 항목부터 뺍니다. 뺄 게 없으면 방금 넣은 것을 물립니다.
  while (facts.length > FACT_LIMIT) {
    const i = facts.findIndex(editable);
    if (i < 0) break;
    const [gone] = facts.splice(i, 1);
    result.added = result.added.filter((f) => f !== gone);
  }
  return result;
}

/**
 * 메시지 하나가 바뀌었을 때(삭제·수정·다른 답변으로 넘김) 부릅니다.
 * 그 메시지에서 나온 자동 항목을 치우고, 다음 확인 때 그 메시지를 다시 읽도록 되감습니다.
 */
export function invalidateFacts(chat, msg, { rewind = true } = {}) {
  if (!msg) return 0;
  let dropped = 0;
  if (Array.isArray(chat.facts)) {
    chat.facts = chat.facts.filter((f) => {
      if (!f.sourceIds?.includes(msg.id)) return true;
      f.sourceIds = f.sourceIds.filter((id) => id !== msg.id);
      // 다른 근거가 남아 있거나, 사람이 손댄 항목이면 둡니다.
      if (f.sourceIds.length || !editable(f)) return true;
      dropped += 1;
      return false;
    });
  }
  if (rewind && msg.at && Number(chat.factsUntilAt) >= msg.at) chat.factsUntilAt = msg.at - 1;
  return dropped;
}

/** 화면이나 백업에서 들어온 목록을 다듬습니다. */
export function cleanFacts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .filter((f) => f && typeof f.text === 'string' && normalize(f.text))
    .slice(0, FACT_LIMIT + 20)
    .map((f) => {
      let id = typeof f.id === 'string' && /^[\w-]{1,16}$/.test(f.id) ? f.id : factId();
      while (seen.has(id)) id = factId();
      seen.add(id);
      return {
        id,
        text: normalize(f.text).slice(0, FACT_TEXT_MAX * 2),
        pinned: Boolean(f.pinned),
        auto: f.auto !== false,
        sourceIds: Array.isArray(f.sourceIds) ? f.sourceIds.filter((x) => typeof x === 'string').slice(0, 10) : [],
        at: Number.isFinite(f.at) ? f.at : Date.now()
      };
    });
}

/* ---------------- 대신 쓰기 ---------------- */

/**
 * 내 차례 대사를 AI 가 초안으로 쓰게 하는 지시. 대화 틀에는 대개
 * "{{user}} 의 몫은 쓰지 말 것" 이 들어 있으므로, 이번 한 번은 예외라고 분명히 적습니다.
 * @param {object} o
 * @param {string} [o.hint]      입력창에 미리 적어 둔 방향
 * @param {boolean} [o.messenger] 메신저 모드면 문자 형식으로
 */
export function impersonatePrompt({ hint = '', messenger = false } = {}) {
  const lines = [
    '[진행 지시: 이번 한 번은 예외로, 당신이 {{user}}를 대신해 {{user}}의 다음 차례를 초안으로 씁니다.',
    '- {{user}}의 시점에서 {{user}}가 할 말과 행동만 씁니다. {{char}}나 다른 인물의 대사와 반응은 쓰지 않습니다.',
    messenger
      ? '- {{user}}가 보낼 메신저 문자 1~2개를 한 줄에 하나씩 씁니다. 묘사는 쓰지 않습니다.'
      : '- 지금까지 대화에서 {{user}}가 쓰던 표기법을 따르고, 1~3문장으로 짧게 씁니다.',
    '- 이름표, 따옴표로 감싼 설명, 머리말 없이 초안 본문만 씁니다.'
  ];
  const direction = String(hint || '').trim();
  if (direction) lines.push(`- 이런 방향으로 씁니다: ${direction.slice(0, 500)}`);
  return `${lines.join('\n')}]`;
}

/** 모델이 붙이는 '이름:' 머리나 감싼 따옴표를 걷어냅니다. */
export function cleanImpersonation(text = '', userName = '') {
  let out = text.trim();
  if (userName) {
    const esc = userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`^(\\*\\*)?${esc}(\\*\\*)?\\s*[:：]\\s*`), '');
  }
  return out.replace(/^\[?초안\]?\s*[:：]\s*/, '').trim();
}
