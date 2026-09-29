/** 토큰 사용량 조회와 기록 지우기. */
import { fail } from '../helpers.js';

export class UsageRoutes {
  constructor({ usage }) {
    this.usage = usage;
  }

  mount(app) {
    app.get('/api/usage', (req, res) => res.json(this.usage.summary()));
    app.delete('/api/usage', (req, res) => {
      // 기록은 모든 계정이 함께 쓰는 하나뿐이라, 지우는 건 주인만 합니다.
      if (req.user && req.user.role !== 'owner') return fail(res, 403, '사용량 기록은 주인 계정만 지울 수 있습니다.');
      this.usage.clear();
      res.json({ ok: true });
    });
  }
}
