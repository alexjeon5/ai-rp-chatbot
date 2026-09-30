import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Store } from '../../src/store.js';
import { flushAll } from '../../src/db.js';
import { Engines } from '../../src/services/engines.js';
import { UserPrefs, normalizePresets, pickPrefs } from '../../src/services/prefs.js';
import { Settings } from '../../src/services/settings.js';

const owner = { id: 'owner1', name: '주인', role: 'owner' };
const member = { id: 'member1', name: '멤버', role: 'member' };

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'settings-'));
  const store = await new Store(dir).load();
  const prefs = new UserPrefs(store);
  const settings = new Settings({ store, prefs, engines: new Engines(store) });
  return { store, prefs, settings, done: async () => { await flushAll(); await rm(dir, { recursive: true, force: true }); } };
}

test('Settings: 계정별 값은 서로 섞이지 않고, 공용 값은 함께 봅니다', async () => {
  const { settings, done } = await setup();
  try {
    settings.update(owner, { params: { temperature: 0.3 }, dev: { theme: { accent: '#000000' } }, historyLimit: 10 });
    settings.update(member, { params: { temperature: 1.4 } });
    assert.equal(settings.view(owner).params.temperature, 0.3);
    assert.equal(settings.view(member).params.temperature, 1.4);
    assert.equal(settings.view(member).historyLimit, 40);
    assert.equal(settings.view(member).dev.theme.accent, '#d9b168');

    settings.update(owner, { image: { enabled: true }, dev: { adultCloud: true } });
    assert.equal(settings.view(member).image.enabled, true);
    assert.equal(settings.view(member).dev.adultCloud, true);
  } finally {
    await done();
  }
});

test('Settings: 멤버가 보낸 공용 항목은 조용히 빠지고 나머지는 저장됩니다', async () => {
  const { settings, store, done } = await setup();
  try {
    const out = settings.update(member, {
      providers: { openai: { apiKey: 'sk-member', baseUrl: 'http://evil.example.com/v1' } },
      removeProviders: ['x'],
      image: { baseUrl: 'ftp://x' },
      defaultProvider: 'openai',
      dev: { adultCloud: true, particleFix: false },
      askModeOnNewChat: false
    });
    assert.equal(store.settings.providers.openai.apiKey, '');
    assert.equal(store.settings.defaultProvider, 'lmstudio');
    assert.equal(store.settings.dev.adultCloud, false);
    assert.equal(out.canManage, false);
    assert.equal(out.dev.particleFix, false);
    assert.equal(out.askModeOnNewChat, false);
    assert.equal(out.providers.openai.apiKey, '', 'API 키는 내보내지 않습니다');
  } finally {
    await done();
  }
});

test('Settings: 주인의 잘못된 주소는 아무것도 바꾸지 않고 거절합니다', async () => {
  const { settings, done } = await setup();
  try {
    assert.throws(() => settings.update(owner, { providers: { lmstudio: { baseUrl: 'http://evil.example.com/v1' } }, historyLimit: 5 }), /엔진 주소를 쓸 수 없습니다/);
    assert.throws(() => settings.update(owner, { image: { workflow: { a: 1 } } }), /워크플로 형식이 아닙니다/);
    assert.equal(settings.view(owner).historyLimit, 40);
  } finally {
    await done();
  }
});

test('Settings.providerFor: 고른 엔진이 지워지면 공용 기본 엔진으로', async () => {
  const { settings, done } = await setup();
  try {
    settings.update(owner, { providers: { mine: { label: 'Mine', baseUrl: 'http://localhost:9/v1', model: 'm' } }, defaultProvider: 'anthropic' });
    assert.equal(settings.view(member).activeProvider, 'anthropic', '고른 적 없으면 기본 엔진');
    settings.update(member, { activeProvider: 'mine' });
    assert.equal(settings.view(member).activeProvider, 'mine');
    settings.update(owner, { removeProviders: ['mine'] });
    assert.equal(settings.view(member).activeProvider, 'anthropic');
    settings.update(owner, { defaultProvider: 'nope' });
    assert.equal(settings.shared.defaultProvider, 'anthropic', '없는 엔진은 기본으로 삼지 않습니다');
  } finally {
    await done();
  }
});

test('UserPrefs: 저장할 수 없는 계정 id 는 파일을 만들지 않은 사본을 받습니다', async () => {
  const { prefs, store, done } = await setup();
  try {
    const temp = prefs.of({ id: null });
    temp.historyLimit = 3;
    assert.equal(prefs.of({ id: null }).historyLimit, 40);
    prefs.of({ id: '../x' });
    assert.equal(store.prefs.size, 0);
    prefs.of(owner);
    assert.equal(store.prefs.size, 1);
  } finally {
    await done();
  }
});

test('pickPrefs · normalizePresets: 공용 값은 빼고, 옛 틀 이름과 순서를 다듬습니다', () => {
  const picked = pickPrefs({ providers: {}, image: {}, params: { temperature: 1 }, dev: { adultCloud: true, particleFix: false } });
  assert.deepEqual(picked, { params: { temperature: 1 }, dev: { particleFix: false } });
  const p = normalizePresets({ presets: [{ id: 'mine', name: '내 틀', template: 'x' }, { id: 'default', name: '기본 롤플레이', template: 'y' }], activePresetId: 'gone' });
  assert.equal(p.presets[0].id, 'default');
  assert.equal(p.presets[0].name, '롤플레이');
  assert.equal(p.presets.at(-1).id, 'mine');
  assert.equal(p.activePresetId, 'default');
});
