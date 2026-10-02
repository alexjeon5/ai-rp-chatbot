/**
 * 장면 그림을 그립니다. 그리는 곳(backend)은 둘입니다.
 *
 * ComfyUI (로컬)
 *   답변 ─▶ LLM 이 장면을 Danbooru 태그로 바꿈 ─▶ 태그 조립·필터 ─▶ ComfyUI /prompt
 *        ─▶ /history 로 끝날 때까지 기다림 ─▶ /view 로 받아 data/images 에 저장
 *   워크플로는 ComfyUI 에서 'Save (API Format)' 으로 내보낸 JSON 을 그대로 씁니다.
 *   값이 정확히 "{{seed}}" 처럼 자리표시자이면 그 값으로 바꿉니다. 올리지 않았으면
 *   아래 기본 SDXL 워크플로를 씁니다.
 *
 * Google Gemini (API)
 *   답변 ─▶ LLM 이 장면을 영어 문장 묘사로 바꿈 ─▶ 스타일 + 묘사 ─▶ models/{model}:generateContent
 *   회사 모델은 태그보다 문장을 잘 알아듣고, 부정 프롬프트와 시드를 받지 않습니다.
 */

import { logHttp, trimBody } from './logs.js';

/* ---------------- 기본값 ---------------- */

/** Illustrious / NoobAI 같은 SDXL 애니메 계열에 맞춘 기본값입니다. */
const API_STYLE = 'Anime-style illustration with clean line art, soft cel shading and gentle lighting. No text, captions, speech bubbles or watermarks.';

export const IMAGE_DEFAULTS = () => ({
  enabled: false,
  // 'comfyui' | 'gemini' | 'openai'
  backend: 'comfyui',
  // ComfyUI 에 보낼 프롬프트 모양. 'tags' 는 SDXL 애니메 계열용 Danbooru 태그,
  // 'prose' 는 Z-Image·Flux 처럼 LLM 텍스트 인코더를 쓰는 모델용 영어 문장 묘사입니다.
  promptStyle: 'tags',
  // OpenAI 로 그릴 때. 주소와 키는 설정 → 엔진의 OpenAI 것을 씁니다.
  openai: {
    model: 'gpt-image-2.5-flare',
    size: '1024x1536',
    quality: 'auto',
    style: API_STYLE
  },
  // Gemini 로 그릴 때. 주소와 키는 설정 → 엔진의 Google Gemini 것을 씁니다.
  gemini: {
    model: 'gemini-3.1-flash-image',
    // Gemini 가 받는 비율 중 하나(GEMINI_RATIOS). ComfyUI 의 픽셀 크기와는 따로 둡니다.
    aspectRatio: '2:3',
    // '' 이면 보내지 않고 모델 기본값을 씁니다. 모델마다 받는 값이 달라서입니다.
    imageSize: '',
    style: API_STYLE
  },
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
  // Gemini·OpenAI 로 그릴 때 캐릭터의 프로필 그림을 참조 이미지로 함께 보내 얼굴·머리·옷을 맞춥니다. 그림이 외부로 나가므로 직접 켭니다.
  useReference: false,
  // 그린 뒤 ComfyUI 가 잡고 있는 VRAM 을 풀어 LLM 이 쓰게 합니다. 같은 PC 에서 돌릴 때 켭니다.
  freeAfter: true,
  // 🎨 그리기 때 LLM 이 만든 태그를 먼저 보여 주고, 확인(수정)한 뒤에 ComfyUI 로 보냅니다.
  reviewTags: true,
  // 성인 대화에만 적용되는, 사용자가 고칠 수 있는 필터.
  adult: {
    forceTags: 'adult',
    blockTags: '',
    extraNegative: ''
  }
});

/** 저장된 이미지 설정에 기본값을 깔아 둡니다. gemini 는 한 단계 안쪽이라 따로 합칩니다. */
export function imageConfig(saved = {}) {
  const base = IMAGE_DEFAULTS();
  return {
    ...base,
    ...saved,
    gemini: { ...base.gemini, ...(saved?.gemini || {}) },
    openai: { ...base.openai, ...(saved?.openai || {}) },
    adult: { ...base.adult, ...(saved?.adult || {}) }
  };
}

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

