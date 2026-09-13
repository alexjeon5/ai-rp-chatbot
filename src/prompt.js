/** 캐릭터 / 페르소나 / 템플릿을 하나의 시스템 프롬프트로 조립합니다. */

/** 마지막 글자에 받침이 있으면 true. 한글이 아닌 이름은 모음으로 끝나는지로 어림합니다. */
function hasBatchim(word = '') {
  const ch = word.trim().slice(-1);
  const code = ch.charCodeAt(0);
  if (Number.isNaN(code)) return null;
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[a-z]/i.test(ch)) return !'aeiouy'.includes(ch.toLowerCase());
  return null;
}

// [받침 있을 때, 받침 없을 때]
const PARTICLE_PAIRS = [
  ['은', '는'], ['이', '가'], ['을', '를'], ['과', '와'],
  ['으로', '로'], ['이라', '라'], ['이랑', '랑'], ['이다', '다'], ['아', '야']
];

const PARTICLE_ALT = new Map();
for (const [withB, withoutB] of PARTICLE_PAIRS) {
  PARTICLE_ALT.set(withB, [withB, withoutB]);
  PARTICLE_ALT.set(withoutB, [withB, withoutB]);
}

const PRONOUN_GA = { 나: '내가', 저: '제가', 너: '네가' };
const ALTERNATIVES = [...new Set(PARTICLE_PAIRS.flat())].sort((a, b) => b.length - a.length);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * {{char}} 같은 자리표시자를 값으로 바꾸면서, 바로 뒤에 붙은 조사를
 * 이름의 받침에 맞춰 고칩니다. "유하린가" → "유하린이".
 * 조사 뒤에 또 한글이 이어지면(예: {{char}}이야기) 손대지 않습니다.
 */
function substitute(text, token, value) {
  // 조사 뒤에 한글이 이어지면 조사로 보지 않고, 이름만 바꿔 넣습니다.
  const re = new RegExp(`${escapeRe(token)}(?:(${ALTERNATIVES.join('|')})(?![가-힣]))?`, 'g');
  return text.replace(re, (_m, particle) => {
    if (!particle) return value;
    if (particle === '가' || particle === '이') {
      const pronoun = PRONOUN_GA[value.trim()];
      if (pronoun) return pronoun;
    }
    const batchim = hasBatchim(value);
    if (batchim === null) return value + particle;
    const [withB, withoutB] = PARTICLE_ALT.get(particle);
    return value + (batchim ? withB : withoutB);
  });
}

export function fillVars(text = '', { char, user, particleFix = true }) {
  const put = (t, token, value) =>
    particleFix ? substitute(t, token, value) : t.replaceAll(token, value);
  let out = text;
  for (const token of ['{{char}}', '{{캐릭터}}']) out = put(out, token, char || '캐릭터');
  for (const token of ['{{user}}', '{{유저}}']) out = put(out, token, user || '사용자');
  return out;
}

/** 함께 등장하는 인물들의 설정을 한 덩어리로 만듭니다. */
function buildCastBlock(cast = []) {
  if (!cast.length) return '';
  const sheets = cast.map((c) => {
    const lines = [`### ${c.name}`];
    if (c.description?.trim()) lines.push(c.description.trim());
    if (c.personality?.trim()) lines.push(`성격: ${c.personality.trim()}`);
    if (c.speech?.trim()) lines.push(`말투: ${c.speech.trim()}`);
    return lines.join('\n');
  });
  return sheets.join('\n\n');
}

export function buildSystem({ character, persona, template, cast = [], particleFix = true }) {
  const vars = { char: character.name, user: persona?.name || '사용자', particleFix };

  // 자리표시자가 하나도 없는 틀(직접 써 온 프롬프트 등)이면 배역 정보가 들어갈 곳이 없습니다.
  // 그런 경우에만 앞쪽에 배역 블록을 덧붙입니다.
  if (!template.includes('{{char}}') && !template.includes('{{캐릭터}}')) {
    template = `${template.trim()}\n\n# 등장인물\n이름: {{char}}\n{{description}}\n성격: {{personality}}\n말투: {{speech}}\n배경: {{scenario}}\n\n# 상대역\n이름: {{user}}\n{{persona}}`;
  }

  const castBlock = buildCastBlock(cast);
  const slots = {
    '{{cast}}': castBlock,
    '{{description}}': character.description,
    '{{personality}}': character.personality,
    '{{speech}}': character.speech,
    '{{scenario}}': character.scenario,
    '{{persona}}': persona?.description
  };

  // 비어 있는 항목은 라벨까지 통째로 지워, 빈 줄이 남지 않게 합니다.
  let out = template;
  for (const [slot, value] of Object.entries(slots)) {
    if (value && value.trim()) {
      out = out.replaceAll(slot, value.trim());
    } else {
      out = out.split('\n').filter((line) => !line.includes(slot)).join('\n');
    }
  }

  // 자리표시자가 없는 틀에도 출연 인물이 들어가야 하므로 뒤에 붙입니다.
  if (castBlock && !template.includes('{{cast}}')) {
    out += `\n\n# 함께 등장하는 인물\n${castBlock}`;
  }
  if (castBlock) {
    out += '\n\n이 인물들은 {{char}}와 마찬가지로 당신이 연기합니다. ' +
      '서로 말을 주고받게 하고, 장면에 필요하면 먼저 나서게 하세요. ' +
      '다만 {{user}}의 대사와 행동은 여전히 쓰지 않습니다.';
  }

  if (character.exampleDialogue?.trim()) {
    out += `\n\n# 대화 예시\n${character.exampleDialogue.trim()}`;
  }
  if (character.notes?.trim()) {
    out += `\n\n# 추가 설정\n${character.notes.trim()}`;
  }

  return fillVars(out, vars).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Gemma 4 는 시스템 프롬프트 맨 앞의 <|think|> 토큰이 있을 때만 사고 모드로 들어갑니다.
 * 로컬 엔진에서 사고를 켜고 끌 때 씁니다.
 */
export function withThinking(system, on) {
  const cleaned = system.replace(/^<\|think\|>\s*/, '');
  return on ? `<|think|>\n${cleaned}` : cleaned;
}

export function buildHistory(chat, limit) {
  return chat.messages
    .filter((m) => !m.hidden && m.content?.trim())
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content }));
}
