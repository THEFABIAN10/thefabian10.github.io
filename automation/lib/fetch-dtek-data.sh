#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# DTEK can return HTTP 200 for pages that contain no schedule. Retry the
# download and validation together, preserving the published data on failure.
for attempt in 1 2 3; do
  echo "Fetching and processing DTEK data (attempt ${attempt}/3)..."
  if curl --fail-with-body --location --silent --show-error --compressed \
    --connect-timeout 15 --max-time 60 \
    "https://www.dtek-dnem.com.ua/ua/shutdowns" \
    --output raw-dtek-data.html; then
    if node "${script_dir}/process-dtek-data.js"; then
      exit 0
    fi
  fi

  if [ "$attempt" -lt 3 ]; then
    echo "DTEK did not return a usable schedule; retrying in 10 seconds..." >&2
    sleep 10
  fi
done

echo "Unable to retrieve a valid DTEK schedule after 3 attempts; previous data was preserved." >&2
exit 1
