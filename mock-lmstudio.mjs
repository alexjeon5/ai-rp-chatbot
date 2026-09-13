// 스모크 테스트용 가짜 OpenAI 호환 서버. 실제 사용과는 무관합니다.
import http from 'node:http';

http.createServer((req, res) => {
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-7b' }, { id: 'mock-13b' }] }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    console.log('[mock] system 길이:', parsed.messages[0].content.length);
    console.log('[mock] system:\n' + parsed.messages[0].content);
    console.log('[mock] turns:', JSON.stringify(parsed.messages.slice(1)));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of ['*고개를 든다.* ', '"늦었네."']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
}).listen(1234, () => console.log('mock ready'));
