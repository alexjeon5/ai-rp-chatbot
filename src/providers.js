/**
 * 프로바이더 어댑터.
 * 모든 어댑터는 { role, content } 배열을 받아 텍스트 조각을 yield 하는
 * async generator 로 통일되어 있습니다. 새 백엔드를 붙이려면 여기에만 추가하면 됩니다.
 */

import { logHttp, trimBody } from './logs.js';

const trimSlash = (u = '') => u.replace(/\/+$/, '');

function hostOfUrl(u = '') {
  try { return new URL(u).host; } catch { return u; }
}
function pathOfUrl(u = '') {
  try { return new URL(u).pathname; } catch { return u; }
}

/**
 * fetch 를 그대로 감싸되, 통신 로그를 남깁니다.
 * 키·본문 내용은 담지 않고, 어디로/얼마나 걸려서/몇 번 상태였는지만 남깁니다.
 * 실패했을 때는 응답 본문을 복제해서(clone) 읽습니다 — 원본은 그대로라 이후
 * assertOk() 등이 다시 res.text() 를 해도 문제없습니다.
 */
async function timedFetch(meta, url, options) {
  const start = Date.now();
  const base = { provider: meta.provider, host: hostOfUrl(url), path: pathOfUrl(url), kind: meta.kind, retry: meta.retry, detail: meta.detail };
  let res;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    logHttp({ ...base, durationMs: Date.now() - start, error: trimBody(networkErr.message || String(networkErr), 300) });
    networkErr.httpLogged = true; // 이미 위에서 남겼습니다.
    throw networkErr;
  }
  const durationMs = Date.now() - start;
  if (!res.ok) {
    let bodyText = '';
    try { bodyText = await res.clone().text(); } catch { /* 본문을 못 읽어도 상태 코드는 남깁니다 */ }
    logHttp({ ...base, status: res.status, durationMs, error: trimBody(bodyText, 600) || res.statusText });
  } else {
    logHttp({ ...base, status: res.status, durationMs });
  }
  return res;
}

/**
 * 웹 검색을 붙일 수 있는 조합인지.
 *
 * OpenAI 는 Chat Completions 에서 '전용 검색 모델' 만 검색합니다.
 * 문서 기준 gpt-5-search-api 가 현행이고, gpt-4o-search-preview 계열은 2026-07-23 에 종료됐습니다.
 * 일반 모델에 web_search_options 를 보내면 400 이 나므로 아예 고를 수 없게 합니다.
 */
export function supportsWebSearch(provider, config = {}) {
  const kind = ['openai', 'anthropic', 'gemini'].includes(provider) ? provider : config.type;
  if (kind === 'openai') return isOpenAiHost(config.baseUrl) && /search/i.test(config.model || '');
  return kind === 'anthropic' || kind === 'gemini';
}

/** 같은 주소가 여러 번 나와도 한 번만 담습니다. */
function addSource(sources, url, title) {
  if (!sources || !url) return;
  if (sources.some((s) => s.url === url)) return;
  sources.push({ url, title: title || url });
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)));

