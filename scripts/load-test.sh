#!/usr/bin/env bash
# load-test.sh — Send a stream of orders to the API
# Usage:
#   ./scripts/load-test.sh              # default: 1 req/s, 60s
#   ./scripts/load-test.sh 5 120        # 5 req/s for 120 seconds
#   ./scripts/load-test.sh 10           # 10 req/s for 60 seconds (default duration)

set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
RPS="${1:-1}"
DURATION="${2:-60}"
INTERVAL=$(echo "scale=4; 1 / $RPS" | bc)

PRODUCTS=("prod-A" "prod-B" "prod-C" "prod-D" "prod-E")
REQUEST_COUNT=0
ERROR_COUNT=0
START=$(date +%s)

echo "Load test started"
echo "  Target : $API_URL/order"
echo "  Rate   : ${RPS} req/s"
echo "  Duration: ${DURATION}s"
echo "  Interval: ${INTERVAL}s"
echo "─────────────────────────────────"

trap 'echo ""; echo "─────────────────────────────────"; echo "Requests: $REQUEST_COUNT | Errors: $ERROR_COUNT | Duration: $(($(date +%s) - START))s"; exit 0' INT TERM

while true; do
  ELAPSED=$(( $(date +%s) - START ))
  if [ "$ELAPSED" -ge "$DURATION" ]; then
    break
  fi

  PRODUCT="${PRODUCTS[$((RANDOM % ${#PRODUCTS[@]}))]}"
  QTY=$(( (RANDOM % 10) + 1 ))

  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${API_URL}/order" \
    -H "Content-Type: application/json" \
    -d "{\"product_id\": \"${PRODUCT}\", \"quantity\": ${QTY}}")

  REQUEST_COUNT=$(( REQUEST_COUNT + 1 ))

  if [[ "$HTTP_STATUS" =~ ^5 ]]; then
    ERROR_COUNT=$(( ERROR_COUNT + 1 ))
    echo "$(date '+%H:%M:%S') [ERROR] HTTP $HTTP_STATUS  (errors: $ERROR_COUNT/$REQUEST_COUNT)"
  else
    echo "$(date '+%H:%M:%S') [OK]    HTTP $HTTP_STATUS  product=$PRODUCT qty=$QTY  req#$REQUEST_COUNT"
  fi

  sleep "$INTERVAL"
done

echo "─────────────────────────────────"
echo "Load test complete"
echo "  Total requests : $REQUEST_COUNT"
echo "  Errors         : $ERROR_COUNT"
echo "  Success rate   : $(echo "scale=1; (1 - $ERROR_COUNT / $REQUEST_COUNT) * 100" | bc)%"
