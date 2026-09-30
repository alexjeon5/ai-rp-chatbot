/**
 * 기본 시나리오가 부르지 않는 보관함 경로: 로어북, 검색, 붙인 그림, 프로필·표정·배경 그림, 캐릭터 카드, 멈추기.
 * 계정별 나누기 작업에서 '대화에 딸린 파일'과 '목록 거르기'가 바뀌지 않았는지 보려고 따로 둡니다.
 */

// 가장 작은 PNG 머리. 서버는 파일 머리만 보고 종류를 정합니다.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);

export async function scenario({ call }) {
  const characters = await call('characters', 'GET', '/api/characters');
  const yuha = characters.find((c) => c.name === '유하린');

  /* ---------- 로어북 ---------- */
  const world = await call('lorebook: 만들기', 'POST', '/api/lorebooks', {
    name: '옥상 세계', global: true, entries: [{ title: '옥상', keys: ['옥상'], content: '옥상 문은 늘 잠겨 있다.' }]
  });
  const bound = await call('lorebook: 캐릭터 책', 'POST', '/api/lorebooks', {
    name: '하린 설정', characterIds: [yuha.id, 'nope'], entries: [{ title: '비밀', keys: ['비밀'], content: '하린은 고양이를 키운다.' }]
  });
  const loose = await call('lorebook: 대화 책', 'POST', '/api/lorebooks', { name: '따로 붙일 책', entries: [{ keys: ['별'], content: '별이 많다.' }] });
  await call('lorebook: 이름 없음', 'POST', '/api/lorebooks', { name: ' ' });
  await call('lorebook: 고치기', 'PUT', `/api/lorebooks/${world.id}`, { description: '학교 옥상' });
  await call('lorebook: 없는 것 고치기', 'PUT', '/api/lorebooks/nope', { description: 'x' });
  await call('lorebook: 시험', 'POST', `/api/lorebooks/${world.id}/test`, { text: '옥상으로 가자' });
  await call('lorebook: 없는 것 시험', 'POST', '/api/lorebooks/nope/test', { text: 'x' });
  await call('lorebooks', 'GET', '/api/lorebooks');

  /* ---------- 대화와 딸린 것 ---------- */
  const chat = await call('chat: 만들기', 'POST', '/api/chats', { characterId: yuha.id });
  await call('chat: 책 붙이기', 'PUT', `/api/chats/${chat.id}`, { lorebookIds: [loose.id, 'nope', loose.id, 3] });
  await call('msg', 'POST', `/api/chats/${chat.id}/messages`, { content: '옥상에서 비밀 얘기를 하자, 별이 보여' });
  await call('lore: 대화', 'GET', `/api/chats/${chat.id}/lore`);
  await call('lore: 없는 대화', 'GET', '/api/chats/nope/lore');
  await call('system: 로어북 들어감', 'GET', `/api/chats/${chat.id}/system`);

  const up = await call('attachment: 올리기', 'POST', `/api/chats/${chat.id}/attachments`, PNG);
  await call('attachment: 그림 아님', 'POST', `/api/chats/${chat.id}/attachments`, Buffer.from('not an image at all'));
  await call('attachment: 없는 대화', 'POST', '/api/chats/nope/attachments', PNG);
  await call('attachment: 파일', 'GET', `/api/uploads/${chat.id}/${up.file}`);
  await call('attachment: 없는 대화의 파일', 'GET', `/api/uploads/nope/${up.file}`);
  await call('msg: 그림 붙여 보내기', 'POST', `/api/chats/${chat.id}/messages`, { content: '이것 봐', attachments: [{ file: up.file, name: '사진' }, { file: 'nope.png' }] });
  await call('attachment: 붙은 것 빼기', 'DELETE', `/api/chats/${chat.id}/attachments/${up.file}`);
  const spare = await call('attachment: 하나 더', 'POST', `/api/chats/${chat.id}/attachments`, PNG);
  await call('attachment: 안 붙은 것 빼기', 'DELETE', `/api/chats/${chat.id}/attachments/${spare.file}`);
  await call('attachment: 없는 대화에서 빼기', 'DELETE', `/api/chats/nope/attachments/${spare.file}`);
  await call('stop: 없는 대화', 'POST', '/api/chats/nope/stop', {});

  /* ---------- 검색 ---------- */
  await call('search', 'GET', `/api/search?q=${encodeURIComponent('옥상 비밀')}`);
  await call('search: rp', 'GET', `/api/search?q=${encodeURIComponent('유하린')}&kind=rp`);
  await call('search: 빈 검색어', 'GET', '/api/search?q=');

  /* ---------- 프로필·표정 ---------- */
  await call('portrait: 올리기', 'PUT', `/api/characters/${yuha.id}/portrait`, PNG);
  await call('portrait: 없는 캐릭터', 'PUT', '/api/characters/nope/portrait', PNG);
  const withFace = await call('expression: 올리기', 'PUT', `/api/characters/${yuha.id}/expressions?label=${encodeURIComponent('웃음')}`, PNG);
  await call('expression: 이름 없음', 'PUT', `/api/characters/${yuha.id}/expressions?label=`, PNG);
  await call('character-art: 파일', 'GET', `/api/character-art/${yuha.id}/${withFace.portrait}`);
  await call('character-art: 없는 캐릭터', 'GET', `/api/character-art/nope/${withFace.portrait}`);
  await call('expression: 지우기', 'DELETE', `/api/characters/${yuha.id}/expressions?label=${encodeURIComponent('웃음')}`);
  await call('expression: 없는 것 지우기', 'DELETE', `/api/characters/${yuha.id}/expressions?label=x`);
  await call('portrait: 지우기', 'DELETE', `/api/characters/${yuha.id}/portrait`);

  /* ---------- 배경 ---------- */
  const bg = await call('background: 올리기', 'POST', `/api/backgrounds?name=${encodeURIComponent('옥상')}`, PNG);
  await call('background: 이름 없음', 'POST', '/api/backgrounds?name=', PNG);
  await call('background: 이름 바꾸기', 'PUT', `/api/backgrounds/${bg.id}`, { name: '밤 옥상' });
  await call('background: 없는 것', 'PUT', '/api/backgrounds/nope', { name: 'x' });
  await call('backgrounds', 'GET', '/api/backgrounds');
  await call('background-art: 파일', 'GET', `/api/background-art/${bg.id}/${bg.file}`);
  await call('background-art: 없는 배경', 'GET', `/api/background-art/nope/${bg.file}`);
  await call('chat: 비주얼 노벨', 'PUT', `/api/chats/${chat.id}`, { vn: true });
  await call('system: 배경 이름', 'GET', `/api/chats/${chat.id}/system`);
  await call('background: 지우기', 'DELETE', `/api/backgrounds/${bg.id}`);
  await call('background: 없는 것 지우기', 'DELETE', '/api/backgrounds/nope');

  /* ---------- 캐릭터 카드 ---------- */
  await call('card: 내보내기', 'GET', `/api/characters/${yuha.id}/export`);
  await call('card: 없는 캐릭터', 'GET', '/api/characters/nope/export');
  const imported = await call('card: 가져오기', 'POST', '/api/characters/import', {
    card: { spec: 'chara_card_v2', data: { name: '카드 인물', first_mes: '안녕', character_book: { name: '카드 세계', entries: [{ keys: ['k'], content: 'v' }] } } }
  });
  await call('card: 카드 아님', 'POST', '/api/characters/import', {});

  /* ---------- 지우기 ---------- */
  await call('lorebook: 지우기(대화에서 빠짐)', 'DELETE', `/api/lorebooks/${loose.id}`);
  await call('lorebook: 없는 것 지우기', 'DELETE', '/api/lorebooks/nope');
  await call('chat: 뗀 뒤', 'GET', `/api/chats/${chat.id}`);
  await call('character: 카드 인물 지우기', 'DELETE', `/api/characters/${imported.character.id}`);
  await call('lorebooks: 마지막', 'GET', '/api/lorebooks');
  await call('chat: 지우기', 'DELETE', `/api/chats/${chat.id}`);
  await call('attachment: 지운 대화의 파일', 'GET', `/api/uploads/${chat.id}/${up.file}`);
  await call('bound 책 남음', 'PUT', `/api/lorebooks/${bound.id}`, { global: false });
}
