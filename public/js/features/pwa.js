/** 홈 화면 설치 지원: 서비스 워커 등록. 주소가 https 이거나 localhost 일 때만 브라우저가 허락합니다. */
export class Pwa {
  register() {
    if (!('serviceWorker' in navigator)) return;
    // 첫 화면 그리기를 늦추지 않게 다 뜬 뒤에 등록합니다.
    addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    });
  }
}
