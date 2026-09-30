/** Express 앱 조립: 공통 미들웨어, 로그인, 정적 파일, 기능별 라우트. */
import express from 'express';
import { rateLimit, sameOrigin } from '../security.js';
import { createServices } from '../services/index.js';
import { SettingsRoutes } from './routes/settings.js';
import { LibraryRoutes } from './routes/library.js';
import { ChatRoutes } from './routes/chats.js';
import { GenerationRoutes } from './routes/generation.js';
import { ImageRoutes } from './routes/images.js';
import { AttachmentRoutes } from './routes/attachments.js';
import { LorebookRoutes } from './routes/lorebooks.js';
import { CharacterCardRoutes } from './routes/character-cards.js';
import { CharacterArtRoutes } from './routes/character-art.js';
import { BackgroundRoutes } from './routes/backgrounds.js';
import { SearchRoutes } from './routes/search.js';
import { UsageRoutes } from './routes/usage.js';
import { BackupRoutes } from './routes/backup.js';

/**
 * 리버스 프록시(Nginx Proxy Manager) 뒤에 있으면 켭니다. 켜야 요청 제한이 실제 접속자 기준으로 걸립니다.
 * 환경변수는 늘 문자열이라 "1" 을 그대로 넘기면 Express 는 홉 수가 아니라 주소 "1" 로 읽고 아무도 믿지 않습니다.
 * 숫자만 있으면 숫자로 바꿔 넘깁니다. 주소(예: "192.168.0.20")는 그대로 둡니다.
 */
function trustProxy(app) {
  const value = (process.env.TRUST_PROXY || '').trim();
  if (value) app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value);
}

/**
 * @param {{ store, auth, publicDir: string, services?: ReturnType<typeof createServices> }} o
 *   services 를 주지 않으면 여기서 만듭니다. 서버는 부팅 때 만든 묶음(마이그레이션을 마친 것)을 넘깁니다.
 */
export function createApp({ store, auth, publicDir, services = createServices({ store, auth }) }) {
  const app = express();
  trustProxy(app);

  // 백업 불러오기는 대화가 쌓이면 수십 MB 가 되므로 그 경로만 한도를 넉넉히 둡니다.
  // 캐릭터 카드는 PNG 를 base64 로 받으므로 그 경로도 2MB 보다 넉넉히 둡니다.
  const jsonBody = express.json({ limit: '2mb' });
  const bodyByPath = { '/api/import': express.json({ limit: '64mb' }), '/api/characters/import': express.json({ limit: '16mb' }) };
  app.use((req, res, next) => (bodyByPath[req.path] || jsonBody)(req, res, next));

  // 쿠키를 보고 req.user 를 채웁니다. 로그인하지 않았으면 첫 화면 대신 로그인 페이지로 보냅니다.
  app.use(auth.attachUser);
  app.use(auth.pageGate);
  app.use('/api', sameOrigin);

  // 로그인 시도는 IP 기준으로 셉니다. IP 를 속이는 경우는 auth.js 의 전체 실패 상한이 막습니다.
  const loginLimit = rateLimit({ windowMs: 15 * 60_000, max: 10, message: '로그인 시도가 너무 잦습니다. 15분 뒤에 다시 시도해 주세요.' });
  app.post('/api/login', loginLimit, (req, res) => auth.login(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: '로그인을 처리하지 못했습니다.' });
  }));
  app.post('/api/logout', auth.logout);

  // 여기부터 /api 는 전부 로그인해야 쓸 수 있습니다. 위 두 경로만 예외입니다.
  app.use('/api', auth.requireAuth);
  // 처음 들어온 계정에 기본 페르소나와 내장 캐릭터를 넣습니다. 계정마다 한 번만 일합니다.
  app.use('/api', (req, res, next) => {
    services.setup.ensure(req.user);
    next();
  });
  app.get('/api/me', auth.me);
  app.use(express.static(publicDir));

  // 밖으로 요청을 내보내는 경로만 제한합니다 (services.limits). 로그인한 뒤라 사용자 기준으로 셉니다 — 헤더를 속여 IP 를 바꿔도 못 피합니다.
  const deps = { ...services, auth };
  for (const Routes of [SettingsRoutes, LibraryRoutes, CharacterCardRoutes, CharacterArtRoutes, BackgroundRoutes, LorebookRoutes, ChatRoutes, GenerationRoutes, ImageRoutes, AttachmentRoutes, SearchRoutes, UsageRoutes, BackupRoutes]) {
    new Routes(deps).mount(app);
  }
  return app;
}
