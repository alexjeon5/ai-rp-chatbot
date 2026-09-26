/** 캐릭터·페르소나 같은 저장 항목의 모양을 다듬는 규칙. 입력 검사와 백업 불러오기가 같이 씁니다. */
import { CHARACTER_FIELDS } from '../content/characters.js';

/** id 는 그대로 파일 이름이 되므로 안전한 글자만 받습니다. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** 캐릭터 시트의 칸만 글자로 골라 냅니다. */
export const characterFields = (raw) => Object.fromEntries(CHARACTER_FIELDS.map((f) => [f, str(raw[f])]));

export const PERSONA_FIELDS = ['name', 'description', 'gender', 'age', 'traits'];

/**
 * 페르소나 값 정리. 성별·나이는 짧은 글, 특징은 한 줄짜리 항목 목록입니다.
 * 들어온 칸만 고쳐서 돌려주므로 PUT 에서 일부만 보내도 됩니다.
 */
export function normalizePersona(p) {
  const out = { ...p };
  for (const k of ['name', 'description', 'gender', 'age']) {
    if (k in out) out[k] = String(out[k] ?? '').slice(0, k === 'description' ? 4000 : 80);
  }
  if ('traits' in out) {
    const list = Array.isArray(out.traits) ? out.traits : String(out.traits || '').split('\n');
    out.traits = list.map((t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 30);
  }
  return out;
}