/** SSE 응답 본문을 한 줄씩 파싱해 data: 뒤의 payload 만 흘려보냅니다. */
async function* sseData(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

async function assertOk(res, name) {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  const err = new Error(`${name} ${res.status}: ${body.slice(0, 500) || res.statusText}`);
  err.status = res.status;
  err.body = body;
  err.httpLogged = true; // timedFetch 가 이 응답을 이미 로그에 남겼습니다.
  throw err;
}

/**
 * "이 모델은 못 쓴다" 는 응답인지 가려냅니다.
 *
 * Gemini 는 계정에 따라 같은 모델이 되기도 하고 404 가 나기도 합니다.
 * 구글이 2.5 계열을 '과거에 써 본 사용자에게만' 열어 두었기 때문입니다.
 * 그래서 고정 목록으로는 거를 수 없고, 실제로 거부당한 것을 기억하는 수밖에 없습니다.
 */
export function readsAsModelGone(error) {
  if (error?.status !== 404 && error?.status !== 400) return null;
  const text = String(error.body || error.message || '');
  const gone = /no longer available|not found|does not exist|has been deprecated|model_not_found|NOT_FOUND/i.test(text);
  if (!gone) return null;

  // 오류 문구가 대체 모델을 알려주는 경우가 많습니다.
  const hint = /use\s+(?:models\/)?([\w.\-]+)/i.exec(text);
  return { replacement: hint?.[1] || null };
}

/**
 * assistant 로 시작하거나 같은 role 이 연속되는 히스토리는
 * Anthropic / Gemini 에서 거부됩니다. 여기서 한 번 정리합니다.
 */
function normalizeTurns(messages) {
  const out = [];
  for (const m of messages) {
    if (!m.content?.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  if (out.length && out[0].role === 'assistant') {
    out.unshift({ role: 'user', content: '(장면을 시작한다)' });
  }
  return out;
}

/* ---------- OpenAI 호환 (OpenAI, LM Studio, 그 외 /v1 호환 서버) ---------- */

/**
 * OpenAI 본사 엔드포인트인지. 로컬 호환 서버와 규칙이 다릅니다.
 * 문자열로 대충 보면 api.openai.com.evil.net 같은 주소에 속으므로 호스트만 떼어 봅니다.
 */
function isOpenAiHost(baseUrl = '') {
  try {
    return /(^|\.)openai\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * o1·o3·o4·gpt-5 이후의 추론 모델은 temperature / top_p / max_tokens 를 거부합니다.
 * 이름만으로 완벽히 가릴 수는 없어서, 아래 판정은 첫 시도의 기본값일 뿐입니다.
 * 실제로 거부당하면 오류 문구를 읽고 한 번 더 고쳐 보냅니다.
 */
const looksLikeReasoningModel = (model = '') =>
  /^(o\d|gpt-5|gpt-6|codex)/i.test(model);

function buildOpenAiBody({ config, system, messages, params, extra, quirks, webSearch }) {
  const body = {
    model: config.model,
    stream: true,
    ...extra,
    messages: [{ role: 'system', content: system }, ...messages]
  };

  // 검색은 전용 모델(gpt-5-search-api, gpt-4o-search-preview 등)에서만 동작합니다.
  if (webSearch) body.web_search_options = {};
  // 마지막 조각에 실제 토큰 수를 받아 컨텍스트 어림을 보정합니다. 모르는 서버면 빼고 다시 보냅니다.
  if (!quirks.noUsage) body.stream_options = { include_usage: true };

  // max_tokens 는 OpenAI 에서 폐기되고 max_completion_tokens 로 바뀌었습니다.
  // 로컬 호환 서버(LM Studio, Ollama, llama.cpp)는 아직 max_tokens 만 압니다.
  if (quirks.completionTokens) body.max_completion_tokens = params.maxTokens;
  else body.max_tokens = params.maxTokens;

  if (!quirks.dropSampling) {
    body.temperature = params.temperature;
    body.top_p = params.topP;
  }
  return body;
}

/** 400 응답 문구를 읽고 무엇을 고쳐야 하는지 알아냅니다. */
function quirksFromError(text = '', current) {
  const next = { ...current };
  let changed = false;
  if (/max_completion_tokens/i.test(text) && !current.completionTokens) {
    next.completionTokens = true;
    changed = true;
  }
  if (/(temperature|top_p)/i.test(text) && /unsupported|not supported|unrecognized/i.test(text) &&
      !current.dropSampling) {
    next.dropSampling = true;
    changed = true;
  }
  if (/stream_options|include_usage/i.test(text) && !current.noUsage) {
    next.noUsage = true;
    changed = true;
  }
  return changed ? next : null;
}

async function* openaiCompatible({ provider, config, system, messages, params, signal, extra, webSearch, sources, onUsage }) {
  const openAiHost = isOpenAiHost(config.baseUrl);
  let quirks = {
    completionTokens: openAiHost,
    dropSampling: openAiHost && looksLikeReasoningModel(config.model)
  };

  const send = (retry = false) => timedFetch(
    { provider, kind: 'chat', detail: config.model, retry },
    `${trimSlash(config.baseUrl)}/chat/completions`,
    {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey || 'not-needed'}`
      },
      body: JSON.stringify(buildOpenAiBody({ config, system, messages, params, extra, quirks, webSearch }))
    }
  );

  let res = await send();
  if (res.status === 400) {
    // 파라미터 때문에 거부당했다면 한 번만 고쳐서 다시 보냅니다.
    const text = await res.text().catch(() => '');
    if (webSearch && /web_search/i.test(text)) {
      const err = new Error(
        `웹 검색을 지원하지 않는 모델입니다 (${config.model}). ` +
        'gpt-5-search-api 처럼 이름에 search 가 들어간 모델을 선택하거나 웹 검색을 꺼 주세요.'
      );
      err.httpLogged = true;
      throw err;
    }
    const fixed = quirksFromError(text, quirks);
    if (!fixed) {
      const err = new Error(`OpenAI 호환 서버 400: ${text.slice(0, 500)}`);
      err.httpLogged = true;
      throw err;
    }
    quirks = fixed;
    res = await send(true);
  }
  await assertOk(res, 'OpenAI 호환 서버');

  for await (const data of sseData(res)) {
    if (data === '[DONE]') return;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    if (json.usage?.prompt_tokens) onUsage?.({ promptTokens: json.usage.prompt_tokens });
    const choice = json.choices?.[0];
    for (const a of choice?.delta?.annotations || choice?.message?.annotations || []) {
      if (a?.type === 'url_citation') addSource(sources, a.url_citation?.url, a.url_citation?.title);
    }
    const delta = choice?.delta?.content;
    if (delta) yield delta;
  }
}

/* ---------- Anthropic ---------- */

/**
 * Anthropic 의 사고 기능은 세대마다 이름이 다릅니다.
 * 4.5 이하는 extended thinking(type: enabled), 4.7 이상은 이를 거부하고 adaptive 를 씁니다.
 * 모델 이름으로 가릴 수 없으니 거부당하면 다음 방식으로 한 번씩 물러섭니다.
 */
const THINKING_MODES = [
  (budget) => ({ type: 'enabled', budget_tokens: budget }),
  // adaptive 는 display 로 사고 표시량을 정합니다. summarized 는 요약본만 흘려보냅니다.
  () => ({ type: 'adaptive', display: 'summarized' }),
  () => null
];

async function* anthropic({ provider, config, system, messages, params, signal, webSearch, sources, thinking, onThought, onUsage }) {
  /*
   * 사고를 켜면 temperature 와 top_k 를 함께 보낼 수 없습니다.
   * budget_tokens 는 max_tokens 보다 작아야 하고, 사고 토큰도 max_tokens 에서 함께 빠집니다.
   * 예산을 한도에 가깝게 잡으면 답변 쓸 자리가 남지 않으므로 여유를 둡니다.
   */
  const budget = 2048;
  const maxTokens = thinking ? Math.max(params.maxTokens, budget + 2048) : params.maxTokens;
  let modeIndex = thinking ? 0 : THINKING_MODES.length - 1;

  const build = () => {
    const mode = THINKING_MODES[modeIndex](budget);
    const body = {
      model: config.model,
      stream: true,
      system,
      max_tokens: maxTokens,
      ...(webSearch
        ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] }
        : {}),
      messages: normalizeTurns(messages)
    };
    if (mode) {
      body.thinking = mode;
    } else {
      // Anthropic 의 temperature 는 0~1 입니다. 1 을 넘겨 보내면 400 이 납니다.
      body.temperature = clamp(params.temperature, 0, 1);
      body.top_p = clamp(params.topP, 0, 1);
      body.top_k = params.topK;
    }
    return body;
  };

  const send = (retry = false) => timedFetch(
    { provider, kind: 'chat', detail: config.model, retry },
    `${trimSlash(config.baseUrl)}/messages`,
    {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(build())
    }
  );

  let res = await send();
  while (res.status === 400 && modeIndex < THINKING_MODES.length - 1) {
    const text = await res.text().catch(() => '');
    if (!/thinking/i.test(text)) {
      const err = new Error(`Anthropic 400: ${text.slice(0, 500)}`);
      err.httpLogged = true;
      throw err;
    }
    modeIndex += 1;
    res = await send(true);
  }
  await assertOk(res, 'Anthropic');

  for await (const data of sseData(res)) {
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json.type === 'error') throw new Error(json.error?.message || 'Anthropic 오류');
    if (json.type === 'message_start') {
      const u = json.message?.usage || {};
      const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (input) onUsage?.({ promptTokens: input });
    }

    // 검색 결과는 별도 블록으로 옵니다. 본문 앞뒤 어디든 끼어들 수 있습니다.
    if (json.type === 'content_block_start' && json.content_block?.type === 'web_search_tool_result') {
      for (const r of json.content_block.content || []) addSource(sources, r.url, r.title);
    }
    if (json.type === 'content_block_delta') {
      if (json.delta?.type === 'text_delta') yield json.delta.text;
      else if (json.delta?.type === 'thinking_delta') onThought?.(json.delta.thinking || '');
    }
  }
}

/* ---------- Google Gemini ---------- */

/**
 * Gemini 의 사고 설정은 모델 계열마다 받는 항목이 다릅니다. (공식 문서 기준)
 *   - 3 계열: thinkingLevel 권장. thinkingBudget 은 호환용으로만 받고, 3 Pro 에서는 결과가 나빠질 수 있음
 *   - 2.5 계열: thinkingLevel 을 아예 지원하지 않음. thinkingBudget 사용
 *   - Gemini API 로 서비스되는 Gemma: 둘 다 지원하지 않음
 *
 * 켤 때는 아무 항목도 붙이지 않습니다. 모델 기본값(대개 동적 사고)이 가장 무난하고,
 * level 을 high 로 올리면 첫 글자까지 한참 걸립니다. includeThoughts 만 켜면 요약을 받습니다.
 *
 * 끌 때는 계열에 맞는 항목이 필요합니다. 다만 3.1 Pro, 3 Flash, Flash-Lite 는
 * 문서상 완전히 끌 수 없고 최소화만 됩니다.
 */
function geminiThinkingModes(model = '', on) {
  if (on) return [{ includeThoughts: true }, null];

  const level = { includeThoughts: false, thinkingLevel: 'low' };
  const budget = { includeThoughts: false, thinkingBudget: 0 };
  // minimal 은 3.8·3.7 Flash 에서 오류가 나므로, 어디서나 받는 low 를 씁니다.
  return /^gemini-3/i.test(model) ? [level, budget, null] : [budget, level, null];
}

/** 400 문구를 보고 무엇 때문인지 알려 줍니다. */
function geminiError(text = '', webSearch, config) {
  if (webSearch && /(search|tool)/i.test(text)) {
    return `웹 검색을 지원하지 않는 모델입니다 (${config.model}).\n` +
      'Gemini 모델을 고르거나 웹 검색을 꺼 주세요. Gemini API 로 서비스되는 Gemma 는 검색 도구가 없습니다.';
  }
  return `Gemini 400: ${text.slice(0, 500)}`;
}

async function* gemini({ provider, config, system, messages, params, signal, webSearch, sources, thinking, onThought, onUsage }) {
  // 키는 쿼리스트링 대신 헤더로 보냅니다. URL 은 로그·프록시에 그대로 남습니다.
  const url = `${trimSlash(config.baseUrl)}/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`;
  const modes = geminiThinkingModes(config.model, thinking);
  let modeIndex = 0;

  /*
   * maxOutputTokens 는 사고 토큰까지 합쳐서 셉니다.
   * 짧게 잡아 두면 모델이 생각하다가 한도에 걸려 본문이 비거나 잘린 채 끝납니다.
   * (finishReason: MAX_TOKENS) 그래서 사고를 켤 때는 바닥을 올려 둡니다.
   */
  const maxOutputTokens = thinking ? Math.max(params.maxTokens, 4096) : params.maxTokens;

  const build = () => ({
    systemInstruction: { parts: [{ text: system }] },
    contents: normalizeTurns(messages).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    ...(webSearch ? { tools: [{ google_search: {} }] } : {}),
    generationConfig: {
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      maxOutputTokens,
      // thinkingConfig 는 반드시 generationConfig 안에 있어야 합니다.
      // 요청 맨 바깥에 두면 Gemini 가 모르는 항목으로 보고 조용히 무시합니다.
      ...(modes[modeIndex] ? { thinkingConfig: modes[modeIndex] } : {})
    }
  });

  const send = (retry = false) => timedFetch(
    { provider, kind: 'chat', detail: config.model, retry },
    url,
    { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey }, body: JSON.stringify(build()) }
  );

  let res = await send();
  while (res.status === 400 && modeIndex < modes.length - 1) {
    const text = await res.text().catch(() => '');
    if (!/thinking/i.test(text)) {
      const err = new Error(geminiError(text, webSearch, config));
      err.httpLogged = true;
      throw err;
    }
    modeIndex += 1;
    res = await send(true);
  }
  if (res.status === 400) {
    const err = new Error(geminiError(await res.text().catch(() => ''), webSearch, config));
    err.httpLogged = true;
    throw err;
  }
  await assertOk(res, 'Gemini');

  for await (const data of sseData(res)) {
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json.error) throw new Error(json.error.message || 'Gemini 오류');
    if (json.usageMetadata?.promptTokenCount) onUsage?.({ promptTokens: json.usageMetadata.promptTokenCount });

    // 근거 자료는 마지막 청크에 groundingMetadata 로 붙어 옵니다.
    for (const chunk of json.candidates?.[0]?.groundingMetadata?.groundingChunks || []) {
      addSource(sources, chunk.web?.uri, chunk.web?.title);
    }
    const parts = json.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (!p.text) continue;
      // thought 가 붙은 조각은 본문이 아니라 사고 요약입니다. 섞이면 답변이 지저분해집니다.
      if (p.thought) onThought?.(p.text);
      else yield p.text;
    }
  }
}

/**
 * LM Studio · llama.cpp · Ollama 처럼 로컬 OpenAI 호환 서버에만 붙이는 값들.
 * OpenAI 본사는 top_k 와 repeat_penalty 를 모르는 파라미터로 보고 400 을 냅니다.
 */
const lmstudio = (opts) => {
  const extra = {};
  if (opts.params.topK) extra.top_k = opts.params.topK;
  // 1 은 억제 없음입니다. 보내지 않으면 서버 기본값이 적용돼 루프에 빠지기 쉽습니다.
  if (opts.params.repeatPenalty > 1) extra.repeat_penalty = opts.params.repeatPenalty;
  return openaiCompatible({ ...opts, extra: Object.keys(extra).length ? extra : undefined });
};

/*
 * Ollama(클라우드·로컬)는 OpenAI 호환 /v1 을 씁니다. 받는 필드가 OpenAI 와 같아서
 * LM Studio 용 top_k·repeat_penalty 를 붙이지 않는 기본 어댑터를 씁니다.
 * 인증은 Authorization: Bearer <키> 이고, 로컬 서버는 키를 보지 않습니다.
 */
const ADAPTERS = { lmstudio, openai: openaiCompatible, anthropic, gemini, ollama: openaiCompatible };

/** 내장 어댑터가 없으면 config.type 을 보고 고릅니다(커스텀 엔진). */
function pickAdapter(provider, config) {
  if (ADAPTERS[provider]) return ADAPTERS[provider];
  const byType = { openai: lmstudio, anthropic, gemini };
  const adapter = byType[config?.type];
  if (!adapter) throw new Error(`알 수 없는 엔진: ${provider}`);
  return adapter;
}

export async function* streamChat({ provider, ...rest }) {
  if (rest.webSearch && !supportsWebSearch(provider, rest.config)) {
    throw new Error(`웹 검색을 지원하지 않는 엔진입니다 (${rest.config?.label || provider}). 로컬 모델에는 검색 도구가 없습니다.`);
  }
  const start = Date.now();
  try {
    yield* pickAdapter(provider, rest.config)({ ...rest, provider });
  } catch (e) {
    // HTTP 단계 실패는 timedFetch 가 이미 남겼습니다. 여기서는 응답이 200 으로 시작됐지만
    // 스트림 도중(SSE data 안의 오류 등) 결국 실패로 끝난, 아직 안 남겨진 경우만 남깁니다.
    if (!e.httpLogged) {
      logHttp({
        provider,
        host: hostOfUrl(rest.config?.baseUrl || ''),
        path: '(그 외 오류)',
        kind: 'chat',
        durationMs: Date.now() - start,
        detail: rest.config?.model,
        error: trimBody(e.message || String(e), 300)
      });
    }
    throw e;
  }
}

/* ---------- 모델 목록 ---------- */

export async function listModels(provider, config) {
  const hidden = new Set(config.unavailableModels || []);
  const keep = (ids) => ids.filter((id) => !hidden.has(id));
  const base = trimSlash(config.baseUrl);
  const kind = ADAPTERS[provider] ? provider : config.type;
  if (kind === 'ollama') {
    // 문서가 안내하는 목록은 /api/tags 입니다(/v1 이 아니라 호스트 바로 아래). 안 되면 /v1/models 로.
    const origin = base.replace(/\/v1$/, '');
    const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
    const tags = await timedFetch({ provider, kind: 'models' }, `${origin}/api/tags`, { headers }).catch(() => null);
    if (tags?.ok) {
      const json = await tags.json();
      const ids = (json.models || []).map((m) => m.model || m.name).filter(Boolean);
      if (ids.length) return keep([...new Set(ids)]).sort();
    }
    const res = await timedFetch({ provider, kind: 'models', retry: true }, `${base}/models`, { headers });
    await assertOk(res, '모델 목록');
    const json = await res.json();
    return keep((json.data || []).map((m) => m.id).filter(Boolean)).sort();
  }
  if (kind === 'lmstudio' || kind === 'openai') {
    const res = await timedFetch(
      { provider, kind: 'models' },
      `${base}/models`,
      { headers: { Authorization: `Bearer ${config.apiKey || 'not-needed'}` } }
    );
    await assertOk(res, '모델 목록');
    const json = await res.json();
    const ids = (json.data || []).map((m) => m.id).filter(Boolean);

    // LM Studio 는 올려둔 모델만 주므로 그대로, OpenAI 는 임베딩·음성·이미지가 섞여 옵니다.
    // 검색 모델(gpt-5-search-api 등)은 남겨 둡니다. 웹 검색은 이 모델로만 됩니다.
    if (!isOpenAiHost(config.baseUrl)) return keep(ids).sort();
    const notChat = /embedding|whisper|tts|dall-e|moderation|image|audio|transcribe|similarity|davinci|babbage/i;
    return keep(ids.filter((id) => !notChat.test(id))).sort();
  }
  if (kind === 'anthropic') {
    // 한 쪽에 최대 1000개. has_more / last_id 로 다음 쪽을 따라갑니다.
    const ids = [];
    let afterId = '';
    for (let page = 0; page < 5; page++) {
      const url = new URL(`${base}/models`);
      url.searchParams.set('limit', '1000');
      if (afterId) url.searchParams.set('after_id', afterId);

      const res = await timedFetch(
        { provider, kind: 'models', retry: page > 0 },
        url,
        { headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' } }
      );
      await assertOk(res, '모델 목록');
      const json = await res.json();

      for (const m of json.data || []) if (m.id) ids.push(m.id);
      if (!json.has_more || !json.last_id) break;
      afterId = json.last_id;
    }
    return keep(ids);
  }
  if (kind === 'gemini') {
    /*
     * 주의: 목록에는 streamGenerateContent 가 표시되지 않습니다.
     * 스트리밍이 되는 모델도 supportedGenerationMethods 에 generateContent 와
     * countTokens 만 담겨 오므로, 구글 공식 예제대로 generateContent 로 거릅니다.
     * (필드명이 supportedActions 로 바뀌는 경우도 함께 받아 둡니다.)
     */
    const supportsChat = (m) => {
      const methods = m.supportedGenerationMethods || m.supportedActions || [];
      return methods.length === 0 || methods.includes('generateContent');
    };

    const names = [];
    let pageToken = '';
    // 한 페이지 최대 1000개. 혹시 모를 무한 루프를 막기 위해 5쪽까지만 봅니다.
    for (let page = 0; page < 5; page++) {
      const url = new URL(`${base}/models`);
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await timedFetch(
        { provider, kind: 'models', retry: page > 0 },
        url,
        { headers: { 'x-goog-api-key': config.apiKey } }
      );
      await assertOk(res, '모델 목록');
      const json = await res.json();

      for (const m of json.models || []) {
        if (supportsChat(m)) names.push((m.name || '').replace(/^models\//, ''));
      }
      pageToken = json.nextPageToken || '';
      if (!pageToken) break;
    }
    return keep(names.filter(Boolean)).sort();
  }
  throw new Error(`알 수 없는 엔진: ${provider}`);
}
