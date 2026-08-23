#!/usr/bin/env bash

set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

start_service=true
skip_image=false
init_only=false

usage() {
  printf '%s\n' \
    'Usage: deploy/scripts/install.sh [--init-only] [--no-start] [--skip-image]' \
    '' \
    'Optional non-interactive inputs:' \
    '  PUBLIC_ORIGIN=https://office.example.com' \
    '  HERMES_OFFICE_USER=admin' \
    '  HERMES_OFFICE_PASSWORD=use-a-password-manager-value' \
    '  OFFICE_BRAND_NAME="Hermes Office"' \
    '  OFFICE_BRAND_SHORT_NAME=Hermes' \
    '  OFFICE_BRAND_DESCRIPTION="Self-hosted AI team workspace"'
}

while (( $# > 0 )); do
  case "$1" in
    --init-only) init_only=true ;;
    --no-start) start_service=false ;;
    --skip-image) skip_image=true ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

require_command docker
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

requested_origin="${PUBLIC_ORIGIN:-}"
requested_user="${HERMES_OFFICE_USER:-}"
requested_password="${HERMES_OFFICE_PASSWORD:-}"
requested_brand_name="${OFFICE_BRAND_NAME:-}"
requested_brand_short_name="${OFFICE_BRAND_SHORT_NAME:-}"
requested_brand_description="${OFFICE_BRAND_DESCRIPTION:-}"
unset HERMES_OFFICE_PASSWORD

created_env=false
if [[ ! -f "$ENV_FILE" ]]; then
  cp -- "$PROJECT_ROOT/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  created_env=true
  info "created $ENV_FILE"
fi

mkdir -p -- "$DEPLOY_DIR/secrets"
chmod 700 "$DEPLOY_DIR/secrets"
if [[ ! -f "$DEPLOY_DIR/secrets/reservation_sources.json" ]]; then
  cp -- "$DEPLOY_DIR/reservation_sources.example.json" "$DEPLOY_DIR/secrets/reservation_sources.json"
  chmod 600 "$DEPLOY_DIR/secrets/reservation_sources.json"
fi

if [[ "$(env_value HERMES_OFFICE_SESSION_SECRET)" == *CHANGE_ME* ]]; then
  set_env_value HERMES_OFFICE_SESSION_SECRET "$(generate_hex 48)"
fi
if [[ "$(env_value RESERVATION_AGENT_READ_TOKEN)" == *CHANGE_ME* ]]; then
  set_env_value RESERVATION_AGENT_READ_TOKEN "$(generate_hex 32)"
fi
set_env_value HERMES_RUNTIME_UID "$(id -u)"
set_env_value HERMES_RUNTIME_GID "$(id -g)"

if [[ -z "$requested_origin" && "$(env_value PUBLIC_ORIGIN)" == "https://office.example.com" && -t 0 ]]; then
  read -r -p 'Public HTTPS origin (for example https://office.example.com): ' requested_origin
fi
if [[ -n "$requested_origin" ]]; then
  set_env_value PUBLIC_ORIGIN "${requested_origin%/}"
  origin_host="${requested_origin#*://}"
  origin_host="${origin_host%%/*}"
  origin_host="${origin_host%%:*}"
  set_env_value PUBLIC_ORIGIN_HOST "$origin_host"
fi
if [[ "$created_env" == true && -z "$requested_user" && -t 0 ]]; then
  read -r -p 'Office login ID [admin]: ' requested_user
  requested_user="${requested_user:-admin}"
fi
if [[ -n "$requested_user" ]]; then
  set_env_value HERMES_OFFICE_USER "$requested_user"
fi
if [[ -n "$requested_brand_name" ]]; then
  set_env_value OFFICE_BRAND_NAME "$requested_brand_name"
fi
if [[ -n "$requested_brand_short_name" ]]; then
  set_env_value OFFICE_BRAND_SHORT_NAME "$requested_brand_short_name"
fi
if [[ -n "$requested_brand_description" ]]; then
  set_env_value OFFICE_BRAND_DESCRIPTION "$requested_brand_description"
fi

if [[ "$(env_value HERMES_OFFICE_PASSWORD_HASH)" == *CHANGE_ME* ]]; then
  if [[ -z "$requested_password" && -t 0 ]]; then
    read -r -s -p 'Office login password (12+ characters): ' requested_password
    printf '\n'
    read -r -s -p 'Confirm password: ' password_confirmation
    printf '\n'
    [[ "$requested_password" == "$password_confirmation" ]] || fail "password confirmation does not match"
  fi
  [[ -n "$requested_password" ]] || fail "set HERMES_OFFICE_PASSWORD or run interactively to finish initialization"
  if command -v node >/dev/null 2>&1; then
    password_hash="$(printf '%s' "$requested_password" | node "$SCRIPT_DIR/password-hash.mjs")"
  else
    password_hash="$(printf '%s' "$requested_password" | docker run --rm -i -v "$SCRIPT_DIR/password-hash.mjs:/password-hash.mjs:ro" node:24-alpine node /password-hash.mjs)"
  fi
  requested_password=''
  set_env_value HERMES_OFFICE_PASSWORD_HASH "$password_hash"
fi

validate_environment
compose config --quiet

if [[ "$init_only" == true ]]; then
  info "configuration initialized; no image or container was changed"
  exit 0
fi

if [[ "$skip_image" != true ]]; then
  case "$(env_value HERMES_OFFICE_DEPLOY_MODE)" in
    build) compose build --pull hermes-office ;;
    pull) compose pull hermes-office ;;
  esac
fi

if [[ "$start_service" != true ]]; then
  info "image is ready; service start was skipped"
  exit 0
fi

runtime_uid="$(env_value HERMES_RUNTIME_UID)"
runtime_gid="$(env_value HERMES_RUNTIME_GID)"
compose run --rm --no-deps --user 0:0 --entrypoint sh hermes-office -c \
  "chown -R ${runtime_uid}:${runtime_gid} /data/chat-files /data/workspace /data/google-drive-assets /data/reservations"
compose up -d --remove-orphans hermes-office

if ! wait_for_healthy 150; then
  compose logs --tail 120 hermes-office >&2 || true
  fail "Hermes Office did not become healthy"
fi

"$SCRIPT_DIR/doctor.sh"
info "installation completed: $(env_value PUBLIC_ORIGIN)"
