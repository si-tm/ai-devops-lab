# AI DevOps Lab

AI DevOpsエージェントが「原因分析 → 修正提案」を実践できる検証環境です。

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│  SoE             Decoupling Layer         SoR           │
│                                                         │
│  ┌─────────┐      ┌─────────┐      ┌──────────────┐    │
│  │   API   │─────▶│  Redis  │─────▶│   Worker     │    │
│  │ :3000   │      │  Queue  │      │              │    │
│  └─────────┘      └─────────┘      └──────┬───────┘    │
│                                           │            │
│                                    ┌──────▼───────┐    │
│                                    │  PostgreSQL  │    │
│                                    │   :5432      │    │
│                                    └──────────────┘    │
└─────────────────────────────────────────────────────────┘

Observability:
  Prometheus :9090  →  Grafana :3001
  OTel Collector → Jaeger :16686
```

## 起動手順

```bash
cd ai-devops-lab
docker compose up --build -d
```

### 動作確認

```bash
# サービス状態
docker compose ps

# ヘルスチェック
curl http://localhost:3000/health

# 注文を1件送信
curl -X POST http://localhost:3000/order \
  -H "Content-Type: application/json" \
  -d '{"product_id": "prod-A", "quantity": 3}'

# 応答例:
# {"status":"queued","orderId":"...","trace_id":"..."}
```

### UI アクセス

| ツール | URL | 認証 |
|--------|-----|------|
| Grafana | http://localhost:3001 | admin / admin |
| Prometheus | http://localhost:9090 | なし |
| Jaeger | http://localhost:16686 | なし |

---

## 障害の起こし方

### コマンド一覧

```bash
# 現在のカオス設定を確認
./scripts/fault-inject.sh status

# シナリオ単体
./scripts/fault-inject.sh latency       on [ms]        # APIに遅延追加 (default: 2000ms)
./scripts/fault-inject.sh errors        on [pct]       # エラー注入 (default: 30%)
./scripts/fault-inject.sh queue-delay   on [ms]        # キュー送信を遅延 (default: 3000ms)
./scripts/fault-inject.sh worker-failure on [pct]      # Worker失敗率 (default: 50%)
./scripts/fault-inject.sh db-lock       on [ms]        # DBロック模擬 (default: 5000ms)

# すべてリセット
./scripts/fault-inject.sh reset

# プリセットシナリオ (複合障害)
./scripts/fault-inject.sh scenario1    # APIレイテンシ + キュー滞留
./scripts/fault-inject.sh scenario2    # Worker大量失敗
./scripts/fault-inject.sh scenario3    # DBロックストーム
./scripts/fault-inject.sh scenario4    # 全部同時 (フル劣化)
```

### APIで直接設定

```bash
# カオス状態を確認
curl http://localhost:3000/chaos

# 複数パラメータを同時設定
curl -X POST http://localhost:3000/chaos/set \
  -H "Content-Type: application/json" \
  -d '{
    "api_latency_ms": 2000,
    "error_rate_pct": 20,
    "worker_failure_rate_pct": 40
  }'

# 全リセット
curl -X POST http://localhost:3000/chaos/reset
```

---

## 5つの障害シナリオ

### 1. APIの高遅延

```bash
./scripts/fault-inject.sh latency on 3000
./scripts/load-test.sh 5 60
```

**どこで異常が分かるか:**
- Grafana: "API Latency Percentiles" → p95 が急上昇
- Prometheus: `histogram_quantile(0.95, rate(api_http_request_duration_seconds_bucket[1m]))`
- Jaeger: `api` サービスのトレースで `api.create_order` スパンが長い
- ログ: `"chaos_type":"api_latency"` のWARNログ

---

### 2. キュー滞留

```bash
./scripts/fault-inject.sh worker-failure on 100   # Workerを完全停止状態に
./scripts/load-test.sh 10 30
```

**どこで異常が分かるか:**
- Grafana: "Queue Depth Over Time" → 線形増加
- Prometheus: `worker_queue_depth > 50` でアラート発火
- Redis: `docker exec ai-devops-redis redis-cli llen orders:queue`

---

### 3. Worker停止

```bash
docker compose stop worker
./scripts/load-test.sh 5 30
# 復旧
docker compose start worker
```

**どこで異常が分かるか:**
- Grafana: "Worker Processing Rate" がゼロに
- Prometheus: `rate(worker_processed_total[2m])` = 0
- キュー深度が増加し続ける

---

### 4. DBロック

```bash
./scripts/fault-inject.sh db-lock on 8000
```

**どこで異常が分かるか:**
- Grafana: "DB Query Duration" → p95/p99 が急上昇
- Jaeger: `db.insert_order` スパンが 8s 以上
- ログ: `"chaos_type":"db_lock"`, `lock_duration_ms: 8000`
- Workerのスループットが低下 → キュー滞留に波及

---

### 5. ランダムエラー増加

```bash
./scripts/fault-inject.sh errors on 50
```

**どこで異常が分かるか:**
- Grafana: "API Success Rate" → 50% 付近に低下
- Prometheus: `rate(api_http_requests_total{status_code="500"}[1m])`
- ログ: `"cause":"chaos_error_injection"` のERRORログ

---

## 負荷生成

```bash
# 1 req/s を 60 秒
./scripts/load-test.sh

