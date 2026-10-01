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
import { ThreadBindings, ChannelBindings } from '../../src/discord/bindings.js';
import { DiscordController } from '../../src/discord/controller.js';

const USERS = [
  { id: 'alice01', name: 'alice', role: 'member', epoch: 0 },
  { id: 'bob0001', name: 'bob', role: 'owner', epoch: 0 }
];
const ALICE_D = { id: '100000000000000001', username: 'alice_d' };
const BOB_D = { id: '100000000000000002', username: 'bob_d' };
const STRANGER_D = { id: '100000000000000009', username: 'stranger' };
const quiet = { error() {}, warn() {}, log() {} };

let seq = 0;
function fakeMessage(channel, { content, components = [], embeds, allowedMentions, author }) {
  const msg = {
    id: `dm${++seq}`, content, components, embeds, allowedMentions, author, channel, channelId: channel.id, deleted: false, reactions: [], replyTo: null,
    reply: async (body) => { const sent = await channel.send(body); sent.replyTo = msg.id; return sent; },
    edit: async (patch) => { Object.assign(msg, patch); return msg; },
    delete: async () => { msg.deleted = true; },
    react: async (emoji) => { msg.reactions.push(emoji); }
  };
  return msg;
}

function fakeThread(parent, id) {
  const find = (mid) => thread.sent.find((m) => m.id === mid && !m.deleted);
  const thread = {
    id, parent, type: ChannelType.PrivateThread, archived: false, sent: [], added: [],
    isThread: () => true,
    send: async (body) => {
      assert.equal((body.allowedMentions?.parse || []).length, 0, '@everyone·역할 멘션은 늘 끔');
      assert.ok(!body.allowedMentions.roles?.length);
      const msg = fakeMessage(thread, { ...body, author: { id: 'bot', bot: true } });
      thread.sent.push(msg);
      return msg;
    },
    messages: {
      fetch: async (mid) => find(mid) || Promise.reject(new Error('없음')),
      edit: async (mid, patch) => { const m = find(mid); if (!m) throw new Error('없음'); Object.assign(m, patch); return m; },
      delete: async (mid) => { const m = find(mid); if (m) m.deleted = true; }
    },
    members: { add: async (userId) => { thread.added.push(userId); } },
    sendTyping: async () => {},
    setArchived: async (v) => { thread.archived = v; }
  };
  return thread;
}

function fakeChannel({ nsfw = false } = {}) {
  // 메시지 보내기·고치기는 스레드와 같습니다. 채널이라 isThread 만 다르고 스레드를 열 수 있습니다.
  const channel = Object.assign(fakeThread(null, `ch${++seq}`), {
    type: ChannelType.GuildText, nsfw, created: [],
    isThread: () => false,
    threads: { create: async (opts) => { const t = fakeThread(channel, `th${++seq}`); t.opts = opts; channel.created.push(t); return t; } }
  });
  return channel;
}

