#!/usr/bin/env bash
# Print the RINGO usage log — one line per page visit, recorded by the
# Lambda in DynamoDB: Central time, UTC time, visitor IP.
#   ./scripts/usage-log.sh
set -euo pipefail

aws dynamodb scan --region us-east-2 --table-name "${RINGO_TABLE:-ringo}" \
  --filter-expression 'begins_with(pk, :p)' \
  --expression-attribute-values '{":p":{"S":"LOG#"}}' \
  --query 'Items[].[central.S, utc.S, ip.S]' --output text \
  | sort -t$'\t' -k2 \
  | column -t -s$'\t'
