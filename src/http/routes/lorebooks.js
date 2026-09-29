/** 로어북: 목록·추가·수정·삭제, 발동 시험, 대화에 적용되는 책 조회. */
import { cleanLorebook, LORE_LIMITS } from '../../lorebook.js';
import { wrap, fail } from '../helpers.js';

export class LorebookRoutes {
  constructor({ store, lore }) {
    Object.assign(this, { store, lore });
  }

  get books() {
    return this.store.lorebooks;
  }

  mount(app) {
    app.get('/api/lorebooks', (req, res) => res.json(this.books.all()));
    app.post('/api/lorebooks', (req, res) => this.create(req, res));
    app.put('/api/lorebooks/:id', (req, res) => this.update(req, res));
    app.delete('/api/lorebooks/:id', wrap((req, res) => this.remove(req, res)));
    app.post('/api/lorebooks/:id/test', (req, res) => this.test(req, res));
    app.get('/api/chats/:id/lore', (req, res) => this.forChat(req, res));
  }

  create(req, res) {
    if (this.books.size >= LORE_LIMITS.books) return fail(res, 400, '로어북이 너무 많습니다.');
    const clean = cleanLorebook(req.body || {});
    if (!clean.name) return fail(res, 400, '이름을 입력해 주세요.');
    res.json(this.books.add({ description: '', global: false, characterIds: [], entries: [], ...clean }));
  }

  update(req, res) {
    const clean = cleanLorebook(req.body || {});
    if ('name' in clean && !clean.name) return fail(res, 400, '이름을 입력해 주세요.');
    const book = this.books.update(req.params.id, clean);
    if (!book) return fail(res, 404, '없는 로어북입니다.');
    res.json(book);
  }

  async remove(req, res) {
    this.lore.detach(req.params.id);
    if (!(await this.books.remove(req.params.id))) return fail(res, 404, '없는 로어북입니다.');
    res.json({ ok: true });
  }

  /** body: { text } — 이 글을 대화로 봤을 때 이 책에서 발동하는 항목. 저장하지 않습니다. */
  test(req, res) {
    const book = this.books.get(req.params.id);
    if (!book) return fail(res, 404, '없는 로어북입니다.');
    // 화면에서 고치는 중인 항목도 시험할 수 있게, 본문에 entries 가 있으면 그걸 씁니다.
    const draft = Array.isArray(req.body?.entries) ? { ...book, ...cleanLorebook({ entries: req.body.entries }) } : book;
    res.json({ triggered: this.lore.test(draft, req.body?.text).map(({ entry, tokens }) => ({ id: entry.id, title: entry.title, tokens })) });
  }

  /** 이 대화에 적용되는 책(적용 이유 포함)과 지금 발동 중인 항목. */
  forChat(req, res) {
    const chat = this.store.chats.get(req.params.id);
    if (!chat) return fail(res, 404, '없는 대화입니다.');
    res.json({
      applied: this.lore.appliedTo(chat).map(({ book, via }) => ({ id: book.id, name: book.name, via })),
      triggered: this.lore.triggered(chat).map(({ book, entry, tokens }) => ({ bookId: book.id, id: entry.id, title: entry.title, tokens })),
      settings: this.lore.settings
    });
  }
}
