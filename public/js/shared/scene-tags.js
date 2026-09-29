/**
 * 답변 안의 화면 표식. 서버(저장·프롬프트)와 브라우저(스트리밍 중 화면)가 같은 규칙을 씁니다.
 *
 *   [[표정: 기쁨]]   지금 캐릭터의 표정
 *   [[장소: 교실]]   장면의 장소
 *   [[판정: 설득 d20 난이도 15]]   주사위 판정 요청
 *
 * 표식은 본문에서 떼어 내 저장하고, 화면에는 보이지 않습니다.
 */

const KEYS = { 표정: 'expression', 장소: 'place', 판정: 'check' };
export const DICE_SIDES = [4, 6, 8, 10, 12, 20, 100];

const tagPattern = () => /\[\[\s*(표정|장소|판정)\s*[:：]\s*([^\]\n]{1,60}?)\s*\]\]/g;

/** "설득 d20 난이도 15" → { label: '설득', sides: 20, dc: 15 }. 읽지 못하면 null. */
export function parseCheck(value) {
  const m = /^(.*?)\s*\bd(\d{1,3})\b\D*?(\d{1,3})\s*$/i.exec(String(value).trim());
  if (!m) return null;
  const sides = Number(m[2]);
  const dc = Number(m[3]);
  const label = m[1].replace(/[[\]]/g, '').trim().slice(0, 20);
  if (!label || !DICE_SIDES.includes(sides) || dc < 1 || dc > 200) return null;
  return { label, sides, dc };
}

/**
 * 표식을 뽑고 본문에서 지웁니다. 같은 종류가 여러 번 나오면 마지막 것이 이깁니다.
 * @returns {{ text: string, expression?: string, place?: string, check?: object }}
 */
export function extractDirectives(text) {
  const out = {};
  const body = String(text ?? '').replace(tagPattern(), (_, key, value) => {
    const name = KEYS[key];
    if (name === 'check') {
      const check = parseCheck(value);
      if (check) out.check = check;
    } else {
      out[name] = value.trim();
    }
    return '';
  });
  // 첫 줄에 표식만 있던 자리에 남은 빈 줄과 앞 공백을 걷어 냅니다.
  return { ...out, text: body.replace(/^[ \t]*\n+/, '').replace(/^[ \t]+/, '') };
}

/**
 * 화면에 보일 글. 쓰는 도중 아직 닫히지 않은 표식(`[[표정: 기`)도 감춥니다.
 */
export function stripForDisplay(text) {
  return extractDirectives(text).text.replace(/\[\[[^\]]*$/, '').replace(/\[$/, '');
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

/** 모델이 적은 이름을 준비된 이름들 중에서 찾습니다. 같은 이름 → 서로 포함하는 이름 순. 없으면 null. */
export function matchLabel(value, labels) {
  const want = norm(value);
  if (!want) return null;
  const exact = labels.find((l) => norm(l) === want);
  if (exact !== undefined) return exact;
  const near = labels.find((l) => norm(l) && (norm(l).includes(want) || want.includes(norm(l))));
  return near ?? null;
}

/** 저장할 장면 정보로. 준비된 이름과 맞지 않는 값은 버립니다. 아무것도 없으면 null. */
export function resolveScene(directives, { expressions = [], places = [] }) {
  const scene = {};
  const expression = matchLabel(directives.expression, expressions);
  if (expression !== null) scene.expression = expression;
  const place = matchLabel(directives.place, places);
  if (place !== null) scene.place = place;
  return Object.keys(scene).length ? scene : null;
}

/** 저장된 장면 정보를 프롬프트용 표식으로 되돌립니다. 지난 답변에도 표식을 보여 줘야 모델이 형식을 잊지 않습니다. */
export function sceneTags(scene) {
  if (!scene) return '';
  return [scene.expression && `[[표정: ${scene.expression}]]`, scene.place && `[[장소: ${scene.place}]]`]
    .filter(Boolean).join(' ');
}

/** 저장된 판정 요청을 프롬프트용 표식으로 되돌립니다. */
export function checkTag(check) {
  return check ? `[[판정: ${check.label} d${check.sides} 난이도 ${check.dc}]]` : '';
}
