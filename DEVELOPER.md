# AI 롤플레이 & 어시스턴트 — 개발자 문서

이 문서는 **소스 코드를 고치거나 새 기능을 붙이려는 사람**을 위한 것입니다.
설치하고 쓰기만 할 거라면 `GUIDE.md`를 보세요. 여기서는 화면 뒤에서 무엇이 어떻게 도는지,
그리고 그걸 고치려면 어느 파일을 열어야 하는지를 다룹니다.

---

## 1. 프로젝트 구조

```
server.js                 부팅만 합니다 — 저장소·로그인·서비스를 만들고, 옛 데이터의 주인을 정한 뒤 createApp 으로 서버를 띄움
src/
  http/
    app.js                 createApp — 미들웨어 순서, 로그인, 계정 준비, 라우트 클래스 등록
    helpers.js             wrap(AppError → 상태 코드) / fail / abortOnClose / sendImage, SSE 를 보내는 EventStream·lazyStream
    routes/                기능별 라우트 클래스 — settings, library(캐릭터·페르소나), chats,
                           generation(생성·대신 쓰기·선택지·기억 — 일은 Replies), lorebooks, character-cards, images, backup 등.
                           req.user 를 actor 로 서비스에 넘기는 얇은 층입니다
  services/                HTTP 를 모르고 actor({ id, name, role })를 받습니다. 디스코드 봇도 같은 것을 씁니다
    index.js               createServices — 서비스 조립. 웹과 봇이 같은 묶음을 씀
    access.js              Access — 누가 어떤 항목을 볼 수 있는지 정하는 한 곳 (2절 '계정별로 나누기')
    errors.js              AppError, NotFound — 서비스가 던지고 라우트가 상태 코드로 바꾸는 오류
    chats.js               Chats — 대화·메시지 다루기 (목록·만들기·고치기·분기·지우기·멈추기)
    replies.js             Replies — 모델에게 글 쓰게 하기 (답변·대신 쓰기·선택지·요약·자동 기억). 조각은 emit 으로
    discord-links.js       DiscordLinks — 디스코드 계정과 앱 계정 잇기 (1회용 코드, 연결 검사)
    public-art.js          PublicArt — 캐릭터 프로필·표정 그림의 서명된 공개 주소(/pub/art, 디스코드 아바타용)
    library.js             Library, Shelf — 캐릭터·페르소나 목록, 내장 캐릭터 추가
    prefs.js               UserPrefs — 계정별 설정(data/prefs/<id>.json), 모드 틀 다듬기
    settings.js            Settings — 공용 설정과 계정별 설정을 합쳐 보여 주고 나눠 저장
    account-setup.js       AccountSetup — 처음 들어온 계정에 기본 페르소나·내장 캐릭터·내장 페르소나 넣기
    ownership.js           Ownership — 옛 데이터의 주인 정하기, claim(옮기기), purge(지우기)
    admin.js               AdminWorker — 계정 명령이 남긴 요청을 서버에서 처리
    engines.js             Engines — 지금 엔진 설정, 성인 허용 판정, 실패 설명, 한 번에 받는 완성
    chat-context.js        ChatContext — 대화 한 개의 캐릭터·페르소나·틀·컨텍스트 예산 (대화 주인 기준)
    character-cards.js     CharacterCards — 카드 가져오기(캐릭터+묶인 로어북 만들기)·내보내기
    character-art.js       CharacterArt — 프로필·표정 그림
    backgrounds.js         Backgrounds — 비주얼 노벨 배경 그림
    lorebooks.js           LoreBooks — 로어북 목록, 대화에 적용되는 책 고르기, 발동 항목, 책 삭제 시 떼어내기
    jobs.js                Jobs — 대화별 진행 중 작업(중복 생성 막기, 멈추기)
    image-files.js         ImageFiles — 그린 그림 파일 저장·삭제
    usage-ledger.js        UsageLedger — 계정·날짜별 토큰 사용량 기록(data/usage.json)과 호출 하나를 지켜보는 계량기
    attachments.js         Attachments — 사용자가 붙인 그림 저장(파일 머리로 종류 확인)·검증·모델용 base64 변환
    records.js             입력값 정리 — SAFE_ID, characterFields, normalizePersona
    backup.js              Backup — 내 데이터 내려받기·불러오기(합치기)
  admin-requests.js        AdminRequests — 계정 명령과 서버 사이의 요청 파일 (data/admin/)
  discord/                 디스코드 봇 — 서비스(createServices)를 웹과 같이 씀. DISCORD_TOKEN 이 있을 때만 켜짐
    bot.js                 startDiscord — Client 만들기, 명령 올리기, 이벤트를 DiscordController 로
    controller.js          DiscordController — 명령·자동완성·버튼·스레드 메시지를 서비스로 잇기
    commands.js            슬래시 명령 정의(/rp start·roll·end·link·unlink, /ask, /assistant on·off·new — API JSON 그대로)
    relay.js               ReplyRelay — 답변 조각을 모아 메시지 편집으로 옮기기(간격, 길면 다음 메시지로)
    split.js               splitMessage — 2000자 한도에 맞춰 문단·줄·문장 순으로 나누기
    bindings.js            ThreadBindings — 스레드 ↔ 대화, ChannelBindings — 어시스턴트 채널의 사람별 대화.
                           둘 다 같은 모양의 대화 자리(slot)를 내주고, 가장 최근 답변 { messageIds, chatMessageId, via } 를 기억
    webhooks.js            Webhooks — 채널마다 봇이 만든 웹훅 하나(캐릭터 이름·그림으로 말하기), webhookName
  content/                 내장 콘텐츠 — templates(대화 모드 틀), characters, personas
  db.js                    파일 저장 기반 클래스 — JsonDoc, Collection
  store.js                 Store 클래스, 공용 설정 기본값
  character-card.js        캐릭터 카드 V1·V2·V3 ↔ 캐릭터·로어북 변환 (parseCard, buildCard)
  png-card.js              PNG 의 tEXt/iTXt 조각에서 카드 JSON 꺼내기 (CardError)
  lorebook.js              로어북 순수 규칙 — 값 정리(cleanEntry·cleanLorebook), 발동 판정(LoreScanner), renderLore
  prompt.js                시스템 프롬프트 조립 (조사 교정은 public/js/shared/korean.js 를 가져다 씀)
  providers.js             엔진 클래스 — Engine 을 잇는 OpenAI/LM Studio/Ollama/Vercel/Anthropic/Gemini
  sanitize.js              사고 블록 제거, 반복 출력 감지
  persona-seeds.js         랜덤 페르소나 씨앗 표 (POOLS, CONFLICTS) 와 굴리기
  persona-gen.js           씨앗 → 소개 문단 프롬프트, 후처리, 모델 없이 쓰는 대체 문장
  character-gen.js         줄글 → 캐릭터 시트 프롬프트, 라벨 파서
  auth.js                  로그인 — 비밀번호 해시, 세션, requireAuth / requireOwner, AUTH_DISABLED(_AS)
  security.js              SSRF 허용 목록, 키 마스킹, 요청 제한(RateLimiter), 같은 출처 확인
scripts/
  user.js                  계정 만들기·지우기·비밀번호 바꾸기, 데이터 옮기기(claim)·지우기(purge), 로그인 잠시 끄기·실패 제한 풀기 (npm run user)
public/
  login.html               로그인 페이지. 앱 스크립트를 읽지 않는 독립 페이지
  index.html               전체 마크업 (사이드바, 대화창, 다이얼로그 다섯 개)
  styles.css               전체 스타일. CSS 변수로 테마 관리
  manifest.webmanifest     홈 화면 설치용 앱 정보 (이름, 아이콘, standalone)
  sw.js                    서비스 워커 — 화면 파일만 네트워크 우선으로 캐시, /api 는 건드리지 않음
  icons/                   앱 아이콘 (icon.svg 원본, 192·512, maskable, apple-touch-icon)
  js/
    app.js                 진입점 — App 이 상태와 기능 객체를 만들어 잇고 첫 화면을 띄움
    api.js                 서버 호출 얇은 래퍼 + SSE 파서
    ui.js                  DOM 렌더링 — 목록, 메시지, 알림
    ui/format.js           표기법·마크다운 렌더러 (formatText, setMarkup)
    select.js              네이티브 select 를 테마에 맞는 드롭다운으로 감싸는 모듈
    shared/korean.js       {{char}}/{{user}} 치환과 조사 교정 — 서버와 브라우저가 함께 씀
    core/                  dom($, esc, storage, setHidden), state(AppState), menu(메뉴 키보드)
    features/              기능별 클래스 — 아래 8절 참고
test/
  support/                 결정적 실행(난수·시각 고정), 가짜 엔진·ComfyUI 서버
  golden/                  동작 기록 테스트 — 9절 참고
mock-lmstudio.mjs           로컬 통합 테스트용 가짜 OpenAI 호환 서버
Dockerfile, docker-compose.yml
```

의존성은 `express` 와 디스코드 봇용 `discord.js` 뿐입니다. 프런트엔드는 빌드 스텝 없이 브라우저가 ES 모듈을 직접 읽습니다.

---

## 2. 데이터 계층

### `src/db.js`

두 클래스로 저장을 추상화합니다.

- **`JsonDoc`** — 파일 하나에 담기는 객체(`settings.json`). `load()`/`save()`만 있고,
  기본값을 바탕에 깔고 저장된 값을 덮는 `merge()`를 씁니다. 새 설정 항목이 생겨도
  기존 파일에 자동으로 채워집니다.
- **`Collection`** — 폴더 하나(`characters/`, `personas/`, `chats/`)를 다룹니다.
  파일 이름이 곧 `id`입니다. `all()` `get(id)` `add()` `update(id, patch)` `remove(id)`를 제공합니다.

쓰기는 **250ms 단위로 묶입니다.** `schedule()`이 같은 파일에 대한 여러 쓰기 요청을 하나로 합치고,
`writeJson()`은 임시 파일에 쓴 뒤 `rename`하는 원자적 교체를 씁니다 — 쓰는 도중 프로세스가 죽어도
파일이 반쯤 쓰인 상태로 남지 않습니다. `flushAll()`은 큐를 즉시 비우며, 서버 종료 신호
(`SIGINT`/`SIGTERM`, `server.js` 하단)에서 호출됩니다.

### `src/store.js` 의 `Store` 클래스

```js
class Store {
  settingsDoc   // JsonDoc — 공용 설정 (엔진·이미지·성인 모드 클라우드 허용·토큰 보정·새 계정 기본 엔진)
  characters    // Collection
  personas      // Collection
  lorebooks     // Collection
  chats         // Collection
  backgrounds   // Collection
  prefs         // Collection — 계정별 설정. 파일 이름이 계정 id
  usageDoc      // JsonDoc — 계정·날짜별 토큰 사용량
}
export const store = new Store();  // 싱글턴
```

`store.load()`가 부팅 시 하는 일, 순서대로:

1. **`migrateFromSingleFile()`** — 예전 `data/db.json` 하나짜리 저장 방식이 남아 있으면
   항목별 파일로 풀어놓고, 원본은 지우지 않고 `db.json.migrated`로 이름만 바꿉니다.
2. 저장소를 병렬로 `load()`.
3. **`normalizeSettings()`** — 새로 생긴 설정 키를 채우고, 기본 엔진이 지워졌으면 `lmstudio` 로 돌립니다.
   계정별로 나누기 전의 설정 파일이라 모드 틀(`presets`)이 아직 남아 있으면 `normalizePresets()` 로 다듬어 둡니다
   (계정별 설정도 불러올 때 같은 함수를 거칩니다 — 옛 이름 바꾸기 `RENAMED`, 없는 내장 틀 추가,
   **내장 틀을 일반→성인 순서로 재정렬**, 커스텀 틀은 그 뒤로).
4. `tagBuiltinCharacters()` — `builtin` 표시가 생기기 전에 들어온 내장 캐릭터를 이름으로 찾아 표시를
   붙입니다(`settings.builtinCharactersTagged` 로 한 번만). 옛 외형 태그 채우기(`fillBuiltinAppearance()`)도
   이때 같이 돕니다.
5. `syncBuiltinCharacters()` — 사람이 손대지 않은 내장 캐릭터를 코드의 최신 내용으로 맞춥니다.
   계정마다 받은 사본을 모두 봅니다.
6. `tagBuiltinPersonas()` — `감독` 페르소나에 `director` 표시를 한 번만 붙입니다.

기본 페르소나·내장 캐릭터·내장 페르소나를 넣는 일은 부팅이 아니라 **계정마다** 합니다
(`AccountSetup`, 아래 '계정별로 나누기'). 부팅 뒤 `server.js` 는 `createServices()` 로 서비스를 만들고
`services.admin.start()` 로 옛 데이터의 주인을 정한 다음 서버를 띄웁니다.

### 내장 콘텐츠

- `BUILTIN_TEMPLATES()` — 여섯 개 프롬프트 틀. **배열 순서가 곧 기본 노출 순서**입니다.
  일반 셋(`default`, `novelist`, `narrator`) 다음에 성인 셋(`adult`, `adult-novel`, `adult-narrator`)이
  옵니다. 순서를 바꾸려면 이 배열만 고치면 되고, `normalizeSettings()`의 재정렬 로직이
  기존 설치에도 소급 적용합니다.
