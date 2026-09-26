/** 라우트들이 같이 쓰는 작은 도구. */

/** async 라우트의 오류를 500 으로 돌려줍니다. */
export const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

export const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

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
