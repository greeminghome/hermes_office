#!/bin/zsh
set -eu

mkdir -p /opt/data/home /opt/data/logs/profiles /opt/data/browser-profiles /workspace
if [[ "${1:-}" != "--supervisor" ]]; then
  chown -R hermes:hermes /opt/data /workspace
fi

profiles="${HERMES_GATEWAY_PROFILES:-}"
profile_cdp_base="${HERMES_PROFILE_CDP_BASE_PORT:-9300}"
profile_proxy_base="${HERMES_PROFILE_CDP_PROXY_BASE_PORT:-9400}"
profile_registry_port="${HERMES_PROFILE_REGISTRY_PORT:-9299}"

valid_profile() {
  [[ "$1" =~ '^[a-z0-9][a-z0-9-]{1,63}$' ]]
}

start_browser_and_proxy() {
  local profile="$1"
  local cdp_port="$2"
  local proxy_port="$3"
  local profile_dir="/opt/data/browser-profiles/${profile}"
  if ! curl -fsS "http://127.0.0.1:${cdp_port}/json/version" >/dev/null 2>&1; then
    gosu hermes env HERMES_HOME=/opt/data HOME=/opt/data/home PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright \
      HERMES_BROWSER_CDP_PORT="$cdp_port" HERMES_BROWSER_CDP_HOST=0.0.0.0 \
      HERMES_BROWSER_PROFILE_DIR="$profile_dir" HERMES_BROWSER_START_URL="${HERMES_BROWSER_START_URL:-about:blank}" \
      AGENT_BROWSER_PROXY="${AGENT_BROWSER_PROXY:-}" \
      nohup /usr/local/bin/start-persistent-browser.sh \
        >>"/opt/data/logs/persistent-browser-${profile}.log" 2>&1 </dev/null &
  fi
  if ! curl -fsS "http://127.0.0.1:${proxy_port}/json/version" >/dev/null 2>&1; then
    gosu hermes env HERMES_HOME=/opt/data HOME=/opt/data/home \
      CDP_PROXY_TARGET_PORT="$cdp_port" CDP_PROXY_PORT="$proxy_port" \
      CDP_PROXY_SESSION_TTL_MS="${CDP_PROXY_SESSION_TTL_MS:-86400000}" \
      CDP_PROXY_SESSION_CONTEXT_TTL_MS="${CDP_PROXY_SESSION_CONTEXT_TTL_MS:-2592000000}" \
      CDP_PROXY_MAX_SESSION_CONTEXTS="${CDP_PROXY_MAX_SESSION_CONTEXTS:-12}" \
      CDP_PROXY_CLEANUP_INTERVAL_MS="${CDP_PROXY_CLEANUP_INTERVAL_MS:-300000}" \
      nohup node /usr/local/bin/cdp-http-proxy.js \
        >>"/opt/data/logs/cdp-http-proxy-${profile}.log" 2>&1 </dev/null &
  fi
}

start_profile_gateway() {
  local profile="$1"
  local cdp_port="$2"
  local proxy_port="$3"
  local managed_profiles="${4:-$profiles}"
  if pgrep -f -- "hermes (-p|--profile) ${profile} gateway run" >/dev/null 2>&1; then
    return
  fi
  gosu hermes env HERMES_HOME=/opt/data HOME=/opt/data/home \
    HERMES_GATEWAY_PROFILES="${managed_profiles}" HERMES_PROFILE_CDP_BASE_PORT="${profile_cdp_base}" \
    HERMES_PROFILE_CDP_PROXY_BASE_PORT="${profile_proxy_base}" \
    BROWSER_CDP_URL="http://127.0.0.1:${cdp_port}" HERMES_BROWSER_SESSION_ROUTER="http://127.0.0.1:${proxy_port}" \
    BROWSER_INACTIVITY_TIMEOUT="${BROWSER_INACTIVITY_TIMEOUT:-1800}" \
    nohup hermes --profile "$profile" gateway run --replace \
      >>"/opt/data/logs/profiles/${profile}.log" 2>&1 </dev/null &
}

