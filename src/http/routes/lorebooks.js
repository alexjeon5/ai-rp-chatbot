/** 로어북 경로: 목록·추가·수정·삭제, 발동 시험, 대화에 적용되는 책 조회. 일은 LoreBooks 서비스가 합니다. */
import { wrap } from '../helpers.js';

export class LorebookRoutes {
  constructor({ lore }) {
    this.lore = lore;
  }

  mount(app) {
    const lore = this.lore;
    app.get('/api/lorebooks', wrap((req, res) => res.json(lore.list(req.user))));
    app.post('/api/lorebooks', wrap((req, res) => res.json(lore.create(req.user, req.body))));
    app.put('/api/lorebooks/:id', wrap((req, res) => res.json(lore.update(req.user, req.params.id, req.body))));
    app.delete('/api/lorebooks/:id', wrap(async (req, res) => {
      await lore.remove(req.user, req.params.id);
      res.json({ ok: true });
    }));
    // body: { text, entries? } — 저장하지 않고 이 글에서 발동하는 항목만 봅니다.
    app.post('/api/lorebooks/:id/test', wrap((req, res) => res.json({ triggered: lore.trial(req.user, req.params.id, req.body || {}) })));
    app.get('/api/chats/:id/lore', wrap((req, res) => res.json(lore.forChat(req.user, req.params.id))));
  }
}
