/** 대화와 메시지: 목록·만들기·고치기·지우기, 넘겨보기, 멈추기, 게이지와 미리보기. */
import { uid } from '../../db.js';
import { fillVars } from '../../prompt.js';
import { CHAT_FLAGS, showSwipe, syncSwipe, invalidateFacts, cleanFacts, pendingForSummary, branchFrom, MEMORY_MAX_CHARS } from '../../chat-ops.js';
import { characterFields, SAFE_ID } from '../../services/records.js';
import { wrap, fail } from '../helpers.js';

export class ChatRoutes {
  constructor({ store, access, context, jobs, images, attachments }) {
    Object.assign(this, { store, access, context, jobs, images, attachments });
  }

  get chats() {
    return this.store.chats;
  }

  /** 대화를 찾습니다. 없거나 남의 것이면 404 를 보내고 null 을 돌려줍니다. */
  chatOr404(req, res) {
    const chat = this.access.findChat(req.user, req.params.id);
    if (!chat) fail(res, 404, '없는 대화입니다.');
    return chat;
  }

  /** 대화 속 메시지를 찾습니다. 없으면 404 를 보내고 null 을 돌려줍니다. */
  messageOr404(req, res) {
    const found = this.access.findMessage(req.user, req.params.id, req.params.mid);
    if (!found) fail(res, 404, '없는 메시지입니다.');
    return found;
  }

  mount(app) {
    app.get('/api/chats', (req, res) => res.json(this.list(req.user)));
    app.get('/api/chats/:id', (req, res) => {
      const chat = this.chatOr404(req, res);
      if (chat) res.json(chat);
    });
    app.post('/api/chats', (req, res) => this.create(req, res));
    app.put('/api/chats/:id', (req, res) => this.update(req, res));
    app.delete('/api/chats/:id', wrap((req, res) => this.remove(req, res)));
    app.post('/api/chats/:id/messages', wrap((req, res) => this.addMessage(req, res)));
    app.post('/api/chats/:id/branch', wrap((req, res) => this.branch(req, res)));
    app.put('/api/chats/:id/messages/:mid', (req, res) => this.editMessage(req, res));
    app.put('/api/chats/:id/messages/:mid/swipe', (req, res) => this.swipe(req, res));
    app.delete('/api/chats/:id/messages/:mid', (req, res) => this.removeMessage(req, res));
    app.post('/api/chats/:id/stop', (req, res) => this.stop(req, res));
    app.post('/api/chats/:id/save-character', (req, res) => this.saveCharacter(req, res));
    app.get('/api/chats/:id/context', (req, res) => this.gauge(req, res));
    app.get('/api/chats/:id/system', (req, res) => this.systemPreview(req, res));
  }

  /** 최근에 대화한 순서로 보여 줍니다. 오래된 대화를 이어가면 위로 올라옵니다. */
  list(actor) {
    const time = (c) => c.updatedAt || c.createdAt || 0;
    return this.access.chats(actor).sort((a, b) => time(b) - time(a)).map(({ messages, ...rest }) => {
      const assistant = rest.kind === 'assistant';
      const preset = this.context.presetOf(rest.presetId);
      const character = assistant ? null : this.context.characterOf(rest);
      return {
        ...rest,
        kind: rest.kind || 'rp',
        avatar: character?.avatar || '',
        onceOnly: Boolean(rest.character),
        presetName: assistant ? '어시스턴트' : preset.name,
        adult: assistant ? false : preset.adult,
        messageCount: messages.length,
        preview: messages[messages.length - 1]?.content?.slice(0, 60) || ''
      };
    });
  }

  create(req, res) {
    const s = this.store.settings;
    const body = req.body;
    if (body?.kind === 'assistant') {
      return res.json(this.chats.add({
        kind: 'assistant', characterId: null, personaId: null, title: '새 채팅', updatedAt: Date.now(), messages: []
      }));
    }
    // 1회성 캐릭터는 목록에 넣지 않고 대화 안에 그대로 담습니다.
    const inline = body?.character;
    const character = inline?.name?.trim()
      ? { ...characterFields(inline), id: null }
      : this.access.findCharacter(req.user, body?.characterId);
    if (!character) return fail(res, 400, '캐릭터를 먼저 선택해 주세요.');
    const persona = this.access.findPersona(req.user, body?.personaId ?? s.activePersonaId);

    const chat = {
      kind: 'rp',
      characterId: character.id,
      ...(character.id ? {} : { character }),
      personaId: persona?.id || null,
      title: character.name,
      presetId: body?.presetId || s.activePresetId,
      updatedAt: Date.now(),
      messages: []
    };
    if (character.greeting?.trim()) {
      chat.messages.push({
        id: uid(),
        role: 'assistant',
        content: fillVars(character.greeting, { char: character.name, user: persona?.name }),
        at: Date.now()
      });
    }
    res.json(this.chats.add(chat));
  }

