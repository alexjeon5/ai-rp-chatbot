/*
 * 서비스 워커. 앱을 홈 화면에 설치할 수 있게 하고, 서버에 닿지 못할 때 화면 틀(HTML·CSS·JS)만 보여 줍니다.
 * 대화·설정은 전부 /api 뒤에 있고 여기서는 절대 저장하지 않습니다 — 로그아웃한 뒤에도 남으면 안 되는 데이터입니다.
 * 파일은 늘 네트워크를 먼저 봅니다. 업데이트 뒤에 새 app.js 와 옛 api.js 가 섞이는 일이 없습니다.
 */
const CACHE = 'rp-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** 우리 서버의 화면 파일인가. API·로그인·서비스 워커 자신은 뺍니다. */
function isShellRequest(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return false;
  return !url.pathname.startsWith('/api/') && url.pathname !== '/sw.js' && url.pathname !== '/login.html';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isShellRequest(request)) return;
  event.respondWith(
    fetch(request)
      .then((res) => {
        // 로그인 페이지로 돌려보낸 응답(redirected)이나 오류는 저장하지 않습니다.
        if (res.ok && !res.redirected && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        // 화면 이동인데 주소를 모르면 저장해 둔 첫 화면으로.
        if (request.mode === 'navigate') return (await caches.match('/')) || Response.error();
        return Response.error();
      })
  );
});
