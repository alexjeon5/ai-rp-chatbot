/**
 * ComfyUI 로 장면 그림을 그립니다.
 *
 *   답변 ─▶ LLM 이 장면을 Danbooru 태그로 바꿈 ─▶ 태그 조립·필터 ─▶ ComfyUI /prompt
 *        ─▶ /history 로 끝날 때까지 기다림 ─▶ /view 로 받아 data/images 에 저장
 *
 * 워크플로는 ComfyUI 에서 'Save (API Format)' 으로 내보낸 JSON 을 그대로 씁니다.
 * 값이 정확히 "{{seed}}" 처럼 자리표시자이면 그 값으로 바꿉니다. 올리지 않았으면
 * 아래 기본 SDXL 워크플로를 씁니다.
 */

import { logHttp, trimBody } from './logs.js';

/* ---------------- 기본값 ---------------- */

/** Illustrious / NoobAI 같은 SDXL 애니메 계열에 맞춘 기본값입니다. */
export const IMAGE_DEFAULTS = () => ({
  enabled: false,
  baseUrl: 'http://127.0.0.1:8188',
  checkpoint: '',
  width: 832,
  height: 1216,
  steps: 28,
  cfg: 5.5,
  sampler: 'euler_ancestral',
  scheduler: 'normal',
  prefix: 'masterpiece, best quality, very aesthetic, absurdres',
  negative: 'lowres, worst quality, bad quality, bad anatomy, bad hands, extra digits, fewer digits, jpeg artifacts, signature, watermark, text, username, blurry',
  // ComfyUI 'Save (API Format)' JSON. null 이면 기본 워크플로.
  workflow: null,
  // 그린 뒤 ComfyUI 가 잡고 있는 VRAM 을 풀어 LLM 이 쓰게 합니다. 같은 PC 에서 돌릴 때 켭니다.
  freeAfter: true,
  // 성인 대화에만 적용되는, 사용자가 고칠 수 있는 필터.
  adult: {
    forceTags: 'adult',
    blockTags: '',
    extraNegative: ''
  }
});

/** 자리표시자가 들어 있는 기본 SDXL txt2img 워크플로 (ComfyUI API 형식). */
export const DEFAULT_WORKFLOW = {
  3: {
    class_type: 'KSampler',
    inputs: {
      seed: '{{seed}}', steps: '{{steps}}', cfg: '{{cfg}}',
      sampler_name: '{{sampler}}', scheduler: '{{scheduler}}', denoise: 1,
      model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0]
    }
  },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{checkpoint}}' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['4', 1] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'rp-chat', images: ['8', 0] } }
};

/** API 형식 워크플로인지 대강 봅니다. 노드마다 class_type 과 inputs 가 있어야 합니다. */
export function looksLikeWorkflow(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const nodes = Object.values(obj);
  return nodes.length > 0 && nodes.every((n) => n && typeof n.class_type === 'string' && n.inputs && typeof n.inputs === 'object');
}

/**
 * 자리표시자를 채운 사본을 만듭니다.
 *   값 전체가 "{{seed}}" 이면 → 숫자 등 원래 타입 그대로
 *   글 안에 섞여 있으면       → 글자로 바꿔 넣기
 */
