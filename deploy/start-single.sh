#!/bin/sh
# One container for a free host: FalkorDB on the loopback, then the app. Nothing is kept on disk: the app loads
# any scenario graph that is missing at start and runs its scripted pass, so a restart heals itself.
set -e
redis-server --bind 127.0.0.1 --port 6379 --protected-mode no --save "" --appendonly no --dir /app/data --daemonize no \
  --loadmodule /var/lib/falkordb/bin/falkordb.so ${FALKORDB_ARGS:-TIMEOUT_MAX 10000 TIMEOUT_DEFAULT 5000 MAX_QUEUED_QUERIES 200 RESULTSET_SIZE 10000} &
for i in $(seq 1 120); do redis-cli -p 6379 ping 2>/dev/null | grep -q PONG && break; sleep 0.5; done
exec /app/.venv/bin/uvicorn devries.app:app --host 0.0.0.0 --port "${PORT:-8000}" --no-server-header
