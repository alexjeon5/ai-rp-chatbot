/**
 * 줄글 한 덩어리를 캐릭터 시트로 바꾸는 부분입니다.
 *
 * 페르소나 생성과 같은 이유로 JSON 을 요구하지 않습니다 — 로컬 모델은 항목이 열 개쯤 되면
 * 중괄호나 따옴표를 흘려서 통째로 못 읽게 되는 일이 잦습니다. 대신 '라벨: 값' 형식으로 받고,
 * 아는 라벨이 나올 때까지를 앞 항목의 내용으로 봅니다(여러 줄 항목이 그대로 살아납니다).
 */

/** 화면의 입력 칸 ↔ 모델에게 쓰게 할 라벨. 순서가 곧 출력 순서입니다. */
export const CHAR_FIELDS = [
  { key: 'name', label: '이름', hint: '한국어 이름 하나. 성을 붙여도 됩니다' },
  { key: 'avatar', label: '아이콘', hint: '이 인물을 나타내는 이모지 하나' },
  { key: 'tags', label: '태그', hint: '장르나 분위기 두세 개, 쉼표로 구분' },
  { key: 'description', label: '한 줄 소개', hint: '목록에서 보일 한 문장' },
  { key: 'appearance', label: '외형 태그', hint: '그림용. 머리·눈·체형·옷차림을 영어 Danbooru 태그 5~10개로, 쉼표로 구분. 예: long black hair, red eyes, gray hoodie' },
  { key: 'personality', label: '성격', hint: '연기의 뼈대. 행동으로 드러나는 성질을 2~4문장' },
  { key: 'speech', label: '말투', hint: '문장 길이, 존대/반말, 버릇을 1~2문장' },
  { key: 'scenario', label: '배경과 상황', hint: '첫 장면의 무대. {{user}}가 어디서 마주치는지' },
  { key: 'greeting', label: '첫 대사', hint: '이 인물이 먼저 던지는 한 턴. *행동* 과 "대사" 를 섞어서' },
  { key: 'exampleDialogue', label: '대화 예시', hint: '{{user}}: 와 {{char}}: 를 번갈아 2~3턴' },
  { key: 'notes', label: '추가 설정', hint: '관계, 금기, 세계관 규칙. 없으면 비워 둡니다' }
];

const BY_LABEL = new Map(CHAR_FIELDS.map((f) => [f.label, f.key]));

/**
 * 모델이 지시된 라벨 대신 흔히 쓰는 말로 바꿔 적는 경우입니다. 지시를 무시해서가 아니라
 * 그쪽이 더 자연스럽다고 판단해서인 경우가 많아, 정확한 라벨 못지않게 자주 나옵니다.
 * 값은 반드시 CHAR_FIELDS 에 있는 key 여야 합니다.
 */
const ALIASES = {
  소개: 'description', 설명: 'description', 특징: 'description',
  외모: 'appearance', 생김새: 'appearance', 외형: 'appearance', '외모 태그': 'appearance',
  배경: 'scenario', 상황: 'scenario', 무대: 'scenario',
  말버릇: 'speech', 어투: 'speech',
  인사: 'greeting', 오프닝: 'greeting', 첫인사: 'greeting',
  '예시 대화': 'exampleDialogue', 대화예시: 'exampleDialogue',
  기타: 'notes', 비고: 'notes', 세계관: 'notes', 관계: 'notes',
  닉네임: 'name', 성명: 'name'
};
for (const [alias, key] of Object.entries(ALIASES)) {
  if (!BY_LABEL.has(alias)) BY_LABEL.set(alias, key);
}

