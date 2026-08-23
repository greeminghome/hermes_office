#!/usr/bin/env bash

set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

require_command docker
require_command git
validate_environment
compose config --quiet

[[ -z "$(git -C "$PROJECT_ROOT" status --porcelain --untracked-files=normal)" ]] || \
  fail "tracked or unignored files are modified; commit, remove, or stash them before updating"
branch="$(git -C "$PROJECT_ROOT" symbolic-ref --quiet --short HEAD)" || fail "updates require a checked-out branch"
old_revision="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
image_reference="$(env_value HERMES_OFFICE_IMAGE)"
rollback_image="hermes-office-rollback:${old_revision:0:12}"
have_rollback=false

"$SCRIPT_DIR/backup.sh"
if docker image inspect "$image_reference" >/dev/null 2>&1; then
  docker image tag "$image_reference" "$rollback_image"
  have_rollback=true
fi

git -C "$PROJECT_ROOT" fetch --prune origin "$branch"
git -C "$PROJECT_ROOT" merge --ff-only "origin/$branch"

deployment_failed=false
case "$(env_value HERMES_OFFICE_DEPLOY_MODE)" in
  build) compose build --pull hermes-office || deployment_failed=true ;;
  pull) compose pull hermes-office || deployment_failed=true ;;
esac
if [[ "$deployment_failed" != true ]]; then
  compose up -d --remove-orphans hermes-office || deployment_failed=true
fi
if [[ "$deployment_failed" != true ]] && ! wait_for_healthy 150; then
  deployment_failed=true
fi
if [[ "$deployment_failed" != true ]] && ! "$SCRIPT_DIR/doctor.sh"; then
  deployment_failed=true
fi

if [[ "$deployment_failed" == true ]]; then
  compose logs --tail 120 hermes-office >&2 || true
  if [[ "$have_rollback" == true ]]; then
    info "deployment failed; restoring the previous runtime image"
    docker image tag "$rollback_image" "$image_reference"
    compose up -d --no-build --force-recreate hermes-office
    wait_for_healthy 150 || true
  fi
  fail "update failed; source remains at the new revision for inspection"
fi

if [[ "$have_rollback" == true ]]; then
  docker image rm "$rollback_image" >/dev/null 2>&1 || true
fi
info "update completed: $old_revision -> $(git -C "$PROJECT_ROOT" rev-parse HEAD)"
