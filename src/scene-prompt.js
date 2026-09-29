/**
 * 화면 연출용 표식을 모델에게 알리는 시스템 프롬프트 조각.
 * 표식의 문법과 해석은 public/js/shared/scene-tags.js 가 맡습니다.
 */

/**
 * @param {object} o
 * @param {string} o.name 주인공 캐릭터 이름
 * @param {string[]} [o.expressions] 고를 수 있는 표정 이름 (비어 있으면 표정 표식을 요청하지 않습니다)
 * @param {string[]} [o.places] 고를 수 있는 장소 이름
 * @param {boolean} [o.dice] 주사위 판정 표식도 요청합니다
 * @returns {string} 요청할 표식이 하나도 없으면 빈 글
 */
export function sceneBlock({ name, expressions = [], places = [], dice = false }) {
  return [screenPart({ name, expressions, places }), dice ? DICE_PART : ''].filter(Boolean).join('\n\n');
}

const DICE_PART = [
  '[주사위 판정 — 연출용, 이야기 속 글이 아닙니다]',
  '이 대화는 주사위로 불확실한 행동의 결과를 정합니다.',
  '- 결과가 갈리고 실패가 이야기에 영향을 주는 행동(설득, 잠입, 전투, 위험한 도약 등)이 나오면, 결과를 정하지 말고 상황까지만 쓴 뒤 답변의 맨 끝에 [[판정: 행동이름 d20 난이도 숫자]] 표식을 적고 멈춥니다.',
  '- 난이도는 1~20 (쉬움 8, 보통 12, 어려움 16, 극한 20). 행동이름은 짧게(예: 설득). 한 답변에 표식은 하나만, 사소한 행동에는 쓰지 않습니다.',
  '- 내 다음 메시지에 🎲 로 시작하는 결과가 있으면 그 결과를 그대로 따라 이야기를 잇습니다. 성공이면 이루어지고 실패면 어긋납니다. 대성공·대실패는 평소보다 극적으로 씁니다. 결과를 뒤집거나 다시 굴리게 하지 않습니다.',
  '예) 문지기가 팔짱을 낀 채 당신을 노려본다.\n[[판정: 설득 d20 난이도 14]]'
].join('\n');

function screenPart({ name, expressions, places }) {
  const lines = [];
  const example = [];
  if (expressions.length) {
    lines.push(`- [[표정: 이름]] — 지금 ${name}의 표정. 고를 수 있는 이름: ${expressions.join(', ')}`);
    example.push(`[[표정: ${expressions[0]}]]`);
  }
  if (places.length) {
    lines.push(`- [[장소: 이름]] — 장면의 장소가 처음이거나 바뀌었을 때만. 고를 수 있는 이름: ${places.join(', ')}`);
    example.push(`[[장소: ${places[0]}]]`);
  }
  if (!lines.length) return '';
  return [
    '[화면 표식 — 연출용, 이야기 속 글이 아닙니다]',
    '답변의 맨 첫 줄에 아래 표식을 한 줄로 적으세요. 표식은 화면에서 이미지 전환에만 쓰이고 독자에게는 보이지 않습니다.',
    ...lines,
    '목록에 없는 이름은 쓰지 말고, 표식 안에는 이름만 적습니다. 표식 다음 줄부터 본문을 씁니다.',
    `예) ${example.join(' ')}`
  ].join('\n');
}
