#!/bin/sh
set -eu

health_url="${READ_PREVIEW_HEALTH_URL:-https://www.freightclaw.net/staging/runtime/readyz}"
response_file="$(/usr/bin/mktemp)"
trap '/usr/bin/unlink "$response_file" 2>/dev/null || true' EXIT HUP INT TERM

status_code="$(/usr/bin/curl --fail-with-body --silent --show-error \
  --connect-timeout 5 \
  --max-time 15 \
  --output "$response_file" \
  --write-out '%{http_code}' \
  "$health_url" 2>/dev/null || true)"

if [ "$status_code" != "200" ] || ! /usr/bin/grep -q '"status"[[:space:]]*:[[:space:]]*"ready"' "$response_file"; then
  /usr/bin/logger --priority user.err --tag freightclaw-read-preview-alert \
    "read-preview readiness failed status=${status_code:-transport_error}"
  exit 1
fi

/usr/bin/logger --priority user.info --tag freightclaw-read-preview-health \
  "read-preview readiness recovered status=200"