  update(req, res) {
    const chat = this.chatOr404(req, res);
    if (!chat) return;
    const body = req.body || {};
    if (body.title) chat.title = body.title;
    if (body.personaId !== undefined) chat.personaId = body.personaId;
    if (body.presetId !== undefined) chat.presetId = body.presetId;
    // 기억(요약)과 작가 노트는 사람이 직접 고칠 수 있습니다.
    if (typeof body.memory === 'string') chat.memory = body.memory.slice(0, MEMORY_MAX_CHARS * 2);
    if (typeof body.authorNote === 'string') chat.authorNote = body.authorNote.slice(0, 2000);
    if (Array.isArray(body.facts)) chat.facts = cleanFacts(body.facts);
    for (const k of CHAT_FLAGS) {
      if (typeof body[k] !== 'boolean') continue;
      if (body[k]) chat[k] = true;
      else delete chat[k];
    }
    // 보관한 대화는 목록에서 빠지고 보관함에만 보입니다. 지우지 않으므로 언제든 꺼낼 수 있습니다.
    if (body.archived === true && !chat.archivedAt) chat.archivedAt = Date.now();
    if (body.archived === false) delete chat.archivedAt;
    if (Array.isArray(body.lorebookIds)) {
      // 이 대화에 직접 붙일 로어북. 있는 책만, 겹치지 않게 받습니다.
      chat.lorebookIds = [...new Set(body.lorebookIds)]
        .filter((id) => this.access.findLorebook(req.user, id))
        .slice(0, 20);
    }
    if (Array.isArray(body.castIds)) {
      // 함께 등장할 인물. 목록에 있는 캐릭터만, 주인공은 빼고, 겹치지 않게 받습니다.
      chat.castIds = [...new Set(body.castIds)]
        .filter((id) => id !== chat.characterId && this.access.findCharacter(req.user, id))
        .slice(0, 8);
    }
    this.chats.save(chat.id);
    res.json(chat);
  }

  /** body: { messageId } — 그 메시지까지 복사한 새 대화를 만듭니다. */
  async branch(req, res) {
    const chat = this.chatOr404(req, res);
    if (!chat) return;
    const made = branchFrom(chat, String(req.body?.messageId || ''));
    if (!made) return fail(res, 404, '없는 메시지입니다.');
    const added = this.chats.add(made.chat);
    await Promise.all([
      this.images.copyAll(chat.id, added.id, made.files),
      this.attachments.copyAll(chat.id, added.id, made.attachmentFiles)
    ]);
    res.json({ chat: added, memoryCleared: made.memoryCleared });
  }

  async remove(req, res) {
    const chat = this.access.findChat(req.user, req.params.id);
    if (!chat) return fail(res, 404, '없는 대화입니다.');
    // 이 대화에서 그린 그림도 함께 지웁니다.
    if (SAFE_ID.test(chat.id)) await Promise.all([this.images.removeAll(chat.id), this.attachments.removeAll(chat.id)]);
    await this.chats.remove(chat.id);
    res.json({ ok: true });
  }

  async addMessage(req, res) {
    const chat = this.chatOr404(req, res);
    if (!chat) return;
    const msg = {
      id: uid(),
      role: req.body?.role === 'assistant' ? 'assistant' : 'user',
      content: String(req.body?.content ?? ''),
      at: Date.now()
    };
    // 붙인 그림은 사용자 메시지에만, 이 대화에 실제로 올라온 파일만 받습니다.
    if (msg.role === 'user') {
      const attachments = await this.attachments.resolve(chat.id, req.body?.attachments);
      if (attachments.length) msg.attachments = attachments;
    }
    if (chat.kind === 'assistant' && chat.title === '새 채팅' && msg.role === 'user') {
      chat.title = msg.content.trim().slice(0, 24) || '새 채팅';
    }
    chat.messages.push(msg);
    chat.updatedAt = Date.now();
    // 보관한 대화에 다시 말을 걸면 목록으로 돌아옵니다.
    if (msg.role === 'user') delete chat.archivedAt;
    this.chats.save(chat.id);
    res.json(msg);
  }

