# Hermes Office 배포 가이드

## 1. 배포 원칙

각 고객 또는 소유자는 독립 VPS, 독립 도메인, 독립 Docker 프로젝트와 독립 데이터
볼륨을 사용합니다. 소스만 공유하고 운영 데이터와 인증 상태는 공유하지 않습니다.

```text
사용자 브라우저
      │ HTTPS
      ▼
리버스 프록시 ──► Hermes Office ──► Hermes Agent API
                         │             └─► 프로필별 CDP/Live Screen
                         ├─► Google OAuth / Calendar / Gmail
                         ├─► 예약 채널 read-only 수집
                         └─► 프로젝트별 Docker 볼륨 4개
```

Office는 Hermes Agent를 포함하지 않습니다. 수령자 전용 Hermes Agent를 먼저
설치하거나 접근 가능한 Agent endpoint를 준비해야 합니다. 세션별 Live Screen
라우팅이 없는 Agent에는 `deploy/hermes-agent/`의 digest 고정 호환 이미지 템플릿을
적용할 수 있습니다. 이 선택형 이미지는 Office 설치 스크립트가 자동 배포하지 않습니다.

## 2. 사전 요구사항

- 64-bit Linux VPS, 권장 4 vCPU / 8 GB RAM 이상
- Docker Engine 및 Docker Compose v2
- HTTPS 도메인과 DNS A/AAAA 레코드
- Hermes Agent API endpoint
- Live Screen 사용 시 프로필별 CDP endpoint
- Google 연동 사용 시 수령자 소유 Google Cloud 프로젝트

방화벽에서는 SSH와 HTTPS만 공개하고 Office의 기본 포트 `4173`, Agent API 및
CDP 포트는 인터넷에 직접 공개하지 않는 구성을 권장합니다.

## 3. 안전한 초기화

```bash
git clone https://github.com/greeminghome/hermes_office.git
cd hermes_office
PUBLIC_ORIGIN=https://office.example.com ./deploy/scripts/install.sh --init-only
```

생성되는 `.env`와 `deploy/secrets/`는 Git에서 제외됩니다. 설치 스크립트는 현재
Linux 사용자의 UID/GID를 저장하고, 48-byte 세션 비밀키와 32-byte Agent 읽기
토큰을 새로 생성하며, Office 비밀번호는 scrypt 해시만 저장합니다.

## 4. Hermes Agent 연결

Agent가 호스트 포트 `9119`를 게시한다면 기본값을 사용합니다.

```dotenv
HERMES_TARGET=http://host.docker.internal:9119
```

Agent가 다른 Compose 프로젝트의 Docker 네트워크에만 있다면 다음처럼 설정합니다.

```dotenv
HERMES_AGENT_NETWORK=recipient-hermes_default
HERMES_TARGET=http://hermes-agent:9119
```

`HERMES_AGENT_NETWORK`가 비어 있지 않으면 설치 스크립트가
`deploy/docker-compose.agent-network.yml`을 자동으로 적용합니다. 네트워크는
미리 존재해야 합니다.

기존 Agent가 legacy server token 방식일 때만 아래 값을 사용합니다. 신규 공식
인증 흐름은 `official`을 유지합니다.

```dotenv
HERMES_AUTH_MODE=legacy-server-token
```

## 5. Live Screen 연결

Live Screen을 쓰지 않으면 CDP 설정을 비워 둡니다. 쓸 경우 외부 공개 URL이 아닌
Docker 내부 endpoint를 사용합니다.

```dotenv
LIVE_SCREEN_CDP_URL=http://hermes-agent:9223
LIVE_SCREEN_PROFILE_CDP_URLS=profile-a=http://hermes-agent:9400,profile-b=http://hermes-agent:9401
```

모든 프로필은 독립 browser context와 고정 session ID를 가져야 합니다. 프로필
저장소 또는 쿠키 디렉터리를 수령자에게 복사하지 말고 각 서비스에서 다시 로그인합니다.

## 6. HTTPS와 Traefik

기존 프록시가 호스트의 `127.0.0.1:4173`으로 전달한다면 추가 설정이 필요 없습니다.
Traefik Docker provider를 쓸 때는 다음 값을 설정합니다.

