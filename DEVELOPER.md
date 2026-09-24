# AI 롤플레이 & 어시스턴트 — 개발자 문서

이 문서는 **소스 코드를 고치거나 새 기능을 붙이려는 사람**을 위한 것입니다.
설치하고 쓰기만 할 거라면 `GUIDE.md`를 보세요. 여기서는 화면 뒤에서 무엇이 어떻게 도는지,
그리고 그걸 고치려면 어느 파일을 열어야 하는지를 다룹니다.

---

## 1. 프로젝트 구조

```
server.js                 REST + SSE 엔드포인트. 요청을 받아 store 와 providers 를 연결
src/
  db.js                    파일 저장 기반 클래스 — JsonDoc, Collection
  store.js                 Store 클래스, 내장 프롬프트 틀, 내장 캐릭터, 설정 기본값
  prompt.js                시스템 프롬프트 조립, 한국어 조사 교정
  providers.js             엔진 어댑터 — OpenAI/Anthropic/Gemini 호환, 스트리밍, 모델 목록
  sanitize.js              사고 블록 제거, 반복 출력 감지
  persona-seeds.js         랜덤 페르소나 씨앗 표 (POOLS, CONFLICTS) 와 굴리기
  persona-gen.js           씨앗 → 소개 문단 프롬프트, 후처리, 모델 없이 쓰는 대체 문장
  character-gen.js         줄글 → 캐릭터 시트 프롬프트, 라벨 파서
public/
  index.html               전체 마크업 (사이드바, 대화창, 다이얼로그 다섯 개)
  styles.css               전체 스타일. CSS 변수로 테마 관리
  js/
    api.js                 서버 호출 얇은 래퍼 + SSE 파서
    ui.js                  DOM 렌더링 — 목록, 메시지, 마크다운, 조사 교정(서버와 별도 구현)
    select.js              네이티브 select 를 테마에 맞는 드롭다운으로 감싸는 모듈
    app.js                 상태 관리와 이벤트 바인딩 (가장 큰 파일, 1300줄+)
mock-lmstudio.mjs           로컬 통합 테스트용 가짜 OpenAI 호환 서버
Dockerfile, docker-compose.yml
```

의존성은 `express` 하나뿐입니다. 프런트엔드는 빌드 스텝 없이 브라우저가 ES 모듈을 직접 읽습니다.

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
  settingsDoc   // JsonDoc
  characters    // Collection
  personas      // Collection
  chats         // Collection
}
export const store = new Store();  // 싱글턴
```

`store.load()`가 부팅 시 하는 일, 순서대로:

1. **`migrateFromSingleFile()`** — 예전 `data/db.json` 하나짜리 저장 방식이 남아 있으면
   항목별 파일로 풀어놓고, 원본은 지우지 않고 `db.json.migrated`로 이름만 바꿉니다.
2. 네 저장소를 병렬로 `load()`.
3. **`normalizeSettings()`** — 새로 생긴 설정 키를 채우고, 내장 프롬프트 틀의 옛 이름을
   새 이름으로 바꾸고(`RENAMED` 맵, 사용자가 직접 바꾼 이름은 건드리지 않음), 없는 내장 틀을
   추가하고, **내장 여섯 개를 일반→성인 순서로 재정렬**합니다. 커스텀 틀은 순서를 건드리지 않고
   그 뒤로 보냅니다.
4. 캐릭터도 페르소나도 없으면 `seed()` — 기본 페르소나 하나와 내장 캐릭터를 넣습니다.

### 내장 콘텐츠

- `BUILTIN_TEMPLATES()` — 여섯 개 프롬프트 틀. **배열 순서가 곧 기본 노출 순서**입니다.
  일반 셋(`default`, `novelist`, `narrator`) 다음에 성인 셋(`adult`, `adult-novel`, `adult-narrator`)이
  옵니다. 순서를 바꾸려면 이 배열만 고치면 되고, `normalizeSettings()`의 재정렬 로직이
  기존 설치에도 소급 적용합니다.
- `BUILTIN_CHARACTERS` — 내장 캐릭터 배열. `addMissingBuiltins()`가 **이름으로 중복을 판단**합니다.
  즉 사용자가 내장 캐릭터의 이름을 바꾸면 그 캐릭터는 "없는 것"으로 보여 다시 추가될 수 있습니다.
  반대로 설명만 바꾸고 이름을 유지하면 건너뜁니다.

### 저장 파일 레이아웃

```
data/
  settings.json
  characters/<id>.json
  personas/<id>.json
  chats/<id>.json        # 메시지 배열을 포함
