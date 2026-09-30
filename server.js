import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flushAll } from './src/db.js';
import { store } from './src/store.js';
import { createAuth } from './src/auth.js';
import { createApp } from './src/http/app.js';
import { createServices } from './src/services/index.js';

const PORT = process.env.PORT || 5173;
const HOST = process.env.HOST || '127.0.0.1';

await store.load();
const auth = await createAuth({ host: HOST });
const services = createServices({ store, auth });
// 옛 데이터의 주인을 정하고, 서버가 꺼져 있던 동안 쌓인 계정 명령(claim 등)을 처리합니다. 그 뒤로는 몇 초마다 봅니다.
await services.admin.start();
const app = createApp({ store, auth, services, publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public') });

// 종료 신호를 받으면 큐에 남은 쓰기를 끝내고 나갑니다.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await flushAll().catch(console.error);
    process.exit(0);
  });
}

app.listen(PORT, HOST, () => {
  console.log(`AI 롤플레이 & 어시스턴트: http://${HOST}:${PORT}`);
});
