/**
 * 대화와 메시지 다루기: 목록·만들기·고치기·지우기, 분기, 메시지 추가·수정·넘겨보기·삭제, 멈추기.
 * HTTP 를 모릅니다. actor(요청한 사람)를 받고, 문제가 있으면 AppError 를 던집니다.
 * 웹 라우트(src/http/routes/chats.js)와 디스코드 봇이 같은 메서드를 부릅니다.
 */
import { uid } from '../db.js';
import { fillVars } from '../prompt.js';
import { CHAT_FLAGS, showSwipe, syncSwipe, invalidateFacts, cleanFacts, branchFrom, MEMORY_MAX_CHARS } from '../chat-ops.js';
import { characterFields, SAFE_ID } from './records.js';
import { AppError, NotFound } from './errors.js';

export class Chats {
  /**
   * @param {{ store, access, context, jobs, images, attachments }} deps
   */
  constructor({ store, access, context, jobs, images, attachments }) {
    Object.assign(this, { store, access, context, jobs, images, attachments });
  }

  get collection() {
    return this.store.chats;
  }

  /** 최근에 대화한 순서로 보여 줍니다. 오래된 대화를 이어가면 위로 올라옵니다. 메시지 대신 요약만 담습니다. */
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

  get(actor, id) {
    return this.access.chat(actor, id);
  }

  /**
   * body: { kind: 'assistant' } 또는 { characterId | character(1회성), personaId?, presetId? }
   * 캐릭터에 첫 대사가 있으면 그걸 첫 메시지로 넣습니다.
   */
  create(actor, body) {
    const s = this.store.settings;
    if (body?.kind === 'assistant') {
      return this.collection.add({
        kind: 'assistant', characterId: null, personaId: null, title: '새 채팅', updatedAt: Date.now(), messages: []
      });
    }
    // 1회성 캐릭터는 목록에 넣지 않고 대화 안에 그대로 담습니다.
    const inline = body?.character;
    const character = inline?.name?.trim()
      ? { ...characterFields(inline), id: null }
      : this.access.findCharacter(actor, body?.characterId);
    if (!character) throw new AppError('캐릭터를 먼저 선택해 주세요.');
    const persona = this.access.findPersona(actor, body?.personaId ?? s.activePersonaId);

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
    return this.collection.add(chat);
  }