# 10 req/s を 120 秒
./scripts/load-test.sh 10 120
```

---

## AIエージェントが使うクエリ集

### Prometheus（メトリクス）

```promql
# API成功率 (SLO: 99%以上)
1 - rate(api_http_requests_total{status_code=~"5.."}[5m])
  / rate(api_http_requests_total[5m])

# p95レイテンシ
histogram_quantile(0.95, rate(api_http_request_duration_seconds_bucket[5m]))

# キュー深度
worker_queue_depth

# Worker失敗率
rate(worker_processed_total{status="error"}[5m])
  / rate(worker_processed_total[5m])

# DBクエリp99
histogram_quantile(0.99, rate(worker_db_query_duration_seconds_bucket[5m]))

# アクティブなカオスシナリオ
api_chaos_active{} == 1 or worker_chaos_active{} == 1
```

### ログ（JSON構造化）

```bash
# APIエラーログを抽出
docker compose logs api | grep '"level":"error"'

# 特定のトレースIDでフィルタ
docker compose logs api worker | grep '"trace_id":"<YOUR_TRACE_ID>"'

# カオス注入ログ
docker compose logs api | grep '"chaos_type"'

# DBロック関連
docker compose logs worker | grep '"chaos_type":"db_lock"'
```

### トレース（Jaeger UI）

1. http://localhost:16686 を開く
2. Service: `api` を選択 → `Find Traces`
3. 遅いトレースを選択 → `api` → `worker` → `db` の依存グラフで原因を特定

---

## ディレクトリ構成

```
ai-devops-lab/
├── docker-compose.yml
├── README.md
├── services/
│   ├── api/                        # SoE: APIサーバ (Node.js/Express)
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.js            # メインサーバ + カオスロジック
│   │       ├── tracing.js          # OpenTelemetry SDK設定
│   │       ├── logger.js           # Winston JSON構造化ログ
│   │       └── metrics.js          # prom-client メトリクス定義
│   ├── worker/                     # Worker: キュー消費 → DB書き込み
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.js            # ワーカーループ + カオスロジック
│   │       ├── tracing.js
│   │       ├── logger.js
│   │       └── metrics.js
│   └── db-init/
│       └── init.sql                # PostgreSQLスキーマ初期化
├── observability/
│   ├── prometheus/
│   │   ├── prometheus.yml          # スクレイプ設定
│   │   └── alerts.yml              # アラートルール5本
│   ├── grafana/
│   │   └── provisioning/
│   │       ├── datasources/
│   │       │   └── datasource.yml  # Prometheus + Jaeger
│   │       └── dashboards/
│   │           ├── dashboard.yml
│   │           └── main.json       # 4層ダッシュボード
│   └── otel-collector/
│       └── otel-config.yml         # OTLP → Jaeger
└── scripts/
    ├── load-test.sh                # 負荷生成
    └── fault-inject.sh             # 障害注入
```

---

## トラブルシューティング

```bash
# ログ確認
docker compose logs -f api
docker compose logs -f worker

# 全サービスを再起動
docker compose restart

# 完全リセット（データも削除）
docker compose down -v
docker compose up --build -d

# Prometheusのスクレイプ状態確認
open http://localhost:9090/targets

# Redis キューの中身を直接確認
docker exec ai-devops-redis redis-cli lrange orders:queue 0 -1 | head -5
docker exec ai-devops-redis redis-cli lrange orders:dlq 0 -1 | head -5
```