- `BUILTIN_CHARACTERS` — 내장 캐릭터 배열. 저장된 캐릭터에는 두 필드가 붙습니다.
  - `builtin` — 어느 내장 캐릭터인지(배열의 `name`). 화면의 **기본** 탭은 이 필드로 나뉘고,
    `addMissingBuiltins()`도 이 필드로 중복을 판단하므로 사용자가 이름을 바꿔도 다시 추가되지 않습니다.
    **배포한 내장 캐릭터의 `name` 은 열쇠이므로 바꾸지 마세요.**
  - `builtinSig` — 마지막으로 받은 내장 내용의 지문(`characterSig()`, `CHARACTER_FIELDS` 의 sha1).
    지금 내용의 지문이 이것과 같으면 손대지 않은 것이라 `syncBuiltinCharacters()`가 새 내용으로 바꾸고,
    다르면 사람이 고친 것이라 그대로 둡니다. 즉 배열의 다른 칸을 고치면 기존 설치에도 반영됩니다.
  - 두 필드는 API 로 쓸 수 없습니다(`CHARACTER_FIELDS` 밖). 복제·대화에서 저장한 캐릭터는 늘 내 캐릭터이고,
    백업 불러오기는 같은 내장 캐릭터가 아직 없을 때만 표시를 살립니다.
- `BUILTIN_PERSONAS` — 내장 페르소나 배열(감독과 몇 사람).
  `AccountSetup.addMissingBuiltinPersonas()`가 넣은 이름을 그 계정의 설정(`prefs.seededPersonas`)에 적어 두므로,
  사용자가 지운 내장 페르소나는 다음 실행 때 되살아나지 않습니다.
  `감독`에는 `director: true` 가 붙어, 대신 쓰기(`impersonatePrompt({ director })`)가 대사 대신 행동 지시를 쓰고
  `cleanImpersonation` 이 끼어든 따옴표 대사를 걷어냅니다. 이 표시가 생기기 전에 들어온 `감독`은
  `tagBuiltinPersonas()`가 이름으로 찾아 한 번만 붙이고(`settings.builtinPersonasTagged`), 그 뒤로는 이름을 바꿔도 남습니다.
  API 로는 바꿀 수 없고(`PERSONA_FIELDS` 밖) 백업에는 따라갑니다.

### 계정별로 나누기

캐릭터·페르소나·로어북·배경·대화는 **계정마다 따로**입니다. 폴더를 나누지 않고 항목마다 `ownerId`(계정 id)를
적어 두고, 읽을 때 거릅니다. `Collection` 이 어차피 전부 메모리에 있어서 거르기가 싸고, id 는 파일 이름이라
모든 계정이 한 공간을 씁니다(그림 폴더 `images/<chatId>` 도 그대로).

- **`Access`(`src/services/access.js`)가 유일한 검사 지점입니다.** 라우트와 서비스는 `store.chats.get(id)` 처럼
  저장소에서 직접 읽지 않고 `access.chat(actor, id)`(없으면 `NotFound`), `access.findChat(actor, id)`(없으면 null),
  `access.chats(actor)` 를 씁니다. 캐릭터·페르소나·로어북·배경도 같은 모양입니다. 쓰기(`add`·`update`·`save`·`remove`)만
  저장소를 직접 부릅니다. `test/unit/access.test.mjs` 가 라우트·서비스 소스에서 직접 읽기를 찾아 막습니다.
  예외는 `access.js`, 계정 id 로만 찾는 `prefs.js`, 그리고 백업 불러오기의 **id 충돌 검사**(`collection.has`)입니다 —
  id 공간은 전역이라 남의 항목과도 겹치면 안 됩니다.
- **남의 항목은 없는 것과 같습니다.** 같은 404, 같은 안내 문구입니다. 주인(owner) 역할도 남의 항목은 못 봅니다.
  역할은 공용 설정을 바꿀 수 있는지만 가릅니다.
- **`ownerId` 를 쓰는 곳은 `access.stamp(actor, item)` 하나입니다.** API 로 받은 값은 어디서도 `ownerId` 로 옮기지 않습니다
  (필드를 골라 담으므로). 백업에 적힌 `ownerId` 도 무시하고 불러온 사람의 것이 됩니다.
- **대화에 딸린 것은 대화 주인 기준입니다.** `ChatContext` 는 캐릭터·페르소나·캐스트·배경 이름·모드 틀·파라미터를
  `access.ownerOf(chat)` 으로 찾습니다. 그래서 누가 부르든(웹, 디스코드) 같은 대화는 같은 프롬프트가 되고,
  남의 전역 로어북이나 배경 이름이 섞이지 않습니다. 대화에 남의 캐릭터·로어북 id 를 적어도(`castIds`·`lorebookIds`)
  걸러집니다.
- **대화에 딸린 파일**(`images/<chatId>/`, `uploads/<chatId>/`)은 그 대화를 볼 수 있어야 보냅니다. 프로필·배경 그림도
  그 캐릭터·배경을 볼 수 있어야 합니다. 네 경로 모두 `helpers.sendImage` 를 거치고 `Cache-Control: private` 로 나가서
  앞단(Cloudflare 등)의 공용 캐시에 남지 않습니다.
- **서비스는 `req` 대신 `actor` 를 받습니다.** `Chats`·`Library`·`LoreBooks`·`Backgrounds`·`CharacterArt`·`CharacterCards`·
  `Backup`·`Settings` 의 메서드는 첫 인자가 actor 이고, 문제가 있으면 `AppError`(404 는 `NotFound`)를 던집니다.
  라우트의 `wrap()` 이 상태 코드로 바꿉니다. 요청 제한도 `limits.generate.hit(userKey(actor))` 로 HTTP 밖에서 셀 수 있습니다.

**설정.** 공용 설정은 `settings.json`, 계정별 설정은 `data/prefs/<계정 id>.json` 입니다(`UserPrefs`).
계정별 값이 없으면 코드 기본값(`defaultPrefs()`)을 씁니다. `Settings.view(actor)` 가 둘을 합친 모양을,
`Settings.update(actor, body)` 가 나눠 저장합니다. 화면은 예전처럼 설정 하나(`GET/PUT /api/settings`)만 봅니다.

| 계정별 (`prefs`) | 공용 (`settings.json`) |
|---|---|
| `activeProvider`(고르기만 — 없거나 지워졌으면 `defaultProvider`) | `providers`(주소·키·모델·감춘 모델) — 주인만 |
| `activePersonaId`, `activePresetId`, `presets` | `image` — 주인만 |
| `askModeOnNewChat`, `historyLimit`, `params`, `assistant` | `dev.adultCloud` — 주인만 |
| `memory`, `lorebook`(스캔 설정) | `defaultProvider`(새 계정 기본 엔진) — 주인만 |
| `dev.particleFix`, `dev.markup`, `dev.theme` | `tokenRatio`(엔진별 토큰 보정) — 서버가 씀 |
| 부기: `onboarded`, `seededPersonas` (화면으로 안 보냄) | 부기: `builtinCharactersTagged`, `builtinPersonasTagged` |

멤버가 보낸 주인 전용 항목은 거절하지 않고 조용히 뺍니다(설정 창은 모든 탭을 한 번에 보내므로).

**계정 준비.** 로그인한 요청마다 `AccountSetup.ensure(actor)` 가 돌지만 계정마다 한 번만 일합니다.
처음 들어온 계정(`prefs.onboarded` 가 없음)에 기본 페르소나 '나'와 내장 캐릭터 사본을 넣고, 넣은 적 없는 내장
페르소나를 추가합니다. 내장 콘텐츠를 공용 읽기 전용으로 두지 않고 계정마다 사본을 주는 이유는, 내장 캐릭터도
고치고 그림을 달고 로어북에 묶고 지우는 보통 캐릭터라서입니다. 손대지 않은 사본은 `syncBuiltinCharacters()` 가
계정과 상관없이 새 내용으로 맞춥니다.

**옛 데이터의 주인 정하기(`Ownership`).** 계정별로 나누기 전의 항목에는 `ownerId` 가 없고, 설정 파일에는 계정별 값이
섞여 있습니다. 부팅 때(그리고 계정 목록이 바뀔 때) `AdminWorker` 가 `Ownership.adoptUnowned()` 를 부릅니다.

- 주인 계정이 **딱 하나**면 그 계정이 받습니다. 계정이 하나도 없고 `AUTH_DISABLED` 면 `local` 이 받습니다.
- 그 밖(주인이 여럿)이면 그대로 두고 로그에 `npm run user -- claim <아이디>` 를 안내합니다. 그동안 그 항목은
  아무에게도 보이지 않고, 주인 계정은 계정 준비를 미룹니다(나중에 claim 으로 받았을 때 내장 캐릭터가 두 벌이 되지 않게).
- 받을 때 옛 설정의 계정별 값은 받는 계정의 prefs 로 옮기고 공용 설정 파일에서 지웁니다. 원본은
  `settings.json.pre-accounts` 로 한 번 남깁니다. 옛 엔진 선택은 `defaultProvider` 가 됩니다. `userId` 가 없는
  사용량 줄도 함께 옮깁니다.
- `claim(to)` 는 주인 없는 항목과 **고아 항목**(ownerId 가 지금 계정 목록에 없는 것 — 지운 계정, `local`)을,
  `claim(to, { from })` 은 그 계정의 항목만 옮깁니다. `purge(ownerId)` 는 항목과 딸린 그림 파일, 계정별 설정을 지웁니다.
  사용량 줄은 요금 기록이라 지우지 않습니다.

**계정 명령과 서버.** 서버는 데이터를 전부 메모리에 올려 두고 씁니다. 명령(`scripts/user.js`)이 `chats/*.json` 을 직접
고치면 서버가 다음 저장 때 옛 내용으로 덮어씁니다. 그래서 데이터를 바꾸는 명령은 `data/admin/requests/<id>.json` 에
요청만 남기고(`AdminRequests`), 서버의 `AdminWorker` 가 2초마다 보고 처리한 뒤 `data/admin/results/<id>.json` 에
결과를 남깁니다. 명령은 몇 초 기다려 결과를 보여 주고, 서버가 꺼져 있으면 다음 부팅 때 처리됩니다.
요청 하나가 파일 하나라 명령과 서버가 같은 파일을 동시에 쓰지 않습니다.

**로그인을 끈 개발 모드.** `AUTH_DISABLED=1` 이면 모든 요청이 `local` 계정(주인 역할)입니다. `local` 은 계정 목록에 없는
따로 된 계정이라, 나중에 로그인을 켜면 `claim` 으로 옮길 수 있습니다. `AUTH_DISABLED_AS=<아이디>` 를 주면 그 계정으로
행동합니다 — 운영 데이터 사본을 내 PC 에서 로그인 없이 열어 볼 때 씁니다.

**로그인 잠시 끄기(`auth off`).** 배포한 서버에서 꺼 두면 로그인하지 않은 요청은 `local` 이 아니라 **주인 계정**
(여럿이면 `users.json` 의 첫 주인)으로 들어옵니다(`bypassUser`). 막힌 주인이 자기 데이터로 들어가려고 쓰는 길이라서입니다.

### 저장 파일 레이아웃

```
data/
  settings.json          # 공용 설정 (엔진·이미지·클라우드 허용·토큰 보정·새 계정 기본 엔진)
  settings.json.pre-accounts  # 계정별로 나누기 전의 설정 원본. 옮길 때 한 번 남김
  prefs/<userId>.json    # 계정별 설정 (모드 틀·파라미터·테마 등). 파일 이름이 계정 id
  users.json             # 계정 목록 (scripts/user.js 만 씀)
  sessions.json          # 로그인 상태 (서버만 씀)
  characters/<id>.json   # 항목마다 ownerId
  personas/<id>.json
  lorebooks/<id>.json    # 세계관 설정집(항목 배열 포함)
  chats/<id>.json        # 메시지 배열을 포함
  backgrounds/           # 비주얼 노벨 배경. 목록 index 와 img/ 폴더. 백업에는 들어가지 않음
  usage.json             # 날짜별 토큰 사용량 { days: { 'YYYY-MM-DD': [{ userId, provider, model, requests, promptTokens, completionTokens, estimated }] } }
  images/<chatId>/       # 장면 그리기로 그린 그림 (대화 권한을 따름)
  uploads/<chatId>/      # 사용자가 메시지에 붙인 그림 (대화 권한을 따름)
  portraits/<characterId>/  # 프로필 그림(portrait.*)과 표정 그림. 백업에는 들어가지 않음
  discord.json           # 디스코드 연결 { links: { 디스코드 id: { userId, epoch, name, linkedAt } }, codes: { sha256(코드): { userId, expiresAt } }, threads, channels(guests·hostUserId·users), artSecret }
  admin/requests/, admin/results/  # 계정 명령 ↔ 서버 요청 파일
```

`chats/<id>.json`에는 `character` 필드가 통째로 박혀 있는 경우가 있습니다 — **1회성 캐릭터**입니다
(`characterId: null` 대신 `character: {...}`). `ChatContext.characterOf(chat)`(`src/services/chat-context.js`)가
`chat.character || store.characters.get(chat.characterId)` 순서로 우선순위를 정합니다.

---

## 3. 프롬프트 조립 — `src/prompt.js`

### `buildSystem({ character, persona, template, particleFix })`

캐릭터/페르소나 필드를 틀의 자리표시자에 채웁니다. 규칙:

- 비어 있는 필드는 **라벨이 붙은 줄째로** 지웁니다(`{{description}}`이 비면 그 줄 자체가 사라짐).
- `{{char}}`가 틀에 한 번도 없으면, 배역 블록을 틀 맨 뒤에 자동으로 붙입니다
  (사용자가 자리표시자를 모르는 프롬프트를 그대로 붙여 넣어도 동작하게 하기 위함).
