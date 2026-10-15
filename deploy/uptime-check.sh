#!/bin/sh
# Is the deployment up, and is its graph still answering correctly?
#
#   deploy/uptime-check.sh https://cistern.example.org
#
# /api/health answers 200 only when FalkorDB is reachable, every scenario graph is loaded, and the canary
# passes: a small graph with a known injection path and a known trifecta is built and scanned, and both must
# be found. Anything else is 503. Exit status: 0 up, 1 down. Run it from somewhere other than the server,
# every few minutes: cron, or a scheduled job of whatever CI the repository ends up with.
set -eu
url="${1:?usage: uptime-check.sh <base url>}"
if body="$(curl --fail --silent --show-error --max-time 20 "${url%/}/api/health" 2>&1)"; then
  echo "UP   $(date -u +%Y-%m-%dT%H:%M:%SZ) $url"
else
  echo "DOWN $(date -u +%Y-%m-%dT%H:%M:%SZ) $url: $body"
  exit 1
fi
