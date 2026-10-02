import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderKeys } from '../../public/js/features/settings-keys.js';

/** 폼 이벤트와 입력값만 재현해 키 전환 때 임시 입력이 다른 키를 덮지 않는지 검사합니다. */
function form(cfg, canManage = true) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', listeners: {}, addEventListener(type, cb) { this.listeners[type] = cb; }, focus() {} });
    return elements.get(id);
  };
  globalThis.document = { getElementById: get };
  globalThis.confirm = () => true;
  const settings = { shownProvider: 'openai', state: { settings: { canManage } }, draftProviders: { openai: cfg },
    modelOptions: ['old-model'], modelCombo: { close() {} }, setKeyVisible(show) { get('s-apikey').type = show ? 'text' : 'password'; } };
  const keys = new ProviderKeys(settings);
  keys.fill();
  const select = (id) => { const el = get('s-api-key-select'); el.value = id; el.listeners.change({ target: el }); };
  return { keys, get, select, settings };
}

test.afterEach(() => { delete globalThis.document; delete globalThis.confirm; });

test('폼에서 키 추가·전환 시 이름과 입력을 각 키에 보존하고 삭제 후 사용 키를 해제', () => {
  const cfg = { apiKey: '', apiKeys: [{ id: 'saved', name: '저장된 키', apiKey: '', hasApiKey: true }], activeApiKeyId: 'saved' };
  const { keys, get, select, settings } = form(cfg);
  assert.equal(get('s-apikey').value, '');
  keys.add();
  const added = cfg.activeApiKeyId;
  get('s-api-key-name').value = '업무용';
  get('s-apikey').value = 'typed-new-secret';
  select('saved');
  assert.equal(cfg.apiKeys.find((k) => k.id === added).apiKey, 'typed-new-secret');
  assert.equal(cfg.apiKeys.find((k) => k.id === added).name, '업무용');
  assert.equal(cfg.apiKeys[0].apiKey, '');
  assert.equal(get('s-apikey').value, '');
  assert.deepEqual(settings.modelOptions, []);
  select(added);
  assert.equal(get('s-apikey').value, 'typed-new-secret');
  assert.equal(get('s-apikey').type, 'password');
  keys.remove();
  assert.equal(cfg.activeApiKeyId, null);
  assert.deepEqual(cfg.apiKeys.map((k) => k.id), ['saved']);
});

test('새 커스텀 엔진의 단일 입력 키를 전환 폼에서 보존하고 이름은 HTML로 해석하지 않음', () => {
  const cfg = { apiKey: 'custom-secret' };
  const { keys, get } = form(cfg);
  assert.equal(keys.selected.apiKey, 'custom-secret');
  assert.equal(get('s-apikey').value, 'custom-secret');
  get('s-api-key-name').value = '<img src=x onerror=alert(1)>';
  keys.stash();
  keys.fill();
  assert.ok(!get('s-api-key-select').innerHTML.includes('<img'));
  assert.ok(get('s-api-key-select').innerHTML.includes('&lt;img'));
});

test('멤버·환경변수·조회 중에는 키 변경을 비활성화', () => {
  for (const mode of ['member', 'env', 'busy']) {
    const cfg = { apiKey: '', apiKeys: [], activeApiKeyId: null, keyFromEnv: mode === 'env' };
    const { keys, get } = form(cfg, mode !== 'member');
    keys.busy = mode === 'busy';
    keys.paintControls();
    assert.equal(get('s-api-key-select').disabled, true);
    assert.equal(get('s-api-key-add').disabled, true);
    get('s-apikey').value = 'forbidden';
    keys.stash();
    keys.add();
    assert.deepEqual(cfg.apiKeys, []);
  }
});
