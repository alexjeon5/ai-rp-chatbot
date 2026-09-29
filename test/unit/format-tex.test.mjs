import test from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from '../../public/js/ui/format.js';

const line = '- 내부 깊이: 3.5cm $\\rightarrow$ 7.2cm';

test('수식 표기: 롤플레이·메신저·마크다운 모두 기호로', () => {
  assert.match(formatText(line), /3\.5cm → 7\.2cm/);
  assert.match(formatText(line, { bubbles: true }), /3\.5cm → 7\.2cm/);
  assert.equal(formatText(line, { plain: true }), '<ul><li><p>내부 깊이: 3.5cm → 7.2cm</p></li></ul>');
});

test('수식 표기: 각도, 화살표, 말줄임', () => {
  assert.match(formatText('기울기 $30^\\circ$, $45^{\\circ}$'), /기울기 30°, 45°/);
  assert.match(formatText('$A \\Rightarrow B$ 그리고 $x \\uparrow$ $\\ldots$'), /A ⇒ B 그리고 x ↑ …/);
});

test('수식 표기: 금액이나 모르는 명령은 그대로', () => {
  assert.match(formatText('$5 에서 $10 으로'), /\$5 에서 \$10 으로/);
  assert.match(formatText('$\\frac{1}{2}$'), /\$\\frac\{1\}\{2\}\$/);
});

test('롤플레이: # 제목·*** 구분선·목록·인용은 블록으로, RP 표기는 그대로', () => {
  const html = formatText('***\n\n### 📁 [ARCHIVE_H: 영상 기록]\n\n- HP: 100\n- MP: 20\n\n> 경고: 기록됨\n\n미나: "안녕?" *손을 흔든다*');
  assert.equal(html,
    '<hr><h3>📁 [ARCHIVE_H: 영상 기록]</h3><ul><li>HP: 100</li><li>MP: 20</li></ul>' +
    '<blockquote><span class="speaker">경고</span>: 기록됨</blockquote>' +
    '<span class="speaker">미나</span>: <q>안녕?</q> <em>손을 흔든다</em>');
});

test('롤플레이: 마크다운이 아닌 줄은 건드리지 않음', () => {
  assert.equal(formatText('* 웃는다 *\n#일상 #카페\n\n2024. 9. 28. 맑음'), '<em> 웃는다 </em>\n#일상 #카페\n\n2024. 9. 28. 맑음');
});
