/**
 * 랜덤 페르소나의 '씨앗 태그'를 뽑습니다.
 *
 * 1단계(여기) — 표를 굴려 모순 없는 태그 조합을 만듭니다. 모델을 부르지 않으므로 즉시 끝납니다.
 * 2단계(src/persona-gen.js) — 그 태그를 모델에 넘겨 소개 문장을 씁니다.
 *
 * 항목을 늘리려면 POOLS 의 배열에 문자열만 더하면 됩니다.
 * 같이 나오면 어색한 조합은 CONFLICTS 에 짝으로 적습니다.
 */

const SURNAMES = ['김', '이', '박', '정', '최', '강', '조', '윤', '한', '서', '신', '권', '황', '안', '송', '류', '전', '홍', '고', '문'];

const GIVEN = {
  여성: ['서연', '하린', '지우', '수아', '유진', '예린', '다은', '세아', '가을', '민주', '채원', '소율', '연우', '지안', '나윤', '은해', '해원', '시아'],
  남성: ['도현', '준서', '시우', '지환', '태인', '현우', '민재', '유겸', '재율', '선호', '하준', '연호', '윤성', '건우', '정후', '서진', '우진', '한결']
};

const POOLS = {
  gender: ['여성', '남성'],

  age: ['10대 후반', '20대 초반', '20대 중반', '20대 후반', '30대 초반', '30대 중반', '나이를 밝히지 않음'],

  role: [
    '대학생', '휴학하고 아르바이트 중', '편의점 야간 알바', '갓 입사한 신입사원',
    '작은 출판사 편집자', '카페를 혼자 꾸리는 사장', '프리랜서 일러스트레이터',
    '동네 서점 직원', '병원 3년차 간호사', '중학교 기간제 교사',
    '망한 밴드의 전 보컬', '이름 없는 웹소설 작가', '영화관 매점 직원',
    '무슨 일을 하는지 잘 말하지 않음', '가업인 국밥집을 물려받는 중',
    '연구실에 사는 대학원생', '헬스장 트레이너', '오래된 세탁소 집 아들딸'
  ],

  look: [
    '눈매가 서늘하다', '웃으면 눈이 사라진다', '늘 다크서클이 짙다',
    '키가 크고 어깨가 넓다', '체구가 작고 손이 유난히 희다', '목덜미에 오래된 흉터가 있다',
    '머리를 아무렇게나 묶고 다닌다', '탈색이 반쯤 빠진 머리', '단정하게 자른 검은 머리',
    '늘 같은 낡은 재킷을 입는다', '손톱이 짧고 물어뜯은 자국이 있다',
    '안경을 자주 올려 쓴다', '귀에 피어싱이 여러 개', '옷차림이 계절보다 한 발 앞선다',
    '표정 변화가 거의 없다', '걸음이 빠르고 보폭이 크다'
  ],

  trait: [
    '무뚝뚝하다', '낯을 가린다', '겁이 없다', '쓸데없이 솔직하다',
    '사람을 잘 믿는다', '의심이 많다', '지기 싫어한다', '금방 삐진다',
    '남 챙기는 게 습관이다', '혼자 있는 시간을 반드시 지킨다',
    '농담으로 위기를 넘긴다', '화를 내는 법을 모른다', '한번 정하면 안 바꾼다',
    '충동적으로 움직인다', '계획 없이는 불안하다', '뒤끝이 길다',
    '호기심이 많다', '체념이 빠르다'
  ],

  speech: [
    '말이 짧고 문장을 끝까지 안 맺는다', '존댓말이 몸에 배어 있다',
    '반말이 편하고 거침없다', '사투리가 가끔 튀어나온다',
    '농담을 진지한 얼굴로 한다', '말끝을 흐린다',
    '말이 빠르고 많다', '한참 뜸을 들이고 답한다',
    '욕을 섞지만 악의는 없다', '남의 말을 그대로 따라 되묻는다',
    '경어와 반말을 섞어 쓴다', '목소리가 낮고 조용하다'
  ],

  hook: [
    '고향을 떠나 온 지 얼마 되지 않았다', '최근에 오래된 연애를 끝냈다',
    '가족과 연락을 끊고 지낸다', '빚을 대신 갚아 주고 있다',
    '잃어버린 사람을 아직 찾고 있다', '이름을 한 번 바꾼 적이 있다',
    '밤에 잠을 거의 자지 못한다', '한 가지 취미에 돈을 다 쓴다',
    '남몰래 글을 쓴다', '고양이 한 마리와 산다',
    '돌아갈 자리를 일부러 남겨 두지 않았다', '약속 시간에 늘 먼저 나와 기다린다',
    '전에 하던 일을 그만둔 이유를 말하지 않는다', '특별할 것 없는 하루를 좋아한다'
  ]
};

