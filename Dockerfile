FROM python:3.12.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY requirements.lock requirements.txt
RUN python -m pip install --upgrade pip==25.2 \
    && python -m pip install -r requirements.txt

COPY . .
RUN useradd --create-home --uid 10001 climate \
    && chown -R climate:climate /app
USER climate

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import json,urllib.request; data=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=3)); raise SystemExit(0 if data['status']=='ok' else 1)"

CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1"]
