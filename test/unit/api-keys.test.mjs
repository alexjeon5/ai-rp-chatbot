import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Store } from '../../src/store.js';
import { flushAll } from '../../src/db.js';
import { UserPrefs } from '../../src/services/prefs.js';
import { Settings } from '../../src/services/settings.js';
import { Engines } from '../../src/services/engines.js';
import { maskProviders, resolveApiKey } from '../../src/security.js';
import { updateApiKeys } from '../../src/api-keys.js';
import { listModels } from '../../src/providers.js';

const owner = { id: 'owner001', role: 'owner' };
const member = { id: 'member01', role: 'member' };
const profiles = [
  { id: 'personal', name: '개인용', apiKey: 'test-personal-secret' },
  { id: 'work', name: '업무용', apiKey: 'test-work-secret' }
];
async function setup(legacy) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rp-api-keys-'));
  if (legacy) await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ providers: legacy }));
  const store = await new Store(dir).load();
  const engines = new Engines(store);
  const settings = new Settings({ store, engines, prefs: new UserPrefs(store) });
  return { dir, store, engines, settings, done: async () => { await flushAll(); await rm(dir, { recursive: true, force: true }); } };
}

test('옛 단일 키를 유지하고 여러 키의 선택을 재시작 뒤에도 보존', async () => {
  const ctx = await setup({ openai: { apiKey: 'legacy-secret', baseUrl: 'http://localhost:9/v1' } });
  try {
    assert.equal(ctx.engines.config('openai').apiKey, 'legacy-secret');
    const legacy = ctx.settings.payload(owner).providers.openai;
    assert.equal(legacy.apiKeys[0].name, '기본 키');
    assert.equal(legacy.apiKeys[0].apiKey, '');
    ctx.settings.update(owner, { providers: { openai: { apiKeys: [...legacy.apiKeys, profiles[1]], activeApiKeyId: 'work' } } });
    await flushAll();
    const reloaded = await new Store(ctx.dir).load();
    assert.equal(new Engines(reloaded).config('openai').apiKey, profiles[1].apiKey);
    assert.equal(reloaded.settings.providers.openai.apiKeys[0].apiKey, 'legacy-secret');
  } finally { await ctx.done(); }
});

test('GET/PUT 마스킹 사본을 저장해도 비밀은 유지되고 이름 변경·교체·삭제를 지원', async () => {
  const ctx = await setup();
  try {
    let out = ctx.settings.update(owner, { providers: { openai: { apiKeys: profiles, activeApiKeyId: 'personal' } } });
    for (const actor of [owner, member]) {
      const json = JSON.stringify(ctx.settings.payload(actor));
      for (const profile of profiles) assert.ok(!json.includes(profile.apiKey));
    }
    const masked = out.providers.openai;
    masked.apiKeys[0].name = '새 개인용';
    out = ctx.settings.update(owner, { providers: { openai: masked } });
    assert.equal(ctx.engines.config('openai').apiKey, profiles[0].apiKey);
    assert.equal(out.providers.openai.apiKeys[0].name, '새 개인용');
    const changed = out.providers.openai;
    changed.apiKeys[1].apiKey = 'replacement-secret';
    changed.activeApiKeyId = 'work';
    out = ctx.settings.update(owner, { providers: { openai: changed } });
    assert.equal(ctx.engines.config('openai').apiKey, 'replacement-secret');
    out = ctx.settings.update(owner, { providers: { openai: { apiKeys: out.providers.openai.apiKeys.filter((k) => k.id !== 'work') } } });
    assert.equal(out.providers.openai.activeApiKeyId, null);
    assert.equal(ctx.engines.config('openai').apiKey, '');
    assert.equal(ctx.store.settings.providers.openai.apiKeys[0].apiKey, profiles[0].apiKey);
    ctx.settings.update(owner, { providers: { openai: { apiKeys: [] } } });
    assert.equal(ctx.engines.config('openai').apiKey, '');
    assert.deepEqual(ctx.store.settings.providers.openai.apiKeys, []);
  } finally { await ctx.done(); }
});

test('일반 계정은 키 추가·전환·삭제를 바꿀 수 없고 제공자별 키가 독립적', async () => {
  const ctx = await setup();
  try {
    ctx.settings.update(owner, { providers: {
      openai: { apiKeys: profiles, activeApiKeyId: 'personal' },
      anthropic: { apiKeys: profiles, activeApiKeyId: 'work' },
      custom: { label: 'Custom', baseUrl: 'http://localhost:9/v1', type: 'openai', apiKeys: profiles, activeApiKeyId: 'work' }
    } });
    ctx.settings.update(member, { providers: { openai: { apiKeys: [], activeApiKeyId: null, apiKey: 'member-secret' } } });
    assert.equal(ctx.engines.config('openai').apiKey, profiles[0].apiKey);
    assert.equal(ctx.engines.config('anthropic').apiKey, profiles[1].apiKey);
    assert.equal(ctx.engines.config('custom').apiKey, profiles[1].apiKey);
  } finally { await ctx.done(); }
});

