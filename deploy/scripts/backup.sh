#!/usr/bin/env bash

set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

output_directory=''
while (( $# > 0 )); do
  case "$1" in
    --output)
      (( $# >= 2 )) || fail "--output requires a directory"
      output_directory="$2"
      shift
      ;;
    -h|--help)
      printf 'Usage: deploy/scripts/backup.sh [--output DIRECTORY]\n'
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

require_command docker
require_command tar
require_command sha256sum
validate_environment
compose config --quiet

if [[ -z "$output_directory" ]]; then
  backup_root="$(env_value DEPLOYMENT_BACKUP_ROOT)"
  [[ -n "$backup_root" ]] || backup_root='./backups'
  [[ "$backup_root" == /* ]] || backup_root="$PROJECT_ROOT/$backup_root"
  output_directory="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p -- "$output_directory"
output_directory="$(cd -- "$output_directory" && pwd -P)"
chmod 700 "$output_directory"
[[ "$output_directory" != / ]] || fail "refusing to use / as a backup directory"
[[ ! -e "$output_directory/data.tar.gz" ]] || fail "backup already exists: $output_directory"

was_running=false
if compose ps --status running --services | grep -Fxq hermes-office; then
  was_running=true
  info "stopping Hermes Office for a consistent SQLite backup"
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
compose run --rm --no-deps --user "$runtime_uid:$runtime_gid" \
  -v "$output_directory:/backup" --entrypoint sh hermes-office -c \
  'tar -czf /backup/data.tar.gz -C /data chat-files workspace google-drive-assets reservations'

cp -- "$ENV_FILE" "$output_directory/config.env"
tar -czf "$output_directory/runtime-secrets.tar.gz" -C "$DEPLOY_DIR" secrets
chmod 600 "$output_directory/data.tar.gz" "$output_directory/config.env" "$output_directory/runtime-secrets.tar.gz"

source_revision="$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
image_reference="$(env_value HERMES_OFFICE_IMAGE)"
image_id="$(docker image inspect --format '{{.Id}}' "$image_reference" 2>/dev/null || printf 'unknown')"
printf '%s\n' \
  'format=hermes-office-backup-v1' \
  "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "source_revision=$source_revision" \
  "image_reference=$image_reference" \
  "image_id=$image_id" \
  > "$output_directory/manifest.txt"
printf 'hermes-office-backup-v1\n' > "$output_directory/BACKUP_FORMAT"
(
  cd -- "$output_directory"
  sha256sum BACKUP_FORMAT manifest.txt data.tar.gz config.env runtime-secrets.tar.gz > checksums.sha256
)
chmod 600 "$output_directory/BACKUP_FORMAT" "$output_directory/manifest.txt" "$output_directory/checksums.sha256"

trap - EXIT
restart_service
info "backup completed: $output_directory"
printf '%s\n' 'warning: this backup contains account configuration and OAuth material; store it as a secret.' >&2
