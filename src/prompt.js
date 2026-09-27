/** 캐릭터 / 페르소나 / 템플릿을 하나의 시스템 프롬프트로 조립합니다. */
import { substitute, fillTokens } from '../public/js/shared/korean.js';

/** {{char}}·{{user}} 를 이름으로 바꿉니다. particleFix 면 뒤에 붙은 조사를 받침에 맞춥니다(shared/korean.js). */
export function fillVars(text = '', { char, user, particleFix = true }) {
  const put = particleFix ? substitute : (t, token, value) => t.replaceAll(token, value);
  return fillTokens(text, char || '캐릭터', user || '사용자', put);
}

/** 함께 등장하는 인물들의 설정을 한 덩어리로 만듭니다. */
function buildCastBlock(cast = []) {
  if (!cast.length) return '';
  const sheets = cast.map((c) => {
    const lines = [`### ${c.name}`];
    if (c.description?.trim()) lines.push(c.description.trim());
    if (c.personality?.trim()) lines.push(`성격: ${c.personality.trim()}`);
    if (c.speech?.trim()) lines.push(`말투: ${c.speech.trim()}`);
    return lines.join('\n');
  });
  return sheets.join('\n\n');
}

/**
 * 페르소나를 {{persona}} 자리에 들어갈 글로 만듭니다. 소개 문단 뒤에 성별·나이·특징 목록을 붙입니다.
 * 비어 있는 항목은 줄째로 빠지고, 전부 비어 있으면 빈 문자열입니다.
 */
export function personaBlock(persona) {
  if (!persona) return '';
  const lines = [];
  if (persona.description?.trim()) lines.push(persona.description.trim());
  if (persona.gender?.trim()) lines.push(`성별: ${persona.gender.trim()}`);
  if (persona.age?.trim()) lines.push(`나이: ${persona.age.trim()}`);
  const traits = (Array.isArray(persona.traits) ? persona.traits : [])
    .map((t) => String(t).trim()).filter(Boolean);
  if (traits.length) lines.push(`특징:\n${traits.map((t) => `- ${t}`).join('\n')}`);
  return lines.join('\n');
}

export function buildSystem({ character, persona, template, cast = [], facts = [], memory = '', particleFix = true }) {
  const vars = { char: character.name, user: persona?.name || '사용자', particleFix };

  // 자리표시자가 하나도 없는 틀(직접 써 온 프롬프트 등)이면 배역 정보가 들어갈 곳이 없습니다.
  // 그런 경우에만 앞쪽에 배역 블록을 덧붙입니다.
  if (!template.includes('{{char}}') && !template.includes('{{캐릭터}}')) {
    template = `${template.trim()}\n\n# 등장인물\n이름: {{char}}\n{{description}}\n성격: {{personality}}\n말투: {{speech}}\n배경: {{scenario}}\n\n# 상대역\n이름: {{user}}\n{{persona}}`;
  }

  const castBlock = buildCastBlock(cast);
  const slots = {
    '{{cast}}': castBlock,
    '{{description}}': character.description,
    '{{personality}}': character.personality,
    '{{speech}}': character.speech,
    '{{scenario}}': character.scenario,
    '{{persona}}': personaBlock(persona)
  };

  // 비어 있는 항목은 라벨까지 통째로 지워, 빈 줄이 남지 않게 합니다.
  let out = template;
  for (const [slot, value] of Object.entries(slots)) {
    if (value && value.trim()) {
      out = out.replaceAll(slot, value.trim());
    } else {
      out = out.split('\n').filter((line) => !line.includes(slot)).join('\n');
    }
  }

  // 자리표시자가 없는 틀에도 출연 인물이 들어가야 하므로 뒤에 붙입니다.
  if (castBlock && !template.includes('{{cast}}')) {
    out += `\n\n# 함께 등장하는 인물\n${castBlock}`;
  }
  if (castBlock) {
    out += '\n\n이 인물들은 {{char}}와 마찬가지로 당신이 연기합니다. ' +
      '서로 말을 주고받게 하고, 장면에 필요하면 먼저 나서게 하세요. ' +
      '여러 인물이 말할 때는 대사 줄 맨 앞에 "이름:" 을 붙여 누가 말하는지 구분하세요. ' +
      '모든 인물이 매번 말할 필요는 없습니다. 장면에 맞는 인물만 나서게 하세요. ' +
      '다만 {{user}}의 대사와 행동은 여전히 쓰지 않습니다.';
  }

  if (character.exampleDialogue?.trim()) {
    out += `\n\n# 대화 예시\n${character.exampleDialogue.trim()}`;
  }
  if (character.notes?.trim()) {
    out += `\n\n# 추가 설정\n${character.notes.trim()}`;
  }
  // 대화 중에 모아 둔 사실 목록. 약속·호칭·취향처럼 어긋나면 티가 나는 것들입니다.
  const factLines = (facts || []).map((f) => f?.text?.trim()).filter(Boolean);
  if (factLines.length) {
    out += `\n\n# 기억해 둔 사실\n이 대화에서 이미 확정된 사실입니다. 어긋나지 않게 하세요.\n${factLines.map((t) => `- ${t}`).join('\n')}`;
  }
  // 기억할 메시지 수 밖으로 밀려난 대화의 요약. 맨 뒤에 두어 가장 최근 사정으로 읽히게 합니다.
  if (memory?.trim()) {
    out += `\n\n# 지금까지의 이야기\n아래는 앞선 대화의 요약입니다. 이 내용과 어긋나지 않게 이어 가세요.\n${memory.trim()}`;
  }

  return fillVars(out, vars).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Gemma 4 는 시스템 프롬프트 맨 앞의 <|think|> 토큰이 있을 때만 사고 모드로 들어갑니다.
 * 로컬 엔진에서 사고를 켜고 끌 때 씁니다.
 */
export function withThinking(system, on) {
  const cleaned = system.replace(/^<\|think\|>\s*/, '');
  return on ? `<|think|>\n${cleaned}` : cleaned;
}

