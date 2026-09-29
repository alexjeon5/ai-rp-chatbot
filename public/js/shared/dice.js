/**
 * 주사위. 굴림 계산과 결과 문장을 만듭니다. 브라우저가 굴리고, 결과 문장이 내 메시지로 모델에게 갑니다.
 * 판정 표식([[판정: …]])의 문법은 scene-tags.js 가 맡습니다.
 */
import { DICE_SIDES } from './scene-tags.js';

export const MAX_COUNT = 10;
export const MAX_MOD = 50;

/** 0 이상 n 미만의 정수. 모자란 쪽으로 쏠리지 않게 범위를 벗어난 값은 다시 뽑습니다. */
export function secureInt(n) {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) return Math.floor(Math.random() * n);
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do c.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % n;
}

/** "2d6+3", "d20", "3d8-1" → { count, sides, mod }. 읽지 못하거나 주사위 종류·개수가 범위 밖이면 null. */
export function parseNotation(value) {
  const m = /^\s*(\d{0,2})\s*d\s*(\d{1,3})\s*(?:([+-])\s*(\d{1,3}))?\s*$/i.exec(String(value));
  if (!m) return null;
  const count = m[1] === '' ? 1 : Number(m[1]);
  const sides = Number(m[2]);
  const mod = m[3] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
  if (count < 1 || count > MAX_COUNT || !DICE_SIDES.includes(sides) || Math.abs(mod) > MAX_MOD) return null;
  return { count, sides, mod };
}

/** rng(n) 은 0..n-1 을 돌려주는 함수입니다. 시험에서 바꿔 끼울 수 있습니다. */
export function rollDice({ count = 1, sides = 20, mod = 0 }, rng = secureInt) {
  const rolls = Array.from({ length: count }, () => rng(sides) + 1);
  return { rolls, mod, total: rolls.reduce((a, b) => a + b, 0) + mod };
}

/** d20 에서 눈이 20 이면 대성공, 1 이면 대실패. 그 밖에는 난이도 이상이면 성공. */
export function judge({ sides, dc }, roll) {
  if (sides === 20 && roll === 20) return '대성공';
  if (sides === 20 && roll === 1) return '대실패';
  return roll >= dc ? '성공' : '실패';
}

/** 그냥 굴린 결과. 예) 🎲 2d6+3 → 4 + 5 +3 = 12 */
export function formatRoll(spec, { rolls, mod, total }) {
  const name = `${spec.count > 1 ? spec.count : ''}d${spec.sides}${mod ? (mod > 0 ? `+${mod}` : String(mod)) : ''}`;
  if (rolls.length === 1 && !mod) return `🎲 ${name} → ${total}`;
  const parts = rolls.join(' + ') + (mod ? ` ${mod > 0 ? '+' : '-'}${Math.abs(mod)}` : '');
  return `🎲 ${name} → ${parts} = ${total}`;
}

/** 판정 결과. 예) 🎲 설득 판정 (d20, 난이도 15): 17 — 성공 */
export function formatCheck(check, roll) {
  return `🎲 ${check.label} 판정 (d${check.sides}, 난이도 ${check.dc}): ${roll} — ${judge(check, roll)}`;
}
