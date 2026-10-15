.PHONY: help up down wipe probe seed test ui serve dev app e2e mcp mcp-config queries-md queries-doc self-manifest agent-eval

APP_URL ?= http://127.0.0.1:8000

help:
	@echo "make up          start FalkorDB (docker compose) and wait until it is healthy"
	@echo "make probe       check the FalkorDB behaviours the design depends on"
	@echo "make seed        load every scenario in scenarios/ and scan it against its expect block"
	@echo "make test        run the whole test suite"
	@echo "make serve       build the UI and run the app from source: UI, API and /mcp on http://localhost:8000"
	@echo "make dev         the same with reload, plus the Vite dev server on http://localhost:5173"
	@echo "make app         run FalkorDB and the app in containers (docker compose), on http://localhost:8000"
	@echo "make e2e         drive the running app in headless Chrome: audit, approve, finding closes (needs Google Chrome)"
	@echo "make mcp         run the MCP server over stdio"
	@echo "make mcp-config  print the entry for an MCP client's config file (Claude Desktop), with absolute paths"
	@echo "make queries-md  print the query catalog as Markdown"
	@echo "make queries-doc rewrite docs/QUERIES.md from the query catalog"
	@echo "make self-manifest  rewrite manifests/cistern.tools.json from this server's own tool list"
	@echo "make agent-eval  compare the auditor with the baseline search on every scenario (RUNS=3; needs a model to say anything about the agent)"
	@echo "make down        stop FalkorDB (data volume kept)     make wipe   stop it and delete the volume"

.env:
	@echo "No .env yet: copy .env.example to .env and set FALKORDB_PASSWORD." && exit 1

up: .env
	docker compose up -d --wait falkordb

down:
	docker compose down

wipe:
	docker compose down -v

probe: up
	uv run pytest tests/probes -v

seed: up
	uv run python -m cistern.ingest --strict

test: up
	uv run pytest

ui/node_modules: ui/package.json ui/package-lock.json
	cd ui && npm ci --no-audit --no-fund && touch node_modules

ui: ui/node_modules
	cd ui && npm run build

serve: up ui
	uv run uvicorn cistern.app:app --port 8000

dev: up ui/node_modules
	(uv run uvicorn cistern.app:app --port 8000 --reload --reload-dir cistern & cd ui && npm run dev)

app: .env
	docker compose up -d --wait --build

e2e: ui/node_modules
	cd ui && node e2e/gate.mjs $(APP_URL) && node e2e/views.mjs $(APP_URL)

mcp: up
	uv run python -m cistern.mcp_server

mcp-config:
	@uv run python -m cistern.mcp_server --client-config

queries-md:
	@uv run python -m cistern.graph.catalog

queries-doc:
	@mkdir -p docs && uv run python -m cistern.graph.catalog > docs/QUERIES.md && echo "docs/QUERIES.md rewritten"

self-manifest:
	uv run python -m cistern.mcp_server --manifest > manifests/cistern.tools.json

RUNS ?= 3
agent-eval: up
	uv run python -m cistern.agent.evaluate --runs $(RUNS)
