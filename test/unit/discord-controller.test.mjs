/**
 * 디스코드 봇의 흐름: 계정 잇기, 스레드 열기, 주인만 말하기, 버튼, 성인 채널 검사.
 * 서비스(저장소·권한·대화)는 진짜를 쓰고, 디스코드 객체와 모델 답변(Replies.reply)만 가짜로 끼웁니다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { ChannelType } from 'discord.js';
import { Store } from '../../src/store.js';
import { flushAll } from '../../src/db.js';
import { createServices } from '../../src/services/index.js';
import { AppError } from '../../src/services/errors.js';
import { ThreadBindings } from '../../src/discord/bindings.js';
import { DiscordController } from '../../src/discord/controller.js';

const USERS = [
  { id: 'alice01', name: 'alice', role: 'member', epoch: 0 },
  { id: 'bob0001', name: 'bob', role: 'owner', epoch: 0 }
];
const ALICE_D = { id: '100000000000000001', username: 'alice_d' };
const STRANGER_D = { id: '100000000000000009', username: 'stranger' };
const quiet = { error() {}, warn() {}, log() {} };

let seq = 0;
function fakeMessage(channel, { content, components = [], author }) {
  const msg = {
    id: `dm${++seq}`, content, components, author, channel, channelId: channel.id, deleted: false, reactions: [],
    edit: async (patch) => { Object.assign(msg, patch); return msg; },
    delete: async () => { msg.deleted = true; },
    react: async (emoji) => { msg.reactions.push(emoji); }
  };
  return msg;
}

function fakeThread(parent, id) {
  const thread = {
    id, parent, type: ChannelType.PrivateThread, archived: false, sent: [], added: [],
    isThread: () => true,
    send: async (body) => {
      assert.deepEqual(body.allowedMentions, { parse: [] }, '봇이 보내는 메시지는 멘션을 울리지 않음');
      const msg = fakeMessage(thread, { ...body, author: { id: 'bot', bot: true } });
      thread.sent.push(msg);
      return msg;
    },
    messages: { fetch: async (mid) => thread.sent.find((m) => m.id === mid && !m.deleted) || Promise.reject(new Error('없음')) },
    members: { add: async (userId) => { thread.added.push(userId); } },
    sendTyping: async () => {},
    setArchived: async (v) => { thread.archived = v; }
  };
  return thread;
}

function fakeChannel({ nsfw = false } = {}) {
  const channel = {
    id: `ch${++seq}`, type: ChannelType.GuildText, nsfw, created: [],
    isThread: () => false,
    threads: { create: async (opts) => { const t = fakeThread(channel, `th${++seq}`); t.opts = opts; channel.created.push(t); return t; } }
  };
  return channel;
}

/** 슬래시 명령·버튼·자동완성 흉내. 답한 것은 replies 에 쌓입니다. */
function fakeInteraction({ kind = 'command', user, channel, sub, values = {}, focused, customId, message }) {
  const i = {
    user, channel, channelId: channel.id, commandName: 'rp', customId, message,
    deferred: false, replied: false, answers: [], choices: null,
    isAutocomplete: () => kind === 'autocomplete',
    isChatInputCommand: () => kind === 'command',
    isButton: () => kind === 'button',
    options: {
      getSubcommand: () => sub,
      getString: (name, required) => {
        if (values[name] === undefined && required) throw new Error(`${name} 없음`);
        return values[name] ?? null;
      },
      getBoolean: (name) => values[name] ?? null,
      getFocused: () => focused
    },
    reply: async (body) => { i.replied = true; i.answers.push(body); },
    followUp: async (body) => { i.answers.push(body); },
    deferReply: async () => { i.deferred = true; },
    deferUpdate: async () => { i.deferred = true; },
    editReply: async (body) => { i.answers.push(body); },
    respond: async (choices) => { i.choices = choices; }
  };
  return i;
}

/** 가짜 모델 답변. 조각 몇 개를 흘리고 저장한 척합니다. */
function fakeReplies(services) {
  const calls = [];
  return {
    calls,
    failNext: null,
    async reply(actor, chatId, { mode, emit }) {
      calls.push({ actor: actor.id, chatId, mode });
      services.access.chat(actor, chatId);
      if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
      emit({ context: {} });
      emit({ delta: '[[표정: 기쁨]]어서 ' });
      emit({ delta: `와요. (${mode})` });
      return { id: `saved${calls.length}`, role: 'assistant', content: `어서 와요. (${mode})` };
    },
    async extractFacts() { calls.push({ facts: true }); return {}; },
    async summarize() { calls.push({ summary: true }); return {}; }
  };
}

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-'));
  const store = await new Store(dir).load();
  const services = createServices({ store, auth: { disabled: false }, users: () => USERS });
  await services.admin.tick();
  services.replies = fakeReplies(services);
  const bindings = new ThreadBindings(store.discordDoc);
  const controller = new DiscordController({ services, bindings, relay: { interval: 1 }, log: quiet });
  const alice = USERS[0];
  services.setup.ensure(alice);
  const link = () => services.discordLinks.redeem({ id: ALICE_D.id, name: ALICE_D.username }, services.discordLinks.issueCode(alice).code);
  return {
    services, bindings, controller, alice, link,
    stop: async () => { services.admin.stop(); await flushAll(); await rm(dir, { recursive: true, force: true }); }
  };
}