- `exampleDialogue`, `notes`는 `# 대화 예시`, `# 추가 설정` 제목을 붙여 맨 뒤에 이어 붙입니다.
- `lore`(이미 완성된 글)가 있으면 `# 추가 설정` 다음, 기억해 둔 사실 앞에 그대로 붙입니다. 아래 로어북 절 참고.

### 로어북 — `src/lorebook.js`, `src/services/lorebooks.js`

키워드가 최근 대화에 나올 때만 프롬프트에 끼우는 설정 조각 모음입니다. 역할을 나눠 두었습니다.

- **`cleanEntry` / `cleanLorebook` / `cleanLoreSettings`** (`src/lorebook.js`) — 들어온 값 정리. `cleanLorebook` 은 들어온 칸만
  돌려줘서 PUT 에 일부만 보내도 됩니다. 항목은 내용이 비면 버리고, 300개·키 20개·내용 4000자 등 `LORE_LIMITS` 로 자릅니다.
- **`LoreScanner`** — 발동 판정. 보이는(`hidden` 아닌) 메시지 중 마지막 `scanDepth` 개를 이어 붙인 글에서 키워드를 찾고
  (`constant` 는 늘 발동, `secondaryKeys` 가 있으면 그중 하나도 나와야 함, `caseSensitive` 아니면 소문자 비교),
  `priority` 높은 순으로 `tokenBudget` 안에 드는 것만 남깁니다. 상한을 넘는 항목은 건너뛰고 더 작은 것을 계속 살핍니다.
- **`renderLore(selected)`** — `# 세계관 설정` 제목 아래 `### 제목\n내용` 을 이은 글. 없으면 빈 글.
- **`LoreBooks`** (`src/services/lorebooks.js`) — 저장소와 잇는 층. `appliedTo(chat)` 가 적용할 책을
  `global` → 캐릭터에 묶인 책(`characterIds`) → 대화에 직접 붙인 책(`chat.lorebookIds`) 순으로 모으고(한 책은 한 번만,
  **그 대화 주인의 책만** — 남의 전역 책은 붙지 않습니다),
  `block(chat, messages)` 가 프롬프트에 붙일 글을 만듭니다. `ChatContext.roleplay(chat, { basis })` 가 이걸 부르며,
  다시 쓰기일 때는 마지막 답변을 뺀 `basis.messages` 로 검사해 그 답변이 만든 발동을 되풀이하지 않습니다.
  어시스턴트 대화에는 적용하지 않습니다.
- 설정은 계정별 `prefs.lorebook = { scanDepth: 4, tokenBudget: 1200 }` (범위 1–20, 100–8000). 대화에서는 대화 주인의 값을 씁니다.
  책을 묶는 `characterIds` 는 내 캐릭터만 받습니다. 책을 지우면 `detach` 가 책 주인의 대화들의 `lorebookIds` 에서도 뺍니다. 대화 분기는 `lorebookIds` 를 복사하고, 백업은 `lorebooks` 를 함께 내보내고
  불러옵니다(`characterIds`·`lorebookIds` 는 id 매핑으로 다시 이음).

### 캐릭터 카드 — `src/character-card.js`, `src/png-card.js`

- `pngCard.cardFromPng(buf)` — PNG 조각을 훑어 tEXt/iTXt 의 `ccv3` → `chara` 순으로 base64 JSON 을 꺼냅니다. 압축 조각은 건너뜁니다. 그림은 쓰지 않고 CRC 도 검사하지 않습니다. 사용자에게 보여도 되는 오류는 `CardError` 입니다(라우트가 400 으로 돌려줌).
- `parseCard(raw)` — V1(납작한 JSON)·V2·V3(`spec`+`data`)을 읽어 `{ character, book, dropped }`. 카드의 긴 `description` 은
  `personality` 칸으로, `system_prompt`·`post_history_instructions` 는 `notes` 로 옮기고 `<USER>`/`<BOT>`/`<START>` 를 다듬습니다.
  `extensions.rpchat.character` 가 있으면(이 앱에서 낸 카드) 그 칸을 그대로 써서 손실 없이 되살립니다.
- `buildCard(character, books)` — V2 카드. 이 앱의 칸은 표준 칸에 풀어 담고(`description` 에 성격·말투·외형·추가 설정을 이어 붙이고 한 줄 소개는 `creator_notes`),
  원래 칸은 `extensions.rpchat` 에 둡니다. `bookToCard`/`bookFromCard` 가 로어북 항목과 `character_book` 을 오갑니다(우선순위는 `priority`).
- `CharacterCards`(서비스)가 저장소와 잇습니다. 가져올 때 세계관이 있으면 `characterIds: [새 캐릭터]` 로 묶인 로어북을 만들고,
  내보낼 때는 `characterIds` 에 그 캐릭터가 든 로어북을 모읍니다. PNG 로 내보내기는 없습니다(카드는 JSON 만).
  PNG 를 가져올 때는 `CharacterCards` 가 그림을 프로필로 저장합니다(`CharacterArt.setPortrait`). 그림 파일 저장·삭제는 `src/services/image-files.js` 를 공유합니다

프런트는 `features/lorebooks.js`(설정집 창) · `lore-entry.js`(항목 편집기) · `chat-lore.js`(대화에 붙이기 창)로 나뉩니다.

### 한국어 조사 교정 — `public/js/shared/korean.js`

`substitute(text, token, value)`가 `{{char}}`/`{{user}}` 뒤에 붙은 조사를 받침에 맞춥니다.

- `PARTICLE_PAIRS`: [받침 있을 때, 없을 때] 열 쌍(은/는, 이/가, 을/를 … 이나/나).
- `hasBatchim(word)`: 한글이면 유니코드 오프셋으로 받침 유무를 계산. 영문이면 끝 글자가
  모음인지로 어림.
- 조사 뒤에 한글이 더 이어지면(`{{char}}로서` 처럼) 조사로 보지 않고 건드리지 않습니다 —
  정규식에 `(?![가-힣])`를 넣어 처리합니다. **이 때문에 프롬프트에 `{{char}}로서` 처럼 쓰면
  조사가 안 붙어서 "유하린로서"로 어색하게 나옵니다.** 내장 틀은 전부 `{{char}}가 되어` 식으로
  피해 갑니다.

### 서버와 브라우저가 같은 파일을 씁니다

조사 교정은 `public/js/shared/korean.js` 한 곳에만 있습니다. 브라우저는 `src/` 를 못 읽으므로
공개 폴더에 두고, 서버의 `prompt.js` 가 상대 경로로 가져다 씁니다(`fillVars`). 브라우저 쪽은
`ui.fillNames` 가 같은 `fillTokens` 를 부릅니다. 이 파일에는 DOM 이나 Node 전용 API 를 쓰지 마세요.

### `withThinking(system, on)`

Gemma 계열은 시스템 프롬프트 맨 앞의 `<|think|>` 토큰이 있을 때만 사고 모드로 들어갑니다.
로컬 엔진에서 어시스턴트 모드의 "생각" 토글을 처리하는 유일한 방법입니다.

---

## 4. 엔진 어댑터 — `src/providers.js`

### 엔진 클래스

엔진마다 `Engine` 을 이어받은 클래스가 하나씩 있고, `async *chat(opts)` 로 텍스트 조각을 `yield` 하고
`models()` 로 모델 목록을 돌려줍니다. 공통 부분(`post`, 400 을 읽고 고쳐 다시 보내는 `sendFixing`,
감춘 모델 거르기 `keep`)은 `Engine` 에 있습니다. `streamChat({ provider, ...opts })` 와 `listModels()` 는
`engineFor()` 로 클래스를 고르는데, 내장 엔진은 `BUILTIN`, 커스텀 엔진은 `config.type`
(`openai`/`anthropic`/`gemini`)으로 `BY_TYPE` 에서 찾습니다.

OpenAI 호환 서버(Ollama, Vercel, vLLM, llama.cpp)는 `OpenAiEngine` 을 이어받아 다른 점만 덮어씁니다
(`LmStudioEngine` 은 `repeat_penalty`·`top_k` 를 더 붙이고, `OllamaEngine`·`VercelEngine` 은 목록 조회만 다름).

### 엔진별 함정 — 전부 실제로 겪고 고친 것들입니다

| 엔진 | 함정 | 대응 |
|---|---|---|
| OpenAI | `max_tokens` 폐기, `max_completion_tokens`로 대체 | `isOpenAiHost()`로 본사 주소 판별 → 그 경우만 `max_completion_tokens` 사용 |
| OpenAI | o3·gpt-5 등 추론 모델은 `temperature`/`top_p` 거부 | `looksLikeReasoningModel()`로 1차 판단, 400 응답 문구를 읽고 `quirksFromError()`로 재시도 |
| OpenAI | 웹 검색은 `gpt-5-search-api` 같은 **전용 검색 모델만** 지원 | `supportsWebSearch()`가 모델명에 `search` 포함 여부까지 확인 |
| OpenAI | 모델 목록에 임베딩·tts·dall-e 등이 섞여 옴 | `notChat` 정규식으로 필터링 |
| Anthropic | `temperature` 상한이 **0~1** (다른 엔진은 2) | `clamp(params.temperature, 0, 1)` |
| Anthropic | 확장 사고는 세대별로 `{type:'enabled'}` 또는 `{type:'adaptive', display:'summarized'}` | `THINKING_MODES` 사다리, 400 시 다음 방식으로 재시도 |
| Anthropic | 사고 예산(`budget_tokens`)이 `max_tokens`를 잡아먹어 답변이 잘릴 수 있음 | 사고 켜면 `max_tokens`를 예산+2048 이상으로 올림 |
| Anthropic | 모델 목록 페이지네이션 (`has_more`/`last_id`) | 최대 5쪽까지 따라가며 수집 |
| Gemini | `thinkingConfig`는 반드시 `generationConfig` **안에** 있어야 함 (바깥에 두면 조용히 무시) | 항상 올바른 위치에 삽입 |
| Gemini | 모델 계열별로 `thinkingBudget` 또는 `thinkingLevel`만 받음, Gemma는 둘 다 거부 | `geminiThinkingModes(model, on)` 사다리, 400 시 재시도 |
| Gemini | `thinkingLevel: 'high'`는 첫 토큰까지 매우 오래 걸림 | 켤 때는 `includeThoughts`만 켜고 깊이는 지정하지 않음 |
| Gemini | 계정에 따라 같은 모델이 404 (`no longer available to new users`) | `readsAsModelGone()`이 감지 → `config.unavailableModels`에 기록해 목록에서 숨김 |
| Gemini | 모델 목록 페이지네이션 (`pageToken`) | 최대 5쪽까지 수집, `supportedGenerationMethods`가 없어도 통과(문서 예제 기준) |
| Gemini | `google_search` 도구는 Gemma 모델에서 거부됨 | 지원 여부는 `supportsWebSearch()`가 판단, 실패 시 `geminiError()`가 원인을 풀어서 안내 |
| LM Studio 등 로컬 | `repeat_penalty`, `top_k`를 안 보내면 반복 루프가 잘 남 | `LmStudioEngine` 이 항상 포함 (OpenAI 본사에는 안 보냄) |
| 공통 | 성인 틀은 기본적으로 로컬 엔진에서만 허용 | `adultAllowed()` = `isLocalUrl()` 또는 `settings.dev.adultCloud` (서버: `src/services/engines.js`, 클라이언트: `public/js/core/state.js`에 각각 구현 — 판정 규칙이 동일해야 함) |

### `isOpenAiHost()` 버그 이력

한때 `/(^|\.)api\.openai\.com/`로 문자열째 검사했는데, 실제 URL은 `https://api.openai.com/...`라
`^`도 `\.`도 안 맞아 **항상 거짓**을 반환했습니다. 이 탓에 `max_completion_tokens` 전환과
웹 검색 모델 판별이 조용히 죽어 있었습니다. 지금은 `new URL(baseUrl).hostname`으로 호스트만
떼어 비교합니다. **문자열 매칭으로 호스트를 판별하지 마세요** — 프로토콜, 서브도메인,
꼬리 문자열에 다 낚입니다.

### 웹 검색 출처 수집

세 엔진이 출처를 완전히 다른 모양으로 줍니다. `addSource(sources, url, title)`로 한곳에 모으고
중복 URL은 걸러냅니다.

- Gemini: 마지막 청크의 `groundingMetadata.groundingChunks[].web`
- Anthropic: 본문 중간에 끼어드는 `content_block_start` 타입 `web_search_tool_result`
- OpenAI: `delta.annotations[].url_citation`

출처는 본문에 이어 붙이지 않고 `Replies.reply` 가 `emit({ sources })` 로 별도 조각(웹에서는 SSE 이벤트)으로 보내며,
저장 시에도 `msg.sources`에 따로 담습니다 — 다음 턴 프롬프트에 섞여 들어가지 않게 하기 위함입니다.

---

## 5. 생성 파이프라인 — `src/services/replies.js` 의 `Replies.reply`

일은 `Replies` 서비스가 하고, `src/http/routes/generation.js` 는 `req.user` 와 본문을 넘기는 얇은 층입니다.
디스코드 봇도 같은 메서드를 부릅니다. 규칙:

- **시작 전에 막히면 던집니다.** 없는 대화·남의 대화(`NotFound`), 이어 쓸 답변 없음, 엔진 문제, 성인 틀 거부는 `AppError` 이고
  이때는 조각을 하나도 보내지 않았습니다. 웹은 `wrap` 이 JSON 오류로 바꿉니다.
