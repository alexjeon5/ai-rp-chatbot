/** 제공자별 이름 붙인 API 키. 브라우저에서 돌아온 빈 값은 저장된 비밀을 보존합니다. */
import { randomUUID } from 'node:crypto';
import { AppError } from './services/errors.js';

export const MAX_API_KEYS = 20;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function normalizeApiKeys(cfg = {}) {
  const legacy = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  const apiKeys = Array.isArray(cfg.apiKeys)
    ? cfg.apiKeys.filter((k) => k && typeof k.id === 'string' && ID.test(k.id) && typeof k.apiKey === 'string' && k.apiKey.trim())
      .map((k) => ({ id: k.id, name: String(k.name || 'API 키').slice(0, 64), apiKey: k.apiKey.trim() }))
    : legacy ? [{ id: 'legacy', name: '기본 키', apiKey: legacy }] : [];
  const selected = own(cfg, 'activeApiKeyId') ? cfg.activeApiKeyId : apiKeys[0]?.id;
  const activeApiKeyId = apiKeys.some((k) => k.id === selected) ? selected : null;
  return { apiKeys, activeApiKeyId, apiKey: apiKeys.find((k) => k.id === activeApiKeyId)?.apiKey || '' };
}

const fail = (message) => { throw new AppError(`API 키: ${message}`); };
function validSecret(value) {
  if (typeof value !== 'string') fail('키는 문자열로 입력해 주세요.');
  const key = value.trim();
  if (!key || key.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(key)) fail('키 값이 비어 있거나 형식이 올바르지 않습니다.');
  return key;
}

/** 저장 전에 모든 항목을 검사합니다. 이 함수는 기존 설정을 바꾸지 않습니다. */
export function updateApiKeys(current = {}, patch = {}) {
  const before = normalizeApiKeys(current);
  let apiKeys = before.apiKeys;
  let activeApiKeyId = before.activeApiKeyId;
  if (own(patch, 'apiKeys')) {
    if (!Array.isArray(patch.apiKeys) || patch.apiKeys.length > MAX_API_KEYS) fail(`제공자마다 최대 ${MAX_API_KEYS}개까지 저장할 수 있습니다.`);
    const seen = new Set();
    apiKeys = patch.apiKeys.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('목록 형식이 올바르지 않습니다.');
      const id = entry.id === undefined ? randomUUID() : entry.id;
      if (typeof id !== 'string' || !ID.test(id) || seen.has(id)) fail('키 ID가 올바르지 않거나 중복됩니다.');
      seen.add(id);
      const old = before.apiKeys.find((k) => k.id === id);
      const name = typeof entry.name === 'string' ? entry.name.trim() : old?.name;
      if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/u.test(name)) fail('키 이름은 1~64자로 입력해 주세요.');
      const keep = entry.apiKey === undefined || (typeof entry.apiKey === 'string' && !entry.apiKey.trim());
      const apiKey = keep && old ? old.apiKey : validSecret(entry.apiKey);
      return { id, name, apiKey };
    });
    if (!apiKeys.some((k) => k.id === activeApiKeyId)) activeApiKeyId = before.apiKeys.length ? null : apiKeys[0]?.id || null;
  }
  if (own(patch, 'activeApiKeyId')) {
    const selected = patch.activeApiKeyId;
    if (selected !== null && selected !== '' && (typeof selected !== 'string' || !apiKeys.some((k) => k.id === selected))) fail('사용할 키가 목록에 없습니다.');
    activeApiKeyId = selected || null;
  }
  // 기존 단일 apiKey API도 유지합니다. 빈 입력은 바꾸지 않고 null은 선택한 키를 지웁니다.
  if (patch.apiKey === null) {
    apiKeys = apiKeys.filter((k) => k.id !== activeApiKeyId);
    activeApiKeyId = null;
  } else if (patch.apiKey !== undefined && !(typeof patch.apiKey === 'string' && !patch.apiKey.trim())) {
    const apiKey = validSecret(patch.apiKey);
    const selected = apiKeys.find((k) => k.id === activeApiKeyId);
    if (selected) selected.apiKey = apiKey;
    else {
      if (apiKeys.length >= MAX_API_KEYS) fail(`제공자마다 최대 ${MAX_API_KEYS}개까지 저장할 수 있습니다.`);
      activeApiKeyId = apiKeys.some((k) => k.id === 'legacy') ? randomUUID() : 'legacy';
      apiKeys.push({ id: activeApiKeyId, name: '기본 키', apiKey });
    }
  }
  return { apiKeys, activeApiKeyId, apiKey: apiKeys.find((k) => k.id === activeApiKeyId)?.apiKey || '' };
}
