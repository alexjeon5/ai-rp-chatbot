/**
 * 서버 동작 기록기. 서버를 띄워 정해진 시나리오로 API 를 부르고, 모든 응답과
 * 엔진·ComfyUI 로 나간 요청, 마지막 저장 파일을 한 JSON 으로 남깁니다.
 *
 *   node test/golden/run.mjs [앱 폴더] [결과 파일]
 *
 * 리팩터링 전후 폴더로 각각 돌려 결과 파일이 같으면 서버 동작이 같은 것입니다.
 * 난수·시각은 test/support/deterministic.mjs 가 고정하고, 남는 차이(id, 시각)는 normalize 가 지웁니다.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockServices } from '../support/mock-services.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(process.argv[2] || path.join(here, '../..'));
const outFile = process.argv[3] || path.join(appDir, 'golden-out.json');
// 시나리오 파일. 요청 제한(1분 30회) 때문에 생성을 많이 부르는 묶음은 따로 둡니다.
const { scenario } = await import(`./${process.argv[4] || 'scenario.mjs'}`);
const APP_PORT = Number(process.env.GOLDEN_APP_PORT || 5185);
const MOCK_PORT = Number(process.env.GOLDEN_MOCK_PORT || 5181);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startMockServices(MOCK_PORT);
const dataDir = await mkdtemp(path.join(tmpdir(), 'rp-golden-'));
const logs = [];
const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(here, '../support/deterministic.mjs')).href, 'server.js'], {
  cwd: appDir,
  env: {
    ...process.env,
    DATA_DIR: dataDir, AUTH_DISABLED: '1', HOST: '127.0.0.1', PORT: String(APP_PORT),
    OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', OLLAMA_API_KEY: '', AI_GATEWAY_API_KEY: '',
    LOCAL_ENGINE_HOSTS: '', EXTRA_ENGINE_HOSTS: '', TRUST_PROXY: ''
  }
});
child.stdout.on('data', (d) => logs.push(...String(d).split('\n').filter(Boolean)));
child.stderr.on('data', (d) => logs.push(...String(d).split('\n').filter(Boolean).map((l) => `ERR ${l}`)));

const base = `http://127.0.0.1:${APP_PORT}`;
for (let i = 0; i < 100; i++) {
  try { await fetch(`${base}/api/me`); break; } catch { await sleep(100); }
}

const steps = [];
async function sent() {
  await sleep(150);
  return (await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`)).json();
}

/** API 한 번. SSE 면 이벤트 배열을, 아니면 JSON 을 남깁니다. */
async function call(name, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const type = res.headers.get('content-type') || '';
  let out;
  if (type.includes('text/event-stream')) {
    const text = await res.text();
    out = text.split('\n\n').filter(Boolean).map((block) => JSON.parse(block.replace(/^data: /, '')));
  } else if (type.includes('json')) {
    out = await res.json();
  } else {
    out = { bytes: (await res.arrayBuffer()).byteLength, type };
  }
  const extra = res.headers.get('content-disposition');
  steps.push({ name, status: res.status, ...(extra ? { disposition: extra } : {}), body: out, sent: await sent() });
  return out;
}

try {
  await scenario({ call });
} finally {
  await sleep(1200); // 쓰기 큐(250ms)를 비울 시간
  child.kill();
  mock.close();
}

/* 저장 파일 모으기 */
const files = {};
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(dataDir, full).replaceAll('\\', '/');
    if (entry.isDirectory()) await walk(full);
    else if (rel.endsWith('.json')) files[rel] = JSON.parse(await readFile(full, 'utf8'));
    else files[rel] = { bytes: (await stat(full)).size };
  }
}
await walk(dataDir);
await rm(dataDir, { recursive: true, force: true });

await writeFile(outFile, JSON.stringify(normalize({ steps, files, logs }), null, 2));
console.log(`기록했습니다: ${outFile} (단계 ${steps.length}개)`);

/**
 * 실행마다 달라지는 값을 지웁니다.
 *   - id 로 쓰이는 값은 처음 나온 순서대로 #1, #2 … 로 바꿉니다 (다른 곳에 나와도 같은 번호)
 *   - 시각(…At, at)과 걸린 시간은 지웁니다
 */
function normalize(root) {
  const ids = new Map();
  const idKey = /(^id$|Id$|^imgId$|^file$|^prompt_id$)/;
  const idList = /(Ids$)/;
  const collect = (v, key = '') => {
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string' && idList.test(key)) remember(x);
        else collect(x, key);
      }
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (typeof x === 'string' && idKey.test(k) && x) remember(x);
        collect(x, k);
      }
    }
  };
  // 생성된 id 만 바꿉니다. 'adult' 같은 모드 id 까지 바꾸면 본문 속 같은 낱말이 가려집니다.
  const remember = (s) => { if (!ids.has(s) && s.length >= 4 && /\d/.test(s)) ids.set(s, `#${ids.size + 1}`); };
  collect(root);
  // 파일 이름·주소 속 id 도 바꿔야 하므로 긴 것부터 치환합니다.
  const order = [...ids.keys()].sort((a, b) => b.length - a.length);
  const fixString = (s) => {
    for (const id of order) if (s.includes(id)) s = s.split(id).join(ids.get(id));
    return s
      .replace(/rp-chat-[0-9a-z]+/g, 'rp-chat-CLIENT')
      .replace(/\b\d+ms\b/g, 'Nms')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, 'DATE');
  };
  const fix = (v, key = '') => {
    if (typeof v === 'string') return fixString(v);
    if (typeof v === 'number' && (/At$|^at$|^durationMs$|^expiresAt$/.test(key) || v > 1e12)) return 'T';
    if (Array.isArray(v)) return v.map((x) => fix(x, key));
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[fixString(k)] = fix(v[k], k);
      return out;
    }
    return v;
  };
  return fix(root);
}
