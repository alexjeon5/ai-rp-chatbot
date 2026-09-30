/**
 * 디스코드에서 온 일을 앱 서비스로 잇기: 슬래시 명령, 자동완성, 버튼, 수정 창, 스레드의 메시지.
 *
 * 규칙
 *   - 봇은 이어 둔 앱 계정(actor)으로만 일합니다 (DiscordLinks). 연결이 없으면 /rp link 를 안내합니다
 *   - 스레드 하나 = 대화 하나. 스레드를 연 사람(주인)만 말하고 버튼을 누릅니다. 다른 사람의 메시지는 대화에 넣지 않습니다
 *   - 권한은 두 번 봅니다. 디스코드 쪽은 스레드 주인인지, 앱 쪽은 Access(대화 주인인지)
 *   - 성인 모드는 연령 제한(NSFW) 채널에서만. 엔진 쪽 성인 허용(adultAllowed)은 Replies 가 따로 봅니다
 *   - 요청 한도는 웹과 같은 몫(limits.generate, 계정 기준)을 나눠 씁니다
 *   - 모델이 쓴 글이 @everyone 같은 알림을 울리지 않게, 봇이 보내는 메시지는 멘션을 모두 끕니다
 *   - 롤플레이 답변은 웹훅으로 캐릭터 이름·프로필 그림을 달고 보냅니다. 웹훅을 못 쓰면 봇 이름으로 보냅니다
 *   - 버튼은 가장 최근 답변에만 답니다: ◀ n/m ▶ 넘겨보기, 🔄 다시 쓰기, ➡️ 이어 쓰기, 💡 선택지, ✍️ 대신 쓰기, 🎲 판정
 */
import { randomInt } from 'node:crypto';
import { ChannelType, MessageFlags, ButtonStyle, ComponentType, TextInputStyle, ThreadAutoArchiveDuration } from 'discord.js';
import { AppError } from '../services/errors.js';
import { userKey } from '../security.js';
import { parseNotation, rollDice, formatRoll, formatCheck } from '../../public/js/shared/dice.js';
import { ReplyRelay, displayText } from './relay.js';
import { splitMessage } from './split.js';
import { webhookName } from './webhooks.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_MENTIONS = { parse: [] };
const AUTOCOMPLETE_MAX = 25;
const NOT_LINKED = '먼저 앱 계정과 이어 주세요. 웹의 설정 → 디스코드에서 코드를 받아 `/rp link code:코드` 로 넣으면 됩니다.';
const ADULT_CHANNEL = '성인 모드 대화는 연령 제한(NSFW) 채널에서만 쓸 수 있습니다.';
const STALE = '지난 차례의 것이라 쓸 수 없습니다. 가장 최근 답변의 버튼으로 다시 받아 주세요.';
/** 주사위는 서버가 굴립니다. 브라우저처럼 고르게 나오는 난수를 씁니다. */
const rng = (n) => randomInt(n);
/** 어시스턴트 답은 화면 표식이 없으므로 글 그대로 보여 줍니다. */
const plainText = (raw) => String(raw ?? '').trim();

/* ---------------- 버튼 ---------------- */

/** 버튼 id: rp:<일>:<대화 id>[:<덧붙임>] */
const buttonId = (action, chatId, arg) => ['rp', action, chatId, arg].filter((x) => x !== undefined).join(':');
export const parseButton = (id) => {
  const [prefix, action, chatId, arg] = String(id).split(':');
  return prefix === 'rp' && action && chatId ? { action, chatId, arg } : null;
};

function button(action, chatId, { label, emoji, style = ButtonStyle.Secondary, disabled = false, arg } = {}) {
  return {
    type: ComponentType.Button, style, custom_id: buttonId(action, chatId, arg), disabled,
    ...(label ? { label: String(label).slice(0, 80) } : {}),
    ...(emoji ? { emoji: { name: emoji } } : {})
  };
}
const rows = (...lines) => lines.filter((l) => l.length).map((components) => ({ type: ComponentType.ActionRow, components }));

/** 쓰는 동안 마지막 메시지에 다는 버튼. */
export const liveButtons = (chatId) => rows([button('stop', chatId, { label: '멈추기', emoji: '⏹', style: ButtonStyle.Danger })]);

