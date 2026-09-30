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

  /**
   * 이 스레드의 대화 자리. 컨트롤러는 스레드든 어시스턴트 채널이든 이 모양 하나로 다룹니다.
   *   { kind, key, discordUserId, chatId, reply, setReply(reply), forget() }
   */
  slot(threadId) {
    const binding = this.get(threadId);
    if (!binding) return null;
    return {
      kind: 'thread',
      key: threadId,
      get discordUserId() { return binding.discordUserId; },
      get chatId() { return binding.chatId; },
      get reply() { return binding.reply || null; },
      setReply: (reply) => this.setReply(threadId, reply),
      forget: () => this.unbind(threadId)
    };
  }

  /** 이 대화에 이어진 스레드 id 들. */
  threadsOf(chatId) {
    return Object.entries(this.threads).filter(([, b]) => b.chatId === chatId).map(([id]) => id);
  }
}

/**
 * 어시스턴트 채널: 그 채널에 쓰는 말을 어시스턴트에게 보냅니다. 스레드 없이 그 채널에 답합니다. data/discord.json 의 channels 에 둡니다.
 *   channels  채널 id → { guildId, setBy, setAt, guests, hostUserId, users }
 *   users     앱 계정 id → { chatId, discordUserId, reply }   사람마다 자기 계정의 어시스턴트 대화가 따로 이어집니다
 *             'guest:<디스코드 id>' → 게스트(계정을 잇지 않은 사람)의 대화. 대화는 호스트(켠 사람) 계정의 것입니다
 *   guests    게스트에게도 답할지. hostUserId 는 그때 답할 호스트 앱 계정, setBy 는 호스트의 디스코드 id
 */
export class ChannelBindings {
  /** @param {import('../db.js').JsonDoc} doc store.discordDoc */
  constructor(doc) {
    this.doc = doc;
  }

  get channels() {
    return (this.doc.data.channels ||= {});
  }

  get(channelId) {
    return this.channels[channelId] || null;
  }

  /** 켭니다. 이미 켜져 있으면 사람들의 대화는 그대로 두고 켠 사람·시각·게스트 설정만 바꿉니다. */
  enable(channelId, { guildId, setBy, guests = false, hostUserId = null }) {
    const channel = (this.channels[channelId] ||= { users: {} });
    Object.assign(channel, { guildId, setBy, setAt: Date.now(), guests: Boolean(guests && hostUserId), hostUserId: guests ? hostUserId : null });
    channel.users ||= {};
    this.doc.save();
    return channel;
  }

  /** 끕니다. 나눈 대화는 앱에 그대로 남습니다. */
  disable(channelId) {
    if (!this.channels[channelId]) return false;
    delete this.channels[channelId];
    this.doc.save();
    return true;
  }

  /**
   * 이 채널에서 이 사람의 대화 자리 (ThreadBindings.slot 과 같은 모양, attach 가 더 있음). 꺼진 채널이면 null.
   * userId 는 앱 계정 id, 게스트면 'guest:<디스코드 id>' 입니다 (guestKey).
   */
  slot(channelId, userId, discordUserId) {
    const channel = this.get(channelId);
    if (!channel) return null;
    const entry = () => channel.users[userId] || null;
    return {
      kind: 'channel',
      key: `${channelId}:${userId}`,
      guest: String(userId).startsWith('guest:'),
      get discordUserId() { return entry()?.discordUserId || discordUserId; },
      get chatId() { return entry()?.chatId || null; },
      get reply() { return entry()?.reply || null; },
      setReply: (reply) => {
        const e = entry();
        if (!e) return;
        e.reply = reply?.messageIds?.length ? { ...reply, messageIds: [...reply.messageIds] } : null;
        this.doc.save();
      },
      /** 새 대화를 이 자리에 붙입니다. */
      attach: (chatId) => {
        channel.users[userId] = { chatId, discordUserId, reply: null };
        this.doc.save();
      },
      forget: () => {
        delete channel.users[userId];
        this.doc.save();
      }
    };
  }
}

/** 게스트 자리의 열쇠. */
export const guestKey = (discordUserId) => `guest:${discordUserId}`;
