/**
 * 사고(thinking) 블록 제거기.
 *
 * Gemma 4 는 thinking 을 꺼도 빈 사고 블록을 출력합니다.
 *   <|channel>thought\n ... <channel|>최종 답변
 * 다른 모델의 <think> ... </think> 도 같이 걸러냅니다.
 *
 * 스트리밍에서는 태그가 청크 사이에서 잘릴 수 있으므로("<|chan" + "nel>thought"),
 * 표지의 앞부분일 수 있는 꼬리는 붙들고 있다가 다음 청크와 합쳐 판단합니다.
 */

const OPEN = ['<|channel>thought', '<|channel|>thought', '<think>', '<thought>'];
const CLOSE = ['<channel|>', '<|channel|>', '</think>', '</thought>'];

const maxLen = (arr) => Math.max(...arr.map((s) => s.length));

/** buf 안에서 가장 먼저 나오는 표지의 위치와 길이. 없으면 null. */
function firstMatch(buf, markers) {
  let best = null;
  for (const m of markers) {
    const i = buf.indexOf(m);
    if (i >= 0 && (!best || i < best.index || (i === best.index && m.length > best.length))) {
      best = { index: i, length: m.length };
    }
  }
  return best;
}

/** buf 의 끝부분이 어떤 표지의 시작일 수 있으면, 그 길이를 돌려줍니다. */
function danglingPrefix(buf, markers) {
  const limit = Math.min(buf.length, maxLen(markers) - 1);
  for (let keep = limit; keep > 0; keep--) {
    const tail = buf.slice(buf.length - keep);
    if (markers.some((m) => m.startsWith(tail))) return keep;
  }
  return 0;
}

export function makeThoughtStripper({ onThought } = {}) {
  let buf = '';
  let inThought = false;

  // 사고 블록 안의 글자를 버리지 않고 따로 넘겨 줍니다. 화면에서 접어서 보여 주기 위함입니다.
  const keepThought = (t) => { if (t && onThought) onThought(t); };

  return {
    /** 청크를 넣으면 내보내도 되는 텍스트만 돌려줍니다. */
    feed(chunk) {
      buf += chunk;
      let out = '';

      for (;;) {
        if (inThought) {
          const close = firstMatch(buf, CLOSE);
          if (!close) {
            // 닫는 표지가 아직 없음. 표지 앞부분일 수 있는 꼬리만 남기고 흘려보냅니다.
            const keep = danglingPrefix(buf, CLOSE);
            keepThought(keep ? buf.slice(0, buf.length - keep) : buf);
            buf = keep ? buf.slice(buf.length - keep) : '';
            break;
          }
          keepThought(buf.slice(0, close.index));
          buf = buf.slice(close.index + close.length);
          inThought = false;
          continue;
        }

        const open = firstMatch(buf, OPEN);
        if (open) {
          out += buf.slice(0, open.index);
          buf = buf.slice(open.index + open.length);
          inThought = true;
          continue;
        }

        const keep = danglingPrefix(buf, OPEN);
        out += keep ? buf.slice(0, buf.length - keep) : buf;
        buf = keep ? buf.slice(buf.length - keep) : '';
        break;
      }

      return out;
    },

    /** 스트림이 끝났을 때 남은 찌꺼기를 회수합니다. */
    flush() {
      const rest = inThought ? '' : buf;
      buf = '';
      return rest;
    }
  };
}

/**
 * 같은 조각이 끝없이 되풀이되는 출력을 알아냅니다.
 *
 * "나찰의 나찰의…" 처럼 깔끔하게 반복되는 경우도 있지만, 실제로는
 * "얇한한한한… 부풀어 오르는 얇한한한한…" 처럼 중간에 다른 조각이 끼어듭니다.
 * 그래서 주기성만 보면 놓칩니다. 두 가지를 함께 봅니다.
 *
 *   1) 꼬리가 짧은 단위로 딱 떨어지게 반복되는가
 *   2) 짧은 조각 하나가 꼬리 전체를 거의 뒤덮고 있는가
 *
 * 후렴구나 말더듬 연출을 오검출하지 않도록 기준은 넉넉히 잡았습니다.
 */
export function looksRepetitive(text = '') {
  if (text.length < 160) return false;
  const tail = text.slice(-600);
  return hasPeriodicTail(tail) || isFloodedByUnit(tail);
}

/** 꼬리가 같은 단위의 되풀이로만 이루어졌는지. */
function hasPeriodicTail(tail) {
  for (const [unitMax, minRepeat] of [[1, 40], [40, 8]]) {
    const unitMin = unitMax === 1 ? 1 : 2;
    for (let len = unitMin; len <= unitMax; len++) {
      const span = len * minRepeat;
      if (tail.length < span) continue;

      const chunk = tail.slice(-span);
      const unit = chunk.slice(0, len);
      let same = true;
      for (let i = len; i < chunk.length; i += len) {
        if (chunk.slice(i, i + len) !== unit) { same = false; break; }
      }
      if (same && unit.trim()) return true;
    }
  }
  return false;
}

/**
 * 짧은 조각 하나가 꼬리의 대부분을 차지하는지.
 * 사이사이 다른 말이 끼어들어도 잡힙니다.
 */
function isFloodedByUnit(tail) {
  const body = tail.replace(/\s+/g, '');
  if (body.length < 120) return false;

  for (let len = 1; len <= 6; len++) {
    const counts = new Map();
    for (let i = 0; i + len <= body.length; i += len) {
      const unit = body.slice(i, i + len);
      counts.set(unit, (counts.get(unit) || 0) + 1);
    }
    const total = Math.floor(body.length / len);
    for (const [unit, n] of counts) {
      // 한 조각이 꼬리의 70% 이상을 먹고, 최소 20번은 나와야 루프로 봅니다.
      if (n >= 20 && n / total >= 0.7 && unit.trim()) return true;
    }
  }
  return false;
}
