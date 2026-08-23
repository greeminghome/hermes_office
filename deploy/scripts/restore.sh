#!/usr/bin/env bash

set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

backup_directory=''
confirmed=false
skip_safety_backup=false
restore_secrets=false

usage() {
  printf '%s\n' \
    'Usage: deploy/scripts/restore.sh BACKUP_DIRECTORY --confirm-restore [options]' \
    '' \
    'Options:' \
    '  --restore-secrets       Also replace deploy/secrets from the backup.' \
    '  --skip-safety-backup    Do not create an automatic pre-restore backup.'
}

while (( $# > 0 )); do
  case "$1" in
    --confirm-restore) confirmed=true ;;
    --skip-safety-backup) skip_safety_backup=true ;;
    --restore-secrets) restore_secrets=true ;;
    -h|--help) usage; exit 0 ;;
    -*) fail "unknown argument: $1" ;;
    *)
      [[ -z "$backup_directory" ]] || fail "only one backup directory may be supplied"
      backup_directory="$1"
      ;;
  esac
  shift
done

[[ "$confirmed" == true ]] || fail "restore is destructive; pass --confirm-restore"
[[ -n "$backup_directory" && -d "$backup_directory" ]] || fail "backup directory not found"
backup_directory="$(cd -- "$backup_directory" && pwd -P)"
[[ "$backup_directory" != / ]] || fail "refusing to restore from /"
[[ "$(<"$backup_directory/BACKUP_FORMAT")" == hermes-office-backup-v1 ]] || fail "unsupported backup format"

require_command docker
require_command tar
require_command sha256sum
validate_environment
(
  cd -- "$backup_directory"
  sha256sum --check checksums.sha256
)

if tar -tzf "$backup_directory/data.tar.gz" | awk '
  /^\// || /(^|\/)\.\.($|\/)/ { bad = 1 }
  !/^(chat-files|workspace|google-drive-assets|reservations)(\/|$)/ { bad = 1 }
  END { exit bad ? 0 : 1 }
'; then
  fail "backup archive contains an unsafe path"
fi

if [[ "$skip_safety_backup" != true ]]; then
  info "creating a pre-restore safety backup"
  "$SCRIPT_DIR/backup.sh"
fi

was_running=false
if compose ps --status running --services | grep -Fxq hermes-office; then
  was_running=true
  compose stop hermes-office
fi

restart_service() {
  if [[ "$was_running" == true ]]; then
    compose up -d hermes-office >/dev/null
  fi
}
trap restart_service EXIT

runtime_uid="$(env_value HERMES_RUNTIME_UID)"
runtime_gid="$(env_value HERMES_RUNTIME_GID)"
compose run --rm --no-deps --user 0:0 -v "$backup_directory:/backup:ro" \
  --entrypoint sh hermes-office -c \
  "for directory in /data/chat-files /data/workspace /data/google-drive-assets /data/reservations; do find \"\$directory\" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; done; tar -xzf /backup/data.tar.gz -C /data; chown -R ${runtime_uid}:${runtime_gid} /data/chat-files /data/workspace /data/google-drive-assets /data/reservations"

if [[ "$restore_secrets" == true ]]; then
  temporary_directory="$(mktemp -d)"
  cleanup_temporary() { rm -rf -- "$temporary_directory"; }
  trap 'cleanup_temporary; restart_service' EXIT
  tar -xzf "$backup_directory/runtime-secrets.tar.gz" -C "$temporary_directory"
  [[ -d "$temporary_directory/secrets" ]] || fail "backup has no secrets directory"
  find "$DEPLOY_DIR/secrets" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  cp -a -- "$temporary_directory/secrets/." "$DEPLOY_DIR/secrets/"
  chmod 700 "$DEPLOY_DIR/secrets"
  find "$DEPLOY_DIR/secrets" -type f -exec chmod 600 {} +
  cleanup_temporary
  trap restart_service EXIT
fi

trap - EXIT
restart_service
if [[ "$was_running" == true ]]; then
  wait_for_healthy 150 || fail "restored service did not become healthy"
fi
info "data restore completed from $backup_directory"
printf '%s\n' 'note: config.env was verified but intentionally not applied; restore deployment settings manually after review.'
