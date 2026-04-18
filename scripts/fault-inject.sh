#!/usr/bin/env bash
# fault-inject.sh — Toggle chaos scenarios on/off
#
# Usage:
#   ./scripts/fault-inject.sh status
#   ./scripts/fault-inject.sh latency on [ms]      # default 2000ms
#   ./scripts/fault-inject.sh latency off
#   ./scripts/fault-inject.sh errors on [pct]       # default 30%
#   ./scripts/fault-inject.sh errors off
#   ./scripts/fault-inject.sh queue-delay on [ms]   # default 3000ms
#   ./scripts/fault-inject.sh queue-delay off
#   ./scripts/fault-inject.sh worker-failure on [pct] # default 50%
#   ./scripts/fault-inject.sh worker-failure off
#   ./scripts/fault-inject.sh db-lock on [ms]       # default 5000ms
#   ./scripts/fault-inject.sh db-lock off
#   ./scripts/fault-inject.sh reset                 # disable ALL chaos
#   ./scripts/fault-inject.sh scenario1             # preset: high latency + queue delay
#   ./scripts/fault-inject.sh scenario2             # preset: worker failure cascade
#   ./scripts/fault-inject.sh scenario3             # preset: DB lock storm

set -euo pipefail

API="${API_URL:-http://localhost:3000}"

function status() {
  echo "Current chaos state:"
  curl -s "${API}/chaos" | python3 -m json.tool 2>/dev/null || curl -s "${API}/chaos"
  echo ""
}

function set_chaos() {
  local payload="$1"
  curl -s -X POST "${API}/chaos/set" \
    -H "Content-Type: application/json" \
    -d "$payload" | python3 -m json.tool 2>/dev/null || true
}

function reset() {
  curl -s -X POST "${API}/chaos/reset" | python3 -m json.tool 2>/dev/null || true
  echo "All chaos scenarios disabled."
}

COMMAND="${1:-status}"

case "$COMMAND" in

  status)
    status
    ;;

  latency)
    ACTION="${2:-on}"
    if [ "$ACTION" = "on" ]; then
      MS="${3:-2000}"
      echo "Enabling API latency: ${MS}ms"
      set_chaos "{\"api_latency_ms\": $MS}"
    else
      echo "Disabling API latency"
      set_chaos '{"api_latency_ms": 0}'
    fi
    ;;

  errors)
    ACTION="${2:-on}"
    if [ "$ACTION" = "on" ]; then
      PCT="${3:-30}"
      echo "Enabling error injection: ${PCT}%"
      set_chaos "{\"error_rate_pct\": $PCT}"
    else
      echo "Disabling error injection"
      set_chaos '{"error_rate_pct": 0}'
    fi
    ;;

  queue-delay)
    ACTION="${2:-on}"
    if [ "$ACTION" = "on" ]; then
      MS="${3:-3000}"
      echo "Enabling queue delay: ${MS}ms"
      set_chaos "{\"queue_delay_ms\": $MS}"
    else
      echo "Disabling queue delay"
      set_chaos '{"queue_delay_ms": 0}'
    fi
    ;;

  worker-failure)
    ACTION="${2:-on}"
    if [ "$ACTION" = "on" ]; then
      PCT="${3:-50}"
      echo "Enabling worker failure rate: ${PCT}%"
      set_chaos "{\"worker_failure_rate_pct\": $PCT}"
    else
      echo "Disabling worker failure"
      set_chaos '{"worker_failure_rate_pct": 0}'
    fi
    ;;

  db-lock)
    ACTION="${2:-on}"
    if [ "$ACTION" = "on" ]; then
      MS="${3:-5000}"
      echo "Enabling DB lock duration: ${MS}ms"
      set_chaos "{\"db_lock_duration_ms\": $MS}"
    else
      echo "Disabling DB lock"
      set_chaos '{"db_lock_duration_ms": 0}'
    fi
    ;;

  reset)
    reset
    ;;

  # ── Preset scenarios ──────────────────────────────

  scenario1)
    echo "Scenario 1: High API Latency + Queue Congestion"
    echo "Expected: p95 latency spike, queue depth growing, Prometheus alert fires"
    set_chaos '{"api_latency_ms": 2000, "queue_delay_ms": 1500}'
    ;;

  scenario2)
    echo "Scenario 2: Worker Failure Cascade"
    echo "Expected: orders piling up in DLQ, worker error rate >20%, queue depth grows"
    set_chaos '{"worker_failure_rate_pct": 60}'
    ;;

  scenario3)
    echo "Scenario 3: DB Lock Storm"
    echo "Expected: DB query p95 >5s, worker throughput drops, queue depth rises"
    set_chaos '{"db_lock_duration_ms": 8000}'
    ;;

  scenario4)
    echo "Scenario 4: Full Degradation (everything on)"
    set_chaos '{"api_latency_ms": 1000, "error_rate_pct": 20, "queue_delay_ms": 1000, "worker_failure_rate_pct": 30, "db_lock_duration_ms": 2000}'
    ;;

  *)
    echo "Unknown command: $COMMAND"
    echo "Usage: $0 {status|latency|errors|queue-delay|worker-failure|db-lock|reset|scenario1|scenario2|scenario3|scenario4}"
    exit 1
    ;;
esac