/** 슬래시 명령·버튼·자동완성 흉내. 답한 것은 replies 에 쌓입니다. */
function fakeInteraction({ kind = 'command', command = 'rp', user, channel, sub, values = {}, focused, customId, message, fields = {}, manager = false }) {
  const i = {
    user, channel, channelId: channel.id, commandName: command, customId, message, guildId: 'g1',
    memberPermissions: { has: () => manager },
    deferred: false, replied: false, answers: [], choices: null, modal: null,
    isAutocomplete: () => kind === 'autocomplete',
    isChatInputCommand: () => kind === 'command',
    isButton: () => kind === 'button',
    isModalSubmit: () => kind === 'modal',
    isFromMessage: () => kind === 'modal',
    fields: { getTextInputValue: (id) => fields[id] ?? '' },
    update: async (body) => { i.replied = true; i.answers.push(body); },
    showModal: async (modal) => { i.replied = true; i.modal = modal; },
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

/**
 * 가짜 모델 답변. 조각 몇 개를 흘리고, 저장은 진짜 Replies.saveReply 로 합니다(넘겨보기·이어 쓰기가 진짜 데이터로 돕니다).
 * next 에 글을 넣으면 그 글로, sources 를 넣으면 출처도 흘립니다.
 */
function fakeReplies(services, real) {
  const calls = [];
  return {
    calls,
    failNext: null,
    next: null,
    sources: null,
    async reply(actor, chatId, { mode, emit }) {
      calls.push({ actor: actor.id, chatId, mode });
      const chat = services.access.chat(actor, chatId);
      if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
      // 화면 표식은 비주얼 노벨을 켠 대화에서만 씁니다(진짜 모델처럼).
      const text = this.next ?? `${chat.vn ? '[[표정: 기쁨]]' : ''}어서 와요. (${mode} ${calls.length})`;
      this.next = null;
      emit({ context: {} });
      for (const part of text.match(/[\s\S]{1,7}/g) || []) emit({ delta: part });
      if (this.sources) emit({ sources: this.sources });
      const last = chat.messages[chat.messages.length - 1];
      const target = mode !== 'new' && last?.role === 'assistant' ? last : null;
      const names = chat.vn ? services.context.sceneNames(chat) : null;
      return real.saveReply(chat, { mode, target, text, thought: '', sources: this.sources || [], provider: 'fake', config: { model: 'm' }, names });
    },
    async choices() { calls.push({ choices: true }); return [{ text: '문을 연다.' }, { text: '설득해 본다.', check: { label: '설득', sides: 20, dc: 12 } }]; },
    async impersonate() { calls.push({ impersonate: true }); return '조용히 고개를 끄덕인다.'; },
    async extractFacts() { calls.push({ facts: true }); return {}; },
    async summarize() { calls.push({ summary: true }); return {}; }
  };
}

/** 캐릭터 이름·그림으로 보내는 가짜 웹훅. 보낸 것은 스레드에 쌓아 봇 메시지와 같이 봅니다. */
function fakeWebhooks() {
  const hooks = new Map();
  const hookFor = (thread) => {
    if (!hooks.has(thread.parent.id)) {
      hooks.set(thread.parent.id, {
        sends: [],
        send: async (body) => {
          assert.equal(body.threadId, thread.id);
          assert.deepEqual(body.allowedMentions, { parse: [] });
          const msg = fakeMessage(thread, { ...body, author: { id: 'hook', bot: true } });
          msg.webhook = { username: body.username, avatarURL: body.avatarURL };
          thread.sent.push(msg);
          hooks.get(thread.parent.id).sends.push(msg);
          return msg;
        },
        editMessage: async (mid, patch) => thread.messages.edit(mid, patch),
        deleteMessage: async (mid) => thread.messages.delete(mid)
      });
    }
    return hooks.get(thread.parent.id);
  };
  return { for: async (thread) => hookFor(thread), forget() {} };
}

async function setup({ webhooks = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-'));
  const store = await new Store(dir).load();
  const services = createServices({ store, auth: { disabled: false }, users: () => USERS, env: { PUBLIC_BASE_URL: 'https://rp.example' } });
  await services.admin.tick();
  services.replies = fakeReplies(services, services.replies);
  const bindings = new ThreadBindings(store.discordDoc);
  const channels = new ChannelBindings(store.discordDoc);
  const controller = new DiscordController({ services, bindings, channels, webhooks: webhooks ? fakeWebhooks() : null, relay: { interval: 1 }, log: quiet });
  const alice = USERS[0];
  services.setup.ensure(alice);
  const link = () => services.discordLinks.redeem({ id: ALICE_D.id, name: ALICE_D.username }, services.discordLinks.issueCode(alice).code);
  const linkBob = () => {
    services.setup.ensure(USERS[1]);
    return services.discordLinks.redeem({ id: BOB_D.id, name: BOB_D.username }, services.discordLinks.issueCode(USERS[1]).code);
  };
  return {
    services, bindings, controller, alice, link, linkBob, channels,
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

    const hero = t.services.library.characters.list(t.alice).find((c) => c.description && c.tags);
    const shown = ac.choices.find((c) => c.value === hero.id);
    assert.ok(shown.name.startsWith(`${hero.avatar} ${hero.name} — `), '이름 뒤에 한 줄 소개');
    assert.ok(shown.name.length <= 100 && !shown.name.includes('{{'));
    const byTag = fakeInteraction({ kind: 'autocomplete', user: ALICE_D, channel, focused: { name: 'character', value: hero.tags.split(',')[0].trim() } });
    await t.controller.onInteraction(byTag);
    assert.ok(byTag.choices.some((c) => c.value === hero.id), '태그로도 찾음');

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
    assert.equal(thread.sent.length, 2, '소개 카드와 첫 대사');
    const [intro, greeting] = thread.sent;
    const card = intro.embeds[0];
    assert.equal(card.title, `${hero.avatar} ${hero.name}`);
    assert.ok(card.description && !card.description.includes('{{'), '한 줄 소개, 자리표시자는 채움');
    assert.deepEqual(card.fields.map((f) => f.name), ['태그', '대화 모드', '나', '시작 상황'].filter((n) => n !== '태그' || hero.tags).filter((n) => n !== '시작 상황' || hero.scenario));
    assert.equal(card.fields.find((f) => f.name === '나').value, '나');
    assert.deepEqual(intro.components, [], '소개 카드에는 버튼이 없음');
    assert.equal(greeting.components[0].components.length, 2, '다시 쓰기·이어 쓰기');
    assert.deepEqual(binding.reply.messageIds, [greeting.id]);
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
    assert.equal(chat.messages.at(-2).content, '안녕!');
    assert.deepEqual(t.services.replies.calls[0], { actor: 'alice01', chatId: chat.id, mode: 'new' });
    const reply = thread.sent.at(-1);
    assert.equal(reply.content, '어서 와요. (new 1)');
    assert.equal(reply.components[0].components.length, 2, '다시 쓰기·이어 쓰기');
    assert.equal(reply.components[1].components.length, 2, '선택지·대신 쓰기');
    assert.deepEqual(thread.sent[1].components, [], '앞 답변(첫 대사)의 버튼은 뗌');
    assert.deepEqual(t.bindings.get(thread.id).reply, { messageIds: [reply.id], chatMessageId: chat.messages.at(-1).id, via: 'bot' });
    await t.controller.background;
    assert.ok(t.services.replies.calls.some((c) => c.facts) && t.services.replies.calls.some((c) => c.summary), '답 뒤에 자동 기억');
  } finally {
    await t.stop();
  }
});

test('버튼: 주인만, 가장 최근 답변에서만. 다시 쓰기는 같은 메시지를 고치고 ◀ n/m ▶ 로 넘겨봄, 막히면 그대로 둠', async () => {
  const t = await setup();
  try {
    const { thread } = await started(t);
    const { chatId } = t.bindings.get(thread.id);
    const chat = t.services.store.chats.get(chatId);
    const greeting = thread.sent[1];
    const press = (action, message = greeting, user = ALICE_D) =>
      fakeInteraction({ kind: 'button', user, channel: thread, customId: `rp:${action}:${chatId}`, message });

    const stranger = press('regen', greeting, STRANGER_D);
    await t.controller.onInteraction(stranger);
    assert.match(stranger.answers[0].content, /스레드를 연 사람만/);

    // 엔진 설정 문제처럼 시작 전에 막히면 지금 답변은 그대로입니다.
    t.services.replies.failNext = new AppError('엔진을 먼저 설정해 주세요.');
    const blocked = press('regen');
    await t.controller.onInteraction(blocked);
    assert.match(blocked.answers.at(-1).content, /엔진을 먼저/);
    assert.equal(greeting.deleted, false);
    assert.equal(greeting.components.length, 2);

    await t.controller.onInteraction(press('regen'));
    assert.equal(greeting.content, '어서 와요. (regenerate 2)', '같은 메시지를 고쳐 씀');
    assert.equal(thread.sent.filter((m) => !m.deleted).length, 2, '소개 카드와 고쳐 쓴 첫 대사뿐');
    const nav = greeting.components[0].components.map((b) => b.label || b.emoji?.name);
    assert.deepEqual(nav.slice(0, 3), ['◀', '2/2', '▶']);

    await t.controller.onInteraction(press('prev'));
    assert.equal(greeting.content, displayGreeting(chat), '첫 번째 답(첫 대사)으로 돌아감');
    assert.equal(greeting.components[0].components[1].label, '1/2');
    assert.equal(chat.messages.at(-1).swipeIndex, 0, '대화에도 넘겨본 장이 남음');
    await t.controller.onInteraction(press('next'));
    assert.equal(greeting.content, '어서 와요. (regenerate 2)');

    await t.controller.onInteraction(press('cont'));
    const added = thread.sent.at(-1);
    assert.match(added.content, /^어서 와요\. \(continue \d+\)$/);
    assert.deepEqual(greeting.components, [], '이어 쓰면 앞 메시지의 버튼은 뗌');
    assert.deepEqual(t.bindings.get(thread.id).reply.messageIds, [greeting.id, added.id]);

    const old = press('regen', { id: 'gone' });
    await t.controller.onInteraction(old);
    assert.match(old.answers[0].content, /가장 최근 답변/);
  } finally {
    await t.stop();
  }
});

/** 첫 대사가 보이는 모양 (이름 자리표시자가 채워진 글). */
const displayGreeting = (chat) => chat.messages[0].swipes[0].content;

test('💡 선택지: 나만 보는 번호 버튼, 고르면 내 차례로 보이고 답이 옴. 판정이 붙은 후보는 굴려서 보냄', async () => {
  const t = await setup();
  try {
    const { thread } = await started(t);
    const { chatId } = t.bindings.get(thread.id);
    const chat = t.services.store.chats.get(chatId);
    const offer = fakeInteraction({ kind: 'button', user: ALICE_D, channel: thread, customId: `rp:choices:${chatId}`, message: thread.sent[1] });
    await t.controller.onInteraction(offer);
    assert.match(offer.answers.at(-1).content, /1\.\*\* 문을 연다/);
    assert.equal(offer.answers.at(-1).components[0].components.length, 2);

    const pick = fakeInteraction({ kind: 'button', user: ALICE_D, channel: thread, customId: `rp:pick:${chatId}:1` });
    await t.controller.onInteraction(pick);
    const mine = chat.messages.at(-2);
    assert.match(mine.content, /^설득해 본다\.\n🎲 설득 판정 \(d20, 난이도 12\): \d+ — /);
    assert.ok(thread.sent.some((m) => m.content?.startsWith('**나** ▸ 설득해 본다.')), '고른 차례를 페르소나 이름으로 보임');
    assert.equal(chat.messages.at(-1).role, 'assistant');

    const stale = fakeInteraction({ kind: 'button', user: ALICE_D, channel: thread, customId: `rp:pick:${chatId}:0` });
    await t.controller.onInteraction(stale);
    assert.match(stale.answers[0].content, /지난 차례/);
  } finally {
    await t.stop();
  }
});

test('✍️ 대신 쓰기: 초안 → 보내기, 또는 고쳐서 보내기 창', async () => {
  const t = await setup();
  try {
    const { thread } = await started(t);
    const { chatId } = t.bindings.get(thread.id);
    const chat = t.services.store.chats.get(chatId);
    const imp = () => fakeInteraction({ kind: 'button', user: ALICE_D, channel: thread, customId: `rp:imp:${chatId}`, message: thread.sent.find((m) => m.components?.length) });

    const first = imp();
    await t.controller.onInteraction(first);
    assert.match(first.answers.at(-1).content, /조용히 고개를 끄덕인다/);
    const send = fakeInteraction({ kind: 'button', user: ALICE_D, channel: thread, customId: `rp:send:${chatId}` });
    await t.controller.onInteraction(send);
    assert.equal(chat.messages.at(-2).content, '조용히 고개를 끄덕인다.');

    await t.controller.onInteraction(imp());
    const edit = fakeInteraction({ kind: 'button', user: ALICE_D, channel: thread, customId: `rp:edit:${chatId}` });
    await t.controller.onInteraction(edit);
    assert.equal(edit.modal.components[0].component.value, '조용히 고개를 끄덕인다.');
    const submit = fakeInteraction({ kind: 'modal', user: ALICE_D, channel: thread, customId: edit.modal.custom_id, fields: { text: '고개를 젓는다.' } });
    await t.controller.onInteraction(submit);
    assert.equal(chat.messages.at(-2).content, '고개를 젓는다.');
  } finally {
    await t.stop();
  }
});

test('🎲 판정 버튼과 /rp roll: 서버가 굴린 결과가 내 차례가 됨', async () => {
  const t = await setup();
  try {
    const { thread } = await started(t);
    const { chatId } = t.bindings.get(thread.id);
    const chat = t.services.store.chats.get(chatId);
    t.services.chats.update(t.alice, chatId, { dice: true, vn: true });
    t.services.replies.next = '문지기가 막아선다. [[판정: 설득 d20 난이도 15]]';
    await t.controller.onMessage(fakeMessage(thread, { content: '들여보내 줘', author: ALICE_D }));
    const reply = thread.sent.at(-1);
    assert.equal(reply.content, '문지기가 막아선다.', '판정 표식은 보이지 않음');
    const checkBtn = reply.components[1].components.find((b) => b.custom_id.startsWith('rp:check:'));
    assert.match(checkBtn.label, /설득 판정 \(d20, 난이도 15\)/);

    await t.controller.onInteraction(fakeInteraction({ kind: 'button', user: ALICE_D, channel: thread, customId: checkBtn.custom_id, message: reply }));
    assert.match(chat.messages.at(-2).content, /^🎲 설득 판정 \(d20, 난이도 15\): \d+ — (대성공|대실패|성공|실패)$/);

    const bad = fakeInteraction({ user: ALICE_D, channel: thread, sub: 'roll', values: { dice: 'd7' } });
    await t.controller.onInteraction(bad);
    assert.match(bad.answers[0].content, /주사위를 읽지 못했습니다/);
    const roll = fakeInteraction({ user: ALICE_D, channel: thread, sub: 'roll', values: { dice: '2d6+3', memo: '문을 걷어찬다.' } });
    await t.controller.onInteraction(roll);
    assert.match(chat.messages.at(-2).content, /^문을 걷어찬다\.\n🎲 2d6\+3 → \d+ \+ \d+ \+3 = \d+$/);
  } finally {
    await t.stop();
  }
});

test('웹훅: 롤플레이 답은 캐릭터 이름·서명된 프로필 주소로, 표정 그림은 썸네일로', async () => {
  const t = await setup({ webhooks: true });
  try {
    t.link();
    const hero = t.services.library.characters.list(t.alice).find((c) => c.greeting?.trim());
    t.services.store.characters.update(hero.id, { portrait: 'p1.png', expressions: [{ label: '기쁨', file: 'e1.png' }] });
    const channel = fakeChannel();
    await t.controller.onInteraction(fakeInteraction({ user: ALICE_D, channel, sub: 'start', values: { character: hero.id } }));
    const thread = channel.created[0];
    const [intro, greeting] = thread.sent;
    assert.equal(intro.webhook, undefined, '소개 카드는 봇 이름으로');
    assert.match(intro.embeds[0].thumbnail.url, /\/pub\/art\/[^/]+\/p1\.png\?s=/, '프로필 그림 썸네일');
    assert.equal(greeting.webhook.username, hero.name);
    assert.match(greeting.webhook.avatarURL, new RegExp(`^https://rp\\.example/pub/art/${hero.id}/p1\\.png\\?s=`));
    assert.equal(t.bindings.get(thread.id).reply.via, 'webhook');

    const { chatId } = t.bindings.get(thread.id);
    t.services.chats.update(t.alice, chatId, { vn: true });
    await t.controller.onMessage(fakeMessage(thread, { content: '안녕', author: ALICE_D }));
    const reply = thread.sent.at(-1);
    assert.equal(reply.webhook.username, hero.name);
    assert.match(reply.embeds[0].thumbnail.url, /\/pub\/art\/[^/]+\/e1\.png\?s=/);
    assert.equal(reply.embeds[0].footer.text, '표정: 기쁨');
  } finally {
    await t.stop();
  }
});

test('/ask: 어시스턴트 스레드. 질문을 보이고 봇 이름으로 답하며 출처를 붙임. 롤플레이 버튼은 없음', async () => {
  const t = await setup({ webhooks: true });
  try {
    t.link();
    const channel = fakeChannel();
    t.services.replies.next = '```js\nconst a = [[1]];\n```';
    t.services.replies.sources = [{ url: 'https://example.com/a', title: '예시 [문서]' }];
    const ask = fakeInteraction({ command: 'ask', user: { ...ALICE_D, globalName: '앨리스' }, channel, values: { question: '배열 만드는 법' } });
    await t.controller.onInteraction(ask);
    const thread = channel.created[0];
    assert.equal(thread.opts.name, '배열 만드는 법');
    const chat = t.services.store.chats.get(t.bindings.get(thread.id).chatId);
    assert.equal(chat.kind, 'assistant');
    assert.equal(chat.ownerId, 'alice01');
    assert.equal(chat.messages[0].content, '배열 만드는 법');
    assert.equal(thread.sent[0].webhook.username, '앨리스', '질문은 내 디스코드 이름으로');
    const answer = thread.sent.at(-1);
    assert.equal(answer.webhook, undefined, '답은 봇 이름으로');
    assert.equal(answer.content, '```js\nconst a = [[1]];\n```', '어시스턴트 글은 표식 거르기 없이 그대로');
    assert.equal(answer.components.length, 1, '다시 쓰기·이어 쓰기 줄만');
    assert.match(answer.embeds[0].description, /\[예시 문서\]\(<https:\/\/example\.com\/a>\)/);
    await t.controller.background;
    assert.ok(!t.services.replies.calls.some((c) => c.facts), '어시스턴트는 자동 기억을 돌리지 않음');

    await t.controller.onMessage(fakeMessage(thread, { content: '더 알려줘', author: ALICE_D }));
    assert.equal(chat.messages.at(-2).content, '더 알려줘');
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

test('webhookName: 디스코드가 거절하는 이름을 고침', async () => {
  const { webhookName } = await import('../../src/discord/webhooks.js');
  assert.equal(webhookName('유하린'), '유하린');
  assert.equal(webhookName('Discord 봇@#'), '봇');
  assert.equal(webhookName('everyone'), '캐릭터');
  assert.equal(webhookName(''), '캐릭터');
  assert.equal(webhookName('가'.repeat(100)).length, 80);
});

test('Webhooks: 권한이 없으면 봇 이름으로, 1분 뒤나 권한이 바뀌면(retry) 다시 물음', async () => {
  const { Webhooks } = await import('../../src/discord/webhooks.js');
  let now = 0;
  let allowed = false;
  const warns = [];
  const hook = { token: 't', applicationId: 'app' };
  const channel = { id: 'c1', name: 'general', fetchWebhooks: async () => { if (!allowed) throw new Error('Missing Permissions'); return new Map([['h', hook]]); } };
  const hooks = new Webhooks({ applicationId: () => 'app', log: { warn: (m) => warns.push(m) }, now: () => now });
  const thread = { parent: channel };
  assert.equal(await hooks.for(thread), null);
  allowed = true;
  assert.equal(await hooks.for(thread), null, '1분 안에는 다시 묻지 않음');
  hooks.retry();
  assert.equal(await hooks.for(thread), hook, '권한이 바뀌면 바로 다시 물음');
  allowed = false;
  hooks.forget('c1');
  assert.equal(await hooks.for(thread), null);
  now += 60_001;
  allowed = true;
  assert.equal(await hooks.for(thread), hook, '1분이 지나면 다시 물음');
  assert.equal(warns.length, 2, '막힐 때마다 알림');
});

test('어시스턴트 채널: 켜기는 채널 관리 권한, 쓴 말에 스레드 없이 답장으로 멘션해 답함, 사람마다 대화가 따로', async () => {
  const t = await setup({ webhooks: true });
  try {
    const channel = fakeChannel();
    const say = (author, content) => t.controller.onMessage(fakeMessage(channel, { content, author }));

    const refused = fakeInteraction({ command: 'assistant', user: ALICE_D, channel, sub: 'on' });
    await t.controller.onInteraction(refused);
    assert.match(refused.answers[0].content, /채널 관리 권한/);
    await say(ALICE_D, '안녕?');
    assert.equal(channel.sent.length, 0, '켜기 전에는 답하지 않음');

    const on = fakeInteraction({ command: 'assistant', user: ALICE_D, channel, sub: 'on', manager: true });
    await t.controller.onInteraction(on);
    assert.match(on.answers[0].content, /어시스턴트 채널/);
    assert.equal(on.answers[0].flags, undefined, '켰다는 안내는 모두에게 보임');

    // 잇지 않은 사람에게는 멘션해 /rp link 를 안내합니다.
    const before = t.services.store.chats.all().length;
    await say(STRANGER_D, '누구세요');
    const hint = channel.sent.at(-1);
    assert.match(hint.content, /\/rp link/);
    assert.deepEqual(hint.allowedMentions.users, [STRANGER_D.id]);
    assert.equal(t.services.store.chats.all().length, before);

    t.link();
    t.linkBob();
    t.services.replies.next = '첫 답입니다.';
    const question = fakeMessage(channel, { content: '파이썬 리스트 정렬?', author: ALICE_D });
    await t.controller.onMessage(question);
    assert.equal(channel.created.length, 0, '스레드를 만들지 않음');
    const answer = channel.sent.at(-1);
    assert.equal(answer.replyTo, question.id, '질문에 대한 답장');
    assert.equal(answer.content, `<@${ALICE_D.id}> 첫 답입니다.`, '질문한 사람을 멘션');
    assert.ok(!channel.sent.some((m) => m.content?.includes('…')), "'…' 자리 없이 첫 조각이 온 뒤에 답장");
    assert.deepEqual(answer.allowedMentions.users, [ALICE_D.id], '멘션은 질문한 사람만 (고쳐 써도 유지)');
    assert.equal(answer.webhook, undefined, '어시스턴트는 봇 이름으로');
    assert.equal(answer.components.length, 1, '다시 쓰기·이어 쓰기');

    const aliceSlot = t.channels.slot(channel.id, 'alice01');
    const aliceChat = t.services.store.chats.get(aliceSlot.chatId);
    assert.equal(aliceChat.kind, 'assistant');
    assert.equal(aliceChat.ownerId, 'alice01');
    assert.equal(aliceChat.title, '파이썬 리스트 정렬?');

    await say(ALICE_D, '역순은?');
    assert.equal(aliceChat.messages.length, 4, '같은 대화로 이어짐 (앞 말을 기억)');
    assert.deepEqual(answer.components, [], '앞 답의 버튼은 뗌');

    await say(BOB_D, '나도 질문');
    const bobChat = t.services.store.chats.get(t.channels.slot(channel.id, 'bob0001').chatId);
    assert.notEqual(bobChat.id, aliceChat.id, '사람마다 자기 계정의 대화');
    assert.equal(bobChat.ownerId, 'bob0001');
    assert.ok(channel.sent.at(-1).content.startsWith(`<@${BOB_D.id}> `));

    // 남의 답에 달린 버튼은 못 누름. 내 답의 다시 쓰기는 같은 메시지를 고치고 멘션을 지킴.
    const aliceLast = channel.sent.find((m) => m.id === aliceSlot.reply.messageIds[0]);
    const bobPress = fakeInteraction({ kind: 'button', user: BOB_D, channel, customId: `rp:regen:${aliceChat.id}`, message: aliceLast });
    await t.controller.onInteraction(bobPress);
    assert.match(bobPress.answers[0].content, /질문한 사람만/);
    t.services.replies.next = '다시 쓴 답.';
    await t.controller.onInteraction(fakeInteraction({ kind: 'button', user: ALICE_D, channel, customId: `rp:regen:${aliceChat.id}`, message: aliceLast }));
    assert.equal(aliceLast.content, `<@${ALICE_D.id}> 다시 쓴 답.`);
    assert.equal(aliceLast.components[0].components[1].label, '2/2', '넘겨보기');

    // /assistant new: 다음 말부터 새 대화. 전 대화는 남음.
    const fresh = fakeInteraction({ command: 'assistant', user: ALICE_D, channel, sub: 'new' });
    await t.controller.onInteraction(fresh);
    assert.equal(fresh.answers[0].flags, 64);
    await say(ALICE_D, '새 질문');
    assert.notEqual(t.channels.slot(channel.id, 'alice01').chatId, aliceChat.id);
    assert.ok(t.services.store.chats.get(aliceChat.id), '전 대화는 남음');

    // 끄면 더 답하지 않음.
    await t.controller.onInteraction(fakeInteraction({ command: 'assistant', user: ALICE_D, channel, sub: 'off', manager: true }));
    const count = channel.sent.length;
    await say(ALICE_D, '아직 있어?');
    assert.equal(channel.sent.length, count);
  } finally {
    await t.stop();
  }
});

test('어시스턴트 채널: 웹에서 대화를 지우면 새 대화로 시작하고, 답을 쓰는 중이면 ⏳', async () => {
  const t = await setup();
  try {
    t.link();
    const channel = fakeChannel();
    t.channels.enable(channel.id, { guildId: 'g1', setBy: ALICE_D.id });
    await t.controller.onMessage(fakeMessage(channel, { content: '하나', author: ALICE_D }));
    const first = t.channels.slot(channel.id, 'alice01').chatId;
    await t.services.chats.remove(t.alice, first);
    await t.controller.onMessage(fakeMessage(channel, { content: '둘', author: ALICE_D }));
    const second = t.channels.slot(channel.id, 'alice01').chatId;
    assert.notEqual(second, first);
    assert.equal(t.services.store.chats.get(second).messages[0].content, '둘');

    t.services.jobs.running.set(second, { controller: new AbortController() });
    const busy = fakeMessage(channel, { content: '셋', author: ALICE_D });
    await t.controller.onMessage(busy);
    assert.deepEqual(busy.reactions, ['⏳']);
  } finally {
    await t.stop();
  }
});

test('게스트 모드: 잇지 않은 사람에게 호스트 계정으로 답함, 게스트마다 대화가 따로, 게스트 한도, 호스트가 연결을 끊으면 멈춤', async () => {
  const t = await setup();
  try {
    const channel = fakeChannel();
    const GUEST_D = { id: '100000000000000007', username: 'guest_d', globalName: '손님' };
    const OTHER_D = { id: '100000000000000008', username: 'other_d' };
    const say = (author, content) => t.controller.onMessage(fakeMessage(channel, { content, author }));

    // 게스트를 허용하려면 켜는 사람이 계정을 이어 두어야 합니다.
    const unlinked = fakeInteraction({ command: 'assistant', user: ALICE_D, channel, sub: 'on', values: { guests: true }, manager: true });
    await t.controller.onInteraction(unlinked);
    assert.match(unlinked.answers[0].content, /\/rp link/);
    assert.equal(t.channels.get(channel.id), null);

    t.link();
    const on = fakeInteraction({ command: 'assistant', user: ALICE_D, channel, sub: 'on', values: { guests: true }, manager: true });
    await t.controller.onInteraction(on);
    assert.match(on.answers[0].content, new RegExp(`게스트.*<@${ALICE_D.id}>`));
    assert.equal(t.channels.get(channel.id).hostUserId, 'alice01');

    await say(GUEST_D, '게스트 질문');
    const answer = channel.sent.at(-1);
    assert.ok(answer.content.startsWith(`<@${GUEST_D.id}> `), '게스트도 멘션해 답함');
    const guestSlot = t.channels.slot(channel.id, `guest:${GUEST_D.id}`);
    const guestChat = t.services.store.chats.get(guestSlot.chatId);
    assert.equal(guestChat.ownerId, 'alice01', '대화는 호스트 계정의 것');
    assert.equal(guestChat.title, '게스트 · 손님', '호스트의 웹 목록에서 알아보게');
    await say(GUEST_D, '이어서');
    assert.equal(guestChat.messages.length, 4, '게스트도 자기 대화로 이어짐');

    await say(ALICE_D, '호스트 본인 질문');
    const aliceChatId = t.channels.slot(channel.id, 'alice01').chatId;
    assert.notEqual(aliceChatId, guestChat.id, '이어 둔 사람은 자기 자리');
    await say(OTHER_D, '다른 게스트');
    assert.notEqual(t.channels.slot(channel.id, `guest:${OTHER_D.id}`).chatId, guestChat.id, '게스트마다 따로');

    // 버튼: 게스트는 자기 답만, 호스트도 게스트의 답은 못 누름.
    const guestAnswer = channel.sent.find((m) => m.id === guestSlot.reply.messageIds[0]);
    const byHost = fakeInteraction({ kind: 'button', user: ALICE_D, channel, customId: `rp:regen:${guestChat.id}`, message: guestAnswer });
    await t.controller.onInteraction(byHost);
    assert.match(byHost.answers[0].content, /질문한 사람만/);
    t.services.replies.next = '게스트용 다시 쓴 답.';
    await t.controller.onInteraction(fakeInteraction({ kind: 'button', user: GUEST_D, channel, customId: `rp:regen:${guestChat.id}`, message: guestAnswer }));
    assert.equal(guestAnswer.content, `<@${GUEST_D.id}> 게스트용 다시 쓴 답.`);

    // 게스트 한도: 한 명당 1분에 5번 (지금까지 질문 2 + 다시 쓰기 1).
    await say(GUEST_D, '넷');
    await say(GUEST_D, '다섯');
    const before = guestChat.messages.length;
    await say(GUEST_D, '여섯');
    assert.equal(guestChat.messages.length, before, '한도를 넘으면 대화에 넣지 않음');
    assert.match(channel.sent.at(-1).content, /1분에 5번/);

    // 호스트가 디스코드 연결을 끊으면 게스트 응답은 멈춤. 게스트의 /assistant new 도 같은 규칙.
    t.services.discordLinks.unlinkDiscord(ALICE_D.id);
    await say(OTHER_D, '아직 되나요');
    assert.match(channel.sent.at(-1).content, /\/rp link/);
    const fresh = fakeInteraction({ command: 'assistant', user: OTHER_D, channel, sub: 'new' });
    await t.controller.onInteraction(fresh);
    assert.match(fresh.answers[0].content, /\/rp link/);
  } finally {
    await t.stop();
  }
});