  /** 제목·페르소나·모드·기억·작가 노트·기능 스위치·보관·붙인 로어북·등장인물을 고칩니다. 준 칸만 바꿉니다. */
  update(actor, id, body = {}) {
    const chat = this.access.chat(actor, id);
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
      // 이 대화에 직접 붙일 로어북. 볼 수 있는 책만, 겹치지 않게 받습니다.
      chat.lorebookIds = [...new Set(body.lorebookIds)]
        .filter((bookId) => this.access.findLorebook(actor, bookId))
        .slice(0, 20);
    }
    if (Array.isArray(body.castIds)) {
      // 함께 등장할 인물. 볼 수 있는 캐릭터만, 주인공은 빼고, 겹치지 않게 받습니다.
      chat.castIds = [...new Set(body.castIds)]
        .filter((characterId) => characterId !== chat.characterId && this.access.findCharacter(actor, characterId))
        .slice(0, 8);
    }
    this.collection.save(chat.id);
    return chat;
  }

  /** 그 메시지까지 복사한 새 대화를 만듭니다. 그림과 붙인 파일도 따로 복사합니다. */
  async branch(actor, id, messageId) {
    const chat = this.access.chat(actor, id);
    const made = branchFrom(chat, String(messageId || ''));
    if (!made) throw new NotFound('없는 메시지입니다.');
    const added = this.collection.add(made.chat);
    await Promise.all([
      this.images.copyAll(chat.id, added.id, made.files),
      this.attachments.copyAll(chat.id, added.id, made.attachmentFiles)
    ]);
    return { chat: added, memoryCleared: made.memoryCleared };
  }

  /** 대화를 지웁니다. 이 대화에서 그린 그림과 붙인 그림도 함께 지웁니다. */
  async remove(actor, id) {
    const chat = this.access.chat(actor, id);
    if (SAFE_ID.test(chat.id)) await Promise.all([this.images.removeAll(chat.id), this.attachments.removeAll(chat.id)]);
    await this.collection.remove(chat.id);
  }

  /** body: { role?, content, attachments? } — 붙인 그림은 사용자 메시지에만, 이 대화에 실제로 올라온 파일만 받습니다. */
  async addMessage(actor, id, body) {
    const chat = this.access.chat(actor, id);
    const msg = {
      id: uid(),
      role: body?.role === 'assistant' ? 'assistant' : 'user',
      content: String(body?.content ?? ''),
      at: Date.now()
    };
    if (msg.role === 'user') {
      const attachments = await this.attachments.resolve(chat.id, body?.attachments);
      if (attachments.length) msg.attachments = attachments;
    }
    if (chat.kind === 'assistant' && chat.title === '새 채팅' && msg.role === 'user') {
      chat.title = msg.content.trim().slice(0, 24) || '새 채팅';
    }
    chat.messages.push(msg);
    chat.updatedAt = Date.now();
    // 보관한 대화에 다시 말을 걸면 목록으로 돌아옵니다.
    if (msg.role === 'user') delete chat.archivedAt;
    this.collection.save(chat.id);
    return msg;
  }

  editMessage(actor, id, messageId, content) {
    const { chat, msg } = this.access.message(actor, id, messageId);
    const before = msg.content;
    msg.content = String(content ?? msg.content);
    msg.editedAt = Date.now();
    syncSwipe(msg);
    // 내용이 바뀌었으면 거기서 뽑은 기억을 치우고 다음 확인 때 다시 읽게 합니다.
    if (msg.content !== before) invalidateFacts(chat, msg);
    this.collection.save(chat.id);
    return msg;
  }

  /** 답변 넘겨보기. index 는 보여 줄 장 번호(0부터)입니다. */
  swipe(actor, id, messageId, index) {
    const { chat, msg } = this.access.message(actor, id, messageId);
    if (!msg.swipes?.length) throw new AppError('넘겨볼 다른 답변이 없습니다.');
    const before = msg.swipeIndex;
    showSwipe(msg, index);
    if (msg.swipeIndex !== before) invalidateFacts(chat, msg);
    this.collection.save(chat.id);
    return msg;
  }

  removeMessage(actor, id, messageId) {
    const chat = this.access.chat(actor, id);
    const i = chat.messages.findIndex((m) => m.id === messageId);
    if (i < 0) throw new NotFound('없는 메시지입니다.');
    const [gone] = chat.messages.splice(i, 1);
    invalidateFacts(chat, gone, { rewind: false });
    for (const img of gone.images || []) this.images.remove(chat.id, img.file);
    for (const a of gone.attachments || []) this.attachments.remove(chat.id, a.file);
    this.collection.save(chat.id);
  }

  /**
   * 진행 중인 생성을 멈춥니다. 지금까지 쓴 내용은 저장되고 화면에도 남습니다.
   * 남의 대화는 돌고 있어도 '멈출 것 없음' 으로 답합니다. 있다는 사실을 드러내지 않습니다.
   * @returns {boolean} 멈췄으면 true
   */
  stop(actor, id) {
    const chat = this.access.findChat(actor, id);
    const run = chat && this.jobs.running.get(chat.id);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  /** 1회성 캐릭터를 캐릭터 목록에 넣습니다. 마음에 들면 계속 쓰라고. */
  saveCharacter(actor, id) {
    const chat = this.access.findChat(actor, id);
    if (!chat?.character) throw new AppError('1회성 캐릭터가 아닙니다.');
    const saved = this.store.characters.add({ ...chat.character, id: undefined });
    chat.characterId = saved.id;
    delete chat.character;
    this.collection.save(chat.id);
    return saved;
  }
}