/** 다 쓴 답변에 다는 버튼. 넘겨볼 다른 답변이 있으면 ◀ n/m ▶, 롤플레이면 선택지·대신 쓰기·판정 줄을 더합니다. */
export function replyComponents(chat, msg) {
  const first = [];
  const count = msg?.swipes?.length || 0;
  if (count > 1) {
    const at = Math.max(0, Math.min(count - 1, msg.swipeIndex ?? count - 1));
    first.push(
      button('prev', chat.id, { emoji: '◀', disabled: at <= 0 }),
      button('count', chat.id, { label: `${at + 1}/${count}`, disabled: true }),
      button('next', chat.id, { emoji: '▶', disabled: at >= count - 1 })
    );
  }
  first.push(button('regen', chat.id, { label: '다시 쓰기', emoji: '🔄' }), button('cont', chat.id, { label: '이어 쓰기', emoji: '➡️' }));
  const second = [];
  if (chat.kind !== 'assistant') {
    second.push(button('choices', chat.id, { label: '선택지', emoji: '💡' }), button('imp', chat.id, { label: '대신 쓰기', emoji: '✍️' }));
    if (chat.dice && msg?.check) {
      const c = msg.check;
      second.push(button('check', chat.id, { label: `${c.label} 판정 (d${c.sides}, 난이도 ${c.dc})`, emoji: '🎲', style: ButtonStyle.Primary }));
    }
  }
  return rows(first, second);
}

/** 연령 제한 채널인지. 스레드는 부모 채널을 따릅니다. */
export const isNsfwChannel = (channel) => Boolean((channel?.isThread?.() ? channel.parent : channel)?.nsfw);

/* ---------------- 보내는 쪽 (ReplyRelay 의 sink) ---------------- */

/** 봇 이름으로 스레드에 보내기. 메시지는 id 로 고치고 지웁니다. */
export const botSink = (thread) => ({
  via: 'bot',
  send: async (content, components = [], embeds = []) => ({ id: (await thread.send({ content, components, embeds, allowedMentions: NO_MENTIONS })).id }),
  edit: (h, content, components = [], embeds = []) => thread.messages.edit(h.id, { content, components, embeds, allowedMentions: NO_MENTIONS }),
  strip: (id) => thread.messages.edit(id, { components: [] }),
  remove: (h) => thread.messages.delete(h.id).catch(() => {})
});

/** 웹훅으로 캐릭터 이름·그림을 달고 스레드에 보내기. 웹훅이 지워졌으면 잊고 오류를 넘깁니다. */
export function webhookSink(hook, thread, { username, avatarURL }, onGone = () => {}) {
  const base = { threadId: thread.id, withComponents: true, allowedMentions: NO_MENTIONS };
  const guard = (work) => work.catch((e) => {
    if (e?.code === 10015) onGone();
    throw e;
  });
  return {
    via: 'webhook',
    send: async (content, components = [], embeds = []) => ({
      id: (await guard(hook.send({ ...base, content, components, embeds, username, ...(avatarURL ? { avatarURL } : {}) }))).id
    }),
    edit: (h, content, components = [], embeds = []) => guard(hook.editMessage(h.id, { ...base, content, components, embeds })),
    strip: (id) => guard(hook.editMessage(id, { ...base, components: [] })),
    remove: (h) => hook.deleteMessage(h.id, thread.id).catch(() => {})
  };
}

export class DiscordController {
  /**
   * @param {{ services: ReturnType<typeof import('../services/index.js').createServices>, bindings: import('./bindings.js').ThreadBindings,
   *           webhooks?: import('./webhooks.js').Webhooks, relay?: object, log?: Pick<Console, 'error'|'warn'> }} deps
   *   relay 는 ReplyRelay 에 더 넘길 값 (시험에서 간격·타이머를 바꿉니다). webhooks 가 없으면 늘 봇 이름으로 말합니다
   */
  constructor({ services, bindings, webhooks = null, relay = {}, log = console }) {
    Object.assign(this, { services, bindings, webhooks, relayOptions: relay, log });
    /** 뒤에서 도는 자동 기억. 시험이 끝을 기다릴 때 씁니다. */
    this.background = Promise.resolve();
    /** 스레드 id → 받아 둔 선택지·대신 쓰기 초안 { kind, list|text, lastId }. 새 차례가 들어가면 버립니다 */
    this.pending = new Map();
  }

  /* ---------------- 공통 ---------------- */

  /** 이 디스코드 사용자가 누구로 일하는지. 이어져 있지 않으면 던집니다. 처음이면 계정 준비(기본 캐릭터 등)도 합니다. */
  actorFor(user) {
    const actor = this.services.discordLinks.actorOf(user.id);
    if (!actor) throw new AppError(NOT_LINKED, 401);
    this.services.setup.ensure(actor);
    return actor;
  }

  /** 모델을 부르는 일 하나를 요청 한도에 셉니다. 웹과 같은 몫입니다. */
  spend(actor) {
    const limit = this.services.limits.generate;
    if (!limit.hit(userKey(actor))) throw new AppError(limit.message, 429);
  }

  checkAdult(chat, channel) {
    if (chat.kind === 'assistant') return;
    if (this.services.context.presetOf(chat).adult && !isNsfwChannel(channel)) throw new AppError(ADULT_CHANNEL);
  }

