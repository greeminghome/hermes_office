# Hermes Office 인수인계 체크리스트

## 제공자가 넘길 것

- 이 GitHub 저장소의 태그 또는 검증된 commit SHA
- 기능 범위와 사용자별 에이전트/권한 정의
- 대상 VPS 사양, 도메인, DNS 및 리버스 프록시 요구사항
- 수령자가 직접 발급해야 할 OAuth client 목록
- 장애 연락처와 업데이트 정책

## 제공자가 넘기면 안 되는 것

- `.env`, 서버 백업, Docker volume archive
- OpenAI/ChatGPT, Google, 네이버, SpaceCloud, Instagram 로그인 토큰
- 브라우저 profile/cookie/localStorage 디렉터리
- 비공개 iCal URL, Telegram bot token, GitHub token
- 기존 사용자의 대화, 예약 원장, 고객 개인정보

## 수령자 설치

- [ ] 독립 VPS와 HTTPS 도메인을 준비했다.
- [ ] 수령자 전용 Hermes Agent를 설치했다.
- [ ] 제품명, 짧은 이름과 설명을 수령자 브랜드로 설정했다.
- [ ] 기본 `admin` 대신 수령자 전용 Office 로그인 ID와 새 비밀번호를 설정했다.
- [ ] 역할 기반 기본 프로필 ID와 실제 Hermes Agent 프로필 ID를 일치시켰다.
- [ ] `install.sh --init-only`로 새 비밀값을 생성했다.
- [ ] Office와 Agent 포트를 인터넷에 직접 노출하지 않았다.
- [ ] `doctor.sh --strict-agent`가 성공한다.
- [ ] 수령자가 Office와 Hermes OAuth에 직접 로그인했다.
- [ ] Google OAuth consent 화면의 계정과 프로젝트 소유자를 확인했다.
- [ ] 에이전트별 Live Screen browser context가 서로 분리되어 있다.
- [ ] 예약 동기화는 `shadow`로 시작한다.

## 기능 인수 테스트

- [ ] 대시보드 메뉴와 모든 주요 상세 탭이 열린다.
- [ ] 채팅 입력, 응답, 세션 재개가 동작한다.
- [ ] 파일 업로드와 데이터룸 권한이 기대대로 동작한다.
- [ ] 에이전트별 Live Screen에서 클릭·스크롤·타이핑이 동작한다.
- [ ] 컨테이너 재시작 후 상태와 데이터가 유지된다.
- [ ] Google Calendar/Gmail/Drive에 연결된 계정이 수령자 계정이다.
- [ ] iCal 소스가 수령자 사업장 URL이다.
- [ ] 중복 일정, 시간대, 취소 반영을 shadow 원장에서 검증했다.
- [ ] 실제 예약을 생성·취소하지 않고 네이버 writer 계정/상품을 검증했다.
- [ ] 백업을 만들고 별도 테스트 프로젝트에서 복원했다.
- [ ] CI의 lint, test, build, package secret scan, Docker build가 모두 통과한다.

모든 항목을 확인한 뒤에만 외부 채널 writer를 한 채널씩 활성화합니다.
