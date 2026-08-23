# Hermes Agent compatibility image

Hermes Office의 세션별 Live Screen은 Agent 쪽에서도 브라우저 context 격리와 고정
session target을 지원해야 합니다. 이 디렉터리는 그 호환 런타임을 구성하는 선택형
이미지 빌드 템플릿입니다. Office 기본 설치가 이 이미지를 자동으로 설치하거나 기존
Agent를 덮어쓰지는 않습니다.

```bash
docker build -t hermes-agent-office:local deploy/hermes-agent
```

기존 Agent Compose에서 위 이미지를 사용하고 다음 내부 포트를 Office와 같은 사설
Docker 네트워크에 노출합니다.

- Dashboard/API: `9119`
- 기본 CDP session router: `9223`
- 프로필 CDP session router: `9400`부터 프로필 순서대로 증가

필수 영구 볼륨은 `/opt/data`와 `/workspace`입니다. 새 소유자는 빈 볼륨으로 시작해
각 OAuth와 브라우저 로그인을 직접 수행해야 합니다. 기존 사용자의 `/opt/data`,
browser profile 또는 config/token 파일을 복사하지 마세요.

예시 환경변수:

```dotenv
HERMES_GATEWAY_PROFILES=profile-a,profile-b
HERMES_PROFILE_CDP_BASE_PORT=9300
HERMES_PROFILE_CDP_PROXY_BASE_PORT=9400
CDP_PROXY_SESSION_TTL_MS=86400000
CDP_PROXY_SESSION_CONTEXT_TTL_MS=2592000000
CDP_PROXY_MAX_SESSION_CONTEXTS=12
```

`overrides/browser_tool.py`와 `overrides/tui_gateway_server.py`는 MIT 라이선스의
Nous Research Hermes Agent를 수정한 파일입니다. 원 라이선스는
`LICENSE.hermes-agent`에 포함되어 있습니다. base image는 검증된 digest로 고정되어
있으며, digest를 변경할 때는 Python override API 호환성과 전체 Live Screen 테스트를
다시 통과해야 합니다.