  /** 명령·버튼에 오류를 알립니다. 사람에게 보여 줄 수 있는 오류(AppError)만 그대로, 나머지는 기록만 합니다. */
  async fail(interaction, error) {
    const content = error instanceof AppError ? error.message : '처리하지 못했습니다. 잠시 뒤에 다시 해 주세요.';
    if (!(error instanceof AppError)) this.log.error(error);
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: EPHEMERAL });
      else await interaction.reply({ content, flags: EPHEMERAL });
    } catch (e) {
      this.log.error(e);
    }
  }

  /** 스레드에 남기는 알림. */
  notice(channel, content) {
    return channel.send({ content: `⚠️ ${content}`, allowedMentions: NO_MENTIONS }).catch((e) => this.log.error(e));
  }

  /** 스레드에 이어진 대화. 웹에서 지웠으면 연결을 풀고 알립니다. */
  chatOf(actor, binding, threadId) {
    try {
      return this.services.chats.get(actor, binding.chatId);
    } catch {
      this.bindings.unbind(threadId);
      throw new AppError('이 스레드의 대화가 지워졌습니다. 새로 시작해 주세요.');
    }
  }

  /** 대화 속 내 이름. 롤플레이는 페르소나 이름, 어시스턴트는 디스코드 이름. */
  speakerName(chat, user) {
    if (chat.kind === 'assistant') return user.globalName || user.username || '나';
    const { access, context } = this.services;
    const owner = access.ownerOf(chat);
    const s = context.settingsOf(chat);
    const persona = access.findPersona(owner, chat.personaId) || access.findPersona(owner, s.activePersonaId);
    return persona?.name || user.globalName || user.username || '나';
  }

  /**
   * 답변을 보낼 쪽. 롤플레이는 웹훅(캐릭터 이름·그림), 어시스턴트나 웹훅을 못 쓰면 봇.
   * via 를 주면 그쪽으로 — 이미 보낸 메시지를 고칠 때는 보낸 쪽이어야 합니다.
   */
  async speaker(thread, chat, via) {
    if (chat.kind === 'assistant' || via === 'bot' || !this.webhooks) return botSink(thread);
    const hook = await this.webhooks.for(thread);
    if (!hook) return botSink(thread);
    const character = this.services.context.characterOf(chat);
    return webhookSink(hook, thread, {
      username: webhookName(character?.name),
      avatarURL: this.services.publicArt?.portraitUrl(character) || undefined
    }, () => this.webhooks.forget(thread.parent?.id));
  }

  /** 답변 끝에 붙는 카드: 표정 그림(비주얼 노벨을 켠 대화), 웹 검색 출처(어시스턴트). */
  embedsFor(chat, msg, sources = msg?.sources || []) {
    const embeds = [];
    const expression = chat.kind !== 'assistant' && chat.vn && msg?.scene?.expression;
    const url = expression && this.services.publicArt?.expressionUrl(this.services.context.characterOf(chat), expression);
    if (url) embeds.push({ thumbnail: { url }, footer: { text: `표정: ${expression}` } });
    if (sources.length) {
      // 링크를 <> 로 감싸면 디스코드가 미리보기를 펼치지 않습니다.
      const lines = sources.slice(0, 8).map((s, n) => `${n + 1}. [${String(s.title || s.url).replace(/[[\]]/g, '').slice(0, 80)}](<${s.url}>)`);
      embeds.push({ title: '출처', description: lines.join('\n').slice(0, 4000) });
    }
    return embeds;
  }

  /** 내 차례를 스레드에 보입니다. 직접 쓴 말이 아니라 버튼·명령으로 넣은 차례(선택지·초안·주사위·질문)에만 씁니다. */
  async postTurn(thread, chat, user, text) {
    const name = this.speakerName(chat, user);
    const hook = this.webhooks && await this.webhooks.for(thread);
    for (const chunk of splitMessage(text)) {
      if (hook) {
        await hook.send({
          content: chunk, username: webhookName(name, '나'), avatarURL: user.displayAvatarURL?.() || undefined,
          threadId: thread.id, allowedMentions: NO_MENTIONS
        }).catch(() => thread.send({ content: `**${name}** ▸ ${chunk}`, allowedMentions: NO_MENTIONS }));
      } else {
        await thread.send({ content: `**${name}** ▸ ${chunk}`, allowedMentions: NO_MENTIONS });
      }
    }
  }

  /** 지난 답변의 버튼을 뗍니다. 버튼은 가장 최근 답변에서만 받습니다. */
  async clearButtons(thread, binding) {
    const reply = binding.reply;
    const last = reply?.messageIds?.[reply.messageIds.length - 1];
    this.bindings.setReply(thread.id, null);
    if (!last) return;
    try {
      if (reply.via === 'webhook' && this.webhooks) {
        const hook = await this.webhooks.for(thread);
        await hook?.editMessage(last, { components: [], threadId: thread.id, withComponents: true });
      } else {
        await thread.messages.edit(last, { components: [] });
      }
    } catch { /* 지워진 메시지면 그만입니다 */ }
  }

  /* ---------------- 상호작용 ---------------- */

  async onInteraction(interaction) {
    try {
      if (interaction.isAutocomplete?.()) return await this.autocomplete(interaction);
      if (interaction.isChatInputCommand?.() && interaction.commandName === 'rp') return await this.command(interaction);
      if (interaction.isChatInputCommand?.() && interaction.commandName === 'ask') return await this.ask(interaction);
      if (interaction.isButton?.() && parseButton(interaction.customId)) return await this.button(interaction);
      if (interaction.isModalSubmit?.() && parseButton(interaction.customId)) return await this.modal(interaction);
    } catch (e) {
      if (interaction.isAutocomplete?.()) return interaction.respond([]).catch(() => {});
      await this.fail(interaction, e);
    }
  }

  async command(i) {
    switch (i.options.getSubcommand()) {
      case 'link': return this.link(i);
      case 'unlink': return this.unlink(i);
      case 'start': return this.start(i);
      case 'roll': return this.roll(i);
      case 'end': return this.end(i);
      default: throw new AppError('모르는 명령입니다.');
    }
  }

  async link(i) {
    const { discordLinks, setup } = this.services;
    const actor = discordLinks.redeem({ id: i.user.id, name: i.user.username }, i.options.getString('code', true));
    setup.ensure(actor);
    await i.reply({ content: `**${actor.name}** 계정과 이었습니다. 채널에서 \`/rp start\` 로 롤플레이를, \`/ask\` 로 어시스턴트를 시작하세요.`, flags: EPHEMERAL });
  }

  async unlink(i) {
    const removed = this.services.discordLinks.unlinkDiscord(i.user.id);
    await i.reply({ content: removed ? '앱 계정과의 연결을 끊었습니다.' : '이어진 앱 계정이 없습니다.', flags: EPHEMERAL });
  }

  /** 캐릭터·페르소나·모드 고르기. 이름에 적은 글자가 들어간 것만 25개까지. */
  async autocomplete(i) {
    const actor = this.services.discordLinks.actorOf(i.user.id);
    if (!actor) return i.respond([]);
    this.services.setup.ensure(actor);
    const { name, value } = i.options.getFocused(true);
    const want = String(value || '').trim().toLowerCase();
    const { library, settings } = this.services;
    const items = {
      character: () => library.characters.list(actor).map((c) => ({ name: c.name, value: c.id })),
      persona: () => library.personas.list(actor).map((p) => ({ name: p.name, value: p.id })),
      mode: () => settings.view(actor).presets.map((p) => ({ name: p.adult ? `${p.name} (성인)` : p.name, value: p.id }))
    }[name]?.() || [];
    const choices = items
      .filter((c) => !want || c.name.toLowerCase().includes(want))
      .slice(0, AUTOCOMPLETE_MAX)
      .map((c) => ({ name: String(c.name).slice(0, 100) || '(이름 없음)', value: String(c.value).slice(0, 100) }));
    await i.respond(choices);
  }

  /** 채널 아래에 스레드를 열고 이 대화와 잇습니다. 못 열면 대화도 지웁니다. */
  async openThread(i, actor, chat, { name, privateThread }) {
    const { chats } = this.services;
    let thread;
    try {
      thread = await i.channel.threads.create({
        name: String(name || '대화').slice(0, 100),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        type: privateThread ? ChannelType.PrivateThread : ChannelType.PublicThread,
        ...(privateThread ? { invitable: false } : {}),
        reason: `${i.user.username} 의 대화`
      });
      if (privateThread) await thread.members.add(i.user.id);
    } catch (e) {
      // 대개 봇 권한(스레드 만들기) 문제입니다.
      await chats.remove(actor, chat.id).catch(() => {});
      this.log.error(e);
      throw new AppError('스레드를 열지 못했습니다. 봇에게 이 채널의 스레드 만들기·스레드에 메시지 보내기 권한이 있는지 확인해 주세요.');
    }
    const binding = this.bindings.bind(thread.id, { chatId: chat.id, discordUserId: i.user.id, userId: actor.id, channelId: i.channel.id });
    return { thread, binding };
  }

  /** /rp start — 채널 아래에 스레드를 열고 대화를 만듭니다. 캐릭터에 첫 대사가 있으면 스레드에 올립니다. */
  async start(i) {
    const actor = this.actorFor(i.user);
    const { access, settings, chats } = this.services;
    if (i.channel?.type !== ChannelType.GuildText) throw new AppError('스레드를 열 수 있는 일반 채팅 채널에서 시작해 주세요.');

    const character = access.character(actor, i.options.getString('character', true), '없는 캐릭터입니다. 목록에서 골라 주세요.');
    const personaId = i.options.getString('persona') || undefined;
    if (personaId) access.persona(actor, personaId, '없는 페르소나입니다. 목록에서 골라 주세요.');
    const view = settings.view(actor);
    const presetId = i.options.getString('mode') || undefined;
    const preset = presetId ? view.presets.find((p) => p.id === presetId) : view.presets.find((p) => p.id === view.activePresetId) || view.presets[0];
    if (!preset) throw new AppError('없는 대화 모드입니다. 목록에서 골라 주세요.');
    if (preset.adult && !isNsfwChannel(i.channel)) throw new AppError(ADULT_CHANNEL);

    await i.deferReply({ flags: EPHEMERAL });
    const chat = chats.create(actor, { characterId: character.id, personaId, presetId: preset.id });
    const { thread } = await this.openThread(i, actor, chat, { name: chat.title || character.name, privateThread: i.options.getBoolean('private') ?? true });

    const greeting = chat.messages[chat.messages.length - 1];
    if (greeting?.role === 'assistant') await this.showReply(thread, chat, greeting);
    await i.editReply({ content: `<#${thread.id}> 에서 **${character.name}** 와(과) 대화를 시작하세요.` });
  }

  /** /ask — 어시스턴트 대화 스레드를 열고 첫 질문에 답합니다. 그 뒤로는 스레드에 쓰면 이어서 대화합니다. */
  async ask(i) {
    const actor = this.actorFor(i.user);
    if (i.channel?.type !== ChannelType.GuildText) throw new AppError('스레드를 열 수 있는 일반 채팅 채널에서 물어봐 주세요.');
    const question = String(i.options.getString('question', true)).trim();
    if (!question) throw new AppError('물어볼 것을 적어 주세요.');

    await i.deferReply({ flags: EPHEMERAL });
    const chat = this.services.chats.create(actor, { kind: 'assistant' });
    const { thread, binding } = await this.openThread(i, actor, chat, { name: question.replace(/\s+/g, ' '), privateThread: i.options.getBoolean('private') ?? true });
    await i.editReply({ content: `<#${thread.id}> 에서 답합니다.` });
    await this.takeTurn(thread, actor, binding, question, { user: i.user, show: true });
  }

  /** 다 쓴 답변(첫 대사, 넘겨본 답변)을 한 번에 보이고 가장 최근 답변으로 적어 둡니다. reuse 를 주면 그 메시지를 고쳐 씁니다. */
  async showReply(thread, chat, msg, reuse = null) {
    const sink = await this.speaker(thread, chat, reuse?.via);
    const relay = new ReplyRelay({
      sink, handles: (reuse?.messageIds || []).map((id) => ({ id })), ...this.relayOptions,
      display: chat.kind === 'assistant' ? plainText : displayText
    });
    const sent = await relay.show(msg.content, { components: replyComponents(chat, msg), embeds: this.embedsFor(chat, msg) });
    if (relay.failure) this.log.error(relay.failure);
    this.bindings.setReply(thread.id, { messageIds: sent.map((m) => m.id), chatMessageId: msg.id, via: sink.via });
  }

  /** 이 스레드의 연결과, 누른 사람이 주인인지. */
  ownedBinding(i) {
    const binding = this.bindings.get(i.channelId);
    if (!binding) throw new AppError('봇이 연 스레드가 아닙니다. `/rp start` 나 `/ask` 로 연 스레드에서 써 주세요.');
    if (i.user.id !== binding.discordUserId) throw new AppError('스레드를 연 사람만 쓸 수 있습니다.', 403);
    const actor = this.actorFor(i.user);
    // 디스코드 쪽이 맞아도, 연결된 앱 계정이 바뀌었으면 그 대화를 볼 수 없습니다.
    if (actor.id !== binding.userId) throw new AppError('이 스레드를 연 뒤에 이어진 앱 계정이 바뀌어 이어갈 수 없습니다.', 403);
    return { binding, actor };
  }

  /** /rp end — 대화를 보관함으로 보내고 스레드를 닫습니다. 주인이 다시 쓰면 둘 다 다시 열립니다. */
  async end(i) {
    const { binding, actor } = this.ownedBinding(i);
    this.services.chats.update(actor, binding.chatId, { archived: true });
    await i.reply({ content: '대화를 보관했습니다. 이 스레드에 다시 쓰면 이어서 대화합니다.' });
    await i.channel.setArchived?.(true).catch(() => {});
  }

  /** /rp roll — 서버가 주사위를 굴려 결과 줄을 내 차례로 보냅니다. */
  async roll(i) {
    const { binding, actor } = this.ownedBinding(i);
    const chat = this.chatOf(actor, binding, i.channelId);
    if (chat.kind === 'assistant') throw new AppError('주사위는 롤플레이 스레드에서 굴립니다.');
    const spec = parseNotation(i.options.getString('dice', true));
    if (!spec) throw new AppError('주사위를 읽지 못했습니다. 예) d20, 2d6+3 — 눈은 4·6·8·10·12·20·100, 개수는 1~10 개입니다.');
    const line = formatRoll(spec, rollDice(spec, rng));
    const memo = String(i.options.getString('memo') || '').trim();
    await i.reply({ content: line, flags: EPHEMERAL });
    await this.takeTurn(i.channel, actor, binding, memo ? `${memo}\n${line}` : line, { user: i.user, show: true });
  }

  /* ---------------- 버튼 ---------------- */

  async button(i) {
    const { action, chatId, arg } = parseButton(i.customId);
    const { binding, actor } = this.ownedBinding(i);
    if (binding.chatId !== chatId) throw new AppError('이 스레드의 대화가 아닙니다.');
    const thread = i.channel;
    const { jobs, chats } = this.services;

    if (action === 'stop') {
      chats.stop(actor, chatId);
      return i.deferUpdate();
    }
    // 가장 최근 답변에 단 버튼들
    if (['regen', 'cont', 'prev', 'next', 'choices', 'imp', 'check'].includes(action)) {
      if (!binding.reply?.messageIds?.includes(i.message?.id)) throw new AppError('가장 최근 답변에서만 누를 수 있습니다.');
      if (jobs.running.has(chatId)) throw new AppError('아직 답변을 쓰는 중입니다.');
    }
    const chat = this.chatOf(actor, binding, thread.id);

    switch (action) {
      case 'regen':
      case 'cont': {
        this.checkAdult(chat, thread);
        this.spend(actor);
        await i.deferUpdate();
        const reply = binding.reply;
        if (action === 'regen') return this.stream(thread, actor, chatId, { mode: 'regenerate', reuse: reply });
        // 이어 쓰기는 새 메시지로 덧붙입니다. 쓰기 시작하면 앞 메시지의 버튼은 뗍니다.
        return this.stream(thread, actor, chatId, { mode: 'continue', keep: reply, onBegin: () => this.clearButtons(thread, { reply }) });
      }
      case 'prev':
      case 'next': {
        const msg = chat.messages.find((m) => m.id === binding.reply.chatMessageId);
        if (!msg?.swipes?.length) throw new AppError('넘겨볼 다른 답변이 없습니다.');
        await i.deferUpdate();
        const at = (msg.swipeIndex ?? msg.swipes.length - 1) + (action === 'prev' ? -1 : 1);
        const shown = chats.swipe(actor, chatId, msg.id, at);
        return this.showReply(thread, chat, shown, binding.reply);
      }
      case 'choices': return this.offerChoices(i, actor, thread, chat);
      case 'imp': return this.offerDraft(i, actor, thread, chat, { fresh: true });
      case 'check': {
        const msg = chat.messages.find((m) => m.id === binding.reply.chatMessageId);
        if (!chat.dice || !msg?.check) throw new AppError('굴릴 판정이 없습니다.');
        await i.deferUpdate();
        const { total } = rollDice({ sides: msg.check.sides }, rng);
        return this.takeTurn(thread, actor, binding, formatCheck(msg.check, total), { user: i.user, show: true });
      }
      // 선택지·초안 창(나만 보는 메시지)에 단 버튼들
      case 'pick': {
        const p = this.pendingFor(thread.id, chat, 'choices');
        const choice = p.list[Number(arg)];
        if (!choice) throw new AppError(STALE);
        const text = choice.check ? `${choice.text}\n${formatCheck(choice.check, rollDice({ sides: choice.check.sides }, rng).total)}` : choice.text;
        await i.update({ content: `보냈습니다 — ${choice.text}`, components: [] });
        return this.takeTurn(thread, actor, binding, text, { user: i.user, show: true });
      }
      case 'send': {
        const p = this.pendingFor(thread.id, chat, 'draft');
        await i.update({ content: '초안을 보냈습니다.', components: [] });
        return this.takeTurn(thread, actor, binding, p.text, { user: i.user, show: true });
      }
      case 'edit': {
        const p = this.pendingFor(thread.id, chat, 'draft');
        return i.showModal(draftModal(chatId, p.text));
      }
      case 'redraft': {
        this.pendingFor(thread.id, chat, 'draft');
        return this.offerDraft(i, actor, thread, chat, { fresh: false });
      }
      default:
        throw new AppError('모르는 버튼입니다.');
    }
  }

  /** 받아 둔 선택지·초안. 그 뒤로 대화가 움직였으면(새 차례) 쓸 수 없습니다. */
  pendingFor(threadId, chat, kind) {
    const p = this.pending.get(threadId);
    if (!p || p.kind !== kind || p.lastId !== chat.messages[chat.messages.length - 1]?.id) throw new AppError(STALE);
    return p;
  }

  /** 💡 — 선택지를 받아 나만 보는 메시지에 번호 버튼으로 보여 줍니다. 고르면 내 차례로 보냅니다. */
  async offerChoices(i, actor, thread, chat) {
    if (chat.kind === 'assistant') throw new AppError('어시스턴트 대화에서는 쓸 수 없습니다.');
    this.checkAdult(chat, thread);
    this.spend(actor);
    await i.deferReply({ flags: EPHEMERAL });
    const list = await this.services.replies.choices(actor, chat.id, {});
    if (!list?.length) return i.editReply({ content: '선택지를 받지 못했습니다. 다시 눌러 보세요.' });
    this.pending.set(thread.id, { kind: 'choices', list, lastId: chat.messages[chat.messages.length - 1]?.id });
    const lines = list.map((c, n) => `**${n + 1}.** ${c.text}${c.check ? ` — 🎲 ${c.check.label} d${c.check.sides}·난이도 ${c.check.dc}` : ''}`);
    await i.editReply({
      content: lines.join('\n').slice(0, 2000),
      components: rows(list.map((c, n) => button('pick', chat.id, { label: String(n + 1), arg: n, style: ButtonStyle.Primary })))
    });
  }

  /** ✍️ — 내 다음 차례를 AI 가 초안으로 씁니다. 나만 보는 메시지에서 보내기·고쳐서 보내기·다시 쓰기를 고릅니다. */
  async offerDraft(i, actor, thread, chat, { fresh }) {
    if (chat.kind === 'assistant') throw new AppError('어시스턴트 대화에서는 쓸 수 없습니다.');
    this.checkAdult(chat, thread);
    this.spend(actor);
    if (fresh) await i.deferReply({ flags: EPHEMERAL });
    else await i.deferUpdate();
    const text = String(await this.services.replies.impersonate(actor, chat.id, { emit: () => {} }) || '').trim();
    if (!text) return i.editReply({ content: '초안을 받지 못했습니다. 다시 눌러 보세요.', components: [] });
    this.pending.set(thread.id, { kind: 'draft', text, lastId: chat.messages[chat.messages.length - 1]?.id });
    await i.editReply({
      content: `**대신 쓴 초안**\n>>> ${text}`.slice(0, 2000),
      components: rows([
        button('send', chat.id, { label: '보내기', emoji: '📨', style: ButtonStyle.Primary }),
        button('edit', chat.id, { label: '고쳐서 보내기', emoji: '✏️' }),
        button('redraft', chat.id, { label: '다시 쓰기', emoji: '🔄' })
      ])
    });
  }

  /** 고쳐서 보내기 창을 닫았을 때. */
  async modal(i) {
    const { action, chatId } = parseButton(i.customId);
    if (action !== 'draft') throw new AppError('모르는 창입니다.');
    const { binding, actor } = this.ownedBinding(i);
    if (binding.chatId !== chatId) throw new AppError('이 스레드의 대화가 아닙니다.');
    const text = String(i.fields.getTextInputValue('text') || '').trim();
    if (!text) throw new AppError('보낼 글이 비어 있습니다.');
    if (i.isFromMessage?.()) {
      await i.deferUpdate();
      await i.editReply({ content: '고친 초안을 보냈습니다.', components: [] });
    } else {
      await i.reply({ content: '고친 초안을 보냈습니다.', flags: EPHEMERAL });
    }
    return this.takeTurn(i.channel, actor, binding, text, { user: i.user, show: true });
  }

  /* ---------------- 스레드의 메시지 ---------------- */

  async onMessage(message) {
    if (message.author?.bot || message.webhookId || !message.channel?.isThread?.()) return;
    const binding = this.bindings.get(message.channelId);
    // 주인이 아닌 사람의 메시지는 대화에 넣지 않습니다. 알리지도 않습니다(스레드가 시끄러워지지 않게).
    if (!binding || message.author.id !== binding.discordUserId) return;
    const thread = message.channel;
    try {
      const actor = this.services.discordLinks.actorOf(message.author.id);
      if (!actor) throw new AppError(NOT_LINKED, 401);
      if (actor.id !== binding.userId) throw new AppError('이 스레드를 연 뒤에 이어진 앱 계정이 바뀌어 이어갈 수 없습니다.', 403);
      this.services.setup.ensure(actor);
      const content = String(message.content || '').trim();
      if (!content) return;
      if (this.services.jobs.running.has(binding.chatId)) {
        await message.react('⏳').catch(() => {});
        return;
      }
      await this.takeTurn(thread, actor, binding, content, { user: message.author });
    } catch (e) {
      if (!(e instanceof AppError)) this.log.error(e);
      await this.notice(thread, e instanceof AppError ? e.message : '처리하지 못했습니다. 잠시 뒤에 다시 해 주세요.');
    }
  }

  /**
   * 내 차례 하나를 넣고 답을 받습니다. show 면 그 차례를 스레드에 보입니다 — 직접 쓴 말은 이미 보이므로 버튼·명령으로 넣은 차례만.
   */
  async takeTurn(thread, actor, binding, text, { user, show = false }) {
    const { chats, jobs } = this.services;
    const chat = this.chatOf(actor, binding, thread.id);
    if (jobs.running.has(chat.id)) throw new AppError('아직 답변을 쓰는 중입니다.');
    this.checkAdult(chat, thread);
    this.spend(actor);
    this.pending.delete(thread.id);
    if (show) await this.postTurn(thread, chat, user, text);
    await chats.addMessage(actor, chat.id, { content: text });
    await this.clearButtons(thread, binding);
    await this.stream(thread, actor, chat.id, { mode: 'new' });
  }

  /**
   * 답변을 흘려 쓰기. Replies.reply 의 조각을 ReplyRelay 가 메시지 편집으로 옮깁니다.
   * reuse(가장 최근 답변)를 주면 그 메시지를 고쳐 쓰고(다시 쓰기), keep 을 주면 그 뒤에 새 메시지로 덧붙입니다(이어 쓰기).
   * 메시지는 첫 조각이 온 뒤에야 건드립니다(onBegin 도 그때). 시작 전에 막히면(엔진 설정 등) 지금 답변이 그대로 남습니다.
   */
  async stream(thread, actor, chatId, { mode, reuse = null, keep = null, onBegin }) {
    const { chats, replies } = this.services;
    const chat = chats.get(actor, chatId);
    const assistant = chat.kind === 'assistant';
    await thread.sendTyping?.().catch(() => {});
    const sink = await this.speaker(thread, chat, (reuse || keep)?.via);
    const relay = new ReplyRelay({
      sink, handles: (reuse?.messageIds || []).map((id) => ({ id })), liveComponents: liveButtons(chatId), ...this.relayOptions,
      display: assistant ? plainText : displayText
    });
    let begun = false;
    const errors = [];
    const sources = [];
    let saved = null;
    try {
      saved = await replies.reply(actor, chatId, {
        mode,
        emit: (event) => {
          if (!begun) {
            begun = true;
            relay.begin();
            onBegin?.();
          }
          if (event.delta) relay.push(event.delta);
          if (event.sources) sources.push(...event.sources);
          if (event.error) errors.push(event.error);
        }
      });
    } catch (e) {
      if (begun) await relay.finish();
      throw e;
    }
    const sent = await relay.finish({
      components: saved ? replyComponents(chat, saved) : [],
      embeds: saved ? this.embedsFor(chat, saved, sources) : []
    });
    if (relay.failure) this.log.error(relay.failure);
    const before = keep?.messageIds || [];
    if (saved) this.bindings.setReply(thread.id, { messageIds: [...before, ...sent.map((m) => m.id)], chatMessageId: saved.id, via: sink.via });
    else if (keep) this.bindings.setReply(thread.id, keep);
    else if (reuse) {
      // 다시 쓰기가 빈 답이면 메시지만 비었고 대화에는 지금 답변이 그대로입니다. 다시 보여 줍니다.
      const current = chat.messages.find((m) => m.id === reuse.chatMessageId);
      if (current) await this.showReply(thread, chat, current);
    }
    for (const error of errors) await this.notice(thread, error);
    if (!saved && !errors.length) await this.notice(thread, '답변이 비어 있습니다. 🔄 다시 쓰기나 새 메시지로 다시 시도해 주세요.');
    if (saved && !assistant) this.background = this.background.then(() => this.afterReply(actor, chatId));
  }

  /** 답변 뒤 자동 기억 → 자동 요약 (웹과 같은 순서). 실패해도 대화를 막지 않습니다. */
  async afterReply(actor, chatId) {
    const { replies } = this.services;
    try {
      await replies.extractFacts(actor, chatId, { auto: true });
      await replies.summarize(actor, chatId, { auto: true });
    } catch (e) {
      this.log.warn?.(`자동 기억을 건너뜁니다: ${e.message}`);
    }
  }
}

/** 초안을 고쳐서 보내는 창. */
function draftModal(chatId, text) {
  return {
    custom_id: buttonId('draft', chatId),
    title: '고쳐서 보내기',
    components: [{
      type: ComponentType.Label,
      label: '내 차례',
      component: { type: ComponentType.TextInput, custom_id: 'text', style: TextInputStyle.Paragraph, value: text.slice(0, 4000), max_length: 4000, required: true }
    }]
  };
}