test('키 목록 검증 실패 시 다른 제공자·이미지·개인 설정도 변경하지 않음', async () => {
  const ctx = await setup();
  try {
    ctx.settings.update(owner, { providers: { openai: { apiKeys: profiles } } });
    const before = JSON.stringify(ctx.store.settings);
    for (const patch of [
      { apiKeys: [...profiles, profiles[0]] }, { apiKeys: [{ id: 'new', name: 'New' }] },
      { activeApiKeyId: 'unknown' }, { apiKeys: [{ ...profiles[0], name: '' }] },
      { apiKeys: [{ ...profiles[0], apiKey: 'bad key' }] },
      { apiKeys: Array.from({ length: 21 }, (_, i) => ({ id: `k${i}`, name: 'Key', apiKey: 'secret' })) }
    ]) {
      assert.throws(() => ctx.settings.update(owner, { providers: { anthropic: { apiKey: 'other-new-secret' }, openai: patch }, image: { enabled: true }, historyLimit: 9 }), /API 키/);
      assert.equal(JSON.stringify(ctx.store.settings), before);
      assert.equal(ctx.settings.view(owner).historyLimit, 40);
    }
  } finally { await ctx.done(); }
});

test('환경변수 우선순위를 유지하고 삭제한 키나 선택 안 한 키로 되돌아가지 않음', () => {
  const old = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = 'env-secret';
    const cfg = { apiKeys: profiles, activeApiKeyId: 'work', apiKey: 'stale-secret' };
    assert.equal(resolveApiKey('gemini', cfg), 'env-secret');
    const masked = maskProviders({ gemini: cfg }).gemini;
    assert.equal(masked.keyFromEnv, true);
    assert.ok(!JSON.stringify(masked).includes('secret'));
    delete process.env.GEMINI_API_KEY;
    assert.equal(resolveApiKey('gemini', cfg), profiles[1].apiKey);
    assert.equal(resolveApiKey('gemini', { ...cfg, activeApiKeyId: null }), '');
    assert.equal(resolveApiKey('gemini', { ...cfg, apiKeys: [] }), '');
    assert.equal(resolveApiKey('gemini', { ...cfg, activeApiKeyId: 'deleted' }), '');
  } finally { if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old; }
});

test('기존 apiKey 입력·빈칸 유지·null 삭제 API 호환', () => {
  const original = { apiKey: 'old-secret' };
  assert.equal(updateApiKeys(original, { apiKey: '   ' }).apiKey, 'old-secret');
  assert.equal(updateApiKeys(original, { apiKey: 'new-secret' }).apiKey, 'new-secret');
  assert.deepEqual(updateApiKeys(original, { apiKey: null }).apiKeys, []);
  assert.equal(original.apiKey, 'old-secret');
});

test('실제 모델 조회 요청 헤더에 제공자별 선택한 키를 보내고 전환 시 숨긴 모델을 초기화', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'test-model' }], models: [{ name: 'models/test-model' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = await setup();
  const oldEnv = Object.fromEntries(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(oldEnv)) delete process.env[k];
  try {
    for (const [provider, header] of [['openai', 'authorization'], ['anthropic', 'x-api-key'], ['gemini', 'x-goog-api-key']]) {
      ctx.settings.update(owner, { providers: { [provider]: { baseUrl: base, apiKeys: profiles, activeApiKeyId: 'personal' } } });
      await listModels(provider, ctx.engines.config(provider));
      assert.equal(seen.at(-1).headers[header], header === 'authorization' ? `Bearer ${profiles[0].apiKey}` : profiles[0].apiKey);
      ctx.store.settings.providers[provider].unavailableModels = ['test-model'];
      ctx.settings.update(owner, { providers: { [provider]: { activeApiKeyId: 'personal' } } });
      assert.deepEqual(ctx.store.settings.providers[provider].unavailableModels, ['test-model']);
      ctx.settings.update(owner, { providers: { [provider]: { activeApiKeyId: 'work' } } });
      assert.deepEqual(ctx.store.settings.providers[provider].unavailableModels, []);
      await listModels(provider, ctx.engines.config(provider));
      assert.equal(seen.at(-1).headers[header], header === 'authorization' ? `Bearer ${profiles[1].apiKey}` : profiles[1].apiKey);
    }
  } finally {
    for (const [k, v] of Object.entries(oldEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await ctx.done();
  }
});
