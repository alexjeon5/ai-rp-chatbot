/**
 * PNG 캐릭터 카드에서 글 덩어리를 꺼냅니다. 카드 만들기 도구들은 캐릭터 JSON 을 base64 로 바꿔
 * 그림 파일의 tEXt 조각(키워드 `chara`, 3판 카드는 `ccv3`)에 넣어 둡니다. 그림 자체는 쓰지 않습니다.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KEYWORDS = ['ccv3', 'chara']; // 앞의 것을 먼저 씁니다

/** 사용자에게 그대로 보여 줘도 되는 카드 오류 */
export class CardError extends Error {}

/** PNG 안의 글 조각들을 { 키워드: 글 } 로. 압축된 조각(zTXt)과 압축된 iTXt 는 건너뜁니다. */
export function pngTextChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new CardError('PNG 파일이 아닙니다.');
  const out = {};
  let at = 8;
  while (at + 12 <= buf.length) {
    const size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const start = at + 8;
    const end = start + size;
    if (end + 4 > buf.length) break; // 잘린 파일. 지금까지 읽은 것만 씁니다
    if (type === 'tEXt') {
      const body = buf.subarray(start, end);
      const nul = body.indexOf(0);
      if (nul > 0) out[body.toString('latin1', 0, nul)] ??= body.toString('latin1', nul + 1);
    } else if (type === 'iTXt') {
      const body = buf.subarray(start, end);
      const nul = body.indexOf(0);
      // 키워드 \0 압축여부 압축방식 언어 \0 번역된키워드 \0 글
      if (nul > 0 && body[nul + 1] === 0) {
        const langEnd = body.indexOf(0, nul + 3);
        const transEnd = langEnd < 0 ? -1 : body.indexOf(0, langEnd + 1);
        if (transEnd >= 0) out[body.toString('latin1', 0, nul)] ??= body.toString('utf8', transEnd + 1);
      }
    } else if (type === 'IEND') break;
    at = end + 4;
  }
  return out;
}

/** PNG 카드에 든 캐릭터 JSON 을 해석해 돌려줍니다. */
export function cardFromPng(buf) {
  const chunks = pngTextChunks(buf);
  const key = KEYWORDS.find((k) => chunks[k]);
  if (!key) throw new CardError('이 PNG 에는 캐릭터 카드 정보가 들어 있지 않습니다.');
  try {
    return JSON.parse(Buffer.from(chunks[key].trim(), 'base64').toString('utf8'));
  } catch {
    throw new CardError('PNG 안의 캐릭터 정보를 읽지 못했습니다.');
  }
}
