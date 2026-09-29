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