start_dashboard() {
  if pgrep -f -- "hermes dashboard.*--port 9119" >/dev/null 2>&1; then
    return
  fi
  gosu hermes env HERMES_HOME=/opt/data HOME=/opt/data/home \
    HERMES_GATEWAY_PROFILES="${profiles}" HERMES_PROFILE_CDP_BASE_PORT="${profile_cdp_base}" \
    HERMES_PROFILE_CDP_PROXY_BASE_PORT="${profile_proxy_base}" \
    BROWSER_CDP_URL="http://127.0.0.1:${HERMES_BROWSER_CDP_PORT:-9222}" \
    HERMES_BROWSER_SESSION_ROUTER="http://127.0.0.1:${HERMES_BROWSER_CDP_PROXY_PORT:-9223}" \
    BROWSER_INACTIVITY_TIMEOUT="${BROWSER_INACTIVITY_TIMEOUT:-1800}" \
    nohup hermes dashboard --port 9119 --host 0.0.0.0 --insecure --tui --no-open --skip-build \
      >>/opt/data/logs/dashboard.log 2>&1 </dev/null &
}

start_profile_registry() {
  if pgrep -f -- "profile-runtime-registry.cjs serve" >/dev/null 2>&1; then
    return
  fi
  gosu hermes env HERMES_HOME=/opt/data HOME=/opt/data/home \
    HERMES_PROFILE_REGISTRY_PORT="$profile_registry_port" \
    HERMES_PROFILE_RUNTIME_REGISTRY="${HERMES_PROFILE_RUNTIME_REGISTRY:-/opt/data/browser-profile-runtime.json}" \
    nohup node /usr/local/bin/profile-runtime-registry.cjs serve \
      >>/opt/data/logs/profile-runtime-registry.log 2>&1 </dev/null &
}

managed_profile_rows() {
  gosu hermes env HERMES_HOME=/opt/data HOME=/opt/data/home \
    HERMES_GATEWAY_PROFILES="$profiles" \
    HERMES_PROFILE_CDP_BASE_PORT="$profile_cdp_base" \
    HERMES_PROFILE_CDP_PROXY_BASE_PORT="$profile_proxy_base" \
    HERMES_PROFILE_DISCOVERY_ROOT="${HERMES_PROFILE_DISCOVERY_ROOT:-/opt/data/profiles}" \
    HERMES_PROFILE_RUNTIME_REGISTRY="${HERMES_PROFILE_RUNTIME_REGISTRY:-/opt/data/browser-profile-runtime.json}" \
    node /usr/local/bin/profile-runtime-registry.cjs sync
}

ensure_services() {
  start_browser_and_proxy default "${HERMES_BROWSER_CDP_PORT:-9222}" "${HERMES_BROWSER_CDP_PROXY_PORT:-9223}"
  start_profile_registry
  local rows="$(managed_profile_rows)"
  local active_profiles="$(print -r -- "$rows" | cut -f1 | paste -sd, -)"
  local profile index cdp_port proxy_port
  while IFS=$'\t' read -r profile index cdp_port proxy_port; do
    [[ -n "$profile" ]] || continue
    valid_profile "$profile" || { print -u2 "Invalid Hermes profile: $profile"; exit 1; }
    start_browser_and_proxy "$profile" "$cdp_port" "$proxy_port"
    start_profile_gateway "$profile" "$cdp_port" "$proxy_port" "$active_profiles"
  done <<< "$rows"
  if [[ -z "$profiles" ]] && ! pgrep -f -- "hermes gateway run" >/dev/null 2>&1; then
    gosu hermes env HERMES_HOME=/opt/data HOME=/opt/data/home \
      BROWSER_CDP_URL="http://127.0.0.1:${HERMES_BROWSER_CDP_PORT:-9222}" \
      HERMES_BROWSER_SESSION_ROUTER="http://127.0.0.1:${HERMES_BROWSER_CDP_PROXY_PORT:-9223}" \
      BROWSER_INACTIVITY_TIMEOUT="${BROWSER_INACTIVITY_TIMEOUT:-1800}" \
      nohup hermes gateway run --replace >>/opt/data/logs/gateway.log 2>&1 </dev/null &
  fi
  start_dashboard
}

ensure_services
while sleep 10; do
  ensure_services
done
