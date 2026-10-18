# Putting DeVries on a public address

**This has not been done.** Nothing here has run on a server. The overlay was brought up on a laptop with
`SITE_ADDRESS=localhost` and checked through the proxy (the list at the end); the steps below are what that
check implies for one small VM, which is option A of PLAN.md section 17. Where to host is still an open
decision (N2 in section 18).

## What is here

| File | What it is |
| --- | --- |
| `docker-compose.deploy.yml` | An overlay on the repository's `docker-compose.yml`: adds [Caddy](https://caddyserver.com/) for HTTPS, makes all three services restart after a reboot, turns on `COOKIE_SECURE`, refuses to start without a token for `/mcp`, and sets a daily spend ceiling for the model |
| `Caddyfile` | HTTPS for one host name, with the certificate obtained and renewed by Caddy. The UI's files are compressed; the API and `/mcp` are streamed untouched |
| `uptime-check.sh` | Asks `/api/health` from outside; exit 0 only if FalkorDB answers, every scenario is loaded and the self-check passes |

The base compose file publishes FalkorDB, the FalkorDB Browser and the app on `127.0.0.1` only. With the
overlay, the one thing reachable from outside the machine is Caddy, on ports 80 and 443.

## Steps

1. A VM with Docker and the compose plugin, a DNS record for the host name pointing at it, and ports 80 and 443
   open. On a laptop, at rest with the nine scenarios loaded, the app container used about 100 MB and FalkorDB
   about 80 MB; a visitor's copy of a small scenario cost about 160 KB of FalkorDB memory when it was measured
   (PLAN.md section 17). Under load nothing has been measured, so check on the VM before raising `SESSION_MAX`.
2. Clone the repository there, then write `.env`:

   ```bash
   cp .env.example .env
   # in .env, set:
   #   FALKORDB_PASSWORD=<a long random value>
   #   DEVRIES_MCP_TOKEN=<another long random value>   # external MCP clients send it as a bearer token
   #   SITE_ADDRESS=devries.example.org                # the public host name; the overlay passes it as ALLOWED_HOSTS too
   #   ANTHROPIC_API_KEY=...                           # optional: without it every run is scripted, and says so
   #   LLM_DAILY_BUDGET_USD=5                          # the overlay's default; past it, new runs are scripted
   ```

3. Start it:

   ```bash
   docker compose -f docker-compose.yml -f deploy/docker-compose.deploy.yml up -d --wait --build
   ```

   The app loads any scenario graph that is missing and scans it, so a fresh volume heals itself.
4. From another machine: `deploy/uptime-check.sh https://devries.example.org`. Put it on a timer for as long as
   the deployment has to stay up.

To update: `git pull`, then the same `up` command. To stop and keep the data: the same command with `down`.

## What a visitor can and cannot do

- Read the nine shared scenarios. The first change a visitor makes (running an audit, approving a plan) is made
  to their own copy of that scenario, kept for an hour; at most 30 sessions hold copies at once.
- With a model configured: three audit runs and ten questions per session, then runs are scripted. Without one,
  every run is scripted.
- Nothing a visitor does reaches another visitor's copy or the shared scenarios.
- `/mcp` answers only to the bearer token.

## What was checked locally, and what was not

Checked on 13 October 2026, with the overlay up on `https://localhost:8443`:

- `/api/health` answers 200 through the proxy, and plain HTTP is redirected to HTTPS
- the UI's JavaScript is served compressed; the API is not; `Strict-Transport-Security` is set
- the session cookie carries `Secure`, `HttpOnly` and `SameSite=Lax`
- `/mcp` answers 401 without the token and 200 with it
- the event stream's first event arrives at once, so the proxy is not buffering it
- the browser test of the whole loop (audit, approve, the finding closes, on two scenarios) passes through the
  proxy, with the local certificate authority accepted for the test
- without `DEVRIES_MCP_TOKEN` or `SITE_ADDRESS` the overlay refuses to start, and says which is missing

Not checked: a real certificate from Let's Encrypt, a real host name, a reboot, memory under many sessions, and
anything about a particular provider.