  editMessage(req, res) {
    const found = this.messageOr404(req, res);
    if (!found) return;
    const { chat, msg } = found;
    const before = msg.content;
    msg.content = String(req.body?.content ?? msg.content);
    msg.editedAt = Date.now();
    syncSwipe(msg);
    // 내용이 바뀌었으면 거기서 뽑은 기억을 치우고 다음 확인 때 다시 읽게 합니다.
    if (msg.content !== before) invalidateFacts(chat, msg);
    this.chats.save(chat.id);
    res.json(msg);
  }

  /** 답변 넘겨보기. body: { index } 보여 줄 장 번호(0부터) */
  swipe(req, res) {
    const found = this.messageOr404(req, res);
    if (!found) return;
    const { chat, msg } = found;
    if (!msg.swipes?.length) return fail(res, 400, '넘겨볼 다른 답변이 없습니다.');
    const before = msg.swipeIndex;
    showSwipe(msg, req.body?.index);
    if (msg.swipeIndex !== before) invalidateFacts(chat, msg);
    this.chats.save(chat.id);
    res.json(msg);
  }

  removeMessage(req, res) {
    const chat = this.chatOr404(req, res);
    if (!chat) return;
    const i = chat.messages.findIndex((m) => m.id === req.params.mid);
    if (i < 0) return fail(res, 404, '없는 메시지입니다.');
    const [gone] = chat.messages.splice(i, 1);
    invalidateFacts(chat, gone, { rewind: false });
    for (const img of gone.images || []) this.images.remove(chat.id, img.file);
    for (const a of gone.attachments || []) this.attachments.remove(chat.id, a.file);
    this.chats.save(chat.id);
    res.json({ ok: true });
  }

  /** 진행 중인 생성을 멈춥니다. 지금까지 쓴 내용은 저장되고 화면에도 남습니다. */
  stop(req, res) {
    // 남의 대화는 돌고 있어도 '멈출 것 없음' 으로 답합니다. 있다는 사실을 드러내지 않습니다.
    const chat = this.access.findChat(req.user, req.params.id);
    const run = chat && this.jobs.running.get(chat.id);
    if (!run) return res.json({ stopped: false });
    run.controller.abort();
    res.json({ stopped: true });
  }

  /** 1회성 캐릭터를 캐릭터 목록에 넣습니다. 마음에 들면 계속 쓰라고. */
  saveCharacter(req, res) {
    const chat = this.access.findChat(req.user, req.params.id);
    if (!chat?.character) return fail(res, 400, '1회성 캐릭터가 아닙니다.');
    const saved = this.store.characters.add({ ...chat.character, id: undefined });
    chat.characterId = saved.id;
    delete chat.character;
    this.chats.save(chat.id);
    res.json({ character: saved });
  }

  /** 컨텍스트 게이지. 지금 보낸다면 설정·기억 / 대화 / 답변 여유가 한도에서 얼마씩 차지하는지. query: provider */
  gauge(req, res) {
    const chat = this.chatOr404(req, res);
    if (!chat) return;
    const plan = this.context.plan(chat, { provider: String(req.query.provider || this.store.settings.activeProvider) });
    res.json({
      ...plan.usage,
      pendingSummary: chat.kind === 'assistant' ? 0 : pendingForSummary(chat, plan.usage.kept).length
    });
  }

  /** 개발자 설정의 '시스템 프롬프트 미리보기'. */
  systemPreview(req, res) {
    const chat = this.chatOr404(req, res);
    if (!chat) return;
    if (chat.kind === 'assistant') {
      return res.json({ system: this.store.settings.assistant.systemPrompt, turns: this.context.plan(chat).usage.kept });
    }
    const ctx = this.context.roleplay(chat);
    if (!ctx) return fail(res, 400, '이 대화의 캐릭터가 삭제되었습니다.');
    res.json({ system: this.context.replySystem(ctx), turns: this.context.plan(chat).usage.kept, authorNote: this.context.authorNote(chat, ctx) });
  }
}
