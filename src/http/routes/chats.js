/** 대화와 메시지 경로. 일은 Chats 서비스가 하고, 여기서는 req.user 를 actor 로 넘깁니다. 게이지와 미리보기도 여기 있습니다. */
import { pendingForSummary } from '../../chat-ops.js';
import { wrap, fail } from '../helpers.js';

export class ChatRoutes {
  constructor({ access, chats, context }) {
    Object.assign(this, { access, chats, context });
  }

  mount(app) {
    const chats = this.chats;
    app.get('/api/chats', wrap((req, res) => res.json(chats.list(req.user))));
    app.get('/api/chats/:id', wrap((req, res) => res.json(chats.get(req.user, req.params.id))));
    app.post('/api/chats', wrap((req, res) => res.json(chats.create(req.user, req.body))));
    app.put('/api/chats/:id', wrap((req, res) => res.json(chats.update(req.user, req.params.id, req.body || {}))));
    app.delete('/api/chats/:id', wrap(async (req, res) => {
      await chats.remove(req.user, req.params.id);
      res.json({ ok: true });
    }));
    app.post('/api/chats/:id/messages', wrap(async (req, res) => res.json(await chats.addMessage(req.user, req.params.id, req.body))));
    // body: { messageId } — 그 메시지까지 복사한 새 대화를 만듭니다.
    app.post('/api/chats/:id/branch', wrap(async (req, res) => res.json(await chats.branch(req.user, req.params.id, req.body?.messageId))));
    app.put('/api/chats/:id/messages/:mid', wrap((req, res) => res.json(chats.editMessage(req.user, req.params.id, req.params.mid, req.body?.content))));
    app.put('/api/chats/:id/messages/:mid/swipe', wrap((req, res) => res.json(chats.swipe(req.user, req.params.id, req.params.mid, req.body?.index))));
    app.delete('/api/chats/:id/messages/:mid', wrap((req, res) => {
      chats.removeMessage(req.user, req.params.id, req.params.mid);
      res.json({ ok: true });
    }));
    app.post('/api/chats/:id/stop', wrap((req, res) => res.json({ stopped: chats.stop(req.user, req.params.id) })));
    app.post('/api/chats/:id/save-character', wrap((req, res) => res.json({ character: chats.saveCharacter(req.user, req.params.id) })));
    app.get('/api/chats/:id/context', wrap((req, res) => this.gauge(req, res)));
    app.get('/api/chats/:id/system', wrap((req, res) => this.systemPreview(req, res)));
  }

  /** 컨텍스트 게이지. 지금 보낸다면 설정·기억 / 대화 / 답변 여유가 한도에서 얼마씩 차지하는지. query: provider */
  gauge(req, res) {
    const chat = this.access.chat(req.user, req.params.id);
    const plan = this.context.plan(chat, { provider: req.query.provider ? String(req.query.provider) : undefined });
    res.json({
      ...plan.usage,
      pendingSummary: chat.kind === 'assistant' ? 0 : pendingForSummary(chat, plan.usage.kept).length
    });
  }

  /** 개발자 설정의 '시스템 프롬프트 미리보기'. */
  systemPreview(req, res) {
    const chat = this.access.chat(req.user, req.params.id);
    if (chat.kind === 'assistant') {
      return res.json({ system: this.context.settingsOf(chat).assistant.systemPrompt, turns: this.context.plan(chat).usage.kept });
    }
    const ctx = this.context.roleplay(chat);
    if (!ctx) return fail(res, 400, '이 대화의 캐릭터가 삭제되었습니다.');
    res.json({ system: this.context.replySystem(ctx), turns: this.context.plan(chat).usage.kept, authorNote: this.context.authorNote(chat, ctx) });
  }
}