- **시작한 뒤에는 던지지 않습니다.** 조각은 `emit(event)` 로 넘기고, 엔진 오류도 `{ error }` 조각입니다. 반환값은 저장한 메시지(없으면 `null`)입니다.
  웹 라우트는 `lazyStream(res)` 로 첫 조각을 보낼 때 SSE 를 열고, 끝에 `{ done, message }` 를 붙입니다.
- **멈추기.** `opts.signal` 이 끊기면(웹은 `abortOnClose(res).signal`) 멈춥니다. 답변 중이면 `jobs.running` 에 컨트롤러가 있어
  `Chats.stop` 으로도 멈추고, 그때까지 쓴 것은 저장됩니다. 요약·기억은 `jobs.backgroundFor(chatId, signal)` 로 돌고 새 답변이 오면 멈춰
  `{ skipped, reason }` 을 돌려줍니다.
- 대신 쓰기(`impersonate`)는 조각을 흘린 뒤 다듬은 초안을, 선택지(`choices`)는 `[{ text, check? }]` 를(멈췄으면 `null`) 돌려줍니다.

요청 하나가 처리되는 순서:

1. `assistant` 모드인지에 따라 시스템 프롬프트·파라미터·사고/검색 설정을 분기 (`s.assistant.*` vs 프리셋).
2. 성인 틀이면 `adultAllowed(config)` 확인 — 로컬 주소도 아니고 `dev.adultCloud` 도 꺼져 있으면 400.
   `dev.adultCloud` 는 설정 창 개발자 탭의 경고 창을 거쳐야 켜지고, 백업 불러오기로는 옮겨 오지 않습니다.
3. `makeThoughtStripper({ onThought })` 생성. 생각을 껐으면 `onThought`를 안 넘겨서 사고 조각이
   버려지게 합니다 (일부 엔진은 꺼도 사고를 보내므로 서버에서 한 번 더 막음).
4. `streamChat()`으로 어댑터 실행. 청크마다:
   - `stripper.feed(chunk)`로 사고 블록 제거
   - `looksRepetitive(text)`로 반복 감지 → 걸리면 `controller.abort()`
5. 스트림 종료 후 반복으로 중단됐으면 안내 문구를 본문에 덧붙임.
6. 출처가 있으면 별도 이벤트로 전송.
7. 완성된 메시지를 `chat.messages`에 추가하고 저장. `thought`, `sources`는 메시지에 별도 필드로.

### SSE 이벤트 모양

```
data: {"delta": "..."}      본문 조각
data: {"thought": "..."}    사고 조각 (생각 켰을 때만)
data: {"sources": [...]}    출처 (검색 켰을 때, 완성 후 한 번)
data: {"error": "..."}      오류
data: {"done": true, "message": {...}}   완료
```

---

### 장면 그리기 — `src/image.js`

- 흐름: `IMAGE_PROMPT_SYSTEM` 으로 LLM 에게 장면 → Danbooru 태그 → `parseSceneTags` → `composePrompt`(품질 태그 + 성인 강제 태그 + 외형 + 장면, 필터) → `fillWorkflow` → `renderImage`(`/prompt` → `/history` 1초 폴링 → `/view`) → `data/images/<chatId>/<file>` 저장 → `msg.images`
- 워크플로는 `settings.image.workflow`(API 형식 JSON) 또는 `DEFAULT_WORKFLOW`. 값 전체가 `"{{seed}}"` 면 원래 타입(숫자)으로, 글 안에 섞이면 글자로 채웁니다
- 필터: 사용자 설정(`image.adult.forceTags/blockTags/extraNegative`)은 성인 대화에만. `CORE_BLOCK_TERMS`·나이 표기·`CORE_NEGATIVE` 는 **모든 대화에** 고정 적용이며, 걸리면 지우지 않고 그리기를 거부합니다. 설정 API 로도 바꿀 수 없게 코드에만 둡니다
- 임시 완화: `GET/POST/DELETE /api/content-filter`. `auth.filterStatus(req)`가 실제 로그인 세션과 계정의 `adultVerifiedAt`·`adultVerificationEpoch`를 검사합니다. POST는 서버 시간 기준 30분이며 활성 중 재요청으로 연장하지 않습니다. CLI `adult <아이디> verify|revoke`로만 성인 확인을 기록·취소하고, 확인 버전 변경으로 기존 완화가 되살아나지 않게 합니다. 로그인 우회는 사용할 수 없습니다.
- `ImageRoutes.composeTags`는 LLM 호출 후 다시 권한·만료를 검사한 `relaxUserFilter`로 `blockTags`만 건너뜁니다. 고정 차단은 사용자 필터보다 먼저 검사하며, `forceTags`·네거티브는 계속 적용합니다. 프런트 상태는 `public/js/features/content-filter.js`가 표시하고 서버가 매 요청의 권한을 결정합니다.
- 그림 경로는 `SAFE_ID` + `IMAGE_FILE` 로 검사해 `data/images` 밖으로 못 나갑니다. 메시지·대화를 지우면 파일도 지웁니다. 메시지당 6장

### 프로필·표정·배경 — `src/services/character-art.js`, `src/services/backgrounds.js`

- `CharacterArt` 가 `data/portraits/<characterId>/` 를 맡습니다. 프로필 1장, 표정은 이름(`cleanLabel`)별로(최대 `ART_LIMITS`). 캐릭터 JSON 에는 파일 이름만 남기고(`portrait`, `expressions: [{label,file}]`) 프런트가 `/api/character-art/:id/:file` 로 부릅니다
- `Backgrounds` 는 앱 전체 배경 목록입니다(`/api/background-art/:id/:file`). 이름은 무대 표식의 장소 이름이 됩니다
- 파일 삭제는 `ImageFiles.remove()` 가 프라미스를 돌려주므로 서비스는 await 합니다(시험에서 지워졌는지 곧바로 볼 수 있음)
- 그림 본문은 `sniffImage` 로 PNG·JPEG·WebP 만 받고 파일명은 서버가 정합니다

### 화면 표식·주사위·선택지 — `public/js/shared/scene-tags.js`, `dice.js`, `src/scene-prompt.js`, `src/choices.js`

- 문법: `[[표정: …]]` `[[장소: …]]` `[[판정: 이름 d20 난이도 N]]`. 서버(저장·프롬프트)와 브라우저(스트리밍 중 화면)가 같은 `scene-tags.js` 를 씁니다.
  `extractDirectives` 가 본문에서 표식을 떼고, `stripForDisplay` 는 스트리밍 중 아직 닫히지 않은 `[[…` 까지 가립니다. `matchLabel`/`resolveScene` 이 표식을 올려 둔 이름에 맞춥니다
- 저장: 답변의 활성 장(swipe)마다 `msg.scene {expression?, place?}` 와 `msg.check {label, sides, dc}`. `chat-ops.js` 의 `VARIANT_KEYS` 에 들어 있어 넘겨보기를 따라 바뀝니다
- 대화 플래그 `chat.vn` `chat.dice` `chat.autoChoices`(`CHAT_FLAGS`, `PUT /api/chats/:id` 에 불리언). 분기하면 이어받습니다
- 프롬프트: `chat-context.js` 의 `roleplay` 가 `chat.vn || chat.dice` 일 때 `sceneBlock()` 을 붙입니다. 표정·장소 목록은 `vn` 일 때만 채웁니다. 과거 답변에는 `withSceneTags` 가 저장해 둔 표식(판정 포함)을 다시 붙여, 모델이 형식을 따라 하게 합니다
- 주사위: `dice.js` 의 `rollDice(spec, rng)`, `judge`, `formatRoll`, `formatCheck`. **브라우저가 굴리고** 결과 문장이 사용자 메시지로 서버에 갑니다(서버는 굴리지 않음). 난수는 `crypto.getRandomValues`(없으면 `Math.random`), 시험에서는 `rng` 를 바꿔 끼웁니다
- 선택지: `POST /api/chats/:id/choices` 가 `choicesPrompt()` 를 마지막 요청에 덧붙여 `engines.complete` 로 한 번 받고 `parseChoices()` 가 `[{ text, check? }]` 로 읽습니다. 저장하지 않으며 롤플레이 대화만 됩니다
- 프런트: `features/stage.js`(`Stage` 무대, 스트리밍 중 `live()`), `backgrounds.js`(배경 창), `character-art.js`(캐릭터 창의 그림 칸), `choices.js`(`Choices` 칩·주사위 팝오버·판정 버튼). 판정 결과는 `Composer.submit(content)` 로 입력창 초안을 건드리지 않고 보냅니다.
  `ChatView.syncScene()` 이 무대와 판정 버튼을 지금 대화 상태에 맞춥니다
- 장면 그리기의 참고 그림은 `src/image.js` 의 `useReference`(기본 꺼짐)입니다. Gemini 는 `inlineData` 부분, OpenAI 는 gpt-image 계열만 `/images/edits` 멀티파트. ComfyUI 는 없음

### 컨텍스트 예산 — `src/context.js`

- `estimateTokens` 는 토크나이저 없이 글자 종류로 어림합니다 (한글 음절 0.9, ASCII 0.3, 그 밖 0.8)
- `planContext` 가 한도(`provider.contextTokens`) − 시스템 − 뒤에 붙는 글(작가 노트 등) − 답변 여유(`maxTokens`) 안에서 최근 메시지부터 고릅니다. `historyLimit`(최대 메시지 수)는 그 위의 상한입니다. 마지막 메시지는 넘쳐도 보냅니다
- 서버의 `planFor(chat)` 가 생성·미리보기·게이지(`GET /api/chats/:id/context`)·요약 판단에 같은 계산을 씁니다
- 엔진이 실제 프롬프트 토큰 수를 알려 주면(`onUsage`: OpenAI 호환은 `stream_options.include_usage`, Anthropic `message_start`, Gemini `usageMetadata`) `nextRatio` 로 `settings.tokenRatio[엔진]` 을 갱신해 다음 어림에 곱합니다. `stream_options` 를 모르는 서버가 400 을 내면 빼고 다시 보냅니다

### 그림 입력(비전) — `src/services/attachments.js`

- 사용자 메시지의 `attachments: [{ id, file, mime, name, bytes }]`. 파일은 `data/uploads/<대화 id>/` 에 있고(`ImageFiles` 를 다른 뿌리로 재사용), 종류는 브라우저가 보낸 값이 아니라 파일 머리(`sniffImage`: PNG·JPEG·WebP)로 정합니다
- 올리기(`POST /api/chats/:id/attachments`, 본문이 그림 파일 그대로, 10MB)와 메시지 추가는 두 단계입니다. 메시지를 만들 때 `Attachments.resolve` 가 화면이 보낸 `{file, name}` 목록을 이 대화에 실제로 있는 파일과 맞춰 보고 최대 4개로 자릅니다.
  보내지 않고 뺀 그림은 화면이 `DELETE …/attachments/:file` 로 지웁니다(이미 메시지에 붙은 파일은 지우지 않음)
- `planContext` 는 `attachments` 가 있는 메시지를 남기고(글이 비어도), 한 장을 `IMAGE_TOKENS`(850)로 세며, 가장 최근 `MAX_SENT_IMAGES`(6)장만 히스토리에 `attachments` 로 실어 줍니다
- 히스토리의 `attachments` 는 보내기 직전에 `Attachments.inline` 이 `images: [{ mime, data(base64) }]` 로 바꿉니다(생성·대신 쓰기 경로). 저장된 메시지에는 base64 를 두지 않습니다
- 엔진 어댑터: `openAiTurns`(content 를 `text` + `image_url` 데이터 URL 조각 배열로) · `anthropicTurns`(`image`/`base64` 조각을 글 앞에) · `geminiTurns`(`inlineData`). `normalizeTurns` 는 같은 역할 턴을 합칠 때 그림도 함께 모읍니다.
  글도 그림도 없는 턴은 어느 엔진에서도 보내지 않습니다
- 브라우저(`features/attach.js`): 긴 변 1600px 초과·GIF·HEIC 등은 canvas 로 JPEG 로 줄여 올리고, 작은 PNG·JPEG·WebP 는 원본 그대로 올립니다. 메시지 속 그림은 `class="img-open"` 링크라 그림 크게 보기 창을 그대로 씁니다
- 지워지는 때: 메시지 삭제, 대화 삭제(폴더째). 분기하면 `branchFrom` 이 돌려주는 `attachmentFiles` 를 복사합니다. 백업(`cleanMessage`)은 `attachments` 를 옮기지 않습니다
- 로컬 모델이 비전을 못 하는지는 알 수 없어 막지 않습니다. 엔진 오류가 그대로 화면에 나옵니다

### 사용량 기록 — `src/usage.js`, `src/services/usage-ledger.js`

