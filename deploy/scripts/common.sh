#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PROJECT_ROOT="$(cd -- "$DEPLOY_DIR/.." && pwd -P)"
ENV_FILE="${HERMES_ENV_FILE:-$PROJECT_ROOT/.env}"
BASE_COMPOSE_FILE="$PROJECT_ROOT/docker-compose.office.yml"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '[hermes-office] %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -v wanted="$key" '
    index($0, wanted "=") == 1 {
      value = substr($0, length(wanted) + 2)
      sub(/\r$/, "", value)
      print value
      exit
    }
  ' "$ENV_FILE"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local temporary
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "$key cannot contain a newline"
  temporary="$(mktemp "${ENV_FILE}.XXXXXX")"
  awk -v wanted="$key" -v replacement="$value" '
    BEGIN { replaced = 0 }
    index($0, wanted "=") == 1 {
      print wanted "=" replacement
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print wanted "=" replacement }
  ' "$ENV_FILE" > "$temporary"
  chmod 600 "$temporary"
  mv -f -- "$temporary" "$ENV_FILE"
}

is_true() {
  [[ "${1,,}" =~ ^(1|true|yes|on)$ ]]
}

compose_files() {
  printf '%s\n' "$BASE_COMPOSE_FILE"
  if [[ -n "$(env_value HERMES_AGENT_NETWORK)" ]]; then
    printf '%s\n' "$DEPLOY_DIR/docker-compose.agent-network.yml"
  fi
  if is_true "$(env_value TRAEFIK_ENABLE)"; then
    printf '%s\n' "$DEPLOY_DIR/docker-compose.traefik.yml"
  fi
}

compose() {
  local args=(--env-file "$ENV_FILE")
  local compose_file
  while IFS= read -r compose_file; do
    args+=(-f "$compose_file")
  done < <(compose_files)
  docker compose "${args[@]}" "$@"
}

generate_hex() {
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return
  fi
  od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
}

validate_environment() {
  [[ -f "$ENV_FILE" ]] || fail "missing $ENV_FILE; run deploy/scripts/install.sh"

  local required=(PUBLIC_ORIGIN HERMES_OFFICE_PASSWORD_HASH HERMES_OFFICE_SESSION_SECRET RESERVATION_AGENT_READ_TOKEN)
  local key value
  for key in "${required[@]}"; do
    value="$(env_value "$key")"
    [[ -n "$value" && "$value" != *CHANGE_ME* ]] || fail "$key is not configured in $ENV_FILE"
  done

  local public_origin
  public_origin="$(env_value PUBLIC_ORIGIN)"
  case "$public_origin" in
    https://*) ;;
    http://127.0.0.1:*|http://localhost:*) ;;
    *) fail "PUBLIC_ORIGIN must use HTTPS, except for localhost evaluation" ;;
  esac

  local session_secret password_hash read_token
  session_secret="$(env_value HERMES_OFFICE_SESSION_SECRET)"
  password_hash="$(env_value HERMES_OFFICE_PASSWORD_HASH)"
  read_token="$(env_value RESERVATION_AGENT_READ_TOKEN)"
  (( ${#session_secret} >= 64 )) || fail "HERMES_OFFICE_SESSION_SECRET is too short"
  [[ "$password_hash" =~ ^[0-9a-f]{32}:[0-9a-f]{128}$ ]] || fail "HERMES_OFFICE_PASSWORD_HASH has an invalid format"
  (( ${#read_token} >= 48 )) || fail "RESERVATION_AGENT_READ_TOKEN is too short"

  case "$(env_value HERMES_OFFICE_DEPLOY_MODE)" in
    build|pull) ;;
    *) fail "HERMES_OFFICE_DEPLOY_MODE must be build or pull" ;;
  esac
  case "$(env_value HERMES_AUTH_MODE)" in
    official|legacy-server-token) ;;
    *) fail "HERMES_AUTH_MODE must be official or legacy-server-token" ;;
  esac
  [[ "$(env_value HERMES_RUNTIME_UID)" =~ ^[0-9]+$ ]] || fail "HERMES_RUNTIME_UID must be numeric"
  [[ "$(env_value HERMES_RUNTIME_GID)" =~ ^[0-9]+$ ]] || fail "HERMES_RUNTIME_GID must be numeric"

  if is_true "$(env_value TRAEFIK_ENABLE)"; then
    [[ -n "$(env_value TRAEFIK_NETWORK)" ]] || fail "TRAEFIK_NETWORK is required"
    [[ -n "$(env_value PUBLIC_ORIGIN_HOST)" ]] || fail "PUBLIC_ORIGIN_HOST is required"
  fi

  local writer_enabled=false
  if is_true "$(env_value RESERVATION_NAVER_AVAILABILITY_ENABLED)" || is_true "$(env_value RESERVATION_SPACECLOUD_WRITE_ENABLED)"; then
    writer_enabled=true
  fi
  if [[ "$writer_enabled" == true ]]; then
    is_true "$(env_value RESERVATION_SYNC_ENABLED)" || fail "reservation writers require RESERVATION_SYNC_ENABLED=true"
    [[ "$(env_value RESERVATION_WRITE_MODE)" == write ]] || fail "reservation writers require RESERVATION_WRITE_MODE=write"
    [[ -n "$(env_value RESERVATION_BROWSER_CDP_URL)" ]] || fail "reservation writers require RESERVATION_BROWSER_CDP_URL"
  fi
  if is_true "$(env_value RESERVATION_NAVER_AVAILABILITY_ENABLED)"; then
    [[ -n "$(env_value RESERVATION_NAVER_BIZ_ID)" ]] || fail "Naver writer requires RESERVATION_NAVER_BIZ_ID"
    [[ -n "$(env_value RESERVATION_NAVER_PRODUCT_ID)" ]] || fail "Naver writer requires RESERVATION_NAVER_PRODUCT_ID"
  fi
  if is_true "$(env_value RESERVATION_SPACECLOUD_WRITE_ENABLED)"; then
    [[ -n "$(env_value RESERVATION_SPACECLOUD_PRODUCT_ID)" ]] || fail "SpaceCloud writer requires RESERVATION_SPACECLOUD_PRODUCT_ID"
    [[ -n "$(env_value RESERVATION_SPACECLOUD_SPACE_ID)" ]] || fail "SpaceCloud writer requires RESERVATION_SPACECLOUD_SPACE_ID"
  fi
}

wait_for_healthy() {
  local timeout_seconds="${1:-120}"
  local started now container_id health_state
  started="$(date +%s)"
  while true; do
    container_id="$(compose ps -q hermes-office 2>/dev/null || true)"
    if [[ -n "$container_id" ]]; then
      health_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      [[ "$health_state" == healthy ]] && return 0
      [[ "$health_state" == exited || "$health_state" == dead ]] && return 1
    fi
    now="$(date +%s)"
    (( now - started < timeout_seconds )) || return 1
    sleep 2
  done
}
