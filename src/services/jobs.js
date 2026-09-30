/**
 * 대화마다 돌고 있는 일. 로컬 엔진은 한 번에 하나만 처리하므로,
 * 새 답변 요청이 오면 뒤에서 돌던 요약·기억 확인을 멈춰 답변이 먼저 나가게 합니다.
 */
export class Jobs {
  /** 생성 중인 대화. 대화 id → { controller } */
  running = new Map();
  /** 뒤에서 도는 작업(요약·기억 확인). 대화 id → AbortController */
  background = new Map();

  pauseBackground(chatId) {
    this.background.get(chatId)?.abort();
  }

  /**
   * 뒤에서 돌 작업의 컨트롤러. 같은 대화에서 돌던 것은 멈추고, signal 이 끊기면(창을 닫음) 이것도 멈춥니다.
   * 일을 마치면(멈췄어도) release 를 불러 주세요.
   */
  backgroundFor(chatId, signal) {
    this.pauseBackground(chatId);
    const controller = new AbortController();
    this.background.set(chatId, controller);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', () => controller.abort(), { once: true });
    return controller;
  }

  release(chatId, controller) {
    if (this.background.get(chatId) === controller) this.background.delete(chatId);
  }
}