```

`chats/<id>.json`에는 `character` 필드가 통째로 박혀 있는 경우가 있습니다 — **1회성 캐릭터**입니다
(`characterId: null` 대신 `character: {...}`). `server.js`의 `characterOf(chat)`가
`chat.character || store.characters.get(chat.characterId)` 순서로 우선순위를 정합니다.

---

## 3. 프롬프트 조립 — `src/prompt.js`

### `buildSystem({ character, persona, template, particleFix })`

캐릭터/페르소나 필드를 틀의 자리표시자에 채웁니다. 규칙:

- 비어 있는 필드는 **라벨이 붙은 줄째로** 지웁니다(`{{description}}`이 비면 그 줄 자체가 사라짐).
- `{{char}}`가 틀에 한 번도 없으면, 배역 블록을 틀 맨 뒤에 자동으로 붙입니다
  (사용자가 자리표시자를 모르는 프롬프트를 그대로 붙여 넣어도 동작하게 하기 위함).
- `exampleDialogue`, `notes`는 `# 대화 예시`, `# 추가 설정` 제목을 붙여 맨 뒤에 이어 붙입니다.

### 한국어 조사 교정

`substitute(text, token, value)`가 `{{char}}`/`{{user}}` 뒤에 붙은 조사를 받침에 맞춥니다.

- `PARTICLE_PAIRS`: [받침 있을 때, 없을 때] 아홉 쌍(은/는, 이/가, 을/를 …).
- `hasBatchim(word)`: 한글이면 유니코드 오프셋으로 받침 유무를 계산. 영문이면 끝 글자가
  모음인지로 어림.
- 조사 뒤에 한글이 더 이어지면(`{{char}}로서` 처럼) 조사로 보지 않고 건드리지 않습니다 —
  정규식에 `(?![가-힣])`를 넣어 처리합니다. **이 때문에 프롬프트에 `{{char}}로서` 처럼 쓰면
  조사가 안 붙어서 "유하린로서"로 어색하게 나옵니다.** 내장 틀은 전부 `{{char}}가 되어` 식으로
  피해 갑니다.

### ⚠️ 같은 로직이 두 군데 있습니다

브라우저가 `src/` 아래 서버 전용 모듈을 못 읽기 때문에, **`public/js/ui.js`에도 같은 조사 교정
로직이 한 벌 더 있습니다**(`fillNames`, 모드 선택 창의 캐릭터 미리보기가 씀). 한쪽을 고치면
반드시 다른 쪽도 맞추세요. 두 파일 모두 함수 위에 상호 참조 주석이 달려 있습니다.

### `withThinking(system, on)`

Gemma 계열은 시스템 프롬프트 맨 앞의 `<|think|>` 토큰이 있을 때만 사고 모드로 들어갑니다.
로컬 엔진에서 어시스턴트 모드의 "생각" 토글을 처리하는 유일한 방법입니다.

---

## 4. 엔진 어댑터 — `src/providers.js`

### 어댑터 계약

모든 어댑터는 `async function*`이고 텍스트 조각을 `yield`합니다. `streamChat({ provider, ...opts })`가
`pickAdapter()`로 알맞은 어댑터를 고릅니다. 내장 어댑터가 없으면(커스텀 엔진) `config.type`
(`openai`/`anthropic`/`gemini`)을 보고 고릅니다.

