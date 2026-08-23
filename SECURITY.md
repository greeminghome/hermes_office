# Security policy

## Secret boundary

이 공개 저장소에는 실제 인증자료나 운영 데이터가 없어야 합니다. 런타임 비밀값은
`.env`, `deploy/secrets/` 또는 프로젝트별 Docker volume에만 둡니다. 이 경로들은
Git과 Docker build context에서 제외됩니다.

다음 자료는 설치 간 재사용하거나 다른 사람에게 전달하지 않습니다.

- OAuth access/refresh token 및 client secret
- 브라우저 profile, cookie, localStorage
- iCal 비공개 URL
- Telegram/Instagram/GitHub/OpenAI token
- 예약 원장, 대화 파일, 고객 개인정보가 포함된 백업

`npm run verify:package`는 알려진 비밀 패턴, 운영 호스트/예약 식별자, 추적된 런타임
데이터 파일을 검사합니다. CI와 별개로 push 직전에도 실행하세요.

## Runtime defaults

- Office 포트는 `127.0.0.1`에만 바인딩
- HTTPS secure cookie 기본값
- 읽기 전용 root filesystem
- 모든 Linux capability 제거 및 `no-new-privileges`
- 호스트 배포 사용자 UID/GID로 비-root 실행
- 예약 동기화와 모든 외부 writer 기본 비활성화
- 데이터와 OAuth 저장소를 프로젝트별 volume으로 격리

## Backup handling

`backup.sh` 결과에는 OAuth 자료와 고객 데이터가 포함될 수 있습니다. 백업 디렉터리는
소유자만 읽을 수 있도록 생성되지만, 서버 밖으로 반출할 때는 별도 암호화 저장소를
사용하고 전달이 끝나면 안전하게 폐기하세요. GitHub issue나 채팅에 백업을 첨부하지
마세요.

## Incident response

비밀값이 commit 또는 로그에 노출되었다면 파일 삭제만으로 끝내지 않습니다.

1. 관련 OAuth consent와 token을 즉시 취소한다.
2. API key, bot token, 세션 서명키와 Office 비밀번호를 교체한다.
3. Git history에서 비밀값을 제거하고 공개 clone/cache 영향을 확인한다.
4. 예약 writer를 비활성화하고 원장 audit에서 비정상 변경을 확인한다.
5. 영향받은 사용자에게 범위와 조치 결과를 알린다.

보안 취약점은 개인정보나 토큰을 포함하지 않은 검증 절차와 함께 저장소 소유자에게
비공개로 보고하세요.
