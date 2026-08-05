#!/usr/bin/env bash
# Print the RINGO usage log — one line per page visit, recorded by the
# Lambda in DynamoDB: Central time, UTC time, visitor IP, and location.
# Locations come from ip-api.com at print time (one lookup per distinct
# IP, so the free rate limit is never a concern at family scale).
#   ./scripts/usage-log.sh
set -euo pipefail

declare -A LOC # ip -> "City, Region, Country" (cached per run)

aws dynamodb scan --region us-east-2 --table-name "${RINGO_TABLE:-ringo}" \
  --filter-expression 'begins_with(pk, :p)' \
  --expression-attribute-values '{":p":{"S":"LOG#"}}' \
  --query 'Items[].[central.S, utc.S, ip.S]' --output text \
  | sort -t$'\t' -k2 \
  | while IFS=$'\t' read -r central utc ip; do
      if [[ -z "${LOC[$ip]:-}" ]]; then
        geo=$(curl -s --max-time 5 "http://ip-api.com/csv/$ip?fields=status,city,region,countryCode" | tr -d '\r' || true)
        if [[ "$geo" == success,* ]]; then
          # ip-api's fixed field order is country,region,city — flip it.
          LOC[$ip]=$(awk -F, '{print $3", "$2", "$1}' <<<"${geo#success,}")
        else
          LOC[$ip]='unknown'
        fi
      fi
      printf '%s\t%s\t%s\t%s\n' "$central" "$utc" "$ip" "${LOC[$ip]}"
    done \
  | column -t -s$'\t'
