/**
 * 서비스 조립. 웹(src/http/app.js)과 디스코드 봇이 같은 묶음을 씁니다.
 * 서비스는 req 를 모르고 actor({ id, name, role })를 받습니다.
 */
import path from 'node:path';
import { RateLimiter, userKey } from '../security.js';
import { readUsers } from '../auth.js';
import { AdminRequests } from '../admin-requests.js';
import { Access } from './access.js';
import { Engines } from './engines.js';
import { ChatContext } from './chat-context.js';
import { Jobs } from './jobs.js';
import { ImageFiles } from './image-files.js';
import { Attachments } from './attachments.js';
import { LoreBooks } from './lorebooks.js';
import { UsageLedger } from './usage-ledger.js';
import { CharacterCards } from './character-cards.js';
import { CharacterArt } from './character-art.js';
import { Backgrounds } from './backgrounds.js';
import { Chats } from './chats.js';
import { Replies } from './replies.js';
import { Library } from './library.js';
import { UserPrefs } from './prefs.js';
import { Settings } from './settings.js';
import { Ownership } from './ownership.js';
import { AccountSetup } from './account-setup.js';
import { AdminWorker } from './admin.js';

/**
 * @param {{ store: import('../store.js').Store, auth?: { disabled?: boolean }, users?: () => object[] }} o
 *   users 는 계정 목록을 읽는 함수. 기본은 data/users.json
 */
export function createServices({ store, auth = {}, users = readUsers }) {
  const byUser = (req) => userKey(req.user);
  // 밖으로 요청을 내보내는 일의 몫. limits.generate.hit(userKey(actor)) 로 HTTP 밖(디스코드)에서도 같은 몫을 셉니다.
  const limits = {
    generate: new RateLimiter({ windowMs: 60_000, max: 30, message: '요청이 너무 잦습니다. 잠시 뒤에 다시 시도해 주세요.', keyOf: byUser }),
    models: new RateLimiter({ windowMs: 60_000, max: 20, message: '모델 목록 요청이 너무 잦습니다. 잠시 뒤에 다시 시도해 주세요.', keyOf: byUser })
  };

  const access = new Access(store);
  const usage = new UsageLedger(store.usageDoc);
  const engines = new Engines(store, usage);
  const prefs = new UserPrefs(store);
  const settings = new Settings({ store, prefs, engines });
  const lore = new LoreBooks(store, access, settings);
  const art = new CharacterArt(store, path.join(store.dir, 'portraits'), access);
  const backgrounds = new Backgrounds(store, path.join(store.dir, 'backgrounds', 'img'), access);
  const context = new ChatContext({ store, access, settings, engines, lore, backgrounds });
  const jobs = new Jobs();
  const images = new ImageFiles(path.join(store.dir, 'images'));
  const attachments = new Attachments(path.join(store.dir, 'uploads'));
  const library = new Library({ store, access, art });
  const ownership = new Ownership({
    store, prefs, users, usage, authDisabled: Boolean(auth.disabled),
    files: { images, attachments, art, backgrounds }
  });

  return {
    store, access, prefs, settings, engines, limits, lore, usage, art, backgrounds, context, jobs, images, attachments,
    library, ownership,
    cards: new CharacterCards(store, art, access),
    chats: new Chats({ store, access, settings, context, jobs, images, attachments }),
    replies: new Replies({ store, access, settings, engines, context, jobs, attachments, usage }),
    setup: new AccountSetup({ store, access, prefs, library, ownership }),
    admin: new AdminWorker({ requests: new AdminRequests(path.join(store.dir, 'admin')), ownership })
  };
}