export function fillWorkflow(workflow, vars) {
  const walk = (v) => {
    if (typeof v === 'string') {
      const whole = /^\{\{(\w+)\}\}$/.exec(v);
      if (whole && whole[1] in vars) return vars[whole[1]];
      return v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(workflow);
}

/* ---------------- 성인 필터 ---------------- */

/**
 * 모든 대화의 그림에서 무조건 막는 표현. 설정에서 끄거나 고칠 수 없습니다.
 * 성인 대화만이 아니라 일반 대화에도 적용합니다 — 애니메 계열 SDXL 모델은 요청하지 않아도
 * 선정적인 쪽으로 기우는 일이 잦아서입니다.
 * 미성년으로 읽힐 수 있는 태그가 하나라도 나오면 그림을 그리지 않습니다 (지우고 그리지 않음 —
 * 다른 태그들만으로도 어려 보이는 그림이 나올 수 있어서입니다).
 */
export const CORE_BLOCK_TERMS = [
  'loli', 'lolita', 'lolicon', 'shota', 'shotacon', 'child', 'children', 'kid', 'kids',
  'toddler', 'infant', 'baby', 'preteen', 'pre-teen', 'underage', 'minor', 'minors',
  'teen', 'teens', 'teenage', 'teenager', 'young girl', 'young boy', 'little girl', 'little boy',
  'schoolgirl', 'schoolboy', 'elementary school', 'elementary schooler', 'middle school',
  'middle schooler', 'junior high', 'kindergarten', 'randoseru', 'aged down', 'age regression',
  'age reversal', 'child body', 'petite child',
  '미성년', '초등', '중학생', '중딩', '고등학생', '고딩', '어린이', '아동', '유아', '아기', '로리', '쇼타'
];
const CORE_AGE = /\b([0-9]|1[0-7])\s*(yo|y\.o\.?|years?[\s-]*old)\b/i;

/** 모든 그림의 네거티브에 늘 붙는 태그. */
export const CORE_NEGATIVE = 'child, loli, shota, underage, aged down, young';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CORE_RE = new RegExp(
  `(^|[^a-z])(${CORE_BLOCK_TERMS.map(escapeRe).join('|')})(?=$|[^a-z])`, 'i');

/** 미성년으로 읽히는 태그들을 돌려줍니다. 비어 있으면 통과입니다. */
export function coreViolations(tags) {
  return tags.filter((t) => CORE_RE.test(t.toLowerCase()) || CORE_AGE.test(t));
}

/* ---------------- 태그 다루기 ---------------- */

/** 쉼표·줄바꿈으로 나뉜 글을 태그 배열로. 공백을 정리하고 겹친 것을 뺍니다. */
export function splitTags(text = '') {
  const seen = new Set();
  const out = [];
  for (const raw of String(text).split(/[,\n]/)) {
    const tag = raw.replace(/\s+/g, ' ').trim();
    const key = tag.toLowerCase().replace(/_/g, ' ');
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** 사용자가 적은 차단 목록. '*' 는 아무 글자나로 봅니다. 예: "gore, *blood*" */
function userBlockMatcher(list) {
  const pats = splitTags(list).map((p) => {
    const body = p.split('*').map(escapeRe).join('.*');
    return new RegExp(p.includes('*') ? `^${body}$` : `(^|\\b)${body}(\\b|$)`, 'i');
  });
  return (tag) => pats.some((re) => re.test(tag));
}

/**
 * 최종 프롬프트를 조립합니다.
 * @returns {{ prompt, negative, removed: string[] } | { blocked: string[] }}
 */
export function composePrompt({ cfg, sceneTags, appearance = [], adult = false }) {
  let tags = splitTags([cfg.prefix, adult ? cfg.adult?.forceTags : '', appearance.join(', '), sceneTags.join(', ')]
    .filter(Boolean).join(', '));

  // 사용자가 고칠 수 있는 필터는 성인 대화에만 적용합니다.
  let removed = [];
  if (adult) {
    const blocked = userBlockMatcher(cfg.adult?.blockTags || '');
    removed = tags.filter(blocked);
    tags = tags.filter((t) => !blocked(t));
  }
  // 고정 차단은 모든 대화에 적용합니다.
  const bad = coreViolations(tags);
  if (bad.length) return { blocked: bad };

  const negative = splitTags([cfg.negative, CORE_NEGATIVE, adult ? cfg.adult?.extraNegative : '']
    .filter(Boolean).join(', ')).join(', ');
  return { prompt: tags.join(', '), negative, removed };
}

/* ---------------- 장면 → 태그 (LLM) ---------------- */

/*
 * 지시문을 영어로 씁니다. 한국어로 지시하면 로컬 모델이 태그 대신 한국어 문장을 쓰거나
 * 롤플레이를 이어 써 버리는 일이 잦습니다. 예시 한 쌍을 앞에 두면 형식을 훨씬 잘 지킵니다.
 */
export const IMAGE_PROMPT_SYSTEM = `You convert a role-play scene into Danbooru tags for an anime SDXL image model (Illustrious / NoobAI).

Output rules:
- Output ONLY English Danbooru tags separated by commas, on one line. 15 to 35 tags.
- No sentences, no explanations, no numbering, no quotes, no Korean.
- Do not continue the story and do not reply to the characters.

Tag order: number of people (1girl, 1boy, 2girls ...) -> each character's appearance -> expression -> pose and action -> clothing -> place and background -> time and lighting -> framing (upper body, cowboy shot, close-up, from side ...)

Rules:
- Never write character names. Copy the given appearance tags to show who is who.
- The viewer is never drawn. If a character looks at or talks to the viewer, use "pov, looking at viewer".
- Only draw what actually happens in the scene. Do not add quality tags such as masterpiece.`;

const EXAMPLE_REQUEST = `Characters:
- Mina: 1girl, adult, short silver hair, blue eyes, white blouse

Scene (Korean role-play; the viewer is "Jun"):
Jun: 비 오는데 우산 같이 쓸래?
Mina: *우산을 받아 들며 웃는다.* "고마워. 사실 좀 추웠거든."

Tags:`;

const EXAMPLE_ANSWER = '1girl, adult, short silver hair, blue eyes, white blouse, smile, holding umbrella, standing, rain, wet hair, city street, night, streetlight, pov, looking at viewer, upper body';

/** 태그를 못 받았을 때 한 번 더 보내는 말. */
export const IMAGE_RETRY_PROMPT =
  'That was not a tag list. Reply again with ONLY comma-separated English Danbooru tags for the same scene. Nothing else.';

/** 장면 요청. 예시 한 쌍 뒤에 실제 장면을 같은 모양으로 붙입니다. */
export function buildImageMessages({ cast, scene, userName }) {
  const people = cast.map((c) =>
    `- ${c.name}: ${c.appearance?.trim() || '(no appearance tags; guess from the scene)'}`);
  const request = [
    'Characters:',
    people.join('\n'),
    '',
    `Scene (Korean role-play; the viewer is "${userName}"):`,
    scene,
    '',
    'Tags:'
  ].join('\n');
  return [
    { role: 'user', content: EXAMPLE_REQUEST },
    { role: 'assistant', content: EXAMPLE_ANSWER },
    { role: 'user', content: request }
  ];
}

/**
 * 모델 출력에서 태그만 추립니다.
 * 'Tags:' 머리, 코드 블록, 목록 표시를 걷어내고, 한글이 섞인 조각이나 문장처럼 긴 조각은 버립니다.
 */
export function parseSceneTags(text = '') {
  let body = text.replace(/```\w*\n?/g, '').trim();
  // 설명을 먼저 쓰고 'Tags:' 뒤에 태그를 적는 모델이 있습니다. 그 뒤만 봅니다.
  const marker = /(?:^|\n)\s*(?:tags?|prompt|태그)\s*[:：]\s*/i.exec(body);
  if (marker) body = body.slice(marker.index + marker[0].length);
  return splitTags(body)
    // 목록 표시(- , 1. , 2) )만 걷어냅니다. 1girl 의 1 은 태그의 일부입니다.
    .map((t) => t.replace(/^(?:[-*•]\s*|\d+[.)]\s+)/, '').replace(/["'`]/g, '').replace(/\.$/, '').trim())
    .filter((t) => t && t.length <= 80 && !/[가-힣]/.test(t) && t.split(' ').length <= 8)
    .slice(0, 50);
}

/** 오류 안내에 붙일 모델 응답 앞부분. 무엇이 문제였는지 보이게 합니다. */
export function previewOutput(text = '') {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '(빈 응답 — 모델이 아무것도 쓰지 않았거나, 생각 블록만 쓰고 끝났습니다)';
  return `"${clean.slice(0, 160)}${clean.length > 160 ? '…' : ''}"`;
}

/** 캐릭터마다 늘 같은 시드. 첫 그림이 비슷한 얼굴로 나오게 합니다. */
export function seedOf(key = '') {
  let h = 2166136261;
  for (const ch of String(key)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h % 4294967295;
}

/* ---------------- ComfyUI 통신 ---------------- */

const trimSlash = (u = '') => u.replace(/\/+$/, '');

async function comfyFetch(baseUrl, path, options = {}) {
  const url = `${trimSlash(baseUrl)}${path}`;
  const start = Date.now();
  const host = (() => { try { return new URL(url).host; } catch { return baseUrl; } })();
  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
    logHttp({ provider: 'comfyui', host, path, kind: 'image', durationMs: Date.now() - start, error: trimBody(e.message, 300) });
    const err = new Error(`ComfyUI 에 연결하지 못했습니다 (${baseUrl}). ComfyUI 가 켜져 있는지, 주소가 맞는지 확인해 주세요.`);
    err.cause = e;
    throw err;
  }
  if (!res.ok) {
    const body = await res.clone().text().catch(() => '');
    logHttp({ provider: 'comfyui', host, path, kind: 'image', status: res.status, durationMs: Date.now() - start, error: trimBody(body, 600) || res.statusText });
  } else if (!path.startsWith('/history') && !path.startsWith('/queue')) {
    // 기다리는 동안 1초마다 부르는 조회는 로그를 채우지 않게 뺍니다.
    logHttp({ provider: 'comfyui', host, path, kind: 'image', status: res.status, durationMs: Date.now() - start });
  }
  return res;
}

/** 체크포인트 목록. ComfyUI 버전에 따라 모양이 달라 둘 다 받습니다. */
export async function listCheckpoints(baseUrl) {
  const res = await comfyFetch(baseUrl, '/object_info/CheckpointLoaderSimple');
  if (!res.ok) throw new Error(`ComfyUI ${res.status}: 체크포인트 목록을 받지 못했습니다.`);
  const json = await res.json();
  const spec = json?.CheckpointLoaderSimple?.input?.required?.ckpt_name;
  const list = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options;
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
}

/** ComfyUI 가 거부한 이유를 사람이 읽을 말로. */
function describeRejection(body) {
  try {
    const json = JSON.parse(body);
    const lines = [json.error?.message || 'ComfyUI 가 워크플로를 거부했습니다.'];
    for (const [node, info] of Object.entries(json.node_errors || {})) {
      for (const e of info.errors || []) lines.push(`- 노드 ${node} (${info.class_type}): ${e.message}${e.details ? ` — ${e.details}` : ''}`);
    }
    return lines.join('\n');
  } catch {
    return body.slice(0, 500) || 'ComfyUI 가 워크플로를 거부했습니다.';
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('취소됨'), { name: 'AbortError' })); }, { once: true });
});