/** 배열로 뽑는 항목과 그 개수. 여기 없는 항목은 문자열 하나입니다. */
const MULTI = { look: 2, trait: 2 };

/** 같이 나오면 어색한 짝. 순서는 상관없습니다. */
const CONFLICTS = [
  ['무뚝뚝하다', '말이 빠르고 많다'],
  ['무뚝뚝하다', '농담으로 위기를 넘긴다'],
  ['낯을 가린다', '반말이 편하고 거침없다'],
  ['낯을 가린다', '말이 빠르고 많다'],
  ['계획 없이는 불안하다', '충동적으로 움직인다'],
  ['의심이 많다', '사람을 잘 믿는다'],
  ['화를 내는 법을 모른다', '뒤끝이 길다'],
  ['존댓말이 몸에 배어 있다', '욕을 섞지만 악의는 없다'],
  ['존댓말이 몸에 배어 있다', '반말이 편하고 거침없다'],
  ['10대 후반', '갓 입사한 신입사원'],
  ['10대 후반', '병원 3년차 간호사'],
  ['10대 후반', '중학교 기간제 교사'],
  ['10대 후반', '연구실에 사는 대학원생'],
  ['10대 후반', '카페를 혼자 꾸리는 사장'],
  ['10대 후반', '망한 밴드의 전 보컬'],
  ['30대 중반', '대학생'],
  ['표정 변화가 거의 없다', '웃으면 눈이 사라진다'],
  ['눈매가 서늘하다', '웃으면 눈이 사라진다'],
  ['체념이 빠르다', '지기 싫어한다']
];

/** 씨앗 항목의 순서와 화면에 쓸 이름. UI 가 이 순서대로 칩을 그립니다. */
export const SEED_FIELDS = [
  { key: 'name', label: '이름' },
  { key: 'gender', label: '성별' },
  { key: 'age', label: '나이대' },
  { key: 'role', label: '직업·신분' },
  { key: 'look', label: '외모' },
  { key: 'trait', label: '성격' },
  { key: 'speech', label: '말투' },
  { key: 'hook', label: '사연' }
];

export const SEED_KEYS = SEED_FIELDS.map((f) => f.key);

/**
 * 성인 모드용 풀입니다. 일반 풀(POOLS)과 완전히 분리되어 있어서, 성인 체크박스를
 * 껐을 때는 이 배열이 아예 참조되지 않습니다.
 *
 * 나이대는 일부러 20대부터 시작합니다 — "10대 후반"처럼 미성년으로 읽힐 여지가 있는
 * 값은 성인 풀에 절대 넣지 않습니다. 여기 내용도 노골적인 묘사가 아니라 관계·태도에
 * 관한 힌트 수준입니다. 실제 성인 서술은 대화 쪽 시스템 프롬프트(성인 롤플레이 등)가
 * 맡고, 여기서는 그런 이야기가 자연스러울 인물의 배경만 만듭니다.
 */
const ADULT_POOLS = {
  gender: POOLS.gender,

  age: ['20대 초반', '20대 중반', '20대 후반', '30대 초반', '30대 중반', '30대 후반', '40대'],

  role: [
    ...POOLS.role,
    '바를 혼자 운영하는 사장', '타투이스트', '나이트 근무가 잦은 소방관',
    '이혼 전문 변호사', '재즈바 피아니스트', '스포츠 마사지사', '나이 차 많은 상사'
  ],

  look: [
    ...POOLS.look,
    '눈이 마주치면 피하지 않는다', '목소리가 낮고 울림이 있다',
    '스킨십에 거리낌이 없다', '술 냄새가 은은히 밴 재킷',
    '셔츠 단추를 하나 더 풀어 둔다', '손끝이 유난히 차갑다'
  ],

  trait: [
    ...POOLS.trait,
    '가벼운 관계를 편하게 여긴다', '한 사람에게 깊이 빠지는 편이다',
    '질투를 숨기지 못한다', '유혹하듯 말해 놓고 정색한다',
    '거절을 잘 못한다', '선을 긋다가도 쉽게 무너진다',
    '연애에 서툴다고 스스로 말한다', '독점욕이 강하다'
  ],

  speech: [
    ...POOLS.speech,
    '장난스럽게 밀고 당긴다', '낮은 목소리로 능청스럽게 말한다',
    '귓가에 대고 속삭이듯 말한다', '취하면 말이 솔직해진다',
    '존댓말과 반말을 넘나들며 거리를 흔든다'
  ],

  hook: [
    ...POOLS.hook,
    '가벼운 관계만 원한다고 말해 왔다', '전 연인과 아직 정리되지 않았다',
    '하룻밤 인연을 반복해 왔다', '누군가와 동거를 시작한 지 얼마 안 됐다',
    '오래 짝사랑해 온 사람이 있다', '술김에 저지른 일을 후회하는 중이다',
    '몸이 먼저 가까워진 뒤에야 마음을 깨달았다'
  ]
};