새 엔진을 붙이려면 같은 시그니처의 함수를 하나 쓰고 `ADAPTERS`에 등록하면 됩니다. OpenAI 호환
서버(Ollama, vLLM, llama.cpp)는 어댑터를 새로 쓸 필요 없이 `lmstudio`/`openaiCompatible`을
그대로 재사용합니다.

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
| LM Studio 등 로컬 | `repeat_penalty`, `top_k`를 안 보내면 반복 루프가 잘 남 | `lmstudio()` 래퍼가 항상 포함 (OpenAI 본사에는 안 보냄) |
| 공통 | 성인 틀은 로컬 엔진에서만 허용 | `isLocalUrl()` (서버: `server.js`, 클라이언트: `app.js`에 각각 구현 — 판정 규칙이 동일해야 함) |

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

출처는 본문에 이어 붙이지 않고 `server.js`에서 `send({ sources })`로 별도 SSE 이벤트로 보내며,
저장 시에도 `msg.sources`에 따로 담습니다 — 다음 턴 프롬프트에 섞여 들어가지 않게 하기 위함입니다.

---

## 5. 생성 파이프라인 — `server.js` 의 `/api/chats/:id/generate`

요청 하나가 처리되는 순서:

1. `assistant` 모드인지에 따라 시스템 프롬프트·파라미터·사고/검색 설정을 분기 (`s.assistant.*` vs 프리셋).
2. 성인 틀이면 `isLocalUrl(config.baseUrl)` 확인 — 아니면 400.
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

### 대화 한 개의 규칙 — `src/chat-ops.js`

저장소와 무관한 순수 함수만 둡니다.

- **답변 넘겨보기** — `addSwipe` / `showSwipe` / `syncSwipe`. 메시지의 `content` 는 늘 보고 있는 장(`swipes[swipeIndex]`)과 같아서, 히스토리·미리보기 코드는 장을 몰라도 됩니다. 장은 최대 20개
- **이어쓰기** — `CONTINUE_PROMPT` 를 사용자 턴으로 덧붙여 보내고 `joinContinuation` 으로 이어 붙입니다. 문장이 끝난 자리에서만 띄웁니다
- **작가 노트** — `withAuthorNote` 가 보낼 히스토리 사본의 마지막 사용자 턴 끝에 붙입니다. 저장된 메시지는 건드리지 않습니다
- **기억 요약** — `pendingForSummary` 가 기억할 메시지 수 밖으로 밀려났고 `chat.summaryUntilAt` 이후인 메시지를 고릅니다. id 가 아니라 시각으로 기억하므로 메시지를 지워도 처음부터 다시 요약하지 않습니다. 결과는 `buildSystem({ memory })` 로 시스템 프롬프트 끝에 붙습니다
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
| GET/PUT | `/api/settings` | 설정 조회/저장. 응답에 `builtinTemplates`, `webSearchCapable` 등 읽기 전용 필드 포함 |
| GET | `/api/models?provider=` | 모델 목록 (엔진별 필터·페이지네이션 적용됨) |
| GET/POST/PUT/DELETE | `/api/characters[/:id]` | 캐릭터 CRUD (`crud()` 헬퍼로 생성) |
| POST | `/api/characters/seed` | 내장 캐릭터 중 없는 것만 추가 |
| GET/POST/PUT/DELETE | `/api/personas[/:id]` | 페르소나 CRUD |
| GET/POST/PUT/DELETE | `/api/chats[/:id]` | 대화 CRUD. PUT 은 `title` `personaId` `presetId` `memory` `authorNote` `castIds` |
| POST/PUT/DELETE | `/api/chats/:id/messages[/:mid]` | 메시지 추가/수정/삭제 |
| POST | `/api/chats/:id/generate` | SSE 스트리밍 생성. `{ regenerate, continue }` 바디. regenerate 는 마지막 답변에 새 장(`swipes`)을 얹고, continue 는 끝에 이어 붙임. 둘 다 새 내용이 생겼을 때만 바뀜 |
| PUT | `/api/chats/:id/messages/:mid/swipe` | `{ index }` 보여 줄 답변 장 바꾸기. `content` 가 그 장으로 바뀜 |
| POST | `/api/chats/:id/summarize` | `{ auto }` 밀려난 옛 대화를 `chat.memory` 로 요약. auto 는 10개 이상 쌓였을 때만 한 묶음 |
| POST | `/api/chats/:id/stop` | 진행 중인 생성을 멈춤. 쓰던 답변은 저장되고 SSE 의 `done` 으로 돌아감 |
| GET | `/api/chats/:id/system` | 진단용 — 조립된 시스템 프롬프트 미리보기 |
| POST | `/api/chats/:id/save-character` | 1회성 캐릭터를 목록으로 승격 |
| DELETE | `/api/providers/:key/unavailable` | 감춰진 모델 기록 초기화 |
| GET | `/api/export` | API 키를 뺀 전체 백업 JSON |
| POST | `/api/import` | `{ data, includeSettings }` 백업을 합침. 같은 id·같은 내용은 건너뛰고, 대화의 캐릭터·페르소나 id 를 맞춰 고침. 본문 한도 64MB |

