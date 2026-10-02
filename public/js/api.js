/**
 * 로그인이 풀렸으면(만료, 다른 곳에서 로그아웃, 비밀번호 변경) 로그인 페이지로 보냅니다.
 * 돌아올 곳은 늘 첫 화면이라 따로 적지 않습니다. 마지막으로 연 대화는 localStorage 가 기억합니다.
 */
function toLogin(res) {
  if (res.status !== 401) return false;
  location.replace('/login.html');
  return true;
}

/** 그림 파일을 그대로 본문에 실어 보냅니다. 종류는 Content-Type 으로 알립니다. */
async function sendImage(url, method, blob) {
  const res = await fetch(url, { method, headers: { 'Content-Type': blob.type }, body: blob });
  if (toLogin(res)) throw new Error('로그인이 필요합니다.');
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `올리지 못했습니다 (${res.status})`);
  }
  return res.json();
}

async function req(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (toLogin(res)) throw new Error('로그인이 필요합니다.');
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `요청 실패 (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  me: () => req('/api/me'),
  contentFilter: () => req('/api/content-filter'),
  relaxContentFilter: () => req('/api/content-filter', { method: 'POST' }),
  restoreContentFilter: () => req('/api/content-filter', { method: 'DELETE' }),
  logout: () => req('/api/logout', { method: 'POST', body: {} }),

  settings: () => req('/api/settings'),
  saveSettings: (body) => req('/api/settings', { method: 'PUT', body }),
  models: (provider) => req(`/api/models?provider=${encodeURIComponent(provider)}`),
  clearUnavailable: (provider) =>
    req(`/api/providers/${encodeURIComponent(provider)}/unavailable`, { method: 'DELETE' }),
  importBackup: (data, includeSettings) =>
    req('/api/import', { method: 'POST', body: { data, includeSettings } }),
  imageCheckpoints: (baseUrl) => req(`/api/image/checkpoints?baseUrl=${encodeURIComponent(baseUrl)}`),
  imageApiModels: (backend) => req(`/api/image/models/${encodeURIComponent(backend)}`),
  uploadAttachment: (chatId, blob) => sendImage(`/api/chats/${chatId}/attachments`, 'POST', blob),
  discardAttachment: (chatId, file) => req(`/api/chats/${chatId}/attachments/${encodeURIComponent(file)}`, { method: 'DELETE' }),
  deleteImage: (chatId, mid, imgId) =>
    req(`/api/chats/${chatId}/messages/${mid}/images/${imgId}`, { method: 'DELETE' }),
  // scope: 'mine'(기본) 또는 'all'(주인만 — 모든 계정의 합계와 계정별 숫자)
  usage: (scope) => req(scope === 'all' ? '/api/usage?scope=all' : '/api/usage'),
  clearUsage: () => req('/api/usage', { method: 'DELETE' }),
  discordLink: () => req('/api/discord/link'),
  discordLinkCode: () => req('/api/discord/link-code', { method: 'POST' }),
  discordUnlink: () => req('/api/discord/link', { method: 'DELETE' }),
  logs: () => req('/api/logs'),
  clearLogs: () => req('/api/logs', { method: 'DELETE' }),

  characters: () => req('/api/characters'),
  createCharacter: (body) => req('/api/characters', { method: 'POST', body }),
  seedCharacters: () => req('/api/characters/seed', { method: 'POST', body: {} }),
  draftCharacter: (brief, current) => req('/api/characters/draft', { method: 'POST', body: { brief, current } }),
  updateCharacter: (id, body) => req(`/api/characters/${id}`, { method: 'PUT', body }),
  deleteCharacter: (id) => req(`/api/characters/${id}`, { method: 'DELETE' }),
  importCard: (body) => req('/api/characters/import', { method: 'POST', body }),
  cardUrl: (id) => `/api/characters/${id}/export`,
  setPortrait: (id, blob) => sendImage(`/api/characters/${id}/portrait`, 'PUT', blob),
  clearPortrait: (id) => req(`/api/characters/${id}/portrait`, { method: 'DELETE' }),
  setExpression: (id, label, blob) => sendImage(`/api/characters/${id}/expressions?label=${encodeURIComponent(label)}`, 'PUT', blob),
  removeExpression: (id, label) => req(`/api/characters/${id}/expressions?label=${encodeURIComponent(label)}`, { method: 'DELETE' }),

  backgrounds: () => req('/api/backgrounds'),
  addBackground: (name, blob) => sendImage(`/api/backgrounds?name=${encodeURIComponent(name)}`, 'POST', blob),
  renameBackground: (id, name) => req(`/api/backgrounds/${id}`, { method: 'PUT', body: { name } }),
  removeBackground: (id) => req(`/api/backgrounds/${id}`, { method: 'DELETE' }),

  personas: () => req('/api/personas'),
  createPersona: (body) => req('/api/personas', { method: 'POST', body }),
  updatePersona: (id, body) => req(`/api/personas/${id}`, { method: 'PUT', body }),
  deletePersona: (id) => req(`/api/personas/${id}`, { method: 'DELETE' }),
  rollPersonaSeeds: (seeds, only, adult) => req('/api/personas/roll', { method: 'POST', body: { seeds, only, adult } }),
  generatePersona: (seeds, adult) => req('/api/personas/generate', { method: 'POST', body: { seeds, adult } }),

  lorebooks: () => req('/api/lorebooks'),
  createLorebook: (body) => req('/api/lorebooks', { method: 'POST', body }),
  updateLorebook: (id, body) => req(`/api/lorebooks/${id}`, { method: 'PUT', body }),
  deleteLorebook: (id) => req(`/api/lorebooks/${id}`, { method: 'DELETE' }),
  testLorebook: (id, text, entries) => req(`/api/lorebooks/${id}/test`, { method: 'POST', body: { text, entries } }),
  suggestChoices: (chatId, count, signal) => req(`/api/chats/${chatId}/choices`, { method: 'POST', body: { count }, signal }),
  chatLore: (chatId) => req(`/api/chats/${chatId}/lore`),

  chats: () => req('/api/chats'),
  chat: (id) => req(`/api/chats/${id}`),
  search: (q, kind) => req(`/api/search?q=${encodeURIComponent(q)}&kind=${kind}`),
  createChat: (body) => req('/api/chats', { method: 'POST', body }),
  systemPreview: (id) => req(`/api/chats/${id}/system`),
  stopChat: (id) => req(`/api/chats/${id}/stop`, { method: 'POST', body: {} }),
  saveInlineCharacter: (id) => req(`/api/chats/${id}/save-character`, { method: 'POST', body: {} }),
  updateChat: (id, body) => req(`/api/chats/${id}`, { method: 'PUT', body }),
  deleteChat: (id) => req(`/api/chats/${id}`, { method: 'DELETE' }),
  branchChat: (id, messageId) => req(`/api/chats/${id}/branch`, { method: 'POST', body: { messageId } }),

  addMessage: (chatId, body) => req(`/api/chats/${chatId}/messages`, { method: 'POST', body }),
  swipe: (chatId, mid, index) =>
    req(`/api/chats/${chatId}/messages/${mid}/swipe`, { method: 'PUT', body: { index } }),
  extractFacts: (chatId, auto = false) =>
    req(`/api/chats/${chatId}/facts/extract`, { method: 'POST', body: { auto } }),
  context: (chatId) => req(`/api/chats/${chatId}/context`),
  summarize: (chatId, auto = false) =>
    req(`/api/chats/${chatId}/summarize`, { method: 'POST', body: { auto } }),
  editMessage: (chatId, mid, content) =>
    req(`/api/chats/${chatId}/messages/${mid}`, { method: 'PUT', body: { content } }),
  deleteMessage: (chatId, mid) =>
    req(`/api/chats/${chatId}/messages/${mid}`, { method: 'DELETE' })
};

/** SSE 응답을 읽으며 조각마다 onDelta 를 호출합니다. */
export function generate(chatId, { regenerate = false, resume = false, ...handlers }) {
  return streamPost(`/api/chats/${chatId}/generate`, { regenerate, continue: resume }, handlers);
}

/** 대신 쓰기. 내 다음 차례 초안을 받습니다. 결과는 { draft } 입니다. */
export function impersonate(chatId, { hint = '', ...handlers }) {
  return streamPost(`/api/chats/${chatId}/impersonate`, { hint }, handlers);
}

/**
 * 장면 그리기. 단계마다 onEvent({ stage, text } | { prompt }) 를 부르고, 끝나면 { image, images } 를 돌려줍니다.
 * @param {object} o
 * @param {string} [o.prompt] 사람이 고친 태그. 주면 LLM 을 건너뜁니다
 * @param {boolean} [o.random] 무작위 시드
 * @param {string} [o.negative] 사람이 고친 부정 태그
 * @param {boolean} [o.review] 태그까지만 만들고 그리지 않습니다. 결과의 review.{prompt,negative} 로 돌려줍니다
 */
export function drawImage(chatId, mid, { prompt, negative, checkpoint, random = false, review = false, ...handlers }) {
  return streamPost(`/api/chats/${chatId}/messages/${mid}/image`, { prompt, negative, checkpoint, random, review }, handlers);
}

async function streamPost(url, body, { signal, onDelta, onThought, onSources, onContext, onEvent }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (toLogin(res)) throw new Error('로그인이 필요합니다.');
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `생성 실패 (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result = { message: null };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = JSON.parse(line.slice(5).trim());
      if (payload.error) throw new Error(payload.error);
      if (payload.delta) onDelta?.(payload.delta);
      if (payload.thought) onThought?.(payload.thought);
      if (payload.sources) onSources?.(payload.sources);
      if (payload.context) onContext?.(payload.context);
      onEvent?.(payload);
      if (payload.done) result = payload;
    }
  }
  return result;
}