/** 문장 묘사(Gemini)에서 같은 표현을 찾습니다. 태그처럼 나뉘어 있지 않아 글 전체를 훑습니다. */
export function coreViolationsText(text = '') {
  const lower = String(text).toLowerCase();
  const found = new Set();
  const all = new RegExp(CORE_RE.source, 'gi');
  for (const m of lower.matchAll(all)) found.add(m[2]);
  const age = new RegExp(CORE_AGE.source, 'gi');
  for (const m of lower.matchAll(age)) found.add(m[0]);
  return [...found];
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
export function composePrompt({ cfg, sceneTags, sceneNegative = [], appearance = [], adult = false, relaxUserFilter = false }) {
  let tags = splitTags([cfg.prefix, adult ? cfg.adult?.forceTags : '', appearance.join(', '), sceneTags.join(', ')]
    .filter(Boolean).join(', '));

  // 사용자 필터로 지우기 전에 고정 차단을 확인합니다.
  const bad = coreViolations(tags);
  if (bad.length) return { blocked: bad };

  // 성인 확인을 마친 로그인 세션에서만 사용자 차단 태그를 잠시 건너뜁니다.
  let removed = [];
  if (adult && !relaxUserFilter) {
    const blocked = userBlockMatcher(cfg.adult?.blockTags || '');
    removed = tags.filter(blocked);
    tags = tags.filter((t) => !blocked(t));
  }
  // 설정의 네거티브와 고정 네거티브는 늘 붙고, 장면마다 만든(또는 사람이 고친) 부정 태그가 뒤에 옵니다.
  const negative = splitTags([cfg.negative, CORE_NEGATIVE, adult ? cfg.adult?.extraNegative : '', sceneNegative.join(', ')]
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
- Output exactly two lines and nothing else:
  Tags: <15 to 35 English Danbooru tags, comma-separated>
  Negative: <0 to 12 English Danbooru tags for things that must NOT appear in this scene, comma-separated>
- Negative tags are scene-specific: wrong number of people, wrong time or place, wrong clothing, props that are not there. Do not repeat generic quality tags such as lowres or bad anatomy.
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

const EXAMPLE_ANSWER = 'Tags: 1girl, adult, short silver hair, blue eyes, white blouse, smile, holding umbrella, standing, rain, wet hair, city street, night, streetlight, pov, looking at viewer, upper body\n' +
  'Negative: 2girls, 1boy, multiple girls, daytime, sunlight, indoors, closed umbrella';

/** 태그를 못 받았을 때 한 번 더 보내는 말. */
export const IMAGE_RETRY_PROMPT =
  'That was not a tag list. Reply again for the same scene with exactly two lines: "Tags: ..." and "Negative: ...", ' +
  'each a comma-separated list of English Danbooru tags. Nothing else.';

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

/** 목록 한 줄을 태그 배열로. 목록 표시·따옴표를 걷어내고 한글이나 문장 조각은 버립니다. */
function cleanTagList(body, max = 50) {
  return splitTags(body)
    // 목록 표시(- , 1. , 2) )만 걷어냅니다. 1girl 의 1 은 태그의 일부입니다.
    .map((t) => t.replace(/^(?:[-*•]\s*|\d+[.)]\s+)/, '').replace(/["'`]/g, '').replace(/\.$/, '').trim())
    .filter((t) => t && t.length <= 80 && !/[가-힣]/.test(t) && t.split(' ').length <= 8)
    .slice(0, max);
}

/**
 * 모델 출력에서 그릴 태그와 부정 태그를 나눠 추립니다.
 * 'Negative:' 줄 뒤는 부정 태그, 그 앞은 그릴 태그입니다. 부정 줄이 없으면 부정 태그는 비어 있습니다.
 */
export function parseSceneOutput(text = '') {
  let body = text.replace(/```\w*\n?/g, '').trim();
  let negative = [];
  const neg = /(?:^|\n)\s*(?:negative(?:\s*(?:tags?|prompt))?|neg|부정\s*태그)\s*[:：]\s*/i.exec(body);
  if (neg) {
    negative = cleanTagList(body.slice(neg.index + neg[0].length).split('\n')[0], 20);
    body = body.slice(0, neg.index);
  }
  // 설명을 먼저 쓰고 'Tags:' 뒤에 태그를 적는 모델이 있습니다. 그 뒤만 봅니다.
  const marker = /(?:^|\n)\s*(?:tags?|prompt|태그)\s*[:：]\s*/i.exec(body);
  if (marker) body = body.slice(marker.index + marker[0].length);
  return { tags: cleanTagList(body), negative };
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

/* ---------------- 장면 → 문장 묘사 (Gemini 용) ---------------- */

export const IMAGE_DESCRIBE_SYSTEM = `You turn a role-play scene into a prompt for an image generation model. Write one English paragraph that describes a single illustration of the scene.

Output rules:
- Output exactly one line and nothing else: Description: <paragraph of 40 to 120 words>
- Do not continue the story, do not reply to the characters, no lists, no Korean.

What to describe, in this order: how many people -> each character's appearance (hair, eyes, build, clothing; use the given appearance notes) -> expression -> pose and action -> place and background -> time and lighting -> camera framing (close-up, upper body, full body, from the side ...).

Rules:
- Never write character names. Tell people apart by appearance.
- Every character is an adult. Call them "young woman", "man", "adult woman" and so on. Never use words such as child, kid, minor, teen, teenage, baby or schoolgirl.
- The viewer is never drawn. If a character looks at or talks to the viewer, write "looking at the viewer".
- Only draw what actually happens in the scene. Do not describe art style or quality; that is added separately.`;

const DESCRIBE_EXAMPLE_ANSWER = 'Description: A young adult woman with short silver hair and blue eyes, wearing a white blouse, smiles warmly as she takes hold of a black umbrella. She stands on a rainy city street at night, her hair slightly damp, streetlights reflecting on the wet pavement behind her. She is looking at the viewer. Upper body shot, soft light from the streetlamps.';

export const IMAGE_DESCRIBE_RETRY_PROMPT =
  'That was not the requested format. Reply again for the same scene with exactly one line: "Description: " followed by one English paragraph. Nothing else.';

/** 장면 요청. 태그 요청과 같은 예시 장면을 쓰되, 답은 문단입니다. */
export function buildDescribeMessages({ cast, scene, userName }) {
  const [, , request] = buildImageMessages({ cast, scene, userName });
  const ask = (text) => text.replace(/\nTags:$/, '\nDescription:');
  return [
    { role: 'user', content: ask(EXAMPLE_REQUEST) },
    { role: 'assistant', content: DESCRIBE_EXAMPLE_ANSWER },
    { role: 'user', content: ask(request.content) }
  ];
}

/** 모델 출력에서 묘사 문단만 추립니다. 너무 짧으면 빈 문자열입니다. */
export function parseDescription(text = '') {
  let body = text.replace(/```\w*\n?/g, '').trim();
  const marker = /(?:^|\n)\s*(?:\*\*)?(?:description|prompt|묘사)(?:\*\*)?\s*[:：]\s*/i.exec(body);
  if (marker) body = body.slice(marker.index + marker[0].length);
  body = body.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim().slice(0, 2000);
  return body.length >= 20 ? body : '';
}

/* ---------------- Gemini 로 그리기 ---------------- */

/** Gemini 이미지 모델이 받는 비율 (공식 문서의 aspectRatio 값). */
export const GEMINI_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** 그림 대신 돌아온 이유를 사람이 읽을 말로. */
function geminiRefusal(json) {
  const block = json?.promptFeedback?.blockReason;
  if (block) return `Gemini 가 요청을 거부했습니다 (${block}). 묘사를 고쳐 다시 그려 보세요.`;
  const cand = json?.candidates?.[0];
  const said = (cand?.content?.parts || []).map((p) => p.text).filter(Boolean).join(' ').trim();
  const reason = cand?.finishReason;
  const lines = [`Gemini 가 그림을 돌려주지 않았습니다${reason && reason !== 'STOP' ? ` (${reason})` : ''}.`];
  if (/SAFETY|PROHIBITED|BLOCK/i.test(reason || '')) lines.push('안전 정책에 걸린 것 같습니다. 묘사를 고쳐 다시 그려 보세요.');
  if (said) lines.push(`모델의 말: "${said.slice(0, 200)}${said.length > 200 ? '…' : ''}"`);
  return lines.join('\n');
}

function geminiHttpError(status, body, model) {
  let message = '';
  try { message = JSON.parse(body)?.error?.message || ''; } catch { /* 본문이 JSON 이 아닐 수 있습니다 */ }
  const text = message || body.slice(0, 300);
  if (status === 401 || status === 403) return `Gemini ${status}: API 키를 확인해 주세요 (설정 → 엔진 → Google Gemini).\n${text}`;
  if (status === 404) return `Gemini 404: 이 계정에서 쓸 수 없는 모델입니다 (${model}). 설정 → 이미지에서 불러오기로 모델을 다시 골라 주세요.\n${text}`;
  if (status === 429) return `Gemini 429: 사용량 한도에 걸렸습니다. 이미지 모델은 무료 등급 한도가 없거나 아주 적을 수 있습니다.\n${text}`;
  if (status === 400 && /image_?size|imageConfig/i.test(text)) return `Gemini 400: 이 모델은 고른 해상도를 받지 않습니다. 설정 → 이미지에서 해상도를 '모델 기본'으로 두세요.\n${text}`;
  return `Gemini ${status}: ${text}`;
}

/** 그릴 글 앞에 참조 그림을 붙입니다. 참조가 없으면 글 하나뿐입니다. */
export const REFERENCE_NOTE = 'The attached image is the character\'s design reference. Keep the same face, hair and outfit, and draw the scene below.';

function geminiParts(prompt, reference) {
  if (!reference) return [{ text: prompt }];
  return [
    { inlineData: { mimeType: reference.mime, data: reference.buffer.toString('base64') } },
    { text: `${REFERENCE_NOTE}\n\n${prompt}` }
  ];
}

/**
 * Gemini 이미지 모델로 한 장 그립니다.
 * @param {{ baseUrl: string, apiKey: string }} config  설정 → 엔진의 Google Gemini (키 채운 사본)
 * @returns {Promise<{ buffer: Buffer, ext: string }>}
 */
export async function renderGemini({ config, model, prompt, aspectRatio, imageSize, reference, signal, timeoutMs = 2 * 60_000 }) {
  const url = `${trimSlash(config.baseUrl)}/models/${encodeURIComponent(model)}:generateContent`;
  const host = (() => { try { return new URL(url).host; } catch { return config.baseUrl; } })();
  const path = `/models/${model}:generateContent`;
  const start = Date.now();
  const body = {
    contents: [{ role: 'user', parts: geminiParts(prompt, reference) }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio, ...(imageSize ? { imageSize } : {}) }
    }
  };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      // 키는 쿼리스트링 대신 헤더로 보냅니다. URL 은 로그·프록시에 그대로 남습니다.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean))
    });
  } catch (e) {
    logHttp({ provider: 'gemini', host, path, kind: 'image', durationMs: Date.now() - start, error: trimBody(e.message, 300) });
    if (e.name === 'TimeoutError') throw new Error('Gemini 가 2분 안에 그림을 돌려주지 않아 멈췄습니다.');
    if (e.name === 'AbortError') throw e;
    throw new Error(`Gemini 에 연결하지 못했습니다 — ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    logHttp({ provider: 'gemini', host, path, kind: 'image', status: res.status, durationMs: Date.now() - start, error: trimBody(text, 600) });
    throw new Error(geminiHttpError(res.status, text, model));
  }
  logHttp({ provider: 'gemini', host, path, kind: 'image', status: res.status, durationMs: Date.now() - start, detail: model });
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Gemini 응답을 읽지 못했습니다.'); }
  const parts = json?.candidates?.[0]?.content?.parts || [];
  // REST 는 inlineData 로 오지만, 일부 예제·프록시는 inline_data 로 적습니다.
  const img = parts.map((p) => p.inlineData || p.inline_data).find((d) => d?.data);
  if (!img) throw new Error(geminiRefusal(json));
  const mime = img.mimeType || img.mime_type || 'image/png';
  return { buffer: Buffer.from(img.data, 'base64'), ext: MIME_EXT[mime] || 'png' };
}

/* ---------------- OpenAI 로 그리기 ---------------- */

/** gpt-image 계열이 받는 크기와 품질 (공식 문서). 'auto' 는 모델이 고릅니다. */
export const OPENAI_SIZES = ['1024x1536', '1536x1024', '1024x1024', 'auto'];
export const OPENAI_QUALITIES = ['auto', 'low', 'medium', 'high'];

function openAiHttpError(status, body, model) {
  let error = {};
  try { error = JSON.parse(body)?.error || {}; } catch { /* 본문이 JSON 이 아닐 수 있습니다 */ }
  const text = error.message || body.slice(0, 300);
  if (error.code === 'moderation_blocked' || /safety system|moderation/i.test(text)) {
    return `OpenAI 가 안전 정책에 걸려 그리지 않았습니다. 묘사를 고쳐 다시 그려 보세요.\n${text}`;
  }
  if (status === 401) return `OpenAI 401: API 키를 확인해 주세요 (설정 → 엔진 → OpenAI).\n${text}`;
  if (status === 403 && /verif/i.test(text)) return `OpenAI 403: 이미지 모델을 쓰려면 OpenAI 콘솔에서 조직 인증(Organization Verification)을 먼저 마쳐야 합니다.\n${text}`;
  if (status === 404) return `OpenAI 404: 이 계정에서 쓸 수 없는 모델입니다 (${model}). 설정 → 이미지에서 불러오기로 모델을 다시 골라 주세요.\n${text}`;
  if (status === 429) return `OpenAI 429: 사용량 한도나 잔액을 확인해 주세요.\n${text}`;
  return `OpenAI ${status}: ${text}`;
}

/**
 * OpenAI Images API 로 한 장 그립니다. gpt-image 계열은 늘 b64_json 으로 돌려줍니다.
 * @param {{ baseUrl: string, apiKey: string }} config  설정 → 엔진의 OpenAI (키 채운 사본)
 * @returns {Promise<{ buffer: Buffer, ext: string }>}
 */
export async function renderOpenAi({ config, model, prompt, size, quality, reference, signal, timeoutMs = 3 * 60_000 }) {
  // 참조 그림은 gpt-image 계열의 편집(edits) 주소로만 받습니다. dall-e 는 참조 없이 그립니다.
  const edit = Boolean(reference) && !/^dall-e/i.test(model);
  const route = edit ? '/images/edits' : '/images/generations';
  const url = `${trimSlash(config.baseUrl)}${route}`;
  const host = (() => { try { return new URL(url).host; } catch { return config.baseUrl; } })();
  const start = Date.now();
  // dall-e 는 기본이 주소(url) 응답이고 품질 값도 달라서, 받는 것만 보냅니다.
  const fields = /^dall-e/i.test(model)
    ? { model, prompt, n: 1, response_format: 'b64_json' }
    : { model, prompt: edit ? `${REFERENCE_NOTE}\n\n${prompt}` : prompt, n: 1, size, quality };
  let body;
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  if (edit) {
    // 편집 주소는 JSON 이 아니라 multipart 로 받습니다. Content-Type 은 fetch 가 경계와 함께 채웁니다.
    body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
    body.append('image', new Blob([reference.buffer], { type: reference.mime }), `reference.${reference.ext}`);
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(fields);
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean))
    });
  } catch (e) {
    logHttp({ provider: 'openai', host, path: route, kind: 'image', durationMs: Date.now() - start, error: trimBody(e.message, 300) });
    if (e.name === 'TimeoutError') throw new Error('OpenAI 가 3분 안에 그림을 돌려주지 않아 멈췄습니다.');
    if (e.name === 'AbortError') throw e;
    throw new Error(`OpenAI 에 연결하지 못했습니다 — ${e.message}`);
  }
  const text = await res.text();
  const meta = { provider: 'openai', host, path: route, kind: 'image', status: res.status, durationMs: Date.now() - start };
  if (!res.ok) {
    logHttp({ ...meta, error: trimBody(text, 600) });
    throw new Error(openAiHttpError(res.status, text, model));
  }
  logHttp({ ...meta, detail: model });
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('OpenAI 응답을 읽지 못했습니다.'); }
  const item = json?.data?.[0];
  if (!item?.b64_json) throw new Error('OpenAI 가 그림을 돌려주지 않았습니다.');
  const ext = MIME_EXT[`image/${json.output_format || 'png'}`] || 'png';
  return { buffer: Buffer.from(item.b64_json, 'base64'), ext };
}

/** OpenAI 모델 목록에서 이미지 모델만 추립니다. 채팅 엔진의 목록은 이미지 모델을 걸러 내서 따로 부릅니다. */
export async function listOpenAiImageModels(config) {
  const res = await fetch(`${trimSlash(config.baseUrl)}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
  if (!res.ok) throw new Error(openAiHttpError(res.status, await res.text().catch(() => ''), ''));
  const json = await res.json();
  return (json.data || []).map((m) => m.id).filter((id) => /^(gpt-image|chatgpt-image|dall-e)/i.test(id || '')).sort();
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

/** ComfyUI 에 연결하지 못했을 때 보여 줄 흔한 샘플러·스케줄러. 실제 목록은 연결 확인 때 받아 옵니다. */
export const COMMON_SAMPLERS = [
  'euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast', 'dpm_adaptive',
  'dpmpp_2s_ancestral', 'dpmpp_sde', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_3m_sde', 'ddim', 'uni_pc', 'lcm'
];
export const COMMON_SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'];

/** KSampler 가 받는 샘플러·스케줄러 목록. 못 받으면 빈 배열입니다. */
export async function listSamplers(baseUrl) {
  const res = await comfyFetch(baseUrl, '/object_info/KSampler');
  if (!res.ok) return { samplers: [], schedulers: [] };
  const json = await res.json().catch(() => null);
  const req = json?.KSampler?.input?.required || {};
  const pick = (spec) => {
    const list = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options;
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  };
  return { samplers: pick(req.sampler_name), schedulers: pick(req.scheduler) };
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