/** 성인 풀 안에서만 부딪히는 짝. 일반 CONFLICTS 와 합쳐서 씁니다. */
const ADULT_CONFLICTS = [
  ['가벼운 관계를 편하게 여긴다', '한 사람에게 깊이 빠지는 편이다'],
  ['거절을 잘 못한다', '선을 긋다가도 쉽게 무너진다'],
  ['무뚝뚝하다', '장난스럽게 밀고 당긴다'],
  ['무뚝뚝하다', '낮은 목소리로 능청스럽게 말한다'],
  ['낯을 가린다', '스킨십에 거리낌이 없다'],
  ['연애에 서툴다고 스스로 말한다', '독점욕이 강하다']
];

const ALL_CONFLICTS = [...CONFLICTS, ...ADULT_CONFLICTS];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const conflicts = (a, b) =>
  ALL_CONFLICTS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/** 이미 뽑힌 값들과 부딪히지 않는 후보만 남깁니다. 전부 걸리면 원본을 그대로 씁니다. */
function compatible(pool, chosen) {
  const flat = Object.values(chosen).flat().filter((v) => typeof v === 'string');
  const ok = pool.filter((v) => !flat.includes(v) && !flat.some((c) => conflicts(v, c)));
  return ok.length ? ok : pool;
}

function rollName(gender) {
  const given = GIVEN[gender] || [...GIVEN.여성, ...GIVEN.남성];
  return pick(SURNAMES) + pick(given);
}

function rollOne(key, chosen, pools) {
  if (key === 'name') return rollName(chosen.gender || pick(pools.gender));
  const pool = compatible(pools[key] || [], chosen);
  const count = MULTI[key];
  if (!count) return pick(pool);

  const out = [];
  const taken = { ...chosen };
  for (let i = 0; i < count; i += 1) {
    const value = pick(compatible(pool.filter((v) => !out.includes(v)), taken));
    out.push(value);
    taken[`${key}_${i}`] = value;
  }
  return out;
}

/**
 * 씨앗 태그를 뽑습니다.
 * @param {object} keep  그대로 둘 항목 (예: { name: '한서윤' }) — 잠근 칩이 여기로 옵니다.
 * @param {string[]} only  이 항목들만 다시 굴립니다. 비우면 keep 을 뺀 전부.
 * @param {boolean} adult  true 면 ADULT_POOLS 에서만 뽑습니다. 두 풀은 섞이지 않습니다.
 */
export function rollSeeds(keep = {}, only = null, adult = false) {
  const pools = adult ? ADULT_POOLS : POOLS;
  const kept = sanitizeSeeds(keep);
  const has = (key) => kept[key] !== undefined;
  // 성별을 다시 굴리면 이름도 따라가야 합니다. 안 그러면 성별과 안 맞는 이름이 남습니다.
  const targets = only && only.includes('gender') && !only.includes('name')
    ? [...only, 'name']
    : only;
  // only 를 주면 그 항목만 다시 굴리고, 나머지는 keep 값을 그대로 둡니다.
  const shouldRoll = (key) => (targets ? targets.includes(key) : !has(key));

  const chosen = {};
  for (const key of SEED_KEYS) if (!shouldRoll(key) && has(key)) chosen[key] = kept[key];

  // 성별을 먼저 정해야 이름을 뽑을 수 있습니다.
  for (const key of ['gender', ...SEED_KEYS.filter((k) => k !== 'gender')]) {
    if (chosen[key] === undefined) chosen[key] = rollOne(key, chosen, pools);
  }

  // SEED_FIELDS 순서로 정리해서 돌려줍니다.
  const out = {};
  for (const key of SEED_KEYS) out[key] = chosen[key];
  return out;
}

/** 씨앗을 사람이 읽는 한 줄로. 모델 프롬프트와 화면 양쪽에서 씁니다. */
export function seedsToLines(seeds = {}) {
  return SEED_FIELDS
    .map(({ key, label }) => {
      const value = seeds[key];
      const text = Array.isArray(value) ? value.join(', ') : value;
      return text ? `${label}: ${text}` : null;
    })
    .filter(Boolean);
}

/** 받은 씨앗에서 알 수 없는 키를 걸러냅니다 (클라이언트가 보낸 값 검증용). */
export function sanitizeSeeds(input = {}) {
  const out = {};
  for (const key of SEED_KEYS) {
    const value = input?.[key];
    if (Array.isArray(value)) {
      const list = value.filter((v) => typeof v === 'string' && v.trim()).slice(0, 4).map((v) => v.slice(0, 60));
      if (list.length) out[key] = list;
    } else if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim().slice(0, 60);
    }
  }
  return out;
}
