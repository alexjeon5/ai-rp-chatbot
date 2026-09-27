/**
 * 화면 동작 기록용 서버. 앱 서버(고정된 난수·시각)와 가짜 엔진을 띄우고, 기록 스크립트를 내려주고 결과를 받습니다.
 *
 *   node test/golden/ui-server.mjs <앱 폴더> <앱 포트> <결과 폴더>
 *
 * 브라우저에서 앱을 연 뒤 (localStorage 를 비우고 새로고침한 다음) 아래를 실행합니다.
 *   const m = await import('http://127.0.0.1:5189/ui-scenario.mjs'); await m.run('이름');
 * 결과는 <결과 폴더>/ui-<이름>.json 에 저장됩니다.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockServices } from '../support/mock-services.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [appDir, appPort = '5187', outDir = here] = process.argv.slice(2);
const MOCK = 'http://127.0.0.1:5181';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await startMockServices(5181);
const dataDir = await mkdtemp(path.join(tmpdir(), 'rp-ui-'));
const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(here, '../support/deterministic.mjs')).href, 'server.js'], {
  cwd: path.resolve(appDir),
  env: { ...process.env, DATA_DIR: dataDir, AUTH_DISABLED: '1', HOST: '127.0.0.1', PORT: appPort, OPENAI_API_KEY: '', LOCAL_ENGINE_HOSTS: '' },
  stdio: 'inherit'
});
process.on('exit', () => child.kill());
process.on('SIGINT', () => process.exit(0));

const base = `http://127.0.0.1:${appPort}`;
for (let i = 0; i < 100; i++) {
  try { await fetch(`${base}/api/me`); break; } catch { await sleep(100); }
}
const api = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
await api('PUT', '/api/settings', {
  providers: { lmstudio: { baseUrl: `${MOCK}/v1`, model: 'mock-7b', contextTokens: 4096 } },
  image: { enabled: true, baseUrl: `${MOCK}/comfy`, checkpoint: 'a.safetensors' }
});
await api('POST', '/api/personas', { name: '도윤', description: '대학생', gender: '남성', traits: ['커피'] });

/* 기록 스크립트와 결과 받기 (다른 출처라 CORS 를 엽니다) */
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  if (req.url === '/ui-scenario.mjs') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    return res.end(await readFile(path.join(here, 'ui-scenario.mjs')));
  }
  // 가려진 창에서는 페이지 타이머가 크게 늦춰지므로, 기다리기는 이 요청으로 합니다.
  const wait = /^\/sleep\/(\d+)$/.exec(req.url);
  if (wait) return setTimeout(() => res.end('ok'), Number(wait[1]));
  const m = /^\/result\/([\w-]+)$/.exec(req.url);
  if (m && req.method === 'POST') {
    // 한글이 조각 경계에서 잘리지 않게 바이트를 모았다가 한 번에 씁니다.
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', async () => {
      await writeFile(path.join(outDir, `ui-${m[1]}.json`), Buffer.concat(parts));
      res.end('ok');
      console.log(`기록했습니다: ui-${m[1]}.json`);
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(5189, '127.0.0.1');
console.log(`준비됐습니다: ${base}`);
