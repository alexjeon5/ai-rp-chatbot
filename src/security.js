/**
 * 외부에 노출된 환경에서 쓰기 위한 방어 장치들.
 *
 * 로그인은 src/auth.js 가 맡습니다. 앞단(Cloudflare Access, Nginx Proxy Manager)의 인증은
 * 밖에서 들어올 때 한 겹 더 두는 것이고, 이 파일은 로그인을 통과한 요청에도 걸리는 제한들입니다.
 */

/* ---------------- 주소 판별 ---------------- */

/**
 * 호스트명을 꺼냅니다. 파싱에 실패하면 null.
 *
 * 문자열 앞부분만 비교하면 안 됩니다.
 * 'http://localhost.evil.com/v1' 은 'http://localhost' 로 시작하지만 남의 서버입니다.
 */
export function hostOf(url = '') {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/** 사설망·루프백 주소인지. 호스트명 전체가 일치해야 합니다. */
export function isLocalHost(host) {
  if (!host) return false;
  if (host === 'localhost' || host === 'host.docker.internal' || host === '::1') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/** 사설망·localhost 주소인지. 로컬 엔진은 API 키를 요구하지 않습니다. */
export const isLocalUrl = (url = '') => isLocalHost(hostOf(url));

/* ---------------- baseUrl 허용 목록 ---------------- */

/**
 * 서버가 대신 요청을 보내 주는 구조라, baseUrl 을 자유롭게 바꿀 수 있으면
 * 이 서버가 그대로 내부망 스캐너가 됩니다. (SSRF)
 * 그래서 미리 정해 둔 주소로만 나갈 수 있게 막습니다.
 */

/** 공식 API 엔드포인트. 여기는 언제나 허용합니다. */
const PUBLIC_HOSTS = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'ollama.com'
]);

/** 클라우드 메타데이터 주소. 어떤 설정으로도 열어 주지 않습니다. */
const ALWAYS_DENY = /^(169\.254\.|fd00:|fe80:)/i;

const fromEnv = (name) =>
  (process.env[name] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * LM Studio 가 도는 PC 주소처럼, 직접 허용해 준 로컬 호스트.
 * compose 의 LOCAL_ENGINE_HOSTS 로 지정합니다. 예: "192.168.0.10"
 */
const allowedLocalHosts = () =>
  new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal', ...fromEnv('LOCAL_ENGINE_HOSTS')]);

/** OpenRouter 처럼 직접 추가한 외부 엔진. EXTRA_ENGINE_HOSTS 로 지정합니다. */
const allowedPublicHosts = () => new Set([...PUBLIC_HOSTS, ...fromEnv('EXTRA_ENGINE_HOSTS')]);

/**
 * 이 baseUrl 로 나가도 되는지 검사합니다.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkBaseUrl(url = '') {
  if (!url.trim()) return { ok: true }; // 비어 있으면 아직 설정 전입니다.

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: '주소 형식이 올바르지 않습니다.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'http 또는 https 주소만 쓸 수 있습니다.' };
  }

  const host = hostOf(url);
  if (ALWAYS_DENY.test(host)) {
    return { ok: false, reason: '허용되지 않는 주소입니다.' };
  }
  if (allowedPublicHosts().has(host)) return { ok: true };
  if (allowedLocalHosts().has(host)) return { ok: true };

  if (isLocalHost(host)) {
    return {
      ok: false,
      reason:
        `허용 목록에 없는 내부 주소입니다 (${host}).\n` +
        'docker-compose.yml 의 LOCAL_ENGINE_HOSTS 에 이 주소를 추가한 뒤 컨테이너를 다시 올려 주세요.'
    };
  }
  return {
    ok: false,
    reason:
      `허용 목록에 없는 주소입니다 (${host}).\n` +
      'docker-compose.yml 의 EXTRA_ENGINE_HOSTS 에 추가한 뒤 컨테이너를 다시 올려 주세요.'
  };
}

/* ---------------- API 키 ---------------- */

/** 환경변수로 키를 넣으면 settings.json 에 평문으로 남지 않습니다. */
const ENV_KEYS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  ollama: 'OLLAMA_API_KEY'
};

/** 환경변수가 있으면 그쪽이 우선입니다. */
export function resolveApiKey(providerKey, cfg = {}) {
  const fromEnvVar = ENV_KEYS[providerKey] ? process.env[ENV_KEYS[providerKey]] : '';
  return (fromEnvVar || '').trim() || cfg.apiKey || '';
}

export const keyComesFromEnv = (providerKey) =>
  Boolean(ENV_KEYS[providerKey] && (process.env[ENV_KEYS[providerKey]] || '').trim());

/**
 * 밖으로 내보낼 설정에서 키를 지웁니다.
 * 키가 들어 있는지 여부만 알려 주면 화면을 그리는 데 충분합니다.
 */
export function maskProviders(providers = {}) {
  const out = {};
  for (const [key, cfg] of Object.entries(providers)) {
    const { apiKey, ...rest } = cfg;
    out[key] = {
      ...rest,
      apiKey: '',
      hasApiKey: Boolean(resolveApiKey(key, cfg)),
      keyFromEnv: keyComesFromEnv(key)
    };
  }
  return out;
}

/* ---------------- 요청 제한 ---------------- */

/**
 * 창 단위로 세는 간단한 제한기. 의존성을 늘리지 않으려고 직접 만들었습니다.
 * 1인용 앱이라 이 정도로 충분합니다.
 */
export function rateLimit({ windowMs, max, message, keyOf }) {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    // 기본은 접속 IP. 로그인한 뒤의 요청은 사용자 기준으로 세는 게 정확합니다 (keyOf).
    const key = (keyOf && keyOf(req)) || req.ip || 'unknown';
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);

    if (list.length >= max) {
      hits.set(key, list);
      return res.status(429).json({ error: message });
    }
    list.push(now);
    hits.set(key, list);

    // 오래된 기록은 가끔 치웁니다. 항목이 무한정 쌓이지 않게.
    if (hits.size > 500) {
      for (const [k, v] of hits) {
        if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      }
    }
    next();
  };
}

/* ---------------- 같은 출처에서 온 요청인지 ---------------- */

/**
 * 앞단에 쿠키 기반 인증(Cloudflare Access 등)을 두면, 다른 사이트가 브라우저를 시켜
 * 이 앱에 요청을 보내게 할 수 있습니다. 쿠키는 자동으로 따라붙습니다. (CSRF)
 * 상태를 바꾸는 요청은 같은 출처에서 왔는지 확인합니다.
 */
export function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();

  const origin = req.get('origin');
  if (!origin) return next(); // 브라우저가 아닌 요청(curl 등). 로그인 쿠키가 없으니 requireAuth 에서 걸립니다.

  const host = hostOf(origin);
  const expected = (req.get('x-forwarded-host') || req.get('host') || '').split(':')[0].toLowerCase();
  if (host && expected && host === expected) return next();

  return res.status(403).json({ error: '다른 사이트에서 보낸 요청은 처리하지 않습니다.' });
}
