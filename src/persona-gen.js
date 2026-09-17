/**
 * 씨앗 태그(src/persona-seeds.js)를 소개 문장으로 바꾸는 부분입니다.
 *
 * 모델은 '한 문단'만 씁니다. JSON 을 받지 않는 이유는 로컬 모델이 따옴표나 중괄호를
 * 자주 흘려서, 형식을 요구할수록 실패가 늘기 때문입니다. 대신 후처리로 군더더기를 걷어냅니다.
 */

import { seedsToLines } from './persona-seeds.js';

export const GEN_SYSTEM =
  '당신은 한국어 창작 보조입니다. 주어진 태그를 재료 삼아 인물 소개 한 문단을 씁니다.\n' +
  '규칙:\n' +
  '- 3~5문장, 한 문단. 줄바꿈 없이.\n' +
  '- 3인칭 서술로 쓰고, 이름은 첫 문장에 한 번만 넣습니다.\n' +
  '- 태그를 그대로 나열하지 말고 문장 안에 녹입니다.\n' +
  '- 대사, 따옴표, 괄호 묘사, 제목, 머리말, 목록 기호를 쓰지 않습니다.\n' +
  '- 설명이나 사족 없이 본문만 출력합니다.';

export function buildGenPrompt(seeds) {
  const lines = seedsToLines(seeds);
  return `다음 태그로 인물 소개 한 문단을 써 주세요.\n\n${lines.join('\n')}\n\n본문만 출력하세요.`;
}

/**
 * 모델이 덧붙이기 쉬운 것들을 걷어냅니다 — 머리말("소개:"), 코드펜스, 따옴표로 감싼 전체,
 * 목록 기호, 여러 문단. 문단이 여러 개면 첫 문단만 씁니다.
 */
export function cleanGenerated(raw = '') {
  let text = String(raw).trim();
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  text = text.split(/\n\s*\n/)[0];
  text = text
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').replace(/^\s*#{1,6}\s*/, '').trim())
    .filter(Boolean)
    .join(' ');
  text = text.replace(/^(인물\s*)?(소개|설명|프로필|출력|답변)\s*[:：]\s*/i, '');
  if (/^["'“”‘’]/.test(text) && /["'“”‘’]$/.test(text)) text = text.slice(1, -1).trim();
  return text.replace(/\s{2,}/g, ' ').trim();
}

/**
 * 모델을 못 쓰는 상황(엔진 미설정, 오류, 오프라인)에서도 기능이 멈추지 않도록
 * 태그만으로 문장을 만듭니다. 문체는 단조롭지만 바로 쓸 수 있습니다.
 */
export function fallbackDescription(seeds = {}) {
  const list = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean);
  const join = (arr) => arr.join(', ');
  const parts = [];

  const head = [seeds.age, seeds.role].filter(Boolean).join(' ');
  if (head) parts.push(`${head}.`);
  if (list(seeds.look).length) parts.push(`${join(list(seeds.look))}.`);
  if (list(seeds.trait).length) parts.push(`${join(list(seeds.trait))}.`);
  if (seeds.speech) parts.push(`${seeds.speech}.`);
  if (seeds.hook) parts.push(`${seeds.hook}.`);

  return parts.join(' ').replace(/\.\./g, '.').trim();
}
