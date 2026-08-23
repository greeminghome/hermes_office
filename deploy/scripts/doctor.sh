#!/usr/bin/env bash

set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

preflight=false
strict_agent=false
while (( $# > 0 )); do
  case "$1" in
    --preflight) preflight=true ;;
    --strict-agent) strict_agent=true ;;
    -h|--help)
      printf 'Usage: deploy/scripts/doctor.sh [--preflight] [--strict-agent]\n'
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

require_command docker
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
validate_environment
compose config --quiet
info "configuration: ok"

if [[ "$preflight" == true ]]; then
  info "preflight completed"
  exit 0
fi

container_id="$(compose ps -q hermes-office)"
[[ -n "$container_id" ]] || fail "Hermes Office container does not exist"
health_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
[[ "$health_state" == healthy ]] || fail "container health is $health_state"
info "container health: healthy"

compose exec -T hermes-office node -e \
  "fetch('http://127.0.0.1:4173/healthz').then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);const body=await r.json();if(body.ok!==true)throw new Error('invalid response')}).catch(e=>{console.error(e.message);process.exit(1)})"
info "application health endpoint: ok"

compose exec -T hermes-office sh -c \
  'for directory in /data/chat-files /data/workspace /data/google-drive-assets /data/reservations; do test -r "$directory" && test -w "$directory" || exit 1; done'
info "persistent volumes: readable and writable"

if compose exec -T hermes-office node -e \
  "const net=require('node:net');const u=new URL(process.env.HERMES_TARGET);const s=net.connect(Number(u.port||80),u.hostname);s.setTimeout(4000);s.once('connect',()=>{s.end();process.exit(0)});s.once('timeout',()=>{s.destroy();process.exit(1)});s.once('error',()=>process.exit(1))"; then
  info "Hermes Agent TCP connection: reachable"
else
  if [[ "$strict_agent" == true ]]; then
    fail "Hermes Agent is not reachable from the Office container"
  fi
  printf '[hermes-office] warning: Hermes Agent is not reachable; Office itself is healthy\n' >&2
fi

info "doctor completed"
