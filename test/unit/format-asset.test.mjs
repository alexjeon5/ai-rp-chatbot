import test from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from '../../public/js/ui/format.js';
import { AppState } from '../../public/js/core/state.js';
import { CharacterArtEditor } from '../../public/js/features/character-art.js';
import { CardTransfer } from '../../public/js/features/card-transfer.js';
import { renderThread } from '../../public/js/ui.js';

const imageUrl = '/api/character-art/hero/neutral.webp';
const assets = (name) => ['Neutral.1.webp', 'x'].includes(name) ? imageUrl : null;

test('registered images accept quotes, attributes, whitespace and self-closing tags', () => {
  for (const raw of [
    '<img src="Neutral.1.webp">',
    "<img src='Neutral.1.webp'>",
    '<IMG class="portrait" SRC = "Neutral.1.webp" width="200" />'
  ]) {
    assert.equal(formatText(raw, { assets }),
      `<img class="rp-asset" src="${imageUrl}" alt="Neutral.1.webp" title="Neutral.1.webp" loading="lazy" draggable="false">`);
  }
});

test('all supported asset macros resolve case-insensitively', () => {
  for (const marker of ['asset', 'img', 'IMAGE', 'Emotion']) {
    const html = formatText(`{{${marker}::x}}`, { assets });
    assert.match(html, /<img class="rp-asset"/);
    assert.ok(html.includes(`src="${imageUrl}"`));
    assert.doesNotMatch(html, /\{\{|\uE000|\uE001/);
  }
});

test('missing assets and missing resolver remove complete markers', () => {
  for (const raw of ['<img src="unknown.webp">', '{{asset::unknown}}', '{{img::unknown}}', '{{emotion::unknown}}']) {
    assert.equal(formatText(raw, { assets }), '');
    assert.equal(formatText(raw), '');
  }
  assert.equal(formatText('before <img src="unknown.webp"> after', { assets }), 'before  after');
  assert.equal(formatText('<img src="unknown.webp">', { assets, bubbles: true }), '');
});

test('external addresses and paths stay escaped without invoking asset lookup', () => {
  for (const name of ['http://evil/x.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 'folder/x.png', '/x.png']) {
    const resolver = () => assert.fail('external addresses are not asset names');
    const html = formatText(`<img src="${name}">`, { assets: resolver });
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /<img\b/);
    const macro = `{{asset::${name}}}`;
    assert.equal(formatText(macro, { assets: resolver }), macro);
  }
});

test('asset URLs and names are escaped before insertion into HTML attributes', () => {
  const url = '/picture?x=" onerror="bad<>&';
  const name = 'a"<>&';
  const html = formatText(`{{asset::${name}}}`, { assets: () => url });
  assert.equal(html,
    '<img class="rp-asset" src="/picture?x=&quot; onerror=&quot;bad&lt;&gt;&amp;" ' +
    'alt="a&quot;&lt;&gt;&amp;" title="a&quot;&lt;&gt;&amp;" loading="lazy" draggable="false">');
});

test('plain mode preserves existing markdown rendering and never resolves assets', () => {
  const raw = '<img src="Neutral.1.webp">\n{{asset::x}}';
  const html = formatText(raw, { plain: true, assets: () => assert.fail('plain mode does not resolve assets') });
  assert.equal(html, '<p>&lt;img src=&quot;Neutral.1.webp&quot;&gt;<br>{{asset::x}}</p>');
  assert.equal(html, formatText(raw, { plain: true, bubbles: true }));
});

test('messenger mode renders images inside bubbles and preserves speaker and action markup', () => {
  const html = formatText('미나: *{{img::x}}*\n글 <img src="Neutral.1.webp"> 글', { assets, bubbles: true });
  assert.match(html, /<span class="bubble"><span class="speaker">미나<\/span>: <em><img class="rp-asset"/);
  assert.match(html, /<span class="bubble">글 <img class="rp-asset"[^>]*> 글<\/span>/);
  assert.doesNotMatch(html, /\uE000|\uE001/);
});

test('inline images coexist with roleplay speaker, asterisks and parentheses', () => {
  for (const raw of ['미나: *{{asset::x}}*', '(미나: {{img::x}} 손을 흔든다)']) {
    const html = formatText(raw, { assets });
    assert.match(html, /<span class="speaker">미나<\/span>/);
    assert.match(html, /<em>.*<img class="rp-asset"/);
    assert.doesNotMatch(html, /\uE000|\uE001/);
  }
  const html = formatText('글 <img src="Neutral.1.webp"> 글', { assets });
  assert.match(html, /^글 <img class="rp-asset"[^>]*> 글$/);
});

test('multiple images preserve their order through block rendering', () => {
  const html = formatText('### {{asset::one}}\n\n- {{img::two}}\n\n> {{image::three}}', {
    assets: (name) => `/pictures/${name}`
  });
  assert.match(html, /<h3><img class="rp-asset" src="\/pictures\/one"/);
  assert.match(html, /<li><img class="rp-asset" src="\/pictures\/two"/);
  assert.match(html, /<blockquote><img class="rp-asset" src="\/pictures\/three"/);
  assert.doesNotMatch(html, /\uE000|\uE001/);
});

test('inline code keeps image tags and asset macros literal while outside markers resolve', () => {
  for (const bubbles of [false, true]) {
    const seen = [];
    const html = formatText('`<img src="a.webp"> {{asset::missing}}` <img src="a.webp"> {{img::a.webp}}', {
      bubbles,
      assets: (name) => { seen.push(name); return imageUrl; }
    });
    assert.deepEqual(seen, ['a.webp', 'a.webp']);
    assert.equal((html.match(/class="rp-asset"/g) || []).length, 2);
    assert.match(html, /&lt;img src=.*a\.webp.*&gt;/);
    assert.ok(html.includes('{{asset::missing}}'));
  }
});

test('closed and streaming unclosed fenced code preserve all asset markers', () => {
  for (const closing of ['', '\n```\n{{image::outside}}']) {
    const seen = [];
    const html = formatText('{{emotion::outside}}\n```html\n<img src="a.webp">\n{{asset::missing}}' + closing, {
      assets: (name) => { seen.push(name); return imageUrl; }
    });
    assert.deepEqual(seen, closing ? ['outside', 'outside'] : ['outside']);
    assert.equal((html.match(/class="rp-asset"/g) || []).length, seen.length);
    assert.ok(html.includes('&lt;img src=&quot;a.webp&quot;&gt;'));
    assert.ok(html.includes('{{asset::missing}}'));
    assert.match(html, /<pre><code/);
  }
});

test('code markers stay visible even without an asset resolver', () => {
  for (const raw of ['`<img src="a.webp"> {{img::missing}}`', '```\n<img src="a.webp"> {{img::missing}}\n```']) {
    const html = formatText(raw);
    assert.match(html, /&lt;img/);
    assert.ok(html.includes('a.webp'));
    assert.ok(html.includes('{{img::missing}}'));
    assert.doesNotMatch(html, /rp-asset/);
  }
});

function makeState(characters) {
  // Class fields read localStorage only when constructing; these methods need just the character list.
  const state = Object.create(AppState.prototype);
  state.characters = characters;
  return state;
}

test('resolver trims and ignores case, then removes only image extensions on both names', () => {
  const state = makeState([{
    id: 'hero',
    assets: [
      { name: ' Neutral.1 ', file: 'neutral.webp' },
      { name: 'Smile.PNG', file: 'smile.webp' },
      { name: 'Neutral.2.webp', file: 'neutral2.webp' },
      { name: 'long.abcdef', file: 'long.webp' }
    ],
    expressions: [{ label: '기쁨', file: 'happy.webp' }]
  }]);
  const resolver = state.assetResolver({ characterId: 'hero' });
  assert.equal(resolver(' NEUTRAL.1.WEBP '), imageUrl);
  assert.equal(resolver('neutral.1'), imageUrl);
  assert.equal(resolver('smile'), '/api/character-art/hero/smile.webp');
  assert.equal(resolver('SMILE.jpeg'), '/api/character-art/hero/smile.webp');
  assert.equal(resolver('neutral.2'), '/api/character-art/hero/neutral2.webp');
  assert.equal(resolver('기쁨.png'), '/api/character-art/hero/happy.webp');
  assert.equal(resolver('long.webp'), null);
  assert.equal(resolver('missing'), null);
  assert.match(formatText('<img src="neutral.1.webp">', { assets: resolver }), /<img class="rp-asset"/);
});

test('resolver keeps numbered asset names distinct when matching image extensions', () => {
  const state = makeState([{
    id: 'hero',
    assets: [
      { name: 'Neutral.1', file: 'neutral.webp' },
      { name: 'a.1', file: 'a1.webp' },
      { name: 'a.2', file: 'a2.webp' },
      { name: 'smile.webp', file: 'smile.webp' }
    ]
  }]);
  const resolver = state.assetResolver({ characterId: 'hero' });
  for (const name of ['neutral.1.webp', 'Neutral.1', 'NEUTRAL.1.PNG']) {
    assert.equal(resolver(name), imageUrl, name);
  }
  for (const name of ['Neutral.3', 'Neutral.3.webp', 'Neutral', 'a', 'a.3', 'a.3.webp', 'a.webp']) {
    assert.equal(resolver(name), null, name);
  }
  assert.equal(resolver('a.2.webp'), '/api/character-art/hero/a2.webp');
  for (const name of ['smile', 'smile.png', 'smile.jpg', 'smile.jpeg', 'smile.gif', 'smile.avif']) {
    assert.equal(resolver(name), '/api/character-art/hero/smile.webp', name);
  }
  for (const name of ['smile.1', 'smile.txt', 'smile.bmp']) assert.equal(resolver(name), null, name);
});

test('exact matches across the cast take priority over main-character extension fallback', () => {
  const state = makeState([
    { id: 'hero', assets: [{ name: 'scene', file: 'main.webp' }] },
    { id: 'guest', assets: [{ name: 'scene.png', file: 'guest.webp' }] }
  ]);
  const resolver = state.assetResolver({ characterId: 'hero', castIds: ['guest'] }, { id: 'pending' });
  assert.equal(resolver('scene.png'), '/api/character-art/guest/guest.webp');
  assert.equal(resolver('scene.webp'), '/api/character-art/hero/main.webp');

  state.characters[0].assets[0].name = 'scene.jpg';
  state.characters[1].assets[0].name = 'scene';
  assert.equal(state.assetResolver({ characterId: 'hero', castIds: ['guest'] })('scene.png'),
    '/api/character-art/hero/main.webp');
});

test('resolver uses each message cast and supports inline characters, encoded URLs and expressions', () => {
  const state = makeState([
    { id: 'old guest', expressions: [{ label: 'old', file: 'old pose.webp' }] },
    { id: 'new', assets: [{ name: 'new', file: 'new.webp' }] }
  ]);
  const chat = { character: { id: 'inline', assets: [{ name: 'main', file: 'main.webp' }] }, castIds: ['new'] };
  const old = state.assetResolver(chat, { id: 'previous', castIds: ['old guest', 'deleted'] });
  assert.equal(old('old'), '/api/character-art/old%20guest/old%20pose.webp');
  assert.equal(old('new'), null);
  assert.equal(old('main'), '/api/character-art/inline/main.webp');
  assert.equal(state.assetResolver(chat, { id: 'previous' })('old'), null);
  assert.equal(state.assetResolver(chat, { id: 'pending' })('new'), '/api/character-art/new/new.webp');
});

test('resolver preserves character order for duplicates and returns null in assistant or empty chats', () => {
  const state = makeState([
    { id: 'hero', assets: [{ name: 'shared', file: 'main.webp' }] },
    { id: 'guest', assets: [{ name: 'SHARED', file: 'guest.webp' }] }
  ]);
  const chat = { characterId: 'hero', castIds: ['guest'] };
  assert.equal(state.assetResolver(chat)('Shared'), '/api/character-art/hero/main.webp');
  assert.equal(state.assetResolver({ ...chat, kind: 'assistant' })('shared'), null);
  assert.equal(state.assetResolver(null)('shared'), null);
});

function mockDocument(t) {
  const elements = new Map();
  const create = () => ({
    innerHTML: '', textContent: '', hidden: false, children: [], listeners: {},
    dataset: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(el) { this.children.push(el); }
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, create());
    return elements.get(id);
  };
  const original = globalThis.document;
  const originalAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.document = { getElementById: get, createElement: create };
  globalThis.requestAnimationFrame = () => 0;
  t.after(() => {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
    if (originalAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalAnimationFrame;
  });
  return get;
}

test('thread rendering passes each message resolver through to its image', (t) => {
  const get = mockDocument(t);
  const chat = { messages: [
    { id: 'first', role: 'assistant', content: '{{asset::x}}' },
    { id: 'second', role: 'assistant', content: '<img src="x">' }
  ] };
  const seen = [];
  renderThread(chat, { name: 'Hero' }, null, { assetsOf: (m) => {
    seen.push(m.id);
    return () => `/pictures/${m.id}.webp`;
  } });
  assert.deepEqual(seen, ['first', 'second']);
  const turns = get('messages').children[0].children;
  assert.ok(turns[0].innerHTML.includes('<img class="rp-asset" src="/pictures/first.webp"'));
  assert.ok(turns[1].innerHTML.includes('<img class="rp-asset" src="/pictures/second.webp"'));
});

test('asset editor displays escaped names and thumbnails, deletes via API and refreshes the thread', async (t) => {
  const get = mockDocument(t);
  const name = 'Neutral.1 & "portrait" <test>';
  const character = { id: 'hero', assets: [{ name, file: 'neutral pose.webp' }] };
  const state = makeState([character]);
  state.editingCharacterId = 'hero';
  state.chat = { characterId: 'hero' };
  const paints = [];
  const app = {
    state,
    characters: { paint: () => paints.push('characters') },
    list: { paint: () => paints.push('list') },
    view: { paintThread: () => paints.push('thread') }
  };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, method: options?.method });
    return { ok: true, status: 200, json: async () => url === '/api/characters'
      ? [{ ...character, assets: [] }]
      : { ...character, assets: [] } };
  });
  const editor = new CharacterArtEditor(app);
  editor.open(character);
  assert.equal(get('c-asset-box').hidden, false);
  assert.equal(get('c-asset-count').textContent, '1개');
  assert.match(get('c-asset-list').innerHTML, /src="\/api\/character-art\/hero\/neutral%20pose.webp"/);
  assert.ok(get('c-asset-list').innerHTML.includes('data-remove-asset="Neutral.1 &amp; &quot;portrait&quot; &lt;test&gt;"'));
  assert.equal(typeof get('c-asset-list').listeners.click, 'function');
  await editor.removeAsset(name);
  assert.deepEqual(requests, [
    { url: `/api/characters/hero/assets?name=${encodeURIComponent(name)}`, method: 'DELETE' },
    { url: '/api/characters', method: undefined }
  ]);
  assert.deepEqual(paints, ['characters', 'list', 'thread']);
  assert.equal(get('c-asset-box').hidden, true);
  assert.equal(get('c-asset-count').textContent, '');
  assert.equal(get('c-asset-list').innerHTML, '');
  editor.open(null);
  assert.equal(get('c-asset-box').hidden, true);
});