- 엔진은 `onUsage({ promptTokens, completionTokens })` 로 **누적값**을 여러 번 알려 줍니다(OpenAI 호환은 마지막 청크, Anthropic 은 `message_start` 의 입력 + `message_delta` 의 `output_tokens`, Gemini 는 청크마다 `usageMetadata`, 사고 토큰 포함). `UsageTally.note` 는 알려 준 값으로 덮어써서 마지막 값이 그 호출의 총량이 됩니다
- `UsageLedger.meter({ userId, ...request })` 가 `{ onUsage, record(text) }` 를 돌려줍니다. 호출이 끝나면(중단·오류 포함) `record` 를 한 번 부르고, 받은 것이 하나도 없으면 남기지 않습니다. 붙는 곳: 답변 생성, 대신 쓰기, `Engines.complete({ userId, ... })`(요약·기억·캐릭터/페르소나 만들기·장면 묘사). `userId` 는 부른 사람(대화에 딸린 호출은 대화 주인)입니다
- 엔진이 토큰 수를 알려 주지 않으면(일부 로컬 서버) 프롬프트는 `rawPromptTokens`, 출력은 `estimateTokens(text)` 로 어림하고 그 줄의 `estimated` 를 올립니다. 화면은 `≈` 로 표시
- 날짜는 서버 시간대의 `YYYY-MM-DD`, 같은 날 같은 계정·엔진·모델은 한 줄로 합칩니다. 90일이 지난 날짜는 기록할 때 지웁니다. 백업에는 담지 않습니다(`data/usage.json` 은 기기 로컬)
- 계정별로 나누기 전의 줄에는 `userId` 가 없습니다. 옛 데이터를 받는 계정이 함께 받습니다(`UsageLedger.reassign`). 계정을 지워도(`purge`) 줄은 요금 기록이라 남깁니다
- `GET /api/usage` 는 내 줄만 모은 `summarizeUsage` 결과(`periods`: 오늘·7일·30일 합계와 모델별 행, `daily`: 30일 날짜별)에 `scope`·`canSeeAll` 을 붙입니다. 주인은 `?scope=all` 로 모든 줄과 기간별 계정별 합계(`periods[].users: [{ userId, name, requests, ... }]`, 숫자만)를 봅니다

### 디스코드 계정 잇기 — `src/services/discord-links.js`

- 디스코드 봇은 **이어 둔 앱 계정(actor)으로만** 일합니다. 연결이 곧 권한이라 따로 허용 목록을 두지 않습니다
- 잇는 방향은 **웹 → 디스코드** 하나뿐입니다. 로그인한 화면에서 코드를 받고(`issueCode`) 디스코드 `/rp link` 에 넣습니다(`redeem`).
  반대 방향(봇이 준 링크를 웹에서 승인)은 남이 자기 디스코드용 링크를 보내 누르게 하면 그 디스코드가 내 계정에 붙으므로 쓰지 않습니다
- 코드는 헷갈리는 글자를 뺀 31자 중 8자리, 5분, 1회용이고, 저장은 sha256 해시만 합니다. 같은 계정이 새 코드를 받으면 앞의 코드는 무효입니다.
  맞춰 보기는 디스코드 사용자마다 10분에 5번(`RateLimiter.hit`)입니다
- 앱 계정 하나에 디스코드 하나입니다. 다시 이으면 앞의 연결은 끊깁니다
- `actorOf(discordId)` 는 쓸 때마다 계정이 있는지, `epoch` 가 이을 때와 같은지 봅니다. 비밀번호 변경·`logout-all` 이면 연결이 끊깁니다(세션과 같은 규칙)
- 로그인을 잠시 꺼 둔 동안(`req.authBypass`)은 코드를 내주지 않습니다. 그 틈에 남의 디스코드가 주인 계정에 영영 붙을 수 있어서입니다
- 로그인을 끈 개발 모드에서는 목록에 없는 `local` 도 이을 수 있습니다(`createServices` 의 `resolveUser`)

### 디스코드 봇 — `src/discord/`

- `server.js` 가 웹을 띄운 뒤 `startDiscord({ services })` 를 기다리지 않고 부릅니다. 토큰이 없으면 `null`, 접속이 실패해도 로그만 남기고 웹은 돕니다
- 봇은 웹과 **같은 서비스 인스턴스**를 씁니다. 그래서 `Jobs`(중복 생성 막기·멈추기), 요청 한도(`limits.generate.hit(userKey(actor))`), 저장소가 하나입니다
- **스레드 하나 = 대화 하나**(`ThreadBindings`, `data/discord.json` 의 `threads`). 스레드 주인(`discordUserId`)만 말하고 버튼을 누릅니다.
  권한은 두 번 봅니다 — 디스코드 쪽(스레드 주인), 앱 쪽(`Access`, 연결된 계정이 대화 주인). 이을 때와 연결된 앱 계정이 달라지면 멈춥니다
- 답변은 `Replies.reply` 의 `emit` 조각을 `ReplyRelay` 가 옮깁니다. **첫 조각이 온 뒤에야** 메시지를 건드리므로, 시작 전에 막히면(엔진 설정 등) 지금 답변이 그대로 남습니다.
  1.2초마다 한 번 고치고, 1900자를 넘으면 다음 메시지로 넘어갑니다. 다시 쓰기는 같은 메시지를 고쳐 쓰고 짧아지면 남는 메시지를 지우며, 이어 쓰기는 새 메시지로 덧붙입니다
- 화면 표식은 `stripForDisplay` 로 떼고(쓰는 중 아직 닫히지 않은 `[[…` 까지), 봇이 보내는 메시지는 `allowedMentions: { parse: [] }` 로 멘션을 모두 끕니다 — 모델이 쓴 `@everyone` 이 울리지 않게
- 버튼 id 는 `rp:<일>:<대화 id>[:<덧붙임>]`. 가장 최근 답변에 다는 것(`regen·cont·prev·next·choices·imp·check`)은 `binding.reply.messageIds` 에 든 메시지에서만 받습니다.
  나만 보는 메시지(선택지·초안)에 다는 것(`pick·send·edit·redraft`)은 받아 둔 목록(`controller.pending`, 메모리)이 **그 뒤로 대화가 움직이지 않았을 때만** 씁니다
- 버튼·명령으로 넣은 차례(선택지·초안·판정·`/rp roll`·`/ask` 질문)는 `postTurn` 이 내 페르소나 이름(어시스턴트는 디스코드 이름)으로 스레드에 보이고, 모두 `takeTurn` 을 거칩니다
- 주사위는 **서버가 굴립니다**(`dice.js` 의 `rollDice` 에 `crypto.randomInt`). 웹은 브라우저가 굴립니다
- **웹훅**: 롤플레이 답은 부모 채널의 봇 소유 웹훅(`withComponents: true` 라 버튼도 붙음)에 `threadId` 를 붙여 캐릭터 이름·프로필 주소로 보냅니다.
  웹훅 관리 권한이 없으면 봇 이름으로 보내고 10분 동안 다시 묻지 않습니다. 웹훅 메시지는 봇이 직접 고칠 수 없으므로 `reply.via` 로 보낸 쪽을 기억해 그쪽으로 고칩니다.
  어시스턴트 답은 늘 봇 이름으로 보냅니다
- **공개 그림**(`PublicArt`, `GET /pub/art/:id/:file?s=`): 디스코드는 우리 서버에 로그인할 수 없어 서명한 주소로 그림을 넘깁니다. `HMAC-SHA256(비밀, "art:<id>/<file>")` 16바이트,
  비밀은 `PUBLIC_ART_SECRET` 또는 `discord.json` 의 `artSecret`. 서명이 맞고 그 파일이 **지금** 그 캐릭터의 프로필·표정일 때만 보냅니다(`Cache-Control: public`).
  `PUBLIC_BASE_URL` 이 없으면 주소를 만들지 않고 아바타 없이 이름만 씁니다. 계정 없이 오는 요청이라 `access.test.mjs` 의 직접 읽기 금지에서 이 파일만 뺐습니다
- `/rp start` 는 첫 대사 앞에 봇 이름으로 캐릭터 소개 카드를 올립니다(`postIntro`: `description`·`tags`·대화 모드·페르소나·`scenario`, 이름 자리표시자는 채움, 프로필 그림 썸네일)
- **어시스턴트 채널**(`/assistant on`, 채널 관리 권한은 `interaction.memberPermissions` 로 봄): 그 채널(스레드 아님)의 메시지는 `onChannelMessage` 가 받습니다.
  `ChannelBindings`(`data/discord.json` 의 `channels`)가 채널 × 앱 계정마다 어시스턴트 대화 하나를 기억하고, 없거나 웹에서 지웠으면 새로 만듭니다(`/assistant new` 는 자리를 비움).
  답은 `mentionSink` 가 질문 메시지에 답장으로 보내며 첫 메시지 앞에 `<@질문한 사람>` 을 붙입니다 — 보낼 때만 알림이 가고, 고칠 때는 멘션을 지키되 다시 울리지 않습니다.
  알림 미리보기에 답의 첫머리가 보이도록 '…' 자리 없이(`ReplyRelay` 의 `placeholder: null`) 보일 글이 처음 생기는 순간 답장하고, 그때까지는 입력 중 표시를 8초마다 다시 켭니다.
  버튼은 누른 사람 자기 자리의 대화 id 와 맞아야 해서(`slotFor`) 남의 답에 달린 버튼은 막힙니다
- **게스트 모드**(`/assistant on guests:True`): 켠 사람의 앱 계정이 호스트(`channels[id].hostUserId`, `setBy` 는 호스트의 디스코드 id)입니다.
  `channelSeat` 가 누가 일하는지 정합니다 — 이어 둔 사람은 자기 계정, 아니면 게스트 자리(`users['guest:<디스코드 id>']`)에 호스트 actor.
  호스트의 디스코드 연결이 지금도 살아 있고 그 계정일 때만 게스트에게 답하므로, 호스트가 연결을 끊으면 멈춥니다.
  게스트 대화는 호스트 계정의 것이라 제목을 `게스트 · 이름` 으로 붙여 둡니다. 한도는 게스트 몫(`controller.guestLimit`, 한 명당 1분 5번)과 호스트 몫(`limits.generate`)을 둘 다 셉니다
