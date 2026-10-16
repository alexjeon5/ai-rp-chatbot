/**
 * 화면 파일(public/) 보내기.
 *
 * 화면 파일은 /v/<판>/... 주소로 보내고 브라우저가 1년 동안 묻지 않고 씁니다. <판> 은 public/ 전체 내용의 지문이라
 * 파일이 하나라도 바뀌면 주소가 바뀝니다 — 업데이트 뒤에 옛 파일과 새 파일이 섞이지 않습니다.
 * 그 주소를 아는 것은 첫 화면(index.html)·로그인 화면뿐이라 이 둘은 늘 서버에 새로 묻습니다.
 * 모듈끼리는 './api.js' 처럼 상대 주소로 부르므로 app.js 하나만 /v/<판>/ 으로 부르면 나머지도 따라옵니다.
 *
 * 첫 화면에는 모든 모듈의 modulepreload 를 넣습니다. 없으면 브라우저가 app.js 를 읽고서야 다음 모듈을 알게 되어
 * 가져오기 단계마다 한 번씩 서버를 오갑니다.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const LONG_CACHE = 'public, max-age=31536000, immutable';
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/login.html': 'login.html' };

const listFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const file = path.join(dir, d.name);
  return d.isDirectory() ? listFiles(file) : [file];
});

/**
 * 지금 public/ 의 판과 고쳐 쓴 페이지들. 파일의 크기·수정 시각이 바뀌었을 때만 다시 계산합니다
 * (node --watch 는 public/ 이 바뀌어도 서버를 다시 켜지 않으므로, 부팅 때 한 번만 계산하면 옛 판이 남습니다).
 */
function shellOf(publicDir) {
  let cached = null;
  return () => {
    const files = listFiles(publicDir).sort();
    const sig = files.map((f) => {
      const s = statSync(f);
      return `${f}:${s.size}:${s.mtimeMs}`;
    }).join('|');
    if (cached?.sig === sig) return cached;

    const hash = createHash('sha256');
    for (const f of files) hash.update(path.relative(publicDir, f)).update(readFileSync(f));
    const version = hash.digest('hex').slice(0, 12);
    const base = `/v/${version}`;
    const modules = files
      .filter((f) => f.endsWith('.js') && path.relative(publicDir, f).startsWith(`js${path.sep}`))
      .map((f) => `<link rel="modulepreload" href="${base}/${path.relative(publicDir, f).split(path.sep).join('/')}">`);
    const pages = {};
    for (const name of new Set(Object.values(PAGES))) {
      let html = readFileSync(path.join(publicDir, name), 'utf8')
        .replace('href="/styles.css"', `href="${base}/styles.css"`)
        .replace('src="/js/app.js"', `src="${base}/js/app.js"`);
      if (html.includes(`src="${base}/js/app.js"`)) html = html.replace('</head>', `${modules.join('\n')}\n</head>`);
      pages[name] = html;
    }
    cached = { sig, version, pages };
    return cached;
  };
}

/** @param {string} publicDir */
export function staticFiles(publicDir) {
  const shell = shellOf(publicDir);
  const router = express.Router();
  const plain = express.static(publicDir);
  // 지금 판이면 오래 캐시합니다. 업데이트 전에 연 화면이 옛 판 주소로 부르면 지금 파일을 주되 캐시하지 않습니다.
  const versioned = express.static(publicDir, { cacheControl: false, setHeaders: (res) => res.setHeader('Cache-Control', LONG_CACHE) });
  const stale = express.static(publicDir, { cacheControl: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') });

  router.get(Object.keys(PAGES), (req, res) => {
    res.set('Cache-Control', 'no-cache').type('html').send(shell().pages[PAGES[req.path]]);
  });
  router.use('/v/:version', (req, res, next) => (req.params.version === shell().version ? versioned : stale)(req, res, next));
  router.use(plain);
  return router;
}