`GET`과 `PUT /api/settings`는 **반드시 같은 모양**(`settingsPayload()`)을 돌려줘야 합니다.
과거에 GET에만 `builtinTemplates`를 붙였다가, 저장 직후 클라이언트가 그 필드를 잃어버려
"기본 내용 가져오기"가 먹통이 된 적이 있습니다.

---

## 8. 프런트엔드 구조

### `public/js/api.js`

서버 호출을 감싸는 얇은 함수 모음(`api.characters()`, `api.saveSettings()` 등)과
`generate()` — SSE 응답을 파싱해 `onDelta`/`onThought`/`onSources` 콜백으로 나눠 줍니다.

### `public/js/ui.js`

가장 조심해서 고쳐야 할 파일입니다. DOM을 직접 조작하는 렌더 함수들과, **직접 구현한 마크다운
렌더러**(`renderMarkdown`)가 있습니다. 외부 라이브러리를 안 쓴 이유는 로컬 모델만 켜고
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
# app.js 가 쓰는 ui.* 가 전부 export 되는지 확인
python3 -c "
import re
ui = open('public/js/ui.js').read()
app = open('public/js/app.js').read()
exported = set(re.findall(r'export (?:function|const) (\w+)', ui))
used = set(re.findall(r'ui\.(\w+)', app)) - {'js'}
print('빠진 것:', used - exported or '없음')
"
```

### `public/js/select.js`

네이티브 `<select>`는 열었을 때 목록을 OS가 그려서 CSS가 안 닿습니다. `enhanceSelects()`가
모든 `select`를 찾아 화면에서는 숨기고(값의 주인은 여전히 select), 테마를 따르는 버튼+목록
쌍으로 감쌉니다. `select.value` setter를 가로채서, 코드가 값을 바꿔도 버튼 글자가 따라오게
합니다. 항목 수로 "고를 게 없다"를 판단하지 마세요 — `innerHTML`로 옵션을 갈아끼운 직후엔
`MutationObserver`가 아직 안 돈 상태라 비어 있는 것으로 오판합니다(실제로 겪은 버그).

### `public/js/app.js`

상태(`state`)와 이벤트 바인딩. 파일이 크니 검색으로 다니세요. 주요 상태:

```js
state = {
  settings, characters, personas, chats, chat,   // 서버 데이터 캐시
  abort,                                          // 진행 중인 생성의 AbortController
  mode,                                           // 'rp' | 'assistant'
  hideAdult,                                      // 성인 대화 숨김 (localStorage)
  pendingCharacter                                // 모드 선택 창에 띄운 캐릭터
}
```

스크롤은 `ui.watchScroll()`이 "사용자가 직접 위로 올렸는가"만 추적하는 pinned 방식입니다.
거리 기반 판정은 '응답 생성 중' 막대가 나타나 레이아웃이 바뀌는 순간 밀려나는 버그가 있어
버렸습니다.

---

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

```bash
node mock-something.mjs &
PORT=5199 node server.js &
sleep 2
curl -s -X PUT http://127.0.0.1:5199/api/settings -d '{"providers":{"lmstudio":{"baseUrl":"http://localhost:1234/v1", ...}}}'
curl -s -N -X POST http://127.0.0.1:5199/api/chats/$ID/generate -d '{}'
```

**같은 셸 호출 안에서 서버를 띄우고 테스트까지 끝내세요.** 백그라운드 프로세스(`&`)는 도구 호출이
끝나면 참조(`$!`)를 잃어버려 나중에 정리하기 까다롭습니다. `pkill -f "node server.js"`로
정리하거나, 매번 새 포트를 쓰는 것도 방법입니다.

`node mock-lmstudio.mjs`는 UI만 확인할 때 쓰는 기본 가짜 서버입니다. 모델에 `mock-7b`을
넣으면 실제 모델 없이 스트리밍 응답을 받을 수 있습니다.

---

## 10. Docker

```bash
docker compose up -d
```

컨테이너 안에서는 `localhost`가 호스트를 가리키지 않으므로, LM Studio 주소를
`http://host.docker.internal:1234/v1`로 잡아야 합니다. `docker-compose.yml`에
`extra_hosts: host.docker.internal:host-gateway`가 이미 들어 있습니다.

