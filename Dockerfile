# Base image Python 3.11 slim yang ringan dan kompatibel dengan ONNX Runtime & OpenCV
FROM python:3.11-slim

# Mencegah pembuatan file .pyc dan buffering stdout
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

# Install dependensi sistem untuk OpenCV headless dan kompresi
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Salin dependensi terlebih dahulu agar caching layer Docker optimal
COPY server/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Salin source code server, model ONNX, dan data benchmark
COPY server/ /app/

# Pastikan direktori data & model tersedia
RUN mkdir -p /app/data/images /app/data/benchmark /app/model

EXPOSE 8000

# Healthcheck otomatis
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Jalankan Uvicorn
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
