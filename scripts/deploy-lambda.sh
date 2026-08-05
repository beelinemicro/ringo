#!/usr/bin/env bash
# Deploy the RINGO WebSocket Lambda (aws/ws-handler + shared game logic).
#   ./scripts/deploy-lambda.sh
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD=build/lambda
rm -rf "$BUILD"
mkdir -p "$BUILD"
cp aws/ws-handler/index.mjs public/js/game.js public/js/ai.js "$BUILD/"
(cd "$BUILD" && zip -q ../ringo-ws.zip index.mjs game.js ai.js)

aws lambda update-function-code --region us-east-2 \
  --function-name ringo-ws \
  --zip-file fileb://build/ringo-ws.zip \
  --query 'LastUpdateStatus' --output text
echo "Lambda ringo-ws updated."
