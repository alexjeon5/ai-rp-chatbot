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
  { key: 'personality', label: '성격', hint: '연기의 뼈대. 행동으로 드러나는 성질을 2~4문장' },
  { key: 'speech', label: '말투', hint: '문장 길이, 존대/반말, 버릇을 1~2문장' },
  { key: 'scenario', label: '배경과 상황', hint: '첫 장면의 무대. {{user}}가 어디서 마주치는지' },
  { key: 'greeting', label: '첫 대사', hint: '이 인물이 먼저 던지는 한 턴. *행동* 과 "대사" 를 섞어서' },
  { key: 'exampleDialogue', label: '대화 예시', hint: '{{user}}: 와 {{char}}: 를 번갈아 2~3턴' },
  { key: 'notes', label: '추가 설정', hint: '관계, 금기, 세계관 규칙. 없으면 비워 둡니다' }
];

const BY_LABEL = new Map(CHAR_FIELDS.map((f) => [f.label, f.key]));

export const CHAR_GEN_SYSTEM =
  '당신은 롤플레이용 캐릭터 시트를 쓰는 한국어 창작 보조입니다.\n' +
  '사용자가 적은 설명을 재료 삼아 빈 곳을 메우고, 모호한 부분은 그럴듯하게 정합니다.\n' +
  '규칙:\n' +
  '- 아래 라벨을 그 순서대로, 각각 "라벨: 내용" 형태로 출력합니다.\n' +
  '- 라벨을 바꾸거나 새로 만들지 않습니다. 번호, 목록 기호, 굵게 표시, 코드블록을 쓰지 않습니다.\n' +
  '- 사용자가 이미 정한 항목은 그대로 두고, 그 설정과 어긋나지 않게 나머지를 씁니다.\n' +
  '- 사용자를 가리킬 때는 {{user}}, 이 인물을 가리킬 때는 {{char}} 를 씁니다.\n' +
  '- 설명이나 사족 없이 시트만 출력합니다.';

export function buildCharPrompt(brief, current = {}) {
  const fixed = CHAR_FIELDS
    .filter((f) => current[f.key]?.trim())
    .map((f) => `${f.label}: ${current[f.key].trim()}`);

  const form = CHAR_FIELDS.map((f) => `${f.label}: (${f.hint})`).join('\n');

  const blocks = [
    '아래 설명을 바탕으로 캐릭터 시트를 채워 주세요.',
    `# 설명\n${String(brief).trim()}`,
    fixed.length ? `# 이미 정해진 항목 (그대로 두세요)\n${fixed.join('\n')}` : null,
    `# 출력 형식\n${form}`,
    '괄호 안의 안내는 지우고 내용만 씁니다.'
  ];
  return blocks.filter(Boolean).join('\n\n');
}

const LABEL_RE = new RegExp(
  `^\\s*(?:[-*]\\s*)?(?:#{1,6}\\s*)?\\*{0,2}(${[...BY_LABEL.keys()].join('|')})\\*{0,2}\\s*[:：]\\s*(.*)$`
);

/** '라벨: 값' 덩어리를 항목별로 나눕니다. 라벨이 없는 줄은 앞 항목에 이어 붙습니다. */
export function parseCharacter(raw = '') {
  const text = String(raw).replace(/```[a-z]*\n?/gi, '').trim();
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
