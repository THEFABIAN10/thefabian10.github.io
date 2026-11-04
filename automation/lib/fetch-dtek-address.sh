#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
session_dir="$(mktemp -d)"
trap 'rm -rf -- "$session_dir"' EXIT

fetch_address() {
  # Establish our own session; this never depends on a valid parsed schedule.
  # The trailing slash avoids the protection response seen on /ua/shutdowns.
  local session_url='https://www.dtek-dnem.com.ua/ua/shutdowns/'
  if [ "$attempt" -gt 1 ]; then
    session_url="${session_url}?t=$(date +%s)-${attempt}"
  fi
  curl --fail-with-body --location --silent --show-error --compressed \
    --connect-timeout 15 --max-time 30 \
    --cookie-jar "${session_dir}/cookies" \
    "$session_url" --output raw-dtek-address-session.html || return 1
  node "${script_dir}/process-dtek-address.js" --csrf-header raw-dtek-address-session.html \
    > "${session_dir}/headers" || return 1

  local update_fact
  update_fact="$(node "${script_dir}/process-dtek-address.js" --update-fact)" || return 1
  curl --fail-with-body --location --silent --show-error --compressed \
    --connect-timeout 15 --max-time 60 \
    'https://www.dtek-dnem.com.ua/ua/ajax' \
    --cookie "${session_dir}/cookies" \
    --header "@${session_dir}/headers" \
    --referer "$session_url" \
    --header 'Origin: https://www.dtek-dnem.com.ua' \
    --header 'X-Requested-With: XMLHttpRequest' \
    --header 'Accept: application/json, text/javascript, */*; q=0.01' \
    --header 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
    --data-urlencode 'method=getHomeNum' \
    --data-urlencode 'data[0][name]=city' \
    --data-urlencode 'data[0][value]=с. Любимівка' \
    --data-urlencode 'data[1][name]=street' \
    --data-urlencode 'data[1][value]=вул. Центральна' \
    --data-urlencode 'data[2][name]=updateFact' \
    --data-urlencode "data[2][value]=${update_fact}" \
    --output raw-dtek-address.json || return 1
  node "${script_dir}/process-dtek-address.js"
}

for attempt in 1 2 3; do
  echo "Fetching and processing DTEK address information (attempt ${attempt}/3)..."
  if fetch_address; then
    exit 0
  fi

  if [ "$attempt" -lt 3 ]; then
    echo 'DTEK did not return usable address information; retrying in 10 seconds...' >&2
    sleep 10
  fi
done

echo 'Unable to retrieve valid DTEK address information after 3 attempts; previous data was preserved.' >&2
exit 1
