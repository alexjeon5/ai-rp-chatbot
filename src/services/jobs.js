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

  /** 뒤에서 돌 작업의 컨트롤러. 같은 대화에서 돌던 것은 멈추고, 응답이 끊기면 이것도 멈춥니다. */
  backgroundFor(chatId, res) {
    this.pauseBackground(chatId);
    const controller = new AbortController();
    this.background.set(chatId, controller);
    res.on('close', () => {
      this.release(chatId, controller);
      if (!res.writableFinished) controller.abort();
    });
    return controller;
  }

  release(chatId, controller) {
    if (this.background.get(chatId) === controller) this.background.delete(chatId);
  }
}
