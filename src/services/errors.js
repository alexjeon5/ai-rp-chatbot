/**
 * 사람이 읽을 안내를 담은 오류. 서비스는 HTTP 를 모르므로 응답 대신 이걸 던지고,
 * 라우트의 wrap() 이 status 로 바꿔 보냅니다. 디스코드처럼 HTTP 가 아닌 곳도 같은 오류를 받습니다.
 */
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** 없거나, 남의 것이라 없는 것처럼 보여야 하는 항목. */
export class NotFound extends AppError {
  constructor(message = '없는 항목입니다.') {
    super(message, 404);
  }
}
