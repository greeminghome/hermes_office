#!/bin/zsh
set -eu

mkdir -p /opt/data/home /opt/data/logs/profiles /opt/data/browser-profiles /workspace
runtime_pid_dir="/opt/data/run/profile-supervisor"
mkdir -p "$runtime_pid_dir"
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

process_file_matches() {
  local pid_file="$1"
  local pattern="$2"
  local pid="" expected_start="" actual_start=""
  [[ -r "$pid_file" ]] && read -r pid expected_start < "$pid_file"
  [[ "$pid" =~ '^[0-9]+$' ]] || return 1
  [[ -r "/proc/${pid}/cmdline" ]] || return 1
  [[ "$expected_start" =~ '^[0-9]+$' ]] || return 1
  actual_start="$(awk '{print $22}' "/proc/${pid}/stat" 2>/dev/null || true)"
  [[ "$actual_start" == "$expected_start" ]] || return 1
  tr '\0' ' ' < "/proc/${pid}/cmdline" | grep -Eq -- "$pattern"
}

remember_pid() {
  local pid_file="$1" pid="$2" start=""
  [[ "$pid" =~ '^[0-9]+$' ]] || return 1
  start="$(awk '{print $22}' "/proc/${pid}/stat" 2>/dev/null || true)"
  [[ "$start" =~ '^[0-9]+$' ]] || return 1
  print -r -- "$pid $start" >| "$pid_file"
}

remember_matching_process() {
  local pid_file="$1"
  local pattern="$2"
  local pid="$(pgrep -fo -- "$pattern" 2>/dev/null || true)"
  [[ "$pid" =~ '^[0-9]+$' ]] || return 1
  remember_pid "$pid_file" "$pid"
  return 0
}

proxy_process_for_port() {
  local proxy_port="$1"
  local pid environment command
  for pid in ${="$(pidof node 2>/dev/null || true)"}; do
    environment="/proc/${pid}/environ"
    command="/proc/${pid}/cmdline"
    [[ -r "$environment" && -r "$command" ]] || continue
    tr '\0' ' ' < "$command" | grep -Eq -- '^node /usr/local/bin/cdp-http-proxy\.js ' || continue
    { tr '\0' '\n' < "$environment" 2>/dev/null || true; } | grep -qx -- "CDP_PROXY_PORT=${proxy_port}" || continue
    print -r -- "$pid"
    return 0
  done
  return 1
}

start_browser_and_proxy() {
  local profile="$1"
  local cdp_port="$2"
  local proxy_port="$3"
  local profile_dir="/opt/data/browser-profiles/${profile}"
  local browser_pid_file="${runtime_pid_dir}/browser-${profile}.pid"
  local proxy_pid_file="${runtime_pid_dir}/proxy-${profile}.pid"
  local browser_pattern="chrome.*--user-data-dir=${profile_dir}([[:space:]]|$)"
  if ! process_file_matches "$browser_pid_file" "$browser_pattern" && ! remember_matching_process "$browser_pid_file" "$browser_pattern"; then
    gosu hermes env HERMES_HOME=/opt/data HOME=/opt/data/home PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright \
      HERMES_BROWSER_CDP_PORT="$cdp_port" HERMES_BROWSER_CDP_HOST=0.0.0.0 \
      HERMES_BROWSER_PROFILE_DIR="$profile_dir" HERMES_BROWSER_START_URL="${HERMES_BROWSER_START_URL:-about:blank}" \
      AGENT_BROWSER_PROXY="${AGENT_BROWSER_PROXY:-}" \
      nohup /usr/local/bin/start-persistent-browser.sh \
        >>"/opt/data/logs/persistent-browser-${profile}.log" 2>&1 </dev/null &
    remember_pid "$browser_pid_file" "$!"
  fi
  if ! process_file_matches "$proxy_pid_file" '^node /usr/local/bin/cdp-http-proxy\.js '; then
    local proxy_pid="$(proxy_process_for_port "$proxy_port" || true)"
    if [[ "$proxy_pid" =~ '^[0-9]+$' ]]; then
      remember_pid "$proxy_pid_file" "$proxy_pid"
      return 0
    fi
    # Migration fallback for routers whose PID predates this cache. This
    # bounded metadata read neither claims a workspace nor starts Chrome.
    if curl -fsS --max-time 15 "http://127.0.0.1:${proxy_port}/json/version" >/dev/null 2>&1; then
      return 0
    fi
    gosu hermes env HERMES_HOME=/opt/data HOME=/opt/data/home \
      CDP_PROXY_TARGET_PORT="$cdp_port" CDP_PROXY_PORT="$proxy_port" \
      CDP_PROXY_SESSION_TTL_MS="${CDP_PROXY_SESSION_TTL_MS:-86400000}" \
      CDP_PROXY_SESSION_CONTEXT_TTL_MS="${CDP_PROXY_SESSION_CONTEXT_TTL_MS:-2592000000}" \
      CDP_PROXY_MAX_SESSION_CONTEXTS="${CDP_PROXY_MAX_SESSION_CONTEXTS:-12}" \
      CDP_PROXY_CLEANUP_INTERVAL_MS="${CDP_PROXY_CLEANUP_INTERVAL_MS:-300000}" \
      nohup node /usr/local/bin/cdp-http-proxy.js \
        >>"/opt/data/logs/cdp-http-proxy-${profile}.log" 2>&1 </dev/null &
    remember_pid "$proxy_pid_file" "$!"
  fi
}

start_profile_gateway() {
  local profile="$1"
  local cdp_port="$2"
  local proxy_port="$3"
  local managed_profiles="${4:-$profiles}"
  local pid_file="${runtime_pid_dir}/gateway-${profile}.pid"
  local pattern="hermes (-p|--profile) ${profile} gateway run"
  if process_file_matches "$pid_file" "$pattern" || remember_matching_process "$pid_file" "$pattern"; then
    return
  fi
  gosu hermes env HERMES_HOME=/opt/data HOME=/opt/data/home \
    HERMES_GATEWAY_PROFILES="${managed_profiles}" HERMES_PROFILE_CDP_BASE_PORT="${profile_cdp_base}" \
    HERMES_PROFILE_CDP_PROXY_BASE_PORT="${profile_proxy_base}" \
    BROWSER_CDP_URL="http://127.0.0.1:${cdp_port}" HERMES_BROWSER_SESSION_ROUTER="http://127.0.0.1:${proxy_port}" \
    BROWSER_INACTIVITY_TIMEOUT="${BROWSER_INACTIVITY_TIMEOUT:-1800}" \
    nohup hermes --profile "$profile" gateway run --replace \
      >>"/opt/data/logs/profiles/${profile}.log" 2>&1 </dev/null &
  remember_pid "$pid_file" "$!"
}

start_dashboard() {
  local pid_file="${runtime_pid_dir}/dashboard.pid"
  local pattern="hermes dashboard.*--port 9119"
  if process_file_matches "$pid_file" "$pattern" || remember_matching_process "$pid_file" "$pattern"; then
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
  remember_pid "$pid_file" "$!"
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
while sleep "${HERMES_SUPERVISOR_INTERVAL_SECONDS:-60}"; do
  ensure_services
done
