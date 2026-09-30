/** 토큰 사용량 조회와 기록 지우기. */
import { wrap, fail } from '../helpers.js';

export class UsageRoutes {
  constructor({ usage, ownership }) {
    Object.assign(this, { usage, ownership });
  }

  mount(app) {
    // 기본은 내 사용량. 주인은 ?scope=all 로 전체와 계정별 합계를 봅니다 (숫자만, 대화 내용은 없음).
    app.get('/api/usage', wrap((req, res) => {
      const canSeeAll = req.user?.role === 'owner';
      const all = req.query.scope === 'all';
      if (all && !canSeeAll) return fail(res, 403, '전체 사용량은 주인 계정만 볼 수 있습니다.');
      const names = new Map(this.ownership.users().map((u) => [u.id, u.name]));
      const nameOf = (id) => names.get(id) || (id === req.user?.id ? req.user.name : `(지운 계정 ${id})`);
      const summary = all ? this.usage.summary({ all: true, nameOf }) : this.usage.summary({ userId: req.user?.id });
      res.json({ scope: all ? 'all' : 'mine', canSeeAll, ...summary });
    }));
    app.delete('/api/usage', (req, res) => {
      // 기록은 요금 확인용이라 모든 계정의 것을 한꺼번에, 주인만 지웁니다.
      if (req.user && req.user.role !== 'owner') return fail(res, 403, '사용량 기록은 주인 계정만 지울 수 있습니다.');
      this.usage.clear();
      res.json({ ok: true });
    });
  }
}
