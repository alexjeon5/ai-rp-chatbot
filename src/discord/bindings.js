/**
 * 디스코드 스레드와 대화 잇기. data/discord.json 의 threads 에 둡니다.
 *   threads  스레드 id → { chatId, discordUserId, userId, channelId, createdAt, reply? }
 *   reply    가장 최근 답변 { messageIds, chatMessageId, via }. 버튼은 이 메시지에서만 받습니다
 *            messageIds 는 그 답변을 담은 디스코드 메시지들, chatMessageId 는 대화 속 메시지, via 는 보낸 쪽('webhook'|'bot')
 */
export class ThreadBindings {
  /** @param {import('../db.js').JsonDoc} doc store.discordDoc */
  constructor(doc) {
    this.doc = doc;
  }

  get threads() {
    return (this.doc.data.threads ||= {});
  }

  get(threadId) {
    return this.threads[threadId] || null;
  }

  bind(threadId, { chatId, discordUserId, userId, channelId }) {
    const binding = { chatId, discordUserId, userId, channelId, createdAt: Date.now() };
    this.threads[threadId] = binding;
    this.doc.save();
    return binding;
  }

  /** 가장 최근 답변. 없으면(내 차례가 새로 들어옴) null. */
  setReply(threadId, reply) {
    const binding = this.get(threadId);
    if (!binding) return;
    binding.reply = reply?.messageIds?.length ? { ...reply, messageIds: [...reply.messageIds] } : null;
    this.doc.save();
  }

  unbind(threadId) {
    if (!this.threads[threadId]) return false;
    delete this.threads[threadId];
    this.doc.save();
    return true;
  }

  /** 이 대화에 이어진 스레드 id 들. */
  threadsOf(chatId) {
    return Object.entries(this.threads).filter(([, b]) => b.chatId === chatId).map(([id]) => id);
  }
}