export const CHAR_GEN_SYSTEM =
  '당신은 롤플레이용 캐릭터 시트를 쓰는 한국어 창작 보조입니다.\n' +
  '사용자가 적은 설명을 재료 삼아 빈 곳을 메우고, 모호한 부분은 그럴듯하게 정합니다.\n' +
  '규칙:\n' +
  '- 아래 라벨을 그 순서대로, 각각 "라벨: 내용" 형태로 출력합니다.\n' +
  '- 라벨을 바꾸거나 새로 만들지 않습니다. 번호, 목록 기호, 굵게 표시, 코드블록을 쓰지 않습니다.\n' +
  '- 사용자가 이미 정한 항목은 그대로 두고, 그 설정과 어긋나지 않게 나머지를 씁니다.\n' +
  '- 사용자를 가리킬 때는 {{user}}, 이 인물을 가리킬 때는 {{char}} 를 씁니다.\n' +
  '- 설명이나 사족 없이 시트만 출력합니다.';

/**
 * 구체적인 완성 예시 하나. 안내 문구(hint)만으로는 형식이 자주 무너져서,
 * 실제로 다 채워진 시트를 한 번 보여 주는 쪽이 훨씬 안정적입니다.
 * 이 예시의 인물을 실제로 쓰라는 게 아니라는 점을 프롬프트에서 같이 밝힙니다.
 */
const CHAR_EXAMPLE = [
  '이름: 강도윤', '아이콘: 🌙', '태그: 일상, 도시',
  '한 줄 소개: 24시간 만화카페를 홀로 지키는 야간 매니저.',
  '성격: 손님을 대할 때는 사무적이지만 단골한테는 먼저 말을 건다. 피곤한 티를 잘 안 내는데 새벽 3시가 넘으면 티가 난다.',
  '말투: 짧은 반말. 존댓말을 쓰다가도 편해지면 금방 반말로 넘어간다.',
  '배경과 상황: 자정이 넘은 만화카페 카운터. {{user}}가 문을 열고 들어온다.',
  '첫 대사: *카운터에 엎드려 있다가 고개를 든다.* "어서 오세요… 아, {{user}}씨네."',
  '대화 예시: {{user}}: 오늘도 혼자예요?\n{{char}}: *하품을 참으며* "다들 어디 갔는지."',
  '추가 설정: 사장은 한 달에 한 번 올까 말까 한다.'
].join('\n');

/**
 * 지금까지 정해진 값(known)에 없는 항목만 "출력 형식"에 올립니다.
 * 이미 정해진 항목까지 매번 다시 쓰게 하면 그만큼 형식이 흐트러질 자리가 늘어나서,
 * 재시도할 때는 남은 빈칸만 채우게 하는 편이 훨씬 안정적입니다.
 */
export function buildCharPrompt(brief, known = {}) {
  const fixed = CHAR_FIELDS.filter((f) => known[f.key]?.trim());
  const blank = CHAR_FIELDS.filter((f) => !known[f.key]?.trim());
  const fixedLines = fixed.map((f) => `${f.label}: ${known[f.key].trim()}`);
  const form = (blank.length ? blank : CHAR_FIELDS).map((f) => `${f.label}: (${f.hint})`).join('\n');

  const blocks = [
    '아래 설명을 바탕으로 캐릭터 시트를 채워 주세요.',
    `# 설명\n${String(brief).trim()}`,
    fixed.length ? `# 이미 정해진 항목 (그대로 두세요)\n${fixedLines.join('\n')}` : null,
    `# 형식 예시 (참고용 — 이 인물이 아니라 이 인물의 형식을 따르세요)\n${CHAR_EXAMPLE}`,
    `# 이번에 채울 항목\n${form}`,
    '괄호 안의 안내는 지우고 내용만 씁니다. 예시에 나온 인물 이름이나 설정은 그대로 베끼지 마세요.'
  ];
  return blocks.filter(Boolean).join('\n\n');
}

/**
 * 라벨 인식은 최대한 관대하게 합니다 — 로컬 모델은 번호나 불릿을 붙이거나,
 * 라벨을 대괄호로 감싸거나, 진하게 표시하는 등 사소한 변형을 흔히 씁니다.
 * 여기서 다 받아 주는 편이, 매번 완벽한 형식을 강요하는 것보다 실패가 적습니다.
 */
const LABEL_RE = new RegExp(
  `^\\s*(?:\\d+[.).]\\s*)?(?:[-*•]\\s*)?(?:#{1,6}\\s*)?[\\[(【]?\\*{0,2}` +
  `(${[...BY_LABEL.keys()].join('|')})\\*{0,2}[\\])】]?\\s*[:：]\\s*(.*)$`
);

