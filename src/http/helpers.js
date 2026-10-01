/** 라우트들이 같이 쓰는 작은 도구. */
import { AppError } from '../services/errors.js';

export const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

/**
 * async 라우트의 오류를 응답으로 바꿉니다.
 * 서비스가 던진 AppError(NotFound 등)는 그 상태 코드와 안내로, 나머지는 500 으로 보냅니다.
 */
export const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  if (e instanceof AppError) {
    if (!res.headersSent) fail(res, e.status, e.message, e.extra);
    return;
  }
  console.error(e);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

/**
 * 브라우저가 창을 닫거나 연결을 끊으면 멈추는 컨트롤러.
 * req 의 close 는 요청 본문이 끝날 때도 발생하므로 res 를 봅니다. 일을 마친 뒤 finish() 를 부르면 더는 멈추지 않습니다.
 */
export function abortOnClose(res) {
  const controller = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) controller.abort(); });
  return Object.assign(controller, { finish: () => { finished = true; } });
}

/**
 * 첫 조각을 보낼 때 여는 SSE. 서비스는 시작 전에 막히면 던지므로(wrap 이 JSON 오류로 바꿈),
 * 응답 머리는 실제로 흘려보낼 것이 생겼을 때 씁니다.
 */
export function lazyStream(res) {
  let out = null;
  const open = () => (out ||= new EventStream(res));
  return {
    send: (obj) => open().send(obj),
    end: () => open().end()
  };
}

/** 조각을 흘려보내는 응답(SSE). 한 줄에 JSON 하나씩 보냅니다. */
export class EventStream {
  constructor(res) {
    this.res = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
  }

  send(obj) {
    this.res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  end() {
    this.res.end();
  }
}

/** 그림 파일의 캐시 규칙. 계정마다 볼 수 있는 그림이 달라서, 앞단(Cloudflare 등)의 공용 캐시에는 남기지 않습니다. */
const PRIVATE_IMAGE_CACHE = 'private, max-age=2592000, immutable';

/**
 * 그림 파일 보내기. 파일 경로 네 곳(장면 그림·붙인 그림·프로필·배경)이 같은 규칙을 씁니다.
 * 볼 수 있는 파일이면 보내고, 아니면(이름이 이상하거나 남의 것이거나 없는 파일) 빈 404 를 보냅니다.
 * 브라우저는 30일 동안 캐시하지만, 여럿이 나눠 쓰는 캐시에는 남지 않게 private 로 보냅니다.
 * @param {string|false|null} file 보낼 파일의 전체 경로. 권한 검사를 통과하지 못했으면 거짓 값
 */
export function sendImage(res, file) {
  if (!file) return res.status(404).end();
  res.sendFile(file, { cacheControl: false, headers: { 'Cache-Control': PRIVATE_IMAGE_CACHE } }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}
