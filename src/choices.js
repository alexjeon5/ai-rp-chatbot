/** 선택지 제안: 내 다음 차례 후보를 여럿 받는 프롬프트와, 모델 답을 후보 목록으로 읽는 함수. */
import { parseCheck } from '../public/js/shared/scene-tags.js';

export const CHOICE_COUNT = { min: 2, max: 5, def: 3 };
const CHOICE_CHARS = 200;

/**
 * 진행 지시 한 덩어리. 대신 쓰기와 같은 방식으로 마지막 요청에 덧붙여 씁니다.
 * @param {object} o
 * @param {boolean} [o.messenger] 메신저 모드면 문자 한 줄씩
 * @param {boolean} [o.director] 감독 페르소나면 대사 대신 다음 장면의 행동 지시
 * @param {boolean} [o.dice] 주사위 판정이 켜져 있으면 불확실한 행동에 판정을 붙일 수 있게 합니다
 * @param {number} [o.count]
 */
export function choicesPrompt({ messenger = false, director = false, dice = false, count = CHOICE_COUNT.def } = {}) {
  const n = Math.min(CHOICE_COUNT.max, Math.max(CHOICE_COUNT.min, Math.round(count) || CHOICE_COUNT.def));
  const lines = [
    `[진행 지시: 이번 한 번은 예외로, {{user}}가 다음에 할 만한 ${director ? '연출 지시' : '말이나 행동'} 후보 ${n}개를 제안합니다.`,
    '- 후보끼리 방향이 확실히 다르게 씁니다. 예) 신중하게, 대담하게, 엉뚱하게.',
    director
      ? '- 각 후보는 다음에 일어날 일을 등장인물의 행동과 상황의 변화로만 씁니다. 따옴표 대사는 쓰지 않습니다.'
      : messenger
        ? '- 각 후보는 {{user}}가 보낼 메신저 문자 한 줄입니다. 묘사는 쓰지 않습니다.'
        : '- 각 후보는 {{user}}의 시점에서 1~2문장(60자 안팎)으로 씁니다. 지금까지 {{user}}가 쓰던 표기법을 따릅니다.',
    '- {{char}}나 다른 인물의 대사와 반응은 쓰지 않습니다.',
    '- 한 줄에 후보 하나, 줄 앞에 "- " 만 붙입니다. 번호, 이름표, 머리말, 설명은 쓰지 않습니다.'
  ];
  if (dice) {
    lines.push('- 결과가 불확실한 행동이면 그 줄 끝에 (판정: 행동이름 d20 난이도 숫자) 를 붙입니다. 예) - 문지기를 구슬려 본다. (판정: 설득 d20 난이도 14)');
  }
  return `${lines.join('\n')}]`;
}

/** 후보 줄을 [{ text, check? }] 로. 머리 기호와 겉따옴표를 걷고, 빈 줄·겹치는 줄은 버립니다. */
export function parseChoices(text = '', max = CHOICE_COUNT.max) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text).split('\n')) {
    let line = raw.trim().replace(/^(?:[-*•▪·]|\d{1,2}[.)])\s+/, '').trim();
    let check;
    line = line.replace(/\s*[(（]\s*판정\s*[:：]\s*([^)）]+?)\s*[)）]\s*$/, (_, value) => {
      check = parseCheck(value) || undefined;
      return '';
    }).trim();
    line = line.replace(/^["“'‘](.+)["”'’]$/, '$1').trim().slice(0, CHOICE_CHARS);
    if (line.length < 2 || seen.has(line)) continue;
    seen.add(line);
    out.push(check ? { text: line, check } : { text: line });
    if (out.length >= max) break;
  }
  return out;
}
