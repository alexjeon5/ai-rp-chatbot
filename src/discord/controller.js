/**
 * 디스코드에서 온 일을 앱 서비스로 잇기: 슬래시 명령, 자동완성, 버튼, 스레드의 메시지.
 *
 * 규칙
 *   - 봇은 이어 둔 앱 계정(actor)으로만 일합니다 (DiscordLinks). 연결이 없으면 /rp link 를 안내합니다
 *   - 스레드 하나 = 대화 하나. 스레드를 연 사람(주인)만 말하고 버튼을 누릅니다. 다른 사람의 메시지는 대화에 넣지 않습니다
 *   - 권한은 두 번 봅니다. 디스코드 쪽은 스레드 주인인지, 앱 쪽은 Access(대화 주인인지)
 *   - 성인 모드는 연령 제한(NSFW) 채널에서만. 엔진 쪽 성인 허용(adultAllowed)은 Replies 가 따로 봅니다
 *   - 요청 한도는 웹과 같은 몫(limits.generate, 계정 기준)을 나눠 씁니다
 *   - 모델이 쓴 글이 @everyone 같은 알림을 울리지 않게, 봇이 보내는 메시지는 멘션을 모두 끕니다
 */
import { ChannelType, MessageFlags, ButtonStyle, ComponentType, ThreadAutoArchiveDuration } from 'discord.js';
import { AppError } from '../services/errors.js';
import { userKey } from '../security.js';
import { ReplyRelay, displayText } from './relay.js';
import { splitMessage } from './split.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_MENTIONS = { parse: [] };
const AUTOCOMPLETE_MAX = 25;
const NOT_LINKED = '먼저 앱 계정과 이어 주세요. 웹의 설정 → 디스코드에서 코드를 받아 `/rp link code:코드` 로 넣으면 됩니다.';
const ADULT_CHANNEL = '성인 모드 대화는 연령 제한(NSFW) 채널에서만 쓸 수 있습니다.';

/** 버튼 id: rp:<일>:<대화 id> */
const buttonId = (action, chatId) => `rp:${action}:${chatId}`;
const parseButton = (id) => {
  const [prefix, action, chatId] = String(id).split(':');
  return prefix === 'rp' && action && chatId ? { action, chatId } : null;
};

const button = (action, chatId, label, emoji, style = ButtonStyle.Secondary) => ({
  type: ComponentType.Button, style, custom_id: buttonId(action, chatId), label, emoji: { name: emoji }
});
const row = (...components) => [{ type: ComponentType.ActionRow, components }];

/** 쓰는 동안 마지막 메시지에 다는 버튼. */
export const liveButtons = (chatId) => row(button('stop', chatId, '멈추기', '⏹', ButtonStyle.Danger));
/** 다 쓴 답변에 다는 버튼. */
export const replyButtons = (chatId) => row(
  button('regen', chatId, '다시 쓰기', '🔄'),
  button('cont', chatId, '이어 쓰기', '➡️')
);

/** 연령 제한 채널인지. 스레드는 부모 채널을 따릅니다. */
export const isNsfwChannel = (channel) => Boolean((channel?.isThread?.() ? channel.parent : channel)?.nsfw);

/** 스레드에 보내는 sink (ReplyRelay 가 씁니다). */
export const threadSink = (thread) => ({
  send: (content, components) => thread.send({ content, components, allowedMentions: NO_MENTIONS }),
  edit: (message, content, components) => message.edit({ content, components, allowedMentions: NO_MENTIONS }),
  remove: (message) => message.delete().catch(() => {})
});

