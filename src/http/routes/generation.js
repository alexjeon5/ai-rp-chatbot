/** 모델에게 글을 쓰게 하는 경로: 답변, 기억 요약, 자동 기억, 대신 쓰기, 선택지. 일은 Replies 서비스가 합니다. */
import { wrap, abortOnClose, lazyStream } from '../helpers.js';

export class GenerationRoutes {
  constructor({ replies, limits }) {
    Object.assign(this, { replies, limits });
  }

  mount(app) {
    const post = (path, fn) => app.post(path, this.limits.generate.middleware, wrap((req, res) => fn.call(this, req, res)));
    post('/api/chats/:id/generate', this.generate);
    post('/api/chats/:id/summarize', this.summarize);
    post('/api/chats/:id/impersonate', this.impersonate);
    post('/api/chats/:id/choices', this.choices);
    post('/api/chats/:id/facts/extract', this.extractFacts);
  }

  /** body: { regenerate?, continue?, provider? } — SSE 로 조각을 보내고 끝에 { done, message }. */
  async generate(req, res) {
    const body = req.body || {};
    const mode = body.continue ? 'continue' : body.regenerate ? 'regenerate' : 'new';
    const out = lazyStream(res);
    const message = await this.replies.reply(req.user, req.params.id, {
      mode, provider: body.provider, signal: abortOnClose(res).signal, emit: out.send
    });
    out.send({ done: true, message });
    out.end();
  }

  /** body: { auto?, provider? } */
  async summarize(req, res) {
    const result = await this.replies.summarize(req.user, req.params.id, {
      auto: Boolean(req.body?.auto), provider: req.body?.provider, signal: abortOnClose(res).signal
    });
    // 창을 닫아 멈춘 것이면 받을 사람이 없습니다.
    if (!res.destroyed) res.json(result);
  }

  /** body: { hint?, provider? } — SSE 로 조각을 보내고 끝에 { done, draft }. 저장하지 않습니다. */
  async impersonate(req, res) {
    const out = lazyStream(res);
    const draft = await this.replies.impersonate(req.user, req.params.id, {
      hint: req.body?.hint, provider: req.body?.provider, signal: abortOnClose(res).signal, emit: out.send
    });
    out.send({ done: true, draft });
    out.end();
  }

  /** body: { count?, provider? } → { choices: [{ text, check? }] } */
  async choices(req, res) {
    const choices = await this.replies.choices(req.user, req.params.id, {
      count: req.body?.count, provider: req.body?.provider, signal: abortOnClose(res).signal
    });
    if (choices) res.json({ choices });
  }

  /** body: { auto?, provider? } */
  async extractFacts(req, res) {
    const result = await this.replies.extractFacts(req.user, req.params.id, {
      auto: Boolean(req.body?.auto), provider: req.body?.provider, signal: abortOnClose(res).signal
    });
    if (!res.writableEnded && !res.destroyed) res.json(result);
  }
}
