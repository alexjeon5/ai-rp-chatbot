/**
 * 자리표시자 치환 + 한국어 조사 교정. 서버(src/prompt.js)와 화면이 이 파일 하나를 같이 씁니다.
 * 브라우저는 /js/shared/korean.js 로, 서버는 상대 경로로 불러옵니다.
 */

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
  ['으로', '로'], ['이라', '라'], ['이랑', '랑'], ['이다', '다'], ['아', '야'],
  ['이나', '나']
];
const PARTICLE_ALT = new Map();
for (const pair of PARTICLE_PAIRS) for (const p of pair) PARTICLE_ALT.set(p, pair);

const PRONOUN_GA = { 나: '내가', 저: '제가', 너: '네가' };
const ALTERNATIVES = [...new Set(PARTICLE_PAIRS.flat())].sort((a, b) => b.length - a.length);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * {{char}} 같은 자리표시자를 값으로 바꾸면서, 바로 뒤에 붙은 조사를 이름의 받침에 맞춰 고칩니다. "유하린가" → "유하린이".
 * 조사 뒤에 또 한글이 이어지면(예: {{char}}이야기) 조사로 보지 않고 이름만 바꿔 넣습니다.
 */
export function substitute(text, token, value) {
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

/** {{char}}·{{캐릭터}}, {{user}}·{{유저}} 를 이름으로 바꿉니다. put 으로 바꾸는 방법(조사 교정 여부)을 고릅니다. */
export function fillTokens(text, char, user, put = substitute) {
  let out = text;
  for (const token of ['{{char}}', '{{캐릭터}}']) out = put(out, token, char);
  for (const token of ['{{user}}', '{{유저}}']) out = put(out, token, user);
  return out;
}