/** alice 가 잇고 스레드를 엽니다. */
async function started(t, { channel = fakeChannel(), values = {} } = {}) {
  t.link();
  const hero = t.services.library.characters.list(t.alice).find((c) => c.greeting?.trim());
  const i = fakeInteraction({ user: ALICE_D, channel, sub: 'start', values: { character: hero.id, ...values } });
  await t.controller.onInteraction(i);
  return { i, channel, hero, thread: channel.created[0] };
}

test('잇기 전에는 시작할 수 없고, /rp link 로 이으면 그 계정의 캐릭터가 자동완성에 나옴', async () => {
  const t = await setup();
  try {
    const channel = fakeChannel();
    const before = fakeInteraction({ user: ALICE_D, channel, sub: 'start', values: { character: 'x' } });
    await t.controller.onInteraction(before);
    assert.match(before.answers[0].content, /\/rp link/);
    assert.equal(channel.created.length, 0);

    const code = t.services.discordLinks.issueCode(t.alice).code;
    const link = fakeInteraction({ user: ALICE_D, channel, sub: 'link', values: { code } });
    await t.controller.onInteraction(link);
    assert.match(link.answers[0].content, /alice/);
    assert.equal(link.answers[0].flags, 64, '나만 보는 답');

    const ac = fakeInteraction({ kind: 'autocomplete', user: ALICE_D, channel, focused: { name: 'character', value: '' } });
    await t.controller.onInteraction(ac);
    const mine = t.services.library.characters.list(t.alice).map((c) => c.id);
    assert.ok(ac.choices.length > 0 && ac.choices.every((c) => mine.includes(c.value)), 'alice 의 캐릭터만');

    const strangerAc = fakeInteraction({ kind: 'autocomplete', user: STRANGER_D, channel, focused: { name: 'character', value: '' } });
    await t.controller.onInteraction(strangerAc);
    assert.deepEqual(strangerAc.choices, [], '잇지 않은 사람에게는 아무것도 안 보임');
  } finally {
    await t.stop();
  }
});

test('/rp start: 비공개 스레드를 열고 주인을 초대하고, 첫 대사를 버튼과 함께 올림', async () => {
  const t = await setup();
  try {
    const { i, thread, hero } = await started(t);
    assert.equal(thread.opts.type, ChannelType.PrivateThread);
    assert.deepEqual(thread.added, [ALICE_D.id]);
    const binding = t.bindings.get(thread.id);
    const chat = t.services.store.chats.get(binding.chatId);
    assert.equal(chat.ownerId, 'alice01', '대화는 이어진 앱 계정의 것');
    assert.equal(chat.characterId, hero.id);
    assert.equal(thread.sent.length, 1);
    assert.equal(thread.sent[0].components[0].components.length, 2, '다시 쓰기·이어 쓰기');
    assert.deepEqual(binding.reply.messageIds, [thread.sent[0].id]);
    assert.match(i.answers.at(-1).content, new RegExp(`<#${thread.id}>`));

    const open = await started(t, { values: { private: false } });
    assert.equal(open.thread.opts.type, ChannelType.PublicThread);
  } finally {
    await t.stop();
  }
});

test('스레드에서는 주인의 말만 대화에 들어가고, 답은 메시지를 고쳐 가며 씀', async () => {
  const t = await setup();
  try {
    const { thread } = await started(t);
    const binding = t.bindings.get(thread.id);
    const chat = t.services.store.chats.get(binding.chatId);
    const count = chat.messages.length;

    await t.controller.onMessage(fakeMessage(thread, { content: '끼어들기', author: STRANGER_D }));
    assert.equal(chat.messages.length, count, '남의 말은 넣지 않음');
    assert.equal(t.services.replies.calls.length, 0);

    await t.controller.onMessage(fakeMessage(thread, { content: '안녕!', author: ALICE_D }));
    assert.equal(chat.messages.at(-1).content, '안녕!');
    assert.deepEqual(t.services.replies.calls[0], { actor: 'alice01', chatId: chat.id, mode: 'new' });
    const reply = thread.sent.at(-1);
    assert.equal(reply.content, '어서 와요. (new)', '화면 표식은 떼고 보임');
    assert.equal(reply.components[0].components.length, 2);
    assert.deepEqual(thread.sent[0].components, [], '앞 답변의 버튼은 뗌');
    assert.deepEqual(t.bindings.get(thread.id).reply.messageIds, [reply.id]);
    await t.controller.background;
    assert.ok(t.services.replies.calls.some((c) => c.facts) && t.services.replies.calls.some((c) => c.summary), '답 뒤에 자동 기억');
  } finally {
    await t.stop();
  }
});