- 컨트롤러는 스레드와 어시스턴트 채널을 **대화 자리(slot)** 하나로 다룹니다: `{ kind, key, discordUserId, chatId, reply, setReply, forget }`. 메시지를 보낼 곳(place)은 스레드 또는 채널입니다
- 비주얼 노벨을 켠 대화는 답의 `scene.expression` 표정 그림을 썸네일 카드로, 어시스턴트는 출처를 카드로 붙입니다(`embedsFor`)
- 어시스턴트 글은 화면 표식 거르기 없이 그대로 보이고, `splitMessage` 는 코드 블록(```) 한가운데서 나뉘면 닫고 같은 언어로 다시 엽니다(`balanceFences`)
- 성인 모드는 연령 제한 채널(스레드는 부모 채널)에서만 — `/rp start` 와 말할 때마다 봅니다. 엔진 쪽 허용(`adultAllowed`)은 `Replies` 가 그대로 봅니다
- 답변 뒤에는 웹처럼 자동 기억 → 자동 요약을 부릅니다(`afterReply`, 롤플레이만). 이 두 호출은 요청 한도에 세지 않습니다(답변 하나에 최대 두 번)
- 시험: `test/unit/discord-controller.test.mjs` 는 진짜 서비스에 가짜 디스코드 객체와 가짜 `replies` 를 끼워 흐름을 봅니다. `discord-relay.test.mjs` 는 나누기·중계

### 대화 검색 — `src/chat-search.js`, `src/http/routes/search.js`

- `searchChats(chats, query, { kind })` 는 순수 함수입니다. 검색어를 공백으로 나눠(최대 6개, 소문자·NFC) **모두 포함한** 메시지만 찾고, 대화는 최근 수정 순, 한 대화에서는 최근 메시지부터 3개까지(`moreInChat`), 전체 60개까지입니다(`truncated`)
- 본문이 걸린 대화는 제목 결과를 따로 내지 않습니다(첫 메시지로 제목을 붙이는 대화가 많아 같은 말이 두 번 나옴). 제목만 걸리면 `messageId: null`
- 라우트는 결과에 대화 제목·종류·캐릭터 이름·보관·성인 여부를 붙여서 돌려줍니다. 검색은 서버 메모리의 대화를 훑을 뿐 색인은 없습니다

### 대화 한 개의 규칙 — `src/chat-ops.js`

저장소와 무관한 순수 함수만 둡니다.

- **답변 넘겨보기** — `addSwipe` / `showSwipe` / `syncSwipe`. 메시지의 `content` 는 늘 보고 있는 장(`swipes[swipeIndex]`)과 같아서, 히스토리·미리보기 코드는 장을 몰라도 됩니다. 장은 최대 20개
- **이어쓰기** — `CONTINUE_PROMPT` 를 사용자 턴으로 덧붙여 보내고 `joinContinuation` 으로 이어 붙입니다. 문장이 끝난 자리에서만 띄웁니다
- **작가 노트** — `withAuthorNote` 가 보낼 히스토리 사본의 마지막 사용자 턴 끝에 붙입니다. 저장된 메시지는 건드리지 않습니다
- **기억 요약** — `pendingForSummary` 가 컨텍스트 예산 밖으로 밀려났고 `chat.summaryUntilAt` 이후인 메시지를 고릅니다. id 가 아니라 시각으로 기억하므로 메시지를 지워도 처음부터 다시 요약하지 않습니다. 결과는 `buildSystem({ memory })` 로 시스템 프롬프트 끝에 붙습니다
- **자동 기억** — `factsWindow` → `buildFactsPrompt` → `parseFactOps` → `applyFactOps`. 모델에게 목록 전체를 다시 쓰게 하지 않고 add/update/remove 만 받습니다. `auto: false`(직접)·`pinned` 항목은 모델이 못 바꿉니다. 항목은 `sourceIds` 로 근거 메시지를 기억하고, 메시지가 지워지거나 다른 장으로 넘어가면 `invalidateFacts` 가 치우고 `factsUntilAt` 을 되감아 다시 읽게 합니다. 요약·기억 확인은 `background` 맵에 등록되어 새 답변 요청이 오면 멈춥니다
- **여러 인물** — `chat.castIds` 의 캐릭터가 `buildSystem({ cast })` 로 들어갑니다. 모델 호출은 한 번이고, 인물끼리의 대화는 줄 앞 `이름:` 으로 구분합니다

## 6. 사고 스트립과 반복 감지 — `src/sanitize.js`

### `makeThoughtStripper({ onThought })`

Gemma 4는 사고를 꺼도 `<|channel>thought\n...<channel|>` 형태의 빈 사고 블록을 출력합니다.
스트리밍이라 태그가 청크 경계에서 잘릴 수 있어(`<|chan` + `nel>thought`), `danglingPrefix()`가
표지의 일부일 수 있는 꼬리를 다음 청크까지 들고 있다가 판단합니다. `onThought` 콜백을 주면
버려지는 대신 그리로 넘어갑니다 (화면에 접어서 보여주는 용도).

### `looksRepetitive(text)`

두 가지를 함께 봅니다 (하나만 보면 놓치는 경우가 실제로 있었습니다):

1. **`hasPeriodicTail`** — 꼬리가 정확히 같은 단위로 반복되는가 (`나찰의 나찰의 나찰의…`).
2. **`isFloodedByUnit`** — 꼬리의 70% 이상을 짧은 조각 하나가 차지하는가. 이게 없으면
   `"얇한한한… 부풀어 오르는 얇한한한…"`처럼 다른 말이 사이에 끼어드는 실제 사례를 놓칩니다.

기준은 일부러 넉넉합니다. 말더듬 연출(`"그, 그게…"`), 후렴구 반복, 말줄임표는 통과하고
진짜 루프만 걸리도록 여러 사례로 검증했습니다. 오검출/미검출 사례가 궁금하면 이 함수의
JSDoc과 과거 대화 로그에 테스트 케이스가 남아 있습니다.

---

## 7. REST API 요약

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET/PUT | `/api/settings` | 공용 설정과 내 계정별 설정을 합친 조회/저장. 응답에 `builtinTemplates`, `webSearchCapable`, `canManage`(공용 설정을 바꿀 수 있는지), `defaultProvider` 등 포함. 설정 창은 모든 탭(엔진·이미지·dev 포함)을 PUT 한 번으로 보내므로, 엔진·ComfyUI 주소 검사를 먼저 끝내고 하나라도 거부되면 아무것도 바꾸지 않습니다. 멤버가 보낸 공용 항목(`providers`·`removeProviders`·`image`·`dev.adultCloud`·`defaultProvider`)은 조용히 빠집니다 |
| GET | `/api/models?provider=` | 모델 목록 (엔진별 필터·페이지네이션 적용됨) |
| GET/POST/PUT/DELETE | `/api/characters[/:id]` | 캐릭터 CRUD (`crud()` 헬퍼로 생성) |
| POST | `/api/characters/seed` | 내장 캐릭터 중 없는 것만 추가 |
| POST | `/api/characters/import` | `{ card }`(JSON) 또는 `{ png }`(base64) 캐릭터 카드를 새 캐릭터로. 응답 `{ character, lorebook, dropped }`. 이 경로만 본문 한도 16MB. 카드가 아니면 400 |
| GET | `/api/characters/:id/export` | 캐릭터를 V2 카드 JSON 으로 내려받기. 묶인 로어북은 `character_book` |
| PUT/DELETE | `/api/characters/:id/portrait` | 프로필 그림 올리기(본문이 PNG·JPEG·WebP 파일 그대로)/지우기 |
| PUT/DELETE | `/api/characters/:id/expressions?label=` | 표정 그림 올리기/지우기 |
| GET | `/api/character-art/:id/:file` | 프로필·표정 그림 파일 |
| GET/POST | `/api/backgrounds` | 배경 목록/올리기(`?name=`, 본문은 그림 파일 그대로) |
| PUT/DELETE | `/api/backgrounds/:id` | 배경 이름 바꾸기 `{ name }`/지우기 |
| GET | `/api/background-art/:id/:file` | 배경 그림 파일 |
| POST | `/api/chats/:id/choices` | `{ count? }` 선택지 제안 `{ choices: [{ text, check? }] }`. 저장하지 않음. 롤플레이 대화만 |
| GET/POST/PUT/DELETE | `/api/personas[/:id]` | 페르소나 CRUD |
| GET/POST/PUT/DELETE | `/api/lorebooks[/:id]` | 세계관 설정집 CRUD. 본문 `{ name, description, global, characterIds, entries }` |
| POST | `/api/lorebooks/:id/test` | `{ text, entries? }` 이 글에서 발동하는 항목 `{ triggered: [{id,title,tokens}] }`. 저장하지 않으며 `entries` 를 주면 고치는 중인 항목으로 시험 |
| GET | `/api/chats/:id/lore` | 이 대화에 적용되는 책(`applied`, 이유 `via`)과 지금 발동 중인 항목(`triggered`), 스캔 설정 |
| GET/POST/PUT/DELETE | `/api/chats[/:id]` | 대화 CRUD. PUT 은 `title` `personaId` `presetId` `memory` `authorNote` `castIds` `lorebookIds` `archived` `vn` `dice` `autoChoices`. 목록은 `updatedAt` 최신순. `archived: true` 면 `archivedAt` 을 적고 화면이 보관함으로 옮깁니다. 보관한 대화에 사용자 메시지가 들어오면 서버가 보관을 풉니다 |
| POST/PUT/DELETE | `/api/chats/:id/messages[/:mid]` | 메시지 추가/수정/삭제. 추가할 때 `attachments: [{ file, name }]` 로 올려 둔 그림을 붙임 |
| POST | `/api/chats/:id/generate` | SSE 스트리밍 생성. `{ regenerate, continue }` 바디. regenerate 는 마지막 답변에 새 장(`swipes`)을 얹고, continue 는 끝에 이어 붙임. 둘 다 새 내용이 생겼을 때만 바뀜 |
| PUT | `/api/chats/:id/messages/:mid/swipe` | `{ index }` 보여 줄 답변 장 바꾸기. `content` 가 그 장으로 바뀜 |
| POST | `/api/chats/:id/facts/extract` | `{ auto }` 최근 대화에서 사실을 뽑아 `chat.facts` 에 추가·수정·삭제. auto 는 답변 4개 이상 쌓였을 때만. 새 generate 요청이 오면 멈춤 |
| POST | `/api/chats/:id/impersonate` | `{ hint }` 대신 쓰기. 내 다음 차례 초안을 SSE 로 흘려보내고 `done` 에 정리된 `draft`. 저장하지 않음 |
| POST | `/api/chats/:id/messages/:mid/image` | `{ prompt?, negative?, checkpoint?, random?, review? }` 장면 그리기. SSE 로 `stage`·`prompt`·`done{image, images}`. prompt 를 주면 LLM 을 건너뜀. checkpoint 는 그 한 장에만 쓰는 모델(설정은 그대로)이고 `image.checkpoint` 에 남김 |
| DELETE | `/api/chats/:id/messages/:mid/images/:imgId` | 그림 삭제 |
| GET | `/api/images/:chatId/:file` | 그림 파일 |
| POST | `/api/chats/:id/attachments` | 붙일 그림 올리기. 본문이 PNG·JPEG·WebP 파일 그대로. `{ file, mime, bytes }` |
| DELETE | `/api/chats/:id/attachments/:file` | 보내지 않고 뺀 그림 지우기. 이미 메시지에 붙었으면 `kept: true` 로 남김 |
| GET | `/api/uploads/:chatId/:file` | 사용자가 붙인 그림 파일 |
| GET | `/api/image/checkpoints?baseUrl=` | ComfyUI 연결 확인 + 체크포인트 목록 |
| GET | `/api/search?q=&kind=rp\|assistant` | 대화 제목·본문 검색. `{ terms, truncated, hits: [{ chatId, messageId, role, snippet, title, character, archived, adult, moreInChat }] }` |
| GET | `/api/usage[?scope=all]` | 내 토큰 사용량 요약(오늘·7일·30일, 모델별, 날짜별). `scope=all` 은 주인만 — 모든 계정의 합계와 계정별 숫자 |
| DELETE | `/api/usage` | 모든 계정의 사용량 기록 지우기. 주인 계정만 |
| GET | `/api/discord/link` | 이 계정의 디스코드 연결 `{ linked: { name, linkedAt } \| null, pending: { expiresAt } \| null, bot: { enabled, name } }` |
| POST | `/api/discord/link-code` | 1회용 연결 코드 `{ code: 'XXXX-XXXX', expiresAt }`. 전에 받은 코드는 무효. 로그인을 잠시 꺼 둔 동안(auth off)은 403 |
| DELETE | `/api/discord/link` | 이 계정의 디스코드 연결 끊기 `{ ok, removed }` |
| GET | `/pub/art/:characterId/:file?s=` | **로그인 없이** 캐릭터 프로필·표정 그림. 서명(`PublicArt`)이 맞고 지금 쓰는 그림일 때만, 아니면 빈 404 |
| GET | `/api/chats/:id/context` | 컨텍스트 게이지. 한도·시스템·대화·답변 여유 토큰, 보내는/잘린 메시지 수, 요약 대기 수 |
| POST | `/api/chats/:id/summarize` | `{ auto }` 밀려난 옛 대화를 `chat.memory` 로 요약. auto 는 10개 이상 쌓였을 때만 한 묶음 |
| POST | `/api/chats/:id/stop` | 진행 중인 생성을 멈춤. 쓰던 답변은 저장되고 SSE 의 `done` 으로 돌아감 |
| GET | `/api/chats/:id/system` | 진단용 — 조립된 시스템 프롬프트 미리보기 |
| POST | `/api/chats/:id/save-character` | 1회성 캐릭터를 목록으로 승격 |
| DELETE | `/api/providers/:key/unavailable` | 감춰진 모델 기록 초기화 |
| GET | `/api/export` | 내 캐릭터·페르소나·로어북·대화와 내 계정별 설정의 백업 JSON. 공용 설정(엔진·키·이미지)·그림 파일·사용량은 빠짐 |
| POST | `/api/import` | `{ data, includeSettings }` 백업을 내 계정에 합침. 멤버도 씀. 내 것과 같은 id·같은 내용은 건너뛰고, 남이 쓰는 id 는 (나, 원래 id) 로 정해지는 새 id 로 들어옴(두 번 불러와도 겹치지 않음). 대화의 캐릭터·페르소나 id 를 맞춰 고침. `includeSettings` 는 내 계정별 설정만 덮음. 본문 한도 64MB |

**모든 경로에서 남의 항목은 없는 항목과 같습니다** — 같은 404 와 같은 안내(예: `없는 대화입니다.`)이고,
그림 파일 경로(`/api/images`·`/api/uploads`·`/api/character-art`·`/api/background-art`)는 빈 404 입니다.
남의 대화의 `stop` 은 `{ stopped: false }` 입니다. 대화·캐릭터·로어북 등에 남의 id 를 적으면 조용히 걸러집니다.

`GET`과 `PUT /api/settings`는 **반드시 같은 모양**(`Settings.payload(actor)`)을 돌려줘야 합니다.
과거에 GET에만 `builtinTemplates`를 붙였다가, 저장 직후 클라이언트가 그 필드를 잃어버려
"기본 내용 가져오기"가 먹통이 된 적이 있습니다.

---

## 8. 프런트엔드 구조

### `public/js/api.js`

서버 호출을 감싸는 얇은 함수 모음(`api.characters()`, `api.saveSettings()` 등)과
`generate()` — SSE 응답을 파싱해 `onDelta`/`onThought`/`onSources` 콜백으로 나눠 줍니다.

### `public/js/ui.js`, `public/js/ui/format.js`

가장 조심해서 고쳐야 할 파일들입니다. `ui.js` 에는 DOM을 직접 조작하는 렌더 함수들이, `ui/format.js` 에는
**직접 구현한 마크다운 렌더러**(`renderMarkdown`)와 표기법 처리(`formatText`)가 있습니다. 외부 라이브러리를 안 쓴 이유는 로컬 모델만 켜고
오프라인으로 쓰는 사용자가 많아서입니다 — CDN에 기대면 그때 마크다운이 통째로 날것으로 보입니다.

렌더링 파이프라인(`formatText`):
- 롤플레이 모드: `*별표*`→행동, `(괄호)`→행동, 줄 맨 앞 `이름:`→화자 라벨, `"따옴표"`→대사 강조.
  모델이 `(이름: 묘사)`처럼 이름을 괄호 안에 넣는 경우를 위해, 줄이 `(이름:`로 시작하면
  이름을 괄호 밖으로 꺼내는 전처리(`line.replace(/^\(([^:\s()]{1,20}):\s*/, '$1: (')`)를
  먼저 거칩니다.
- 어시스턴트 모드: `renderMarkdown` — 제목, 목록(중첩 포함), 표, 인용, 구분선, 링크, 코드,
  간단한 TeX 표기(`$\rightarrow$` 등 30여 개 매핑)를 직접 파싱합니다. 코드 블록은 제일 먼저
  플레이스홀더로 빼뒀다가 마지막에 되돌려 넣어, 안의 `#`이나 `-`가 마크다운으로 오해받지 않게 합니다.

**함수를 지우지 마세요.** 과거에 이 파일을 문자열 위치로 잘라 교체하다가 `renderChatList`,
`renderCharacterList`, `toast`, `fillNames` 네 함수가 통째로 날아간 적이 있습니다
("이 주석부터 저 주석까지" 방식으로 자르는 구간에 다른 함수가 들어 있었음). 이 파일을 고칠 때는:

```bash
# 모든 모듈이 쓰는 ui.* 가 export 되는지, $('id') · on('id', …) 로 찾는 DOM id 가 index.html 에 다 있는지 확인
node -e "
const fs = require('fs'), path = require('path');
const files = [];
const walk = (d) => fs.readdirSync(d).forEach((n) => { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') && files.push(p); });
walk('public/js');
const ui = fs.readFileSync('public/js/ui.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const exported = new Set([...ui.matchAll(/export (?:async )?(?:function|const) (\w+)|export \{([^}]*)\}/g)].flatMap((m) => m[1] ? [m[1]] : m[2].split(',').map((x) => x.trim())));
const used = new Set(), ids = new Set();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bui\.(\w+)/g)) if (m[1] !== 'js') used.add(m[1]);
  for (const m of src.matchAll(/(?:[$][(]|\bon[(])'([\w-]+)'/g)) ids.add(m[1]);
}
console.log('빠진 export:', [...used].filter((n) => !exported.has(n)).join(', ') || '없음');
console.log('빠진 id:', [...ids].filter((id) => !html.includes('id=\"' + id + '\"')).join(', ') || '없음');
"
```

`export async function` 도 잡아야 합니다 — 예전 스니펫은 이걸 놓쳐서 `copyText` 가 빠졌다고 잘못 알렸습니다.
`thread` 처럼 렌더 함수가 그때그때 만드는 요소의 id 는 index.html 에 없어서 '빠진 id' 로 나와도 괜찮습니다.

### `public/js/select.js`

네이티브 `<select>`는 열었을 때 목록을 OS가 그려서 CSS가 안 닿습니다. `enhanceSelects()`가
모든 `select`를 찾아 화면에서는 숨기고(값의 주인은 여전히 select), 테마를 따르는 버튼+목록
쌍으로 감쌉니다. `select.value` setter를 가로채서, 코드가 값을 바꿔도 버튼 글자가 따라오게
합니다. 항목 수로 "고를 게 없다"를 판단하지 마세요 — `innerHTML`로 옵션을 갈아끼운 직후엔
`MutationObserver`가 아직 안 돈 상태라 비어 있는 것으로 오판합니다(실제로 겪은 버그).

`makeCombo(input, { items, onPick, emptyText, noMatchText })`는 글자를 쳐서 거르거나 목록에서 고르는
입력칸입니다(엔진 모델, ComfyUI 체크포인트). 브라우저 기본 `datalist`는 테마를 따라오지 않아서 쓰지 않습니다.
적힌 값이 목록의 한 항목과 똑같으면 거르지 않고 전부 보여 줍니다 — 고른 뒤 다시 열어 다른 걸 고를 수 있게.

두 목록 모두 버튼 폭에 묶지 않고 글자 길이만큼 넓어집니다(`.sel-list, .combo-list { width: max-content }`).
좁은 버튼(입력창 아래 엔진 선택기)에서 항목이 "LM S…" 처럼 잘리던 문제 때문입니다. `placeList()`가 펼칠 때
아래가 모자라면 `.is-up`, 오른쪽이 모자라면 `.is-end`(버튼 오른쪽 끝 기준)를 붙입니다.

### `public/js/app.js` 와 `features/`

`app.js` 는 진입점만 합니다. `App` 이 상태(`AppState`)를 하나 만들고, 기능 객체들에 자기 자신을 넘겨
만듭니다. 기능끼리는 `app.view.open(id)`, `app.list.refresh()` 처럼 `App` 을 거쳐 서로 부릅니다.

| 필드 | 파일 | 맡는 일 |
|---|---|---|
| `state` | `core/state.js` | 서버 데이터 사본(`settings, characters, personas, lorebooks, chats, chat`), 진행 중 생성 `run`, `mode`, `hideAdult`, `showArchived`, 계산 메서드 |
| `toolbar` | `features/toolbar.js` | 입력창 아래 엔진 선택기, 모델 이름, 웹 검색·생각 토글 |
| `list` | `features/chat-list.js` | 사이드바 대화 목록, 모드 탭, 보관함, 우클릭 메뉴, 이름 바꾸기·보관·삭제 |
| `drawing` | `features/drawing.js` | 🎨 장면 그리기, 태그 검토, 그림 크게 보기 |
| `view` | `features/chat-view.js` | 대화 열기·닫기, 상단 헤더와 ⋯ 메뉴, 메시지 그리기·넘기기·편집 |
| `composer` | `features/composer.js` | 입력창, 보내기·다시 쓰기·이어 쓰기·멈추기, 대신 쓰기, 컨텍스트 게이지 |
| `search` | `features/search.js` | 사이드바 대화 검색(250ms 뒤 요청, 늦게 온 응답 버림), 결과에서 그 메시지로 이동, Ctrl/⌘+K |
| `pwa` | `features/pwa.js` | 서비스 워커 등록 (`app.js` 가 App 을 만들기 전에 호출) |
| `attach` | `features/attach.js` | 그림 붙이기(고르기·붙여넣기·끌어놓기), 줄여 올리기, 보내기 전 미리보기 |
| `memory` | `features/memory.js` | 기억(설정 기록·요약) 창과 답변 뒤 자동 정리 |
| `cast` | `features/cast.js` | 함께 등장하는 인물 창 |
| `newChat` | `features/new-chat.js` | 새 대화 시작과 모드 선택 창 (`MODE_NOTES`) |
| `characters` | `features/characters.js` | 캐릭터 목록 탭과 캐릭터 창 |
| `personas` | `features/personas.js` | 페르소나 창과 랜덤 페르소나 |
| `lorebooks` | `features/lorebooks.js` | 세계관 설정집 창 — 목록·이름·적용 범위·발동 시험. 항목 편집은 `lore-entry.js` 의 `LoreEntryEditor` |
| `chatLore` | `features/chat-lore.js` | 대화의 ⋯ 메뉴 「세계관 적용」 창 — 이 대화에 붙일 설정집과 지금 발동 중인 항목 |
| `cardTransfer` | `features/card-transfer.js` | 캐릭터 카드 가져오기(JSON·PNG)·내보내기 버튼 |
| `settings` | `features/settings.js` | 설정 창 — 엔진·대화 모드·탭·저장. 이미지 탭은 `settings-image.js`, 화면·개발자 탭은 `settings-dev.js`, 사용량 탭은 `settings-usage.js`, 디스코드 탭은 `settings-discord.js` |

`theme.js` 의 `applyTheme(dev)` 는 테마 색·글꼴·파비콘·표기법을 화면에 적용합니다.

**만드는 순서가 동작의 일부입니다.** `#messages` 클릭은 그림 크게 보기(`Drawing`)가 메시지 편집(`ChatView`)보다
먼저 받아야 하므로 `Drawing` 을 먼저 만듭니다. 생성자 안에서는 이벤트만 걸고 다른 기능을 부르지 마세요 —
아직 안 만들어진 기능일 수 있습니다.

대화 목록은 `state.modeChats()`(지금 모드) → `visibleChats()`(보관 여부로 나눔, 보관함은 보관한 순) →
`listedChats()`(성인 숨기기까지 적용한, 실제로 보이는 것) 세 단계로 거릅니다. 이름 바꾸기·보관·삭제는
`ChatList` 의 `rename` / `setArchived` / `remove` 가 대화 id 로 처리하고, 상단 ⋯ 메뉴와 목록 우클릭 메뉴가
둘 다 이 메서드들을 부릅니다. 열린 대화가 보관·삭제로 목록에서 빠지면 `openNeighbor` 가 그 자리의 다음 대화를 엽니다.

스크롤은 `ui.watchScroll()`이 "사용자가 직접 위로 올렸는가"만 추적하는 pinned 방식입니다.
거리 기반 판정은 '응답 생성 중' 막대가 나타나 레이아웃이 바뀌는 순간 밀려나는 버그가 있어
버렸습니다.

---

### 홈 화면 설치(PWA) — `public/sw.js`

- 정적 파일(`express.static`)은 로그인 없이 받을 수 있으므로 manifest·sw.js·아이콘도 그대로 열립니다. 첫 화면(`/`)만 `pageGate` 가 로그인 페이지로 돌립니다
- 워커는 같은 출처의 GET 중 `/api/`·`/sw.js`·`/login.html` 을 뺀 요청을 **네트워크 우선**으로 받고, 성공한(`ok`, 리다이렉트 아님, `basic`) 응답만 `rp-shell-v1` 에 복사해 둡니다.
  실패하면 캐시에서 꺼내고, 화면 이동이면 `/` 를 냅니다. 로그인 페이지로 돌려보낸 응답을 저장하면 다음에 "리다이렉트된 응답으로 이동" 오류가 나므로 저장하지 않습니다
- 캐시 우선을 쓰지 않는 이유: ES 모듈이 여러 파일이라 업데이트 뒤 새 `app.js` 와 옛 `api.js` 가 섞이기 쉽습니다. 파일을 바꿀 때 워커를 고칠 필요가 없습니다(캐시 구조를 바꿀 때만 `CACHE` 이름을 올립니다)
- 대화·설정 같은 API 응답과 그림 파일은 절대 캐시하지 않습니다. 로그아웃한 기기에 데이터가 남으면 안 되기 때문입니다
- 서비스 워커는 https 또는 localhost 에서만 등록됩니다. 그 밖(LAN 의 http)에서는 조용히 건너뜁니다
- 아이콘은 `public/icons/icon.svg` 의 말풍선을 Chromium 으로 찍어 만든 PNG 입니다. `theme.js` 는 테마를 바꾸면 `theme-color` 메타를 같이 바꿉니다(manifest 의 색은 고정)

## 9. 로컬 테스트 방법

실제 LM Studio나 API 키 없이 검증하려면 가짜 서버를 씁니다. 이 프로젝트 전체가 이 패턴으로
테스트됐습니다.

```js
// mock-something.mjs
import http from 'node:http';
http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const p = JSON.parse(b);
    console.log('받은 값:', p.temperature, p.tools);  // 실제로 뭘 보냈는지 확인
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '응답' } }] })}\n\n`);
    res.end();
  });
}).listen(1234);
```

그다음 서버를 띄우고 `curl`로 실제 API처럼 호출합니다.

로그인이 켜져 있으면 `curl` 이 전부 401 을 받습니다. 테스트할 때는 `AUTH_DISABLED=1` 로 끄세요.
`HOST` 가 기본값(`127.0.0.1`)일 때만 먹습니다. 로그인 자체를 시험할 때는 끄지 말고 쿠키를 씁니다
(`curl -c jar -d '{"name":..,"password":..}' .../api/login` 뒤로 `-b jar`).

```bash
node mock-something.mjs &
AUTH_DISABLED=1 PORT=5199 node server.js &
sleep 2
curl -s -X PUT http://127.0.0.1:5199/api/settings -d '{"providers":{"lmstudio":{"baseUrl":"http://localhost:1234/v1", ...}}}'
curl -s -N -X POST http://127.0.0.1:5199/api/chats/$ID/generate -d '{}'
```

**같은 셸 호출 안에서 서버를 띄우고 테스트까지 끝내세요.** 백그라운드 프로세스(`&`)는 도구 호출이
끝나면 참조(`$!`)를 잃어버려 나중에 정리하기 까다롭습니다. `pkill -f "node server.js"`로
정리하거나, 매번 새 포트를 쓰는 것도 방법입니다.

`node mock-lmstudio.mjs`는 UI만 확인할 때 쓰는 기본 가짜 서버입니다. 모델에 `mock-7b`을
넣으면 실제 모델 없이 스트리밍 응답을 받을 수 있습니다.

### 단위 테스트 — `npm test`

`test/unit/*.test.mjs` 를 `node --test` 로 돕니다. 계정 나누기에 관한 것:

- `isolation.test.mjs` — 가짜 로그인(`x-test-user` 헤더)으로 두 계정을 만들어 **실제 HTTP 경로**를 부릅니다.
  다른 계정의 대화·붙인 그림·프로필·배경·검색 결과·백업·전역 로어북·사용량이 보이지 않는지, 남의 id 를 끌어다 붙여도
  걸러지는지, 설정이 따로인지, 남의 백업을 불러와도 원본이 그대로인지 봅니다. 새 경로를 만들면 여기에 한 줄 더하세요
- `access.test.mjs` — `Access` 규칙과, 라우트·서비스가 저장소를 직접 읽지 않는지 소스를 검사합니다
- `ownership.test.mjs` — 옛 데이터의 주인 정하기, 옛 설정 옮기기, claim·purge, 계정 명령 요청 파일
- `settings.test.mjs` — 계정별 설정이 섞이지 않는지, 멤버가 공용 항목을 못 바꾸는지, 기본 엔진

### 동작 기록 테스트 — `test/golden/`

구조를 바꾸는 리팩터링이 **동작을 하나도 바꾸지 않았는지** 확인하는 테스트입니다. 같은 시나리오를
고치기 전 코드(보통 `git worktree add ../base <커밋>`)와 고친 코드에 똑같이 돌리고, 나온 파일을
바이트 단위로 비교합니다. 서버는 `test/support/deterministic.mjs` 로 난수·UUID·시각을 고정한 채 뜨고,
엔진과 ComfyUI 는 `test/support/mock-services.mjs` 가 받은 요청을 기록하며 흉내 냅니다.

```bash
# API 시나리오 (대화·설정·캐릭터·백업 등), 엔진별 시나리오, 로그인·계정 명령
node test/golden/run.mjs ../base base.json
node test/golden/run.mjs . new.json
node test/golden/run.mjs . eng-new.json scenario-engines.mjs
node test/golden/run.mjs . lib-new.json scenario-library.mjs   # 로어북·검색·붙인 그림·프로필·배경·카드
node test/golden/auth.mjs . auth-new.json
cmp base.json new.json
```

API 시나리오는 `AUTH_DISABLED=1` 로 돌아서 계정이 `local` 하나뿐입니다. 계정 사이의 격리는 위의 `isolation.test.mjs` 가,
계정 명령(`claim` 포함)과 계정마다 내장 콘텐츠를 받는 것은 `auth.mjs` 가 봅니다.

포트는 가짜 서버 5181, 앱 5185(`GOLDEN_MOCK_PORT`, `GOLDEN_APP_PORT` 로 바꿀 수 있음), 로그인 테스트 5186 입니다.
포트가 다르면 결과 파일의 주소도 달라지므로, 비교할 두 번은 같은 포트로 돌리세요.

화면 동작은 `ui-server.mjs` 로 앱(5187)과 시나리오 서버(5189)를 띄운 뒤, 브라우저에서 그 앱을 열고
시나리오를 실행합니다. 결과는 `<출력 폴더>/ui-<이름>.json` 으로 저장됩니다.

```bash
node test/golden/ui-server.mjs . 5187 out
```

```js
// http://127.0.0.1:5187 을 연 브라우저 콘솔에서 (먼저 localStorage.clear() 후 새로고침)
import('http://127.0.0.1:5189/ui-scenario.mjs').then((m) => m.run('new'));
```

통신 로그 창에는 병렬 요청의 순서와 걸린 시간(ms)이 그대로 찍히므로, 두 결과가 그 부분만 다르면 같은 동작입니다.

---

## 10. Docker

```bash
docker compose up -d
```

컨테이너 안에서는 `localhost`가 호스트를 가리키지 않습니다. 기본 `docker-compose.yml`은 LM Studio 가 다른 PC 에 있는
구성(라즈베리파이 등)을 전제로 해서, 그 PC 의 LAN IP 를 `LOCAL_ENGINE_HOSTS`에 적고 엔진 주소도 그 IP 로 잡습니다.
같은 PC 에서 돌린다면 compose 에 `extra_hosts: ["host.docker.internal:host-gateway"]`를 더하고
`http://host.docker.internal:1234/v1`을 쓰세요(이 호스트 이름은 `security.js`가 로컬로 취급합니다).

---

## 11. 새 엔진 추가하기

1. `src/providers.js`에 `Engine` 을 이어받은 클래스를 만들고 `async *chat(opts)` 와 `models()` 를 씁니다.
   OpenAI 호환이면 `OpenAiEngine` 을 이어받아 다른 점만 덮어쓰세요 (`OllamaEngine` 참고).
2. `BUILTIN` 에 등록.
3. 목록 조회에 페이지네이션·필터가 있다면 `models()` 안에서 함께 처리합니다.
4. `src/store.js`의 `defaultSettings().providers`에 기본 항목 추가 (`label`, `type`, `baseUrl`, `model`, `unavailableModels: []`).
5. 성인 틀·웹 검색을 지원한다면 `supportsWebSearch()`, `isLocalUrl()` 판정에 반영.

이미 OpenAI/Anthropic/Gemini 형식 중 하나를 따르는 서비스라면, 설정 창 엔진 탭의 **엔진 추가**로
코드 수정 없이 붙일 수 있습니다 (`type` 필드로 세 형식 중 하나를 고르는 방식).

## 12. 새 대화 모드 추가하기

1. `src/content/templates.js`에 `export const MY_TEMPLATE = \`...\`;` 로 틀 작성.
2. 같은 파일의 `BUILTIN_TEMPLATES()` 배열에 `{ id, name, template: MY_TEMPLATE, adult }` 추가.
   **일반/성인 순서를 지키세요** — 일반 항목은 성인 항목보다 배열 앞쪽에 둡니다.
3. 표기법이 새로운 거라면 (`public/js/ui/format.js`의) `formatText`/`renderMarkdown`에 반영이 필요할 수
   있습니다.
4. `public/js/features/new-chat.js`의 `MODE_NOTES`에 모드 선택 창에서 보여줄 한 줄 설명을 추가하면 좋습니다
   (없으면 틀 내용 첫 줄을 대신 보여줍니다).

---

## 12-1. 랜덤 페르소나

두 단계로 나뉘어 있습니다. **표를 굴리는 단계는 모델을 부르지 않습니다** — 칩을 다시 굴릴 때마다
모델을 부르면 느리고 비싼 데다, 조합이 마음에 들 때까지 굴려 보는 흐름 자체가 끊깁니다.

1. `src/persona-seeds.js` — `POOLS` 에서 항목별로 뽑습니다. `CONFLICTS` 에 적힌 짝은 같이 나오지
않습니다(후보가 전부 걸리면 제한을 풀고 원본 풀에서 뽑습니다 — 조합이 막혀 500이 나는 것보다 낫습니다).
`rollSeeds(keep, only)` 의 `only` 가 "이 항목만 다시" 이고, 나머지는 `keep` 을 그대로 씁니다.
`gender` 를 다시 굴리면 `name` 이 자동으로 따라갑니다.
2. `src/persona-gen.js` — 태그를 문장으로. **JSON 을 요구하지 않습니다.** 로컬 모델이 중괄호·따옴표를
흘리는 경우가 잦아, 형식을 요구할수록 실패가 늘었습니다. 대신 `cleanGenerated()` 가 머리말(`소개:`),
코드펜스, 목록 기호, 둘째 문단을 걷어냅니다.

`rollSeeds(keep, only, adult)` 의 세 번째 인자가 풀을 완전히 바꿉니다 — `POOLS` 와
`ADULT_POOLS` 는 같은 함수(`compatible`/`conflicts`)를 공유하지만 배열 자체는 분리되어 있어서,
`adult: false` 로 부르면 성인 풀의 문구가 절대 섞이지 않습니다. `ADULT_POOLS.age` 에는
"10대" 로 읽힐 수 있는 값을 아예 넣지 않았습니다 — 성인 캐릭터의 나이 안전장치입니다.

`POST /api/personas/generate` 는 엔진 미설정·주소 거부·키 없음·모델 오류·빈 응답을 전부
`fallbackDescription()` 으로 흡수해 **200 으로** 돌려줍니다 (`fallback: true`, `reason` 포함).
페르소나를 만드는 중에 오류 창을 띄우는 것보다, 밋밋하더라도 문장이 들어가는 쪽이 낫기 때문입니다.
`adult: true` 로 호출하면 대화의 성인 프리셋과 같은 규칙(`adultAllowed`)을 한 번 더 검사합니다 —
허용되지 않은 엔진이면 모델을 부르지 않고 바로 `fallback: true` 로 빠집니다. 씨앗을 굴리기만 하는
`/api/personas/roll` 은 모델을 안 부르므로 이 검사가 필요 없습니다.

`maxTokens` 는 설정값과 무관하게 700 으로 잘라 둡니다 — 한 문단이면 충분한데 4096 을 주면
로컬 모델이 계속 이어 씁니다.

프런트는 `public/js/features/personas.js` 의 `Personas.seeds` 하나가 상태 전부입니다. 칩 클릭 → `only` 로 재굴림,
**문장 만들기** → 기존 이름·소개 입력칸을 채움. 저장은 원래의 **페르소나 추가** 버튼이 그대로 합니다.

## 12-2. 줄글 → 캐릭터 시트

`POST /api/characters/draft` 는 **저장하지 않습니다.** 화면의 입력 칸을 채워 주기만 하고,
저장은 원래의 캐릭터 저장 버튼이 그대로 합니다. 덕분에 '이번만 쓰기', 편집, 삭제 흐름을
하나도 건드리지 않았습니다.

형식은 JSON 이 아니라 `라벨: 값` 입니다. 항목이 열 개쯤 되면 로컬 모델이 중괄호나 따옴표를
흘려서 통째로 못 읽게 되는 일이 잦았습니다. `parseCharacter()` 는 아는 라벨이 나올 때까지를
앞 항목의 내용으로 보기 때문에 **여러 줄 항목(성격, 대화 예시)이 그대로 살아납니다.**
`**이름**:`, `- 이름:`, `### 이름:`, `[이름]:`, `1. 이름:` 같은 변형과 코드펜스도 받아 주고,
`ALIASES` 에는 모델이 지시된 라벨 대신 자주 쓰는 말(`소개`→`description`, `배경`→`scenario` 등)이
등록되어 있습니다. 줄바꿈을 아예 안 지키고 한 줄로 몰아 쓰는 응답은 `splitInlineLabels()` 가
라벨 앞에 줄바꿈을 끼워 넣어 평소 파서가 그대로 처리하게 만듭니다 — 응답에 줄바꿈이 하나라도
있으면 건드리지 않으므로, 정상적으로 줄이 나뉜 응답에는 영향이 없습니다.

라벨을 늘리려면 `src/character-gen.js` 의 `CHAR_FIELDS` 에 `{ key, label, hint }` 를 추가하면
프롬프트의 출력 형식과 파서가 함께 따라옵니다. `key` 는 화면 입력칸 id(`c-<key>`)이자
`src/content/characters.js` 의 `CHARACTER_FIELDS` 와 같아야 합니다.

### 형식이 자주 무너지던 문제와 대응

로컬 모델(특히 롤플레이 쪽으로 강하게 파인튜닝된 모델)은 지시문의 힌트를 그대로 베끼거나
(`이름: (한국어 이름 하나...)` 를 글자 그대로 반복), 줄바꿈을 무시하거나, 라벨을 비슷한 말로
바꿔 쓰는 일이 실제로 잦았습니다. 세 가지로 대응합니다.

1. **온도를 구조화된 출력에 맞게 낮춥니다.** 롤플레이용 `s.params.temperature`(보통 1.0)를
   그대로 쓰지 않고 `Math.min(s.params.temperature ?? 1, 0.5)` 로 이 요청에서만 낮춥니다.
   온도가 높을수록 라벨을 바꿔 쓰거나 형식을 벗어나는 일이 늘어납니다.
2. **형식 예시(`CHAR_EXAMPLE`)를 프롬프트에 실제로 채워진 시트 하나로 보여 줍니다.** 힌트
   문장만으로 형식을 설명하는 것보다, 완성된 예시 하나를 보여 주는 쪽이 훨씬 안정적이었습니다.
   예시의 인물을 그대로 베끼지 말라는 문구를 같이 넣어 둡니다.
3. **재시도는 처음부터 다시 시키지 않고, 남은 빈칸만 채우게 합니다.** `looksUsable()` 이
   실패하면(성격/소개/배경/말투 중 하나도 없으면) `ask(character)` 를 한 번 더 부르는데, 이때
   `buildCharPrompt` 의 두 번째 인자로 **지금까지 채워진 값**을 넘겨 그 항목은 '이미 정해진
   항목'으로 고정하고 나머지만 채우게 합니다. 매번 열 개를 통째로 다시 시키는 것보다 형식이
   덜 흐트러집니다. `mergeCharacters(base, extra)` 가 `base` 에 이미 값이 있는 항목은 `extra` 로
   덮지 않습니다 — 두 번의 시도 결과를 안전하게 합칠 수 있는 이유입니다.

두 번 다 실패해도 **더 이상 502 로 끊지 않습니다.** `roughFallback()` 이 마지막(가장 최근)
시도의 원문을 `notes` 칸에 그대로 남기고 `fallback: true` 와 함께 200 을 돌려줍니다 — 이름까지
지어내지는 않지만, 손으로 옮길 거리라도 남기는 편이 완전한 오류보다 낫다고 판단했습니다.
서버는 재시도가 있었을 경우 **재시도의 원문**(`lastText`)을 씁니다 — 첫 시도보다 나중 시도가
빈칸 채우기 맥락을 더 갖고 있어 보통 더 쓸모 있는 텍스트이기 때문입니다.

사용자가 이미 채워 둔 칸은 두 번 지킵니다 — 프롬프트에 '이미 정해진 항목'으로 넣어 모델이
안 건드리길 기대하고, 응답을 받은 뒤에도 `mergeCharacters(current, parsed)` 로 다시 한 번
지킵니다. 모델이 지시를 무시하고 다시 쓰는 경우가 있기 때문입니다.

## 13. 알려온 함정들 (겪은 순서대로)

- **문자열 위치로 파일을 잘라내는 편집**은 그 구간에 다른 게 들어 있으면 통째로 날아갑니다.
  `ui.js`에서 함수 네 개를 잃은 사고, `styles.css`에서 선택자 중간에 다른 규칙이 끼어든 사고
  둘 다 이 방식에서 나왔습니다. 자르기 전에 그 구간 내용을 먼저 확인하세요.
- **호스트 판별은 문자열 매칭이 아니라 `new URL().hostname`으로.** `isOpenAiHost()` 버그 참고.
- **엔진마다 파라미터 규칙이 다르고, 문서를 봐도 계정별 예외가 있습니다** (Gemini 2.5가 일부
  계정에서만 404). 고정 목록으로 거르지 말고, 실패를 기억해 두는 방식(`unavailableModels`)이
  더 견고합니다.
- **`GET`과 `PUT`이 같은 모양을 돌려줘야** 저장 후에도 클라이언트가 읽기 전용 필드를 잃지
  않습니다.
- **서버와 브라우저가 함께 쓰는 코드는 `public/js/shared/` 에 둡니다.** 브라우저가 `src/` 를 못 읽어서
  예전에는 조사 교정이 두 벌 있었고, 한쪽만 고쳐지는 일이 잦았습니다.
- **프런트 모듈이 참조하는 DOM id, `ui.*`/`api.*` 이름은 전부 실존해야 합니다.** 어느 한쪽만
  고치면 부팅 자체가 멈춥니다. 8절의 점검 스니펫을 습관적으로 돌리세요.