/**
 * 워크플로를 보내고 끝날 때까지 기다린 뒤 첫 번째 이미지를 받아 옵니다.
 * @returns {Promise<{ buffer: Buffer, ext: string }>}
 */
export async function renderImage(baseUrl, workflow, { signal, onStage, timeoutMs = 5 * 60_000 } = {}) {
  const clientId = `rp-chat-${Date.now().toString(36)}`;
  const res = await comfyFetch(baseUrl, '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal
  });
  if (!res.ok) throw new Error(describeRejection(await res.text().catch(() => '')));
  const { prompt_id: promptId } = await res.json();
  if (!promptId) throw new Error('ComfyUI 가 작업 번호를 돌려주지 않았습니다.');

  // 취소하면 ComfyUI 쪽 작업도 멈춥니다.
  const cancel = () => {
    comfyFetch(baseUrl, '/queue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [promptId] })
    }).catch(() => {});
    comfyFetch(baseUrl, '/interrupt', { method: 'POST' }).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });

  const started = Date.now();
  let lastStage = '';
  try {
    while (Date.now() - started < timeoutMs) {
      const h = await comfyFetch(baseUrl, `/history/${encodeURIComponent(promptId)}`, { signal });
      const entry = h.ok ? (await h.json())?.[promptId] : null;
      if (entry) {
        const status = entry.status || {};
        if (status.status_str === 'error') {
          const msg = (status.messages || []).find(([type]) => type === 'execution_error')?.[1];
          throw new Error(`ComfyUI 실행 오류${msg ? ` — ${msg.node_type || ''}: ${msg.exception_message || ''}` : ''}`);
        }
        const images = Object.values(entry.outputs || {}).flatMap((o) => o.images || []);
        const img = images.find((i) => i.type === 'output') || images[0];
        if (img) {
          onStage?.('save', '받아 오는 중');
          const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
          const file = await comfyFetch(baseUrl, `/view?${q}`, { signal });
          if (!file.ok) throw new Error(`ComfyUI ${file.status}: 그림을 받아 오지 못했습니다.`);
          const buffer = Buffer.from(await file.arrayBuffer());
          const ext = /\.(png|jpe?g|webp)$/i.exec(img.filename)?.[1]?.toLowerCase().replace('jpeg', 'jpg') || 'png';
          return { buffer, ext };
        }
        if (status.completed) throw new Error('워크플로가 끝났지만 저장된 그림이 없습니다. SaveImage 노드가 있는지 확인해 주세요.');
      } else {
        // 아직 시작 전이면 대기열 위치를 알려 줍니다.
        const q = await comfyFetch(baseUrl, '/queue', { signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const running = (q?.queue_running || []).some((x) => x[1] === promptId);
        const ahead = (q?.queue_pending || []).findIndex((x) => x[1] === promptId);
        const stage = running ? '그리는 중' : ahead > 0 ? `대기열 ${ahead}번째` : '그리는 중';
        if (stage !== lastStage) onStage?.('draw', stage);
        lastStage = stage;
      }
      await sleep(1000, signal);
    }
    cancel();
    throw new Error('5분이 지나도 그림이 끝나지 않아 멈췄습니다.');
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/** 그린 뒤 ComfyUI 가 잡고 있는 모델·메모리를 풉니다. 같은 GPU 의 LLM 이 다시 쓸 수 있게. */
export async function freeMemory(baseUrl) {
  await comfyFetch(baseUrl, '/free', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true })
  }).catch(() => {});
}