---

## 11. 새 엔진 추가하기

1. `src/providers.js`에 `async function* myEngine({ config, system, messages, params, signal, ... })`를
   씁니다. OpenAI 호환이면 새로 쓸 필요 없이 `openaiCompatible`을 재사용하세요.
2. `ADAPTERS`에 등록.
3. `listModels()`에 그 엔진의 목록 조회 분기를 추가 (페이지네이션·필터가 있다면 함께).
4. `src/store.js`의 `defaultSettings().providers`에 기본 항목 추가 (`label`, `type`, `baseUrl`, `model`, `unavailableModels: []`).
5. 성인 틀·웹 검색을 지원한다면 `supportsWebSearch()`, `isLocalUrl()` 판정에 반영.

이미 OpenAI/Anthropic/Gemini 형식 중 하나를 따르는 서비스라면, 개발자 설정의 **엔진 추가**로
코드 수정 없이 붙일 수 있습니다 (`type` 필드로 세 형식 중 하나를 고르는 방식).

## 12. 새 대화 모드 추가하기

1. `src/store.js`에 `export const MY_TEMPLATE = \`...\`;` 로 틀 작성.
2. `BUILTIN_TEMPLATES()` 배열에 `{ id, name, template: MY_TEMPLATE, adult }` 추가.
   **일반/성인 순서를 지키세요** — 일반 항목은 성인 항목보다 배열 앞쪽에 둡니다.
3. 표기법이 새로운 거라면 (`public/js/ui.js`의) `formatText`/`renderMarkdown`에 반영이 필요할 수
   있습니다.
4. `public/js/app.js`의 `MODE_NOTES`에 모드 선택 창에서 보여줄 한 줄 설명을 추가하면 좋습니다
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
`adult: true` 로 호출하면 대화의 성인 프리셋과 같은 규칙(`isLocalUrl`)을 한 번 더 검사합니다 —
로컬이 아니면 모델을 부르지 않고 바로 `fallback: true` 로 빠집니다. 씨앗을 굴리기만 하는
`/api/personas/roll` 은 모델을 안 부르므로 이 검사가 필요 없습니다.

`maxTokens` 는 설정값과 무관하게 700 으로 잘라 둡니다 — 한 문단이면 충분한데 4096 을 주면
로컬 모델이 계속 이어 씁니다.

프런트는 `public/js/app.js` 의 `seedDraft` 하나가 상태 전부입니다. 칩 클릭 → `only` 로 재굴림,
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
`server.js` 의 `CHARACTER_FIELDS` 와 같아야 합니다.

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
- **조사 교정과 마크다운 렌더러가 서버/클라이언트에 이중으로 존재**하는 이유는 브라우저가
  `src/`를 못 읽어서입니다. 감안하고 양쪽을 맞춰 고치세요.
- **`app.js`가 참조하는 DOM id, `ui.*`/`api.*` 이름은 전부 실존해야 합니다.** 어느 한쪽만
  고치면 부팅 자체가 멈춥니다. 8절의 점검 스니펫을 습관적으로 돌리세요.
