import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flushAll } from './src/db.js';
import { store } from './src/store.js';
import { createAuth } from './src/auth.js';
import { createApp } from './src/http/app.js';

const PORT = process.env.PORT || 5173;
const HOST = process.env.HOST || '127.0.0.1';

await store.load();
const auth = await createAuth({ host: HOST });
const app = createApp({ store, auth, publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public') });

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