```dotenv
TRAEFIK_ENABLE=true
TRAEFIK_NETWORK=traefik
TRAEFIK_CERT_RESOLVER=letsencrypt
PUBLIC_ORIGIN_HOST=office.example.com
```

해당 외부 네트워크가 실제로 존재하는지 확인합니다.

```bash
docker network inspect traefik
```

## 7. 계정 연결

Office를 시작하고 로그인한 뒤 새 소유자 계정으로 다음 순서를 따릅니다.

1. Hermes/OpenAI 또는 ChatGPT OAuth
2. Google Calendar/Gmail OAuth client와 redirect URI
3. Google Drive read-only OAuth
4. 프로필별 Live Screen에서 네이버 및 스페이스클라우드 로그인
5. 필요한 플러그인·Telegram·Instagram 연결

Google OAuth redirect URI는 정확히 다음 형식으로 등록합니다.

```text
https://office.example.com/bridge/reservations/google/callback
```

Google Drive용 비밀파일을 직접 공급하는 경우 `deploy/secrets/`에 두고 권한을
`0600`으로 설정합니다. 예약 Google OAuth 토큰은 Office UI가
`office-reservations` 볼륨 안에 생성합니다.

## 8. 예약 동기화 활성화

`deploy/secrets/reservation_sources.json`에는 수령자 소유 iCal URL만 입력합니다.

```json
{
  "hourplace_ical_url": "https://...",
  "spacecloud_ical_url": "https://..."
}
```

처음에는 아래 안전 기본값을 유지합니다.

```dotenv
RESERVATION_SYNC_ENABLED=false
RESERVATION_WRITE_MODE=shadow
RESERVATION_GOOGLE_WRITE_ENABLED=false
RESERVATION_NAVER_AVAILABILITY_ENABLED=false
RESERVATION_SPACECLOUD_WRITE_ENABLED=false
```

활성화 순서는 다음과 같습니다.

1. iCal/Gmail/Google 계정 read-only 상태 확인
2. `RESERVATION_SYNC_ENABLED=true`, `RESERVATION_WRITE_MODE=shadow`
3. 원장 중복·시간대·충돌 검증
4. Google writer만 활성화하고 read-back 확인
5. 네이버 계정·상품과 SpaceCloud 계정·공간을 읽기 점검
6. 채널 writer를 하나씩 활성화하고 기존 예약을 변경하지 않는 read-back 검증

네이버 writer는 실제 네이버 예약을 만들거나 취소하지 않고 가용 일정만 관리하도록
설계되어 있습니다. 테스트를 위해 실제 예약 생성·취소를 반복하지 마세요.

## 9. 진단, 백업, 업데이트

```bash
./deploy/scripts/doctor.sh --strict-agent
./deploy/scripts/backup.sh
./deploy/scripts/update.sh
```

업데이트는 먼저 cold backup을 만든 뒤 현재 브랜치를 fast-forward로 갱신합니다.
새 이미지가 헬스 검증에 실패하면 직전 런타임 이미지를 다시 태깅해 컨테이너를
복구합니다. 소스는 실패 원인 분석을 위해 새 revision에 유지됩니다.

복원은 기존 볼륨 내용을 교체하므로 명시적 확인이 필요합니다.

```bash
./deploy/scripts/restore.sh ./backups/TIMESTAMP --confirm-restore
```

OAuth와 iCal 비밀파일까지 되돌릴 때만 `--restore-secrets`를 추가합니다. 백업의
`config.env`는 체크섬 검증만 하고 자동 적용하지 않습니다.

## 10. 완료 판정

설치 완료는 단순히 첫 화면이 뜨는 상태가 아닙니다. 다음이 모두 충족되어야 합니다.

- `doctor.sh --strict-agent` 성공
- HTTPS 로그인과 로그아웃 성공
- 새 소유자의 Hermes OAuth로 대화 성공
- 에이전트별 세션 및 Live Screen 격리 확인
- 재시작 후 대화·조직·예약 데이터 유지
- OAuth 계정명이 수령자 계정과 일치
- 예약 writer 기본 비활성화 및 shadow 검증
- 백업 생성, 체크섬 검사, 별도 테스트 인스턴스 복원 성공