export class DiscordController {
  /**
   * @param {{ services: ReturnType<typeof import('../services/index.js').createServices>, bindings: import('./bindings.js').ThreadBindings,
   *           relay?: object, log?: Pick<Console, 'error'|'warn'> }} deps
   *   relay 는 ReplyRelay 에 더 넘길 값 (시험에서 간격·타이머를 바꿉니다)
   */
  constructor({ services, bindings, relay = {}, log = console }) {
    Object.assign(this, { services, bindings, relayOptions: relay, log });
    /** 뒤에서 도는 자동 기억. 시험이 끝을 기다릴 때 씁니다. */
    this.background = Promise.resolve();
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

  /** 스레드에 남기는 알림 (메시지에 대한 답). */
  notice(channel, content) {
    return channel.send({ content: `⚠️ ${content}`, allowedMentions: NO_MENTIONS }).catch((e) => this.log.error(e));
  }

  /* ---------------- 상호작용 ---------------- */

  async onInteraction(interaction) {
    try {
      if (interaction.isAutocomplete?.()) return await this.autocomplete(interaction);
      if (interaction.isChatInputCommand?.() && interaction.commandName === 'rp') return await this.command(interaction);
      if (interaction.isButton?.() && parseButton(interaction.customId)) return await this.button(interaction);
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
      case 'end': return this.end(i);
      default: throw new AppError('모르는 명령입니다.');
    }
  }

  async link(i) {
    const { discordLinks, setup } = this.services;
    const actor = discordLinks.redeem({ id: i.user.id, name: i.user.username }, i.options.getString('code', true));
    setup.ensure(actor);
    await i.reply({ content: `**${actor.name}** 계정과 이었습니다. 채널에서 \`/rp start\` 로 대화를 시작하세요.`, flags: EPHEMERAL });
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

  /** /rp start — 채널 아래에 스레드를 열고 대화를 만듭니다. 캐릭터에 첫 대사가 있으면 스레드에 올립니다. */
  async start(i) {
    const actor = this.actorFor(i.user);
    const { access, settings, chats } = this.services;
    const channel = i.channel;
    if (channel?.type !== ChannelType.GuildText) throw new AppError('스레드를 열 수 있는 일반 채팅 채널에서 시작해 주세요.');

    const character = access.character(actor, i.options.getString('character', true), '없는 캐릭터입니다. 목록에서 골라 주세요.');
    const personaId = i.options.getString('persona') || undefined;
    if (personaId) access.persona(actor, personaId, '없는 페르소나입니다. 목록에서 골라 주세요.');
    const view = settings.view(actor);
    const presetId = i.options.getString('mode') || undefined;
    const preset = presetId ? view.presets.find((p) => p.id === presetId) : view.presets.find((p) => p.id === view.activePresetId) || view.presets[0];
    if (!preset) throw new AppError('없는 대화 모드입니다. 목록에서 골라 주세요.');
    if (preset.adult && !isNsfwChannel(channel)) throw new AppError(ADULT_CHANNEL);
    const privateThread = i.options.getBoolean('private') ?? true;

    await i.deferReply({ flags: EPHEMERAL });
    const chat = chats.create(actor, { characterId: character.id, personaId, presetId: preset.id });
    let thread;
    try {
      thread = await channel.threads.create({
        name: String(chat.title || character.name).slice(0, 100),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        type: privateThread ? ChannelType.PrivateThread : ChannelType.PublicThread,
        ...(privateThread ? { invitable: false } : {}),
        reason: `${i.user.username} 의 롤플레이`
      });
      if (privateThread) await thread.members.add(i.user.id);
    } catch (e) {
      // 스레드를 못 열었으면 대화도 남기지 않습니다. 대개 봇 권한(스레드 만들기) 문제입니다.
      await chats.remove(actor, chat.id).catch(() => {});
      this.log.error(e);
      throw new AppError('스레드를 열지 못했습니다. 봇에게 이 채널의 스레드 만들기·스레드에 메시지 보내기 권한이 있는지 확인해 주세요.');
    }
    this.bindings.bind(thread.id, { chatId: chat.id, discordUserId: i.user.id, userId: actor.id, channelId: channel.id });

    const greeting = chat.messages[chat.messages.length - 1];
    if (greeting?.role === 'assistant') await this.post(thread, chat.id, greeting.content);
    await i.editReply({ content: `<#${thread.id}> 에서 **${character.name}** 와(과) 대화를 시작하세요.` });
  }

  /** 다 쓴 글을 한 번에 올리고 최근 답변으로 적어 둡니다 (첫 대사). */
  async post(thread, chatId, content) {
    const chunks = splitMessage(displayText(content));
    const sent = [];
    for (let n = 0; n < chunks.length; n += 1) {
      const last = n === chunks.length - 1;
      sent.push(await thread.send({ content: chunks[n], components: last ? replyButtons(chatId) : [], allowedMentions: NO_MENTIONS }));
    }
    this.bindings.setReply(thread.id, sent.map((m) => m.id));
  }

  /** 이 스레드의 연결과, 누른 사람이 주인인지. */
  ownedBinding(i) {
    const binding = this.bindings.get(i.channelId);
    if (!binding) throw new AppError('롤플레이 스레드가 아닙니다. `/rp start` 로 연 스레드에서 써 주세요.');
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

  async button(i) {
    const { action, chatId } = parseButton(i.customId);
    const { binding, actor } = this.ownedBinding(i);
    if (binding.chatId !== chatId) throw new AppError('이 스레드의 대화가 아닙니다.');
    const { jobs, chats } = this.services;

    if (action === 'stop') {
      chats.stop(actor, chatId);
      return i.deferUpdate();
    }
    if (action !== 'regen' && action !== 'cont') throw new AppError('모르는 버튼입니다.');
    const ids = binding.reply?.messageIds || [];
    if (!ids.includes(i.message?.id)) throw new AppError('가장 최근 답변에서만 누를 수 있습니다.');
    if (jobs.running.has(chatId)) throw new AppError('아직 답변을 쓰는 중입니다.');
    const chat = chats.get(actor, chatId);
    if (this.services.context.presetOf(chat).adult && !isNsfwChannel(i.channel)) throw new AppError(ADULT_CHANNEL);
    this.spend(actor);
    await i.deferUpdate();

    const thread = i.channel;
    if (action === 'regen') {
      // 지금 답변을 담은 메시지를 그대로 고쳐 씁니다. 못 찾은 메시지(지워짐)는 새로 보냅니다.
      const handles = (await Promise.all(ids.map((id) => thread.messages.fetch(id).catch(() => null)))).filter(Boolean);
      return this.stream(thread, actor, chatId, { mode: 'regenerate', handles });
    }
    // 이어 쓰기는 새 메시지로 덧붙입니다. 쓰기 시작하면 앞 메시지의 버튼은 뗍니다.
    return this.stream(thread, actor, chatId, {
      mode: 'continue', keep: ids, onBegin: () => i.message.edit({ components: [] }).catch(() => {})
    });
  }

  /* ---------------- 스레드의 메시지 ---------------- */

  async onMessage(message) {
    if (message.author?.bot || !message.channel?.isThread?.()) return;
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

      const { chats, jobs, context } = this.services;
      let chat;
      try {
        chat = chats.get(actor, binding.chatId);
      } catch (e) {
        // 웹에서 대화를 지웠으면 이 스레드는 더 쓸 수 없습니다.
        this.bindings.unbind(thread.id);
        throw new AppError('이 스레드의 대화가 지워졌습니다. `/rp start` 로 새로 시작해 주세요.');
      }
      if (jobs.running.has(chat.id)) {
        await message.react('⏳').catch(() => {});
        return;
      }
      if (context.presetOf(chat).adult && !isNsfwChannel(thread)) throw new AppError(ADULT_CHANNEL);
      this.spend(actor);
      await chats.addMessage(actor, chat.id, { content });
      // 앞 답변의 버튼은 뗍니다. 다시 쓰기·이어 쓰기는 가장 최근 답변에서만 받습니다.
      await this.clearButtons(thread, binding);
      await this.stream(thread, actor, chat.id, { mode: 'new' });
    } catch (e) {
      if (!(e instanceof AppError)) this.log.error(e);
      await this.notice(thread, e instanceof AppError ? e.message : '처리하지 못했습니다. 잠시 뒤에 다시 해 주세요.');
    }
  }

  async clearButtons(thread, binding) {
    const ids = binding.reply?.messageIds || [];
    const last = ids[ids.length - 1];
    if (!last) return;
    const message = await thread.messages.fetch(last).catch(() => null);
    await message?.edit({ components: [] }).catch(() => {});
    this.bindings.setReply(thread.id, []);
  }

  /**
   * 답변을 흘려 쓰기. Replies.reply 의 조각을 ReplyRelay 가 메시지 편집으로 옮깁니다.
   * handles 를 주면 그 메시지를 고쳐 쓰고(다시 쓰기), keep 을 주면 그 뒤에 새 메시지로 덧붙입니다(이어 쓰기).
   * 메시지는 첫 조각이 온 뒤에야 건드립니다(onBegin 도 그때). 시작 전에 막히면(엔진 설정 등) 지금 답변이 그대로 남습니다.
   */
  async stream(thread, actor, chatId, { mode, handles = [], keep = [], onBegin }) {
    await thread.sendTyping?.().catch(() => {});
    const relay = new ReplyRelay({ sink: threadSink(thread), handles, liveComponents: liveButtons(chatId), ...this.relayOptions });
    let begun = false;
    const errors = [];
    let saved = null;
    try {
      saved = await this.services.replies.reply(actor, chatId, {
        mode,
        emit: (event) => {
          if (!begun) {
            begun = true;
            relay.begin();
            onBegin?.();
          }
          if (event.delta) relay.push(event.delta);
          if (event.error) errors.push(event.error);
        }
      });
    } catch (e) {
      if (begun) {
        await relay.finish();
        this.bindings.setReply(thread.id, keep);
      }
      throw e;
    }
    const sent = await relay.finish({ components: saved ? replyButtons(chatId) : [] });
    if (relay.failure) this.log.error(relay.failure);
    this.bindings.setReply(thread.id, saved ? [...keep, ...sent.map((m) => m.id)] : keep);
    for (const error of errors) await this.notice(thread, error);
    if (!saved && !errors.length) await this.notice(thread, '답변이 비어 있습니다. 🔄 다시 쓰기나 새 메시지로 다시 시도해 주세요.');
    if (saved) this.background = this.background.then(() => this.afterReply(actor, chatId));
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
