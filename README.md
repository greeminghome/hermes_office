# Hermes Office deployment package

Hermes Agent를 대시보드, 실시간 채팅, Live Screen, 데이터룸, 조직 운영 및 예약
동기화 UI와 연결하는 자체 호스팅 패키지입니다. 새 사용자에게 이식할 때 운영 VPS의
파일을 복제하지 않고 이 저장소에서 독립 설치하도록 설계했습니다.

실제 OAuth 토큰, 브라우저 프로필, iCal 비공개 URL, 예약 DB, 비밀번호와 기존 대화
데이터는 포함하지 않습니다. 예약 동기화와 외부 채널 writer는 모두 비활성화된
`shadow` 상태로 시작합니다.

## 빠른 설치

Ubuntu/Debian 계열 VPS와 Docker Engine + Docker Compose v2를 권장합니다.

```bash
git clone https://github.com/greeminghome/hermes_office.git
cd hermes_office
PUBLIC_ORIGIN=https://office.example.com ./deploy/scripts/install.sh --init-only
```

설치 프로그램이 Office 로그인 비밀번호를 안전하게 입력받고 새 세션 서명키와
에이전트 읽기 토큰을 생성합니다. 이어서 `.env`에서 `HERMES_TARGET`과 필요한
네트워크 설정을 확인한 후 실행합니다.

```bash
./deploy/scripts/install.sh
```

기본 포트는 서버의 `127.0.0.1:4173`에만 바인딩됩니다. 공개 HTTPS는 기존
리버스 프록시 또는 제공된 Traefik 오버레이를 사용하세요. 자세한 설치와 네트워크
구성은 [배포 가이드](docs/DEPLOYMENT.md)를 따릅니다.

## 구성

- `docker-compose.office.yml`: 이식 가능한 기본 런타임
- `.env.example`: 비밀값 없는 전체 설정 템플릿
- `deploy/docker-compose.agent-network.yml`: 별도 Docker 네트워크의 Hermes Agent 연결
- `deploy/docker-compose.traefik.yml`: 선택형 HTTPS 라우팅
- `deploy/hermes-agent/`: 세션별 Live Screen을 위한 선택형 Agent 호환 이미지
- `deploy/scripts/install.sh`: 초기화, 이미지 준비, 기동, 헬스 검증
- `deploy/scripts/doctor.sh`: 설정·컨테이너·볼륨·Agent 연결 진단
- `deploy/scripts/backup.sh`: 정합성 있는 cold backup
- `deploy/scripts/restore.sh`: 체크섬 검증과 명시적 확인이 있는 복원
- `deploy/scripts/update.sh`: 사전 백업, fast-forward 업데이트, 런타임 롤백

애플리케이션 데이터는 `office-chat-files`, `office-workspace`,
`office-google-drive`, `office-reservations`라는 프로젝트별 Docker 볼륨에
분리됩니다. 컨테이너는 읽기 전용 루트 파일시스템, 모든 Linux capability 제거,
호스트 사용자 UID/GID로 실행됩니다.

## 새 소유자가 다시 연결해야 하는 계정

아래 연결은 복사하거나 공유하지 말고 새 설치의 UI에서 새 소유자가 직접 로그인해야
합니다.

- Hermes/OpenAI 또는 ChatGPT OAuth
- Gmail 및 Google Calendar OAuth
- Google Drive read-only OAuth
- 네이버 스마트플레이스 브라우저 세션
- 스페이스클라우드 브라우저 세션
- 아워플레이스·스페이스클라우드 iCal URL
- Instagram, Telegram 및 기타 플러그인 자격증명

예약 writer는 읽기와 계정 검증을 먼저 완료한 뒤 한 채널씩 활성화해야 합니다.
네이버 실제 예약 생성·취소를 검증 수단으로 사용하지 마세요.

## 운영 명령

```bash
./deploy/scripts/doctor.sh --strict-agent
./deploy/scripts/backup.sh
./deploy/scripts/update.sh
./deploy/scripts/restore.sh ./backups/20260823T120000Z --confirm-restore
```

백업에는 OAuth 자료가 들어갈 수 있으므로 비밀파일로 취급해야 합니다. 다른 사람에게
넘길 때는 백업을 전달하지 말고 [인수인계 체크리스트](docs/HANDOFF_CHECKLIST.md)를
사용하세요. 보안 원칙과 유출 대응은 [SECURITY.md](SECURITY.md)에 정리되어 있습니다.

## 개발 검증

```bash
npm ci
npm run verify
docker compose --env-file .env.example -f docker-compose.office.yml config --quiet
```

`main` 브랜치와 pull request에서는 같은 검사와 Docker 이미지 빌드가 GitHub
Actions에서 자동 실행됩니다. `v*` 태그는 GHCR에 버전 및 `latest` 이미지를
게시합니다.