test('버튼: 주인만, 가장 최근 답변에서만. 다시 쓰기는 같은 메시지를 고쳐 쓰고, 막히면 그대로 둠', async () => {
  const t = await setup();
  try {
    const { thread } = await started(t);
    const { chatId } = t.bindings.get(thread.id);
    const greeting = thread.sent[0];

    const stranger = fakeInteraction({ kind: 'button', user: STRANGER_D, channel: thread, customId: `rp:regen:${chatId}`, message: greeting });
    await t.controller.onInteraction(stranger);
    assert.match(stranger.answers[0].content, /스레드를 연 사람만/);

    // 엔진 설정 문제처럼 시작 전에 막히면 지금 답변은 그대로입니다.
    t.services.replies.failNext = new AppError('엔진을 먼저 설정해 주세요.');
    const blocked = fakeInteraction({ kind: 'button', user: ALICE_D, channel: thread, customId: `rp:regen:${chatId}`, message: greeting });
    await t.controller.onInteraction(blocked);
    assert.match(blocked.answers.at(-1).content, /엔진을 먼저/);
    assert.equal(greeting.deleted, false);
    assert.equal(greeting.components.length, 1);

    const regen = fakeInteraction({ kind: 'button', user: ALICE_D, channel: thread, customId: `rp:regen:${chatId}`, message: greeting });
    await t.controller.onInteraction(regen);
    assert.equal(greeting.content, '어서 와요. (regenerate)', '같은 메시지를 고쳐 씀');
    assert.equal(thread.sent.filter((m) => !m.deleted).length, 1);

    const cont = fakeInteraction({ kind: 'button', user: ALICE_D, channel: thread, customId: `rp:cont:${chatId}`, message: greeting });
    await t.controller.onInteraction(cont);
    const added = thread.sent.at(-1);
    assert.equal(added.content, '어서 와요. (continue)');
    assert.deepEqual(greeting.components, [], '이어 쓰면 앞 메시지의 버튼은 뗌');
    assert.deepEqual(t.bindings.get(thread.id).reply.messageIds, [greeting.id, added.id]);

    const old = fakeInteraction({ kind: 'button', user: ALICE_D, channel: thread, customId: `rp:regen:${chatId}`, message: { id: 'gone' } });
    await t.controller.onInteraction(old);
    assert.match(old.answers[0].content, /가장 최근 답변/);
  } finally {
    await t.stop();
  }
});

test('성인 모드는 연령 제한 채널에서만 열리고, 연결이 끊기면 스레드에서도 멈춤', async () => {
  const t = await setup();
  try {
    t.link();
    const adult = t.services.settings.view(t.alice).presets.find((p) => p.adult);
    const hero = t.services.library.characters.list(t.alice)[0];
    const plain = fakeChannel();
    const refused = fakeInteraction({ user: ALICE_D, channel: plain, sub: 'start', values: { character: hero.id, mode: adult.id } });
    await t.controller.onInteraction(refused);
    assert.match(refused.answers[0].content, /연령 제한/);
    assert.equal(plain.created.length, 0);

    const nsfw = fakeChannel({ nsfw: true });
    await t.controller.onInteraction(fakeInteraction({ user: ALICE_D, channel: nsfw, sub: 'start', values: { character: hero.id, mode: adult.id } }));
    assert.equal(nsfw.created.length, 1);

    const { thread } = await started(t);
    t.services.discordLinks.unlinkDiscord(ALICE_D.id);
    await t.controller.onMessage(fakeMessage(thread, { content: '안녕', author: ALICE_D }));
    assert.match(thread.sent.at(-1).content, /\/rp link/);
    assert.equal(t.services.replies.calls.length, 0);
  } finally {
    await t.stop();
  }
});

test('/rp end: 대화를 보관하고 스레드를 닫음. 다시 말하면 보관에서 나옴', async () => {
  const t = await setup();
  try {
    const { thread } = await started(t);
    const { chatId } = t.bindings.get(thread.id);
    const end = fakeInteraction({ user: ALICE_D, channel: thread, sub: 'end' });
    await t.controller.onInteraction(end);
    assert.ok(t.services.store.chats.get(chatId).archivedAt);
    assert.equal(thread.archived, true);

    await t.controller.onMessage(fakeMessage(thread, { content: '다시 왔어', author: ALICE_D }));
    assert.equal(t.services.store.chats.get(chatId).archivedAt, undefined);
  } finally {
    await t.stop();
  }
});
