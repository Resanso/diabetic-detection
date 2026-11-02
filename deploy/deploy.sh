#!/usr/bin/env bash
# Deploy Retinova ke VPS mentio. Jalankan dari root repo: ./deploy/deploy.sh [--benchmark]
#   - selalu membackup server/data di VPS lebih dulu (~/backups)
#   - tidak pernah menimpa server/data dan server/model di VPS
#   - --benchmark: ganti juga set benchmark lab (server/data/benchmark) dengan versi lokal
set -euo pipefail

HOST=${HOST:-mentio-vps}
DIR=${DIR:-diabetic-detection}
SERVICE=diabetic-detection
CONTAINER=diabetic-detection-app
URL=${URL:-https://tilik.43-134-5-10.sslip.io}
STAMP=$(date +%Y%m%d-%H%M)

cd "$(dirname "$0")/.."

echo "== Backup data di VPS"
ssh "$HOST" "cd ~/$DIR && mkdir -p ~/backups && tar czf ~/backups/$DIR-data-$STAMP.tgz server/data && ls -lh ~/backups/$DIR-data-$STAMP.tgz"

echo "== Sinkron kode"
rsync -az --exclude data --exclude model --exclude static/app --exclude __pycache__ server/ "$HOST:$DIR/server/"
rsync -az --exclude node_modules --exclude dist web/ "$HOST:$DIR/web/"
rsync -az docker-compose.yml Dockerfile .dockerignore README.md "$HOST:$DIR/"

if [[ "${1:-}" == "--benchmark" ]]; then
  echo "== Ganti set benchmark lab"
  rsync -az --delete server/data/benchmark/ "$HOST:$DIR/server/data/benchmark/"
fi

echo "== Build dan jalankan ulang"
ssh "$HOST" "cd ~/$DIR && docker compose up -d --build $SERVICE"

echo "== Verifikasi"
ssh "$HOST" "for i in \$(seq 1 45); do s=\$(docker inspect -f '{{.State.Health.Status}}' $CONTAINER); [ \"\$s\" = healthy ] && break; sleep 2; done; echo \"health: \$s\";
  docker exec $CONTAINER python -c \"import json; m=json.load(open('/app/model/metadata.json')); print('model:', m['model'], m.get('preprocess_mode'), m.get('img_size'))\";
  curl -s -o /dev/null -w 'situs %{http_code}  ' $URL/;
  curl -s -o /dev/null -w 'lab %{http_code}  ' $URL/lab;
  curl -s -o /dev/null -w 'mentio.space %{http_code}\n' https://mentio.space/"
