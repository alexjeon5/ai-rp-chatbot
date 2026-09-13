async function req(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `요청 실패 (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  settings: () => req('/api/settings'),
  saveSettings: (body) => req('/api/settings', { method: 'PUT', body }),
  models: (provider) => req(`/api/models?provider=${encodeURIComponent(provider)}`),
  clearUnavailable: (provider) =>
    req(`/api/providers/${encodeURIComponent(provider)}/unavailable`, { method: 'DELETE' }),

  characters: () => req('/api/characters'),
  createCharacter: (body) => req('/api/characters', { method: 'POST', body }),
  seedCharacters: () => req('/api/characters/seed', { method: 'POST', body: {} }),
  updateCharacter: (id, body) => req(`/api/characters/${id}`, { method: 'PUT', body }),
  deleteCharacter: (id) => req(`/api/characters/${id}`, { method: 'DELETE' }),

  personas: () => req('/api/personas'),
  createPersona: (body) => req('/api/personas', { method: 'POST', body }),
  updatePersona: (id, body) => req(`/api/personas/${id}`, { method: 'PUT', body }),
  deletePersona: (id) => req(`/api/personas/${id}`, { method: 'DELETE' }),

  chats: () => req('/api/chats'),
  chat: (id) => req(`/api/chats/${id}`),
  createChat: (body) => req('/api/chats', { method: 'POST', body }),
  systemPreview: (id) => req(`/api/chats/${id}/system`),
  saveInlineCharacter: (id) => req(`/api/chats/${id}/save-character`, { method: 'POST', body: {} }),
  updateChat: (id, body) => req(`/api/chats/${id}`, { method: 'PUT', body }),
  deleteChat: (id) => req(`/api/chats/${id}`, { method: 'DELETE' }),

  addMessage: (chatId, body) => req(`/api/chats/${chatId}/messages`, { method: 'POST', body }),
  editMessage: (chatId, mid, content) =>
    req(`/api/chats/${chatId}/messages/${mid}`, { method: 'PUT', body: { content } }),
  deleteMessage: (chatId, mid) =>
    req(`/api/chats/${chatId}/messages/${mid}`, { method: 'DELETE' })
};

/** SSE 응답을 읽으며 조각마다 onDelta 를 호출합니다. */
export async function generate(chatId, { regenerate = false, signal, onDelta, onThought, onSources }) {
  const res = await fetch(`/api/chats/${chatId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ regenerate }),
    signal
  });
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
      if (payload.done) result = payload;
    }
  }
  return result;
}