/**
 * 줄바꿈을 아예 안 지키고 한 줄로 죽 이어 쓰는 모델이 있습니다 — 라벨은 맞게 쓰면서도
 * 줄만 안 나누면 한 줄 파서(parseCharacter)는 첫 라벨의 값이 그 뒤 전부를 삼켜 버립니다.
 * 그런 경우에만(줄바꿈이 전혀 없고 라벨이 둘 이상 보일 때만) 라벨 앞에 줄바꿈을 끼워
 * 넣어 평소 파서가 그대로 쓸 수 있게 만듭니다. 정상적으로 줄바꿈된 응답은 건드리지 않습니다.
 */
function splitInlineLabels(text) {
  if (text.includes('\n')) return text;
  const inline = new RegExp(`(?:${[...BY_LABEL.keys()].join('|')})\\s*[:：]`, 'g');
  const hits = [...text.matchAll(inline)];
  if (hits.length < 2) return text;
  let out = text.slice(0, hits[0].index);
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    out += (i > 0 ? '\n' : '') + text.slice(start, end);
  }
  return out;
}

/** '라벨: 값' 덩어리를 항목별로 나눕니다. 라벨이 없는 줄은 앞 항목에 이어 붙습니다. */
export function parseCharacter(raw = '') {
  const text = splitInlineLabels(String(raw).replace(/```[a-z]*\n?/gi, '').trim());
  const out = {};
  let key = null;

  for (const line of text.split('\n')) {
    const m = line.match(LABEL_RE);
    if (m) {
      key = BY_LABEL.get(m[1]);
      out[key] = m[2].trim();
    } else if (key) {
      out[key] += `\n${line}`;
    }
  }

  const limits = { name: 40, avatar: 8, tags: 120, description: 200 };
  for (const [k, v] of Object.entries(out)) {
    let value = v
      .split('\n')
      .map((l) => l.replace(/^\s*\*{0,2}\s*$/, '').trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    // 모델이 "(이 인물을 나타내는 이모지 하나)" 처럼 안내를 그대로 옮겨 적는 경우가 있습니다.
    if (/^\(.*\)$/.test(value)) value = '';
    if (limits[k]) value = value.split('\n')[0].slice(0, limits[k]).trim();
    out[k] = value;
  }

  // 아이콘은 한 글자(이모지)만 남깁니다. 화면 입력칸이 2자까지만 받습니다.
  if (out.avatar) out.avatar = [...out.avatar.replace(/[\s"'`]/g, '')][0] || '';

  for (const { key: k } of CHAR_FIELDS) if (!out[k]) out[k] = '';
  return out;
}

/** 쓸 만한 시트인지 봅니다. 이름과 살점 하나는 있어야 합니다. */
export function looksUsable(character = {}) {
  const meat = ['personality', 'description', 'scenario', 'speech']
    .filter((k) => character[k]?.trim()).length;
  return Boolean(character.name?.trim()) && meat >= 1;
}

/** base 에 없는 항목만 extra 로 채웁니다. 이미 있는 값은 덮지 않습니다. */
export function mergeCharacters(base = {}, extra = {}) {
  const out = {};
  for (const { key } of CHAR_FIELDS) out[key] = base[key]?.trim() ? base[key] : (extra[key] || '');
  return out;
}

/**
 * 두 번 시도해도 라벨을 못 읽었을 때 마지막 수단입니다. 화면 칸을 완전히 비워 두는
 * 대신, 모델이 실제로 쓴 글을 추가 설정 칸에 그대로 남겨 손으로 옮길 거리라도 줍니다.
 */
export function roughFallback(base = {}, raw = '') {
  const out = { ...base };
  for (const { key } of CHAR_FIELDS) if (!out[key]) out[key] = '';
  const leftover = String(raw).trim().slice(0, 1500);
  if (!out.notes && leftover) out.notes = leftover;
  return out;
}
