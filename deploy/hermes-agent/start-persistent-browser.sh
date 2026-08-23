#!/bin/zsh
set -eu

export HOME="${HOME:-/opt/data/home}"
export HERMES_HOME="${HERMES_HOME:-/opt/data}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/hermes/.playwright}"

port="${HERMES_BROWSER_CDP_PORT:-9222}"
bind_address="${HERMES_BROWSER_CDP_HOST:-0.0.0.0}"
profile_dir="${HERMES_BROWSER_PROFILE_DIR:-/opt/data/browser-profiles/default}"
start_url="${HERMES_BROWSER_START_URL:-about:blank}"
log_dir="/opt/data/logs"
mkdir -p "$profile_dir" "$log_dir"

if ! pgrep -f "chrome.*--user-data-dir=${profile_dir}" >/dev/null 2>&1; then
  rm -f "$profile_dir"/SingletonLock "$profile_dir"/SingletonSocket "$profile_dir"/SingletonCookie
fi
if curl -fsS "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
  exit 0
fi

chrome_bin="${HERMES_CHROME_BIN:-}"
if [[ -z "$chrome_bin" ]]; then
  chrome_bin="$(find "$PLAYWRIGHT_BROWSERS_PATH" -type f -path '*/chrome-linux*/chrome' | sort | tail -1 || true)"
fi
if [[ -z "$chrome_bin" || ! -x "$chrome_bin" ]]; then
  print -u2 "Chromium binary was not found under PLAYWRIGHT_BROWSERS_PATH"
  exit 1
fi

proxy_args=()
if [[ -n "${AGENT_BROWSER_PROXY:-}" ]]; then
  if [[ ! "${AGENT_BROWSER_PROXY}" =~ '^socks5h?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):[0-9]{1,5}$' ]]; then
    print -u2 "AGENT_BROWSER_PROXY must be a host:port SOCKS URL without embedded credentials"
    exit 1
  fi
  proxy_args+=(--proxy-server="${AGENT_BROWSER_PROXY}")
fi

exec xvfb-run -a -s "-screen 0 1600x900x24" "$chrome_bin" \
  --remote-debugging-address="$bind_address" \
  --remote-debugging-port="$port" \
  "--remote-allow-origins=*" \
  --user-data-dir="$profile_dir" \
  --profile-directory=Default \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-setuid-sandbox \
  --no-sandbox \
  --window-size=1600,900 \
  --lang=ko-KR \
  --accept-lang=ko-KR,ko,en-US,en \
  "${proxy_args[@]}" \
  "$start_url" \
  >>"$log_dir/persistent-browser.log" 2>&1