test('card import toast includes notices once and preserves dropped-item warnings', async (t) => {
  const get = mockDocument(t);
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const response = {
    character: { name: 'Hero', expressions: [{}], assets: [{}, {}] },
    lorebook: { entries: [{}, {}] },
    notices: ['에셋 그림 2개', '긴 세계관 항목을 나눠 담았습니다'],
    dropped: ['소리 에셋']
  };
  t.mock.method(globalThis, 'fetch', async (url) => ({
    ok: true, status: 200,
    json: async () => url === '/api/characters/import' ? response : []
  }));
  const transfer = Object.create(CardTransfer.prototype);
  transfer.state = {};
  transfer.app = { characters: { rememberTab() {}, paint() {} } };
  transfer.payloadOf = async () => ({ card: {} });
  await transfer.importFile({});
  assert.equal(get('toast').textContent,
    '「Hero」을(를) 가져왔습니다 · 표정 1개 · 세계관 2항목 · 에셋 그림 2개 · 긴 세계관 항목을 나눠 담았습니다 (옮기지 못함: 소리 에셋)');
  delete response.notices;
  delete response.dropped;
  await transfer.importFile({});
  assert.equal(get('toast').textContent, '「Hero」을(를) 가져왔습니다 · 표정 1개 · 세계관 2항목');
});
