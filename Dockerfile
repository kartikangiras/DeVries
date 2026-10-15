# The app image: the built UI plus the Python package. FalkorDB runs beside it (docker-compose.yml).

FROM node:22-alpine AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build


FROM python:3.12-slim AS app
RUN pip install --no-cache-dir uv==0.11.23
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1

# dependencies first, so a code change does not reinstall them
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY devries/ devries/
COPY scenarios/ scenarios/
COPY manifests/ manifests/
RUN uv sync --frozen --no-dev
COPY --from=ui /ui/dist ui/dist

RUN useradd --system --uid 10001 --home /app devries && chown -R devries /app
USER devries
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD ["/app/.venv/bin/python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"]
CMD ["/app/.venv/bin/uvicorn", "devries.app:app", "--host", "0.0.0.0", "--port", "8000"]
