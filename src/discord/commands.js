/**
 * 슬래시 명령 정의. 디스코드 API 모양(JSON) 그대로 둡니다 — 빌더 없이 봐도 무엇이 등록되는지 알 수 있게.
 *   /rp start character:<자동완성> persona:<자동완성> mode:<자동완성> private:<예/아니오>
 *   /rp roll dice:<2d6+3> memo:<덧붙일 말> · /rp end · /rp link code:<코드> · /rp unlink
 *   /ask question:<질문> private:<예/아니오>   어시스턴트 스레드
 */

/** 옵션 종류 (Discord ApplicationCommandOptionType) */
const SUB = 1;
const STRING = 3;
const BOOLEAN = 5;

export const RP_COMMAND = {
  name: 'rp',
  description: 'AI 롤플레이',
  // 서버 채널에서만. 스레드를 만들어야 해서 DM 에서는 쓸 수 없습니다.
  contexts: [0],
  options: [
    {
      type: SUB, name: 'start', description: '캐릭터와 새 대화 스레드를 엽니다',
      options: [
        { type: STRING, name: 'character', description: '캐릭터', required: true, autocomplete: true },
        { type: STRING, name: 'persona', description: '내 페르소나 (비우면 기본 페르소나)', autocomplete: true },
        { type: STRING, name: 'mode', description: '대화 모드 (비우면 기본 모드)', autocomplete: true },
        { type: BOOLEAN, name: 'private', description: '비공개 스레드로 열지 (기본: 예)' }
      ]
    },
    {
      type: SUB, name: 'roll', description: '주사위를 굴려 결과를 내 차례로 보냅니다 (롤플레이 스레드에서)',
      options: [
        { type: STRING, name: 'dice', description: '예) d20, 2d6+3 — 눈은 4·6·8·10·12·20·100, 개수 1~10', required: true, max_length: 12 },
        { type: STRING, name: 'memo', description: '결과 앞에 붙일 내 말이나 행동', max_length: 1000 }
      ]
    },
    { type: SUB, name: 'end', description: '이 스레드의 대화를 보관하고 스레드를 닫습니다' },
    {
      type: SUB, name: 'link', description: '웹의 설정 → 디스코드에서 받은 코드로 앱 계정과 잇습니다',
      options: [{ type: STRING, name: 'code', description: '연결 코드 (XXXX-XXXX)', required: true, min_length: 8, max_length: 12 }]
    },
    { type: SUB, name: 'unlink', description: '앱 계정과의 연결을 끊습니다' }
  ]
};

export const ASK_COMMAND = {
  name: 'ask',
  description: 'AI 어시스턴트에게 묻습니다 (새 스레드에서 이어서 대화)',
  contexts: [0],
  options: [
    { type: STRING, name: 'question', description: '물어볼 것', required: true, max_length: 4000 },
    { type: BOOLEAN, name: 'private', description: '비공개 스레드로 열지 (기본: 예)' }
  ]
};

export const COMMANDS = [RP_COMMAND, ASK_COMMAND];
