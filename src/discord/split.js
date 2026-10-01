/** 디스코드 한 메시지에 들어가는 조각으로 글 나누기. 한 메시지는 2000자까지입니다. */

/** 한 조각의 기본 길이. 2000자에 여유를 둡니다. */
export const CHUNK_LIMIT = 1900;

/** limit 안에서 가장 늦게 끊을 수 있는 자리(그 자리 앞까지가 한 조각). 너무 앞(절반 전)이면 잘게 쪼개지므로 쓰지 않습니다. */
function cutPoint(window, limit) {
  const min = limit / 2;
  for (const sep of ['\n\n', '\n']) {
    const i = window.lastIndexOf(sep);
    if (i >= 0 && i + sep.length > min) return i + sep.length;
  }
  // 문장 끝(마침표·물음표 등, 닫는 따옴표까지) 다음 띄어쓰기.
  const sentence = /[.!?。…~][)"'”’」』]*\s/g;
  let best = -1;
  for (let m = sentence.exec(window); m; m = sentence.exec(window)) best = m.index + m[0].length;
  if (best > min) return best;
  const space = window.lastIndexOf(' ');
  if (space > min) return space + 1;
  return limit;
}

/**
 * 앞에서부터 limit 안에서 가장 늦게 끊을 수 있는 곳을 찾아 나눕니다. 문단 → 줄 → 문장 → 띄어쓰기 → 글자 순입니다.
 * 앞 조각의 경계는 뒤에 글이 더 붙어도 바뀌지 않으므로, 스트리밍 중에 나눠도 앞 메시지가 흔들리지 않습니다.
 */
export function splitMessage(text, limit = CHUNK_LIMIT) {
  const out = [];
  let rest = String(text ?? '');
  while (rest.length > limit) {
    const cut = cutPoint(rest.slice(0, limit), limit);
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.trim()) out.push(rest);
  return balanceFences(out.filter((chunk) => chunk.trim()));
}

const FENCE = /^\s*```(\S*)/;

/**
 * 코드 블록(```) 한가운데서 나뉜 조각은 앞 조각 끝에서 닫고 다음 조각 앞에서 같은 언어로 다시 엽니다.
 * 그러지 않으면 뒤 메시지의 코드가 본문처럼, 본문이 코드처럼 보입니다. 붙는 글자는 조각마다 20자 안팎입니다.
 */
export function balanceFences(chunks) {
  let open = null;
  return chunks.map((chunk) => {
    const head = open === null ? '' : `\`\`\`${open}\n`;
    for (const line of chunk.split('\n')) {
      const m = FENCE.exec(line);
      if (m) open = open === null ? m[1] : null;
    }
    return `${head}${chunk}${open === null ? '' : '\n```'}`;
  });
}
