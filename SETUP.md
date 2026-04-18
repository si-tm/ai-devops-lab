# AI DevOps Lab — AWS ECS (Fargate) セットアップガイド

> **対象読者:** AWSの基礎知識はあるが ECS / Fargate のデプロイ経験が浅い方  
> **目標:** コピペで再現でき、デプロイ後すぐに障害検証ができる運用検証環境の構築

---

## 目次

1. [前提条件](#1-前提条件)
2. [全体アーキテクチャ](#2-全体アーキテクチャ)
3. [準備作業（変数・IAM）](#3-準備作業)
4. [ネットワーク構築](#4-ネットワーク構築)
5. [ECR — イメージのビルド & プッシュ](#5-ecr--イメージのビルド--プッシュ)
6. [データ層（RDS / ElastiCache）](#6-データ層)
7. [Secrets Manager — 認証情報の格納](#7-secrets-manager)
8. [IAM ロール](#8-iam-ロール)
9. [CloudWatch Log Groups](#9-cloudwatch-log-groups)
10. [ECS クラスター](#10-ecs-クラスター)
11. [OTel Collector 設定（SSM Parameter Store）](#11-otel-collector-設定)
12. [ECS タスク定義](#12-ecs-タスク定義)
13. [ECS サービス & ALB](#13-ecs-サービス--alb)
14. [動作確認](#14-動作確認)
15. [CloudWatch Logs / X-Ray — AI エージェント調査手順](#15-cloudwatch-logs--x-ray)
16. [障害検証方法](#16-障害検証方法)
17. [環境変数一覧](#17-環境変数一覧)
18. [トラブルシューティング](#18-トラブルシューティング)
19. [リソース削除手順](#19-リソース削除手順)

---

## 1. 前提条件

### 必要なツール

```bash
# バージョン確認
aws --version     # 2.x 以上
docker --version  # 24.x 以上
jq --version      # 1.6 以上（オプションだが推奨）

# インストール（未導入の場合）
# AWS CLI: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
# jq: brew install jq
```

### AWS CLI 認証設定

```bash
aws configure
# AWS Access Key ID: <your-key>
# AWS Secret Access Key: <your-secret>
# Default region name: ap-northeast-1
# Default output format: json

# 接続確認
aws sts get-caller-identity
```

### 必要な IAM 権限（デプロイ実行ユーザー）

以下のマネージドポリシーをアタッチするか、同等の権限を持つユーザーで実行してください：

- `AmazonEC2FullAccess`
- `AmazonECS_FullAccess`
- `AmazonRDSFullAccess`
- `AmazonElastiCacheFullAccess`
- `AmazonECR_FullAccess`
- `SecretsManagerReadWrite`
- `AmazonSSMFullAccess`
- `IAMFullAccess`
- `CloudWatchFullAccess`
- `AWSXRayFullAccess`
- `ElasticLoadBalancingFullAccess`

> **コスト目安:** この環境を24時間稼働させると **約 $5–10/日** かかります。検証後は [Section 19](#19-リソース削除手順) で必ず削除してください。

---

## 2. 全体アーキテクチャ

```
                         Internet
                             │
                    ┌────────▼────────┐
                    │   ALB (public)   │  :80
                    └────────┬────────┘
                             │
              ───────────────────────────────
              パブリックサブネット (2 AZ)
              ───────────────────────────────
                             │ (Security Group: alb-sg → api-sg)
              ───────────────────────────────
              プライベートサブネット (2 AZ)
              ───────────────────────────────
                    ┌────────▼────────┐
                    │  ECS Fargate    │
                    │  [api コンテナ] │  :3000
                    │  [adot サイドカー│  :4317/4318 (localhost)
                    └─────┬──────┬───┘
                          │      │
              ┌───────────┘      └───────────┐
              ▼                              ▼
   ┌──────────────────┐          ┌──────────────────┐
   │  ElastiCache     │          │  ECS Fargate     │
   │  Redis (cluster) │◀─────────│  [worker]        │
   │  :6379           │          │  [adot sidecar]  │
   └──────────────────┘          └────────┬─────────┘
                                          │
                                 ┌────────▼─────────┐
                                 │  RDS PostgreSQL  │
                                 │  :5432           │
                                 └──────────────────┘

Observability (マネージドサービスに置き換え):
  ローカル Prometheus  → CloudWatch Metrics (Container Insights)
  ローカル Jaeger      → AWS X-Ray
  ローカル Grafana     → CloudWatch Dashboards
  全コンテナログ       → CloudWatch Logs (awslogs driver)

トレースフロー:
  API / Worker
    └─(OTLP localhost)→ ADOT Collector (sidecar)
         └─(AWS SDK)→ X-Ray
```

### コンポーネント対応表

| ローカル (docker-compose) | AWS |
|--------------------------|-----|
| API (Node.js) | ECS Fargate タスク |
| Worker (Node.js) | ECS Fargate タスク |
| Redis | ElastiCache (Serverless) |
| PostgreSQL | RDS Aurora Serverless v2 / RDS t3.micro |
| OTel Collector | ADOT Collector (sidecar コンテナ) |
| Prometheus | CloudWatch Container Insights |
| Jaeger | AWS X-Ray |
| Grafana | CloudWatch Dashboards |

---

## 3. 準備作業

### 3-1. 共通変数の設定（全コマンドの前に実行）

```bash
export AWS_REGION="ap-northeast-1"
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export PROJECT="ai-devops-lab"
export VPC_CIDR="10.0.0.0/16"

echo "Account: ${ACCOUNT_ID}"
echo "Region:  ${AWS_REGION}"
echo "Project: ${PROJECT}"
```

> **Tip:** シェルを再起動した場合はこのブロックを再実行してください。以降のコマンドはすべてこれらの変数を使用します。

---

## 4. ネットワーク構築

### 4-1. VPC

```bash
VPC_ID=$(aws ec2 create-vpc \
  --cidr-block ${VPC_CIDR} \
  --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=${PROJECT}-vpc}]" \
  --query 'Vpc.VpcId' --output text)

aws ec2 modify-vpc-attribute --vpc-id ${VPC_ID} --enable-dns-hostnames
aws ec2 modify-vpc-attribute --vpc-id ${VPC_ID} --enable-dns-support

echo "VPC_ID=${VPC_ID}"
```

### 4-2. インターネットゲートウェイ

```bash
IGW_ID=$(aws ec2 create-internet-gateway \
  --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=${PROJECT}-igw}]" \
  --query 'InternetGateway.InternetGatewayId' --output text)

aws ec2 attach-internet-gateway --internet-gateway-id ${IGW_ID} --vpc-id ${VPC_ID}

echo "IGW_ID=${IGW_ID}"
```

### 4-3. サブネット（2 AZ）

```bash
# パブリックサブネット（ALB 用）
SUBNET_PUB_1A=$(aws ec2 create-subnet \
  --vpc-id ${VPC_ID} \
  --cidr-block 10.0.1.0/24 \
  --availability-zone ${AWS_REGION}a \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${PROJECT}-pub-1a}]" \
  --query 'Subnet.SubnetId' --output text)

SUBNET_PUB_1C=$(aws ec2 create-subnet \
  --vpc-id ${VPC_ID} \
  --cidr-block 10.0.2.0/24 \
  --availability-zone ${AWS_REGION}c \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${PROJECT}-pub-1c}]" \
  --query 'Subnet.SubnetId' --output text)

# プライベートサブネット（ECS / RDS / ElastiCache 用）
SUBNET_PRI_1A=$(aws ec2 create-subnet \
  --vpc-id ${VPC_ID} \
  --cidr-block 10.0.11.0/24 \
  --availability-zone ${AWS_REGION}a \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${PROJECT}-pri-1a}]" \
  --query 'Subnet.SubnetId' --output text)

SUBNET_PRI_1C=$(aws ec2 create-subnet \
  --vpc-id ${VPC_ID} \
  --cidr-block 10.0.12.0/24 \
  --availability-zone ${AWS_REGION}c \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${PROJECT}-pri-1c}]" \
  --query 'Subnet.SubnetId' --output text)

# パブリックサブネットは自動パブリック IP を有効化
aws ec2 modify-subnet-attribute --subnet-id ${SUBNET_PUB_1A} --map-public-ip-on-launch
aws ec2 modify-subnet-attribute --subnet-id ${SUBNET_PUB_1C} --map-public-ip-on-launch

echo "PUB_1A=${SUBNET_PUB_1A} PUB_1C=${SUBNET_PUB_1C}"
echo "PRI_1A=${SUBNET_PRI_1A} PRI_1C=${SUBNET_PRI_1C}"
```

### 4-4. NAT ゲートウェイ（プライベートサブネットのアウトバウンド用）

```bash
# Elastic IP 確保
EIP_ALLOC=$(aws ec2 allocate-address --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=${PROJECT}-nat-eip}]" \
  --query 'AllocationId' --output text)

# NAT GW 作成（1AZ のみ — コスト削減）
NAT_GW_ID=$(aws ec2 create-nat-gateway \
  --subnet-id ${SUBNET_PUB_1A} \
  --allocation-id ${EIP_ALLOC} \
  --tag-specifications "ResourceType=natgateway,Tags=[{Key=Name,Value=${PROJECT}-nat}]" \
  --query 'NatGateway.NatGatewayId' --output text)

echo "NAT_GW_ID=${NAT_GW_ID}"
echo "NAT GW のプロビジョニング中（約1分）..."
aws ec2 wait nat-gateway-available --nat-gateway-ids ${NAT_GW_ID}
echo "NAT GW 準備完了"
```

### 4-5. ルートテーブル

```bash
# パブリック用（IGW へ）
RT_PUB=$(aws ec2 create-route-table \
  --vpc-id ${VPC_ID} \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=${PROJECT}-rt-pub}]" \
  --query 'RouteTable.RouteTableId' --output text)

aws ec2 create-route --route-table-id ${RT_PUB} \
  --destination-cidr-block 0.0.0.0/0 --gateway-id ${IGW_ID}
aws ec2 associate-route-table --route-table-id ${RT_PUB} --subnet-id ${SUBNET_PUB_1A}
aws ec2 associate-route-table --route-table-id ${RT_PUB} --subnet-id ${SUBNET_PUB_1C}

# プライベート用（NAT GW へ）
RT_PRI=$(aws ec2 create-route-table \
  --vpc-id ${VPC_ID} \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=${PROJECT}-rt-pri}]" \
  --query 'RouteTable.RouteTableId' --output text)

aws ec2 create-route --route-table-id ${RT_PRI} \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id ${NAT_GW_ID}
aws ec2 associate-route-table --route-table-id ${RT_PRI} --subnet-id ${SUBNET_PRI_1A}
aws ec2 associate-route-table --route-table-id ${RT_PRI} --subnet-id ${SUBNET_PRI_1C}
```

### 4-6. セキュリティグループ

```bash
# ALB 用
SG_ALB=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-alb-sg" \
  --description "ALB inbound HTTP" \
  --vpc-id ${VPC_ID} \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=${PROJECT}-alb-sg}]" \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id ${SG_ALB} \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

# API ECS タスク用
SG_API=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-api-sg" \
  --description "API ECS task" \
  --vpc-id ${VPC_ID} \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=${PROJECT}-api-sg}]" \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id ${SG_API} \
  --protocol tcp --port 3000 --source-group ${SG_ALB}

# Worker ECS タスク用（インバウンド不要、アウトバウンドのみ）
SG_WORKER=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-worker-sg" \
  --description "Worker ECS task" \
  --vpc-id ${VPC_ID} \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=${PROJECT}-worker-sg}]" \
  --query 'GroupId' --output text)

# ElastiCache (Redis) 用
SG_REDIS=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-redis-sg" \
  --description "ElastiCache Redis" \
  --vpc-id ${VPC_ID} \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=${PROJECT}-redis-sg}]" \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id ${SG_REDIS} \
  --protocol tcp --port 6379 --source-group ${SG_API}
aws ec2 authorize-security-group-ingress --group-id ${SG_REDIS} \
  --protocol tcp --port 6379 --source-group ${SG_WORKER}

# RDS (PostgreSQL) 用
SG_RDS=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-rds-sg" \
  --description "RDS PostgreSQL" \
  --vpc-id ${VPC_ID} \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=${PROJECT}-rds-sg}]" \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id ${SG_RDS} \
  --protocol tcp --port 5432 --source-group ${SG_WORKER}

echo "SG_ALB=${SG_ALB} SG_API=${SG_API} SG_WORKER=${SG_WORKER}"
echo "SG_REDIS=${SG_REDIS} SG_RDS=${SG_RDS}"
```

---

## 5. ECR — イメージのビルド & プッシュ

### 5-1. ECR リポジトリ作成

```bash
aws ecr create-repository \
  --repository-name ${PROJECT}/api \
  --image-scanning-configuration scanOnPush=true \
  --region ${AWS_REGION}

aws ecr create-repository \
  --repository-name ${PROJECT}/worker \
  --image-scanning-configuration scanOnPush=true \
  --region ${AWS_REGION}

ECR_BASE="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
echo "ECR_BASE=${ECR_BASE}"
```

### 5-2. Docker ログイン

```bash
aws ecr get-login-password --region ${AWS_REGION} | \
  docker login --username AWS --password-stdin ${ECR_BASE}
```

### 5-3. イメージのビルド & プッシュ

```bash
cd ~/ai-devops-lab   # リポジトリのルートに移動

# API
docker build -t ${PROJECT}/api ./services/api
docker tag ${PROJECT}/api:latest ${ECR_BASE}/${PROJECT}/api:latest
docker push ${ECR_BASE}/${PROJECT}/api:latest

# Worker
docker build -t ${PROJECT}/worker ./services/worker
docker tag ${PROJECT}/worker:latest ${ECR_BASE}/${PROJECT}/worker:latest
docker push ${ECR_BASE}/${PROJECT}/worker:latest

echo "Push 完了"
echo "API_IMAGE=${ECR_BASE}/${PROJECT}/api:latest"
echo "WORKER_IMAGE=${ECR_BASE}/${PROJECT}/worker:latest"
```

---

## 6. データ層

### 6-1. RDS サブネットグループ

```bash
aws rds create-db-subnet-group \
  --db-subnet-group-name "${PROJECT}-rds-subnet" \
  --db-subnet-group-description "RDS subnet group for ${PROJECT}" \
  --subnet-ids ${SUBNET_PRI_1A} ${SUBNET_PRI_1C}
```

### 6-2. RDS PostgreSQL (db.t3.micro)

```bash
aws rds create-db-instance \
  --db-instance-identifier "${PROJECT}-postgres" \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --engine-version "15.4" \
  --master-username postgres \
  --master-user-password "ChangeMe123!" \
  --db-name orders \
  --db-subnet-group-name "${PROJECT}-rds-subnet" \
  --vpc-security-group-ids ${SG_RDS} \
  --storage-type gp3 \
  --allocated-storage 20 \
  --backup-retention-period 0 \
  --no-multi-az \
  --no-publicly-accessible \
  --tags Key=Project,Value=${PROJECT}

echo "RDS プロビジョニング中（5〜10分）..."
aws rds wait db-instance-available \
  --db-instance-identifier "${PROJECT}-postgres"

RDS_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier "${PROJECT}-postgres" \
  --query 'DBInstances[0].Endpoint.Address' --output text)

echo "RDS_ENDPOINT=${RDS_ENDPOINT}"
```

### 6-3. ElastiCache サブネットグループ

```bash
aws elasticache create-cache-subnet-group \
  --cache-subnet-group-name "${PROJECT}-redis-subnet" \
  --cache-subnet-group-description "Redis subnet group" \
  --subnet-ids ${SUBNET_PRI_1A} ${SUBNET_PRI_1C}
```

### 6-4. ElastiCache Redis (cache.t3.micro)

```bash
aws elasticache create-cache-cluster \
  --cache-cluster-id "${PROJECT}-redis" \
  --cache-node-type cache.t3.micro \
  --engine redis \
  --engine-version "7.1" \
  --num-cache-nodes 1 \
  --cache-subnet-group-name "${PROJECT}-redis-subnet" \
  --security-group-ids ${SG_REDIS} \
  --tags Key=Project,Value=${PROJECT}

echo "ElastiCache プロビジョニング中（3〜5分）..."
aws elasticache wait cache-cluster-available \
  --cache-cluster-id "${PROJECT}-redis"

REDIS_ENDPOINT=$(aws elasticache describe-cache-clusters \
  --cache-cluster-id "${PROJECT}-redis" \
  --show-cache-node-info \
  --query 'CacheClusters[0].CacheNodes[0].Endpoint.Address' --output text)

echo "REDIS_ENDPOINT=${REDIS_ENDPOINT}"
```

---

## 7. Secrets Manager

認証情報をコードや環境変数に直書きせず、Secrets Manager で管理します。

```bash
# DB 接続文字列
aws secretsmanager create-secret \
  --name "${PROJECT}/database-url" \
  --description "PostgreSQL connection string" \
  --secret-string "postgresql://postgres:ChangeMe123!@${RDS_ENDPOINT}:5432/orders"

# Redis URL
aws secretsmanager create-secret \
  --name "${PROJECT}/redis-url" \
  --description "ElastiCache Redis URL" \
  --secret-string "redis://${REDIS_ENDPOINT}:6379"

echo "Secrets 登録完了"
```

> **重要:** `ChangeMe123!` は必ず変更してください。

---

## 8. IAM ロール

### 8-1. ECS タスク実行ロール（ECR プル / Secrets 取得 / ログ書き込み）

```bash
# 信頼ポリシー
cat > /tmp/ecs-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ecs-tasks.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

aws iam create-role \
  --role-name "${PROJECT}-execution-role" \
  --assume-role-policy-document file:///tmp/ecs-trust-policy.json

aws iam attach-role-policy \
  --role-name "${PROJECT}-execution-role" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Secrets Manager 読み取り権限
cat > /tmp/secrets-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue"],
    "Resource": "arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:${PROJECT}/*"
  }]
}
EOF

aws iam put-role-policy \
  --role-name "${PROJECT}-execution-role" \
  --policy-name "SecretsAccess" \
  --policy-document file:///tmp/secrets-policy.json

EXECUTION_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${PROJECT}-execution-role"
echo "EXECUTION_ROLE_ARN=${EXECUTION_ROLE_ARN}"
```

### 8-2. ECS タスクロール（X-Ray / CloudWatch メトリクス書き込み）

```bash
aws iam create-role \
  --role-name "${PROJECT}-task-role" \
  --assume-role-policy-document file:///tmp/ecs-trust-policy.json

# X-Ray 書き込み
aws iam attach-role-policy \
  --role-name "${PROJECT}-task-role" \
  --policy-arn arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess

# CloudWatch メトリクス書き込み
aws iam attach-role-policy \
  --role-name "${PROJECT}-task-role" \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy

TASK_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${PROJECT}-task-role"
echo "TASK_ROLE_ARN=${TASK_ROLE_ARN}"
```

---

## 9. CloudWatch Log Groups

```bash
aws logs create-log-group \
  --log-group-name "/ecs/${PROJECT}/api" \
  --tags Project=${PROJECT}

aws logs create-log-group \
  --log-group-name "/ecs/${PROJECT}/worker" \
  --tags Project=${PROJECT}

aws logs create-log-group \
  --log-group-name "/ecs/${PROJECT}/adot" \
  --tags Project=${PROJECT}

# ログ保持期間（30日）
for group in "/ecs/${PROJECT}/api" "/ecs/${PROJECT}/worker" "/ecs/${PROJECT}/adot"; do
  aws logs put-retention-policy \
    --log-group-name "${group}" \
    --retention-in-days 30
done

echo "Log Groups 作成完了"
```

---

## 10. ECS クラスター

```bash
aws ecs create-cluster \
  --cluster-name "${PROJECT}" \
  --settings name=containerInsights,value=enabled \
  --tags key=Project,value=${PROJECT}

echo "ECS クラスター作成完了: ${PROJECT}"
```

---

## 11. OTel Collector 設定

ADOT (AWS Distro for OpenTelemetry) Collector をサイドカーとして実行します。  
設定ファイルを SSM Parameter Store に格納し、コンテナ起動時に読み込みます。

```bash
cat > /tmp/otel-config.yaml << 'EOF'
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    send_batch_size: 256
    timeout: 5s
  resourcedetection:
    detectors: [env, ecs, ec2]
    timeout: 2s

exporters:
  awsxray:
    region: "${AWS_REGION}"
    no_verify_ssl: false
  awsemf:
    region: "${AWS_REGION}"
    namespace: "AI-DevOps-Lab"
    log_group_name: "/ecs/ai-devops-lab/metrics"
    log_stream_name: "{TaskId}"

service:
  pipelines:
    traces:
      receivers:  [otlp]
      processors: [resourcedetection, batch]
      exporters:  [awsxray]
EOF

aws ssm put-parameter \
  --name "/${PROJECT}/otel-config" \
  --value "$(cat /tmp/otel-config.yaml)" \
  --type String \
  --overwrite

echo "ADOT 設定を SSM に保存しました"
```

---

## 12. ECS タスク定義

> **注:** 以下の `<PLACEHOLDERS>` は前のステップで取得した値に置き換えてください。  
> `ECR_BASE`, `ACCOUNT_ID`, `AWS_REGION`, `PROJECT` の変数が設定済みであれば  
> `envsubst` を使って自動置換できます。

### 12-1. API タスク定義

```bash
# Secrets Manager ARN の取得
SECRET_ARN_REDIS=$(aws secretsmanager describe-secret \
  --secret-id "${PROJECT}/redis-url" \
  --query 'ARN' --output text)

cat > /tmp/api-task-def.json << EOF
{
  "family": "${PROJECT}-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "${EXECUTION_ROLE_ARN}",
  "taskRoleArn": "${TASK_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "api",
      "image": "${ECR_BASE}/${PROJECT}/api:latest",
      "essential": true,
      "portMappings": [
        { "containerPort": 3000, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "OTEL_SERVICE_NAME",              "value": "api" },
        { "name": "OTEL_EXPORTER_OTLP_ENDPOINT",   "value": "http://localhost:4318" },
        { "name": "NODE_ENV",                       "value": "production" },
        { "name": "LOG_LEVEL",                      "value": "info" }
      ],
      "secrets": [
        { "name": "REDIS_URL", "valueFrom": "${SECRET_ARN_REDIS}" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group":         "/ecs/${PROJECT}/api",
          "awslogs-region":        "${AWS_REGION}",
          "awslogs-stream-prefix": "api"
        }
      },
      "healthCheck": {
        "command":     ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
        "interval":    15,
        "timeout":     5,
        "retries":     3,
        "startPeriod": 30
      }
    },
    {
      "name": "adot-collector",
      "image": "public.ecr.aws/aws-observability/aws-otel-collector:latest",
      "essential": false,
      "command": ["--config", "env:ADOT_CONFIG"],
      "environment": [
        { "name": "AWS_REGION",  "value": "${AWS_REGION}" },
        { "name": "ADOT_CONFIG", "valueFrom": "/${PROJECT}/otel-config" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group":         "/ecs/${PROJECT}/adot",
          "awslogs-region":        "${AWS_REGION}",
          "awslogs-stream-prefix": "adot-api"
        }
      }
    }
  ]
}
EOF

aws ecs register-task-definition --cli-input-json file:///tmp/api-task-def.json
echo "API タスク定義 登録完了"
```

### 12-2. Worker タスク定義

```bash
SECRET_ARN_DB=$(aws secretsmanager describe-secret \
  --secret-id "${PROJECT}/database-url" \
  --query 'ARN' --output text)

cat > /tmp/worker-task-def.json << EOF
{
  "family": "${PROJECT}-worker",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "${EXECUTION_ROLE_ARN}",
  "taskRoleArn": "${TASK_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "worker",
      "image": "${ECR_BASE}/${PROJECT}/worker:latest",
      "essential": true,
      "environment": [
        { "name": "OTEL_SERVICE_NAME",            "value": "worker" },
        { "name": "OTEL_EXPORTER_OTLP_ENDPOINT", "value": "http://localhost:4318" },
        { "name": "METRICS_PORT",                "value": "9091" },
        { "name": "NODE_ENV",                    "value": "production" },
        { "name": "LOG_LEVEL",                   "value": "info" }
      ],
      "secrets": [
        { "name": "REDIS_URL",    "valueFrom": "${SECRET_ARN_REDIS}" },
        { "name": "DATABASE_URL", "valueFrom": "${SECRET_ARN_DB}" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group":         "/ecs/${PROJECT}/worker",
          "awslogs-region":        "${AWS_REGION}",
          "awslogs-stream-prefix": "worker"
        }
      }
    },
    {
      "name": "adot-collector",
      "image": "public.ecr.aws/aws-observability/aws-otel-collector:latest",
      "essential": false,
      "command": ["--config", "env:ADOT_CONFIG"],
      "environment": [
        { "name": "AWS_REGION",  "value": "${AWS_REGION}" },
        { "name": "ADOT_CONFIG", "valueFrom": "/${PROJECT}/otel-config" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group":         "/ecs/${PROJECT}/adot",
          "awslogs-region":        "${AWS_REGION}",
          "awslogs-stream-prefix": "adot-worker"
        }
      }
    }
  ]
}
EOF

aws ecs register-task-definition --cli-input-json file:///tmp/worker-task-def.json
echo "Worker タスク定義 登録完了"
```

---

## 13. ECS サービス & ALB

### 13-1. ALB + ターゲットグループ

```bash
# ALB 作成
ALB_ARN=$(aws elbv2 create-load-balancer \
  --name "${PROJECT}-alb" \
  --subnets ${SUBNET_PUB_1A} ${SUBNET_PUB_1C} \
  --security-groups ${SG_ALB} \
  --scheme internet-facing \
  --type application \
  --tags Key=Project,Value=${PROJECT} \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

# ターゲットグループ（API 用）
TG_ARN=$(aws elbv2 create-target-group \
  --name "${PROJECT}-api-tg" \
  --protocol HTTP \
  --port 3000 \
  --vpc-id ${VPC_ID} \
  --target-type ip \
  --health-check-path /health \
  --health-check-interval-seconds 15 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# HTTP リスナー
aws elbv2 create-listener \
  --load-balancer-arn ${ALB_ARN} \
  --protocol HTTP \
  --port 80 \
  --default-actions Type=forward,TargetGroupArn=${TG_ARN}

ALB_DNS=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns ${ALB_ARN} \
  --query 'LoadBalancers[0].DNSName' --output text)

echo "ALB_DNS=${ALB_DNS}"
```

### 13-2. ECS サービス作成

```bash
# API サービス
aws ecs create-service \
  --cluster "${PROJECT}" \
  --service-name "${PROJECT}-api" \
  --task-definition "${PROJECT}-api" \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[${SUBNET_PRI_1A},${SUBNET_PRI_1C}],
    securityGroups=[${SG_API}],
    assignPublicIp=DISABLED
  }" \
  --load-balancers "targetGroupArn=${TG_ARN},containerName=api,containerPort=3000" \
  --deployment-configuration "minimumHealthyPercent=50,maximumPercent=200" \
  --enable-execute-command \
  --tags key=Project,value=${PROJECT}

# Worker サービス（ロードバランサーなし）
aws ecs create-service \
  --cluster "${PROJECT}" \
  --service-name "${PROJECT}-worker" \
  --task-definition "${PROJECT}-worker" \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[${SUBNET_PRI_1A},${SUBNET_PRI_1C}],
    securityGroups=[${SG_WORKER}],
    assignPublicIp=DISABLED
  }" \
  --enable-execute-command \
  --tags key=Project,value=${PROJECT}

echo "ECS サービス作成完了。タスク起動中（約2〜3分）..."
aws ecs wait services-stable \
  --cluster "${PROJECT}" \
  --services "${PROJECT}-api" "${PROJECT}-worker"
echo "全サービス安定"
```

---

## 14. 動作確認

### 14-1. ALB DNS 確認

```bash
echo "API URL: http://${ALB_DNS}"
```

### 14-2. ヘルスチェック

```bash
curl -s http://${ALB_DNS}/health | python3 -m json.tool
# 期待レスポンス:
# {
#   "status": "ok",
#   "service": "api",
#   "redis": "connected",
#   "timestamp": "..."
# }
```

### 14-3. 注文を送信してエンドツーエンドを確認

```bash
# 注文送信
RESPONSE=$(curl -s -X POST http://${ALB_DNS}/order \
  -H "Content-Type: application/json" \
  -d '{"product_id": "prod-A", "quantity": 3}')

echo ${RESPONSE} | python3 -m json.tool
# {
#   "status": "queued",
#   "orderId": "xxxxxxxx-xxxx-...",
#   "trace_id": "abcdef1234567890..."
# }

# trace_id を変数に保存（後で X-Ray 検索に使用）
TRACE_ID=$(echo ${RESPONSE} | python3 -c "import sys,json; print(json.load(sys.stdin)['trace_id'])")
echo "TRACE_ID=${TRACE_ID}"
```

### 14-4. ECS タスクログを確認

```bash
# API ログ（最新20件）
aws logs tail "/ecs/${PROJECT}/api" --since 5m --format short

# Worker ログ
aws logs tail "/ecs/${PROJECT}/worker" --since 5m --format short
```

### 14-5. ECS Exec でコンテナに入って疎通確認（デバッグ用）

```bash
# タスク ID を取得
TASK_ID=$(aws ecs list-tasks \
  --cluster "${PROJECT}" \
  --service-name "${PROJECT}-api" \
  --query 'taskArns[0]' --output text | awk -F'/' '{print $NF}')

# コンテナ内で Redis 疎通確認
aws ecs execute-command \
  --cluster "${PROJECT}" \
  --task ${TASK_ID} \
  --container api \
  --interactive \
  --command "wget -qO- http://localhost:3000/health"
```

### 14-6. RDS にデータが入っているか確認

```bash
# Worker タスクのコンテナに入って psql で確認
WORKER_TASK=$(aws ecs list-tasks \
  --cluster "${PROJECT}" \
  --service-name "${PROJECT}-worker" \
  --query 'taskArns[0]' --output text | awk -F'/' '{print $NF}')

aws ecs execute-command \
  --cluster "${PROJECT}" \
  --task ${WORKER_TASK} \
  --container worker \
  --interactive \
  --command "sh -c 'node -e \"const{Pool}=require(\\\"pg\\\");const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(\\\"SELECT count(*) FROM orders\\\").then(r=>console.log(JSON.stringify(r.rows))).catch(console.error)\"'"
```

---

## 15. CloudWatch Logs / X-Ray

### 15-1. CloudWatch Logs Insights — AI エージェント調査クエリ集

AWS コンソール → CloudWatch → Logs Insights で以下を実行してください。  
**対象ロググループ:** `/ecs/ai-devops-lab/api` および `/ecs/ai-devops-lab/worker`

#### エラーログ抽出（直近30分）

```sql
fields @timestamp, level, message, cause, orderId, trace_id, error
| filter level = "error"
| sort @timestamp desc
| limit 50
```

#### 特定の trace_id でエンドツーエンド追跡

```sql
fields @timestamp, service, level, message, orderId, cause
| filter trace_id = "YOUR_TRACE_ID_HERE"
| sort @timestamp asc
```

#### カオス注入イベントの確認

```sql
fields @timestamp, service, chaos_type, chaos_config, message
| filter ispresent(chaos_type) or ispresent(chaos_config)
| sort @timestamp desc
| limit 100
```

#### エラー率の時系列集計（1分ごと）

```sql
fields @timestamp, level, service
| stats
    count(*) as total,
    count_distinct(case when level = "error" then @logStream end) as errors
    by bin(1min), service
| sort @timestamp desc
```

#### 高レイテンシなリクエストを検索

```sql
fields @timestamp, orderId, trace_id, duration_ms, service
| filter duration_ms > 1000
| sort duration_ms desc
| limit 20
```

#### Worker の DLQ 送信（処理失敗）ログ

```sql
fields @timestamp, message, cause, orderId, trace_id
| filter message like "DLQ"
| sort @timestamp desc
```

#### サービス別エラー数（過去1時間）

```sql
fields @timestamp, service, level
| filter level = "error"
| stats count(*) as error_count by service
| sort error_count desc
```

### 15-2. AWS X-Ray でトレース確認

```bash
# CLI でトレースを検索（過去30分）
aws xray get-trace-summaries \
  --start-time $(date -d '30 minutes ago' +%s 2>/dev/null || date -v-30M +%s) \
  --end-time $(date +%s) \
  --filter-expression 'service("api")' \
  --region ${AWS_REGION} \
  | python3 -m json.tool | head -80

# 特定 trace_id の詳細取得
aws xray batch-get-traces \
  --trace-ids "1-${TRACE_ID:0:8}-${TRACE_ID:8:24}" \
  --region ${AWS_REGION} \
  | python3 -m json.tool
```

**コンソール確認手順:**
1. AWS コンソール → X-Ray → サービスマップ
2. `api` → `worker` → `postgresql` の依存グラフを確認
3. レイテンシの高いトレースをクリック → Flame Graph で遅延箇所を特定

### 15-3. CloudWatch Container Insights

```bash
# コンソール確認パス
# CloudWatch → Container Insights → ECS クラスター → ai-devops-lab
# → パフォーマンスのモニタリング → CPU / メモリ / ネットワーク
```

---

## 16. 障害検証方法

### 16-1. カオス注入コマンド

```bash
# 変数確認（セクション3の変数が必要）
echo "API: http://${ALB_DNS}"

# 現在のカオス状態確認
curl -s http://${ALB_DNS}/chaos | python3 -m json.tool

# ── シナリオ 1: API 高レイテンシ ────────────────────────
curl -X POST http://${ALB_DNS}/chaos/set \
  -H "Content-Type: application/json" \
  -d '{"api_latency_ms": 3000}'
# → X-Ray で api.create_order スパンが 3s になることを確認

# ── シナリオ 2: キュー滞留 ────────────────────────────
curl -X POST http://${ALB_DNS}/chaos/set \
  -H "Content-Type: application/json" \
  -d '{"worker_failure_rate_pct": 100}'
# → CloudWatch Logs Insights で "DLQ" ログが増加

# ── シナリオ 3: Worker 停止 ──────────────────────────
aws ecs update-service \
  --cluster "${PROJECT}" \
  --service "${PROJECT}-worker" \
  --desired-count 0
# 復旧:
aws ecs update-service \
  --cluster "${PROJECT}" \
  --service "${PROJECT}-worker" \
  --desired-count 1

# ── シナリオ 4: DB ロック ─────────────────────────────
curl -X POST http://${ALB_DNS}/chaos/set \
  -H "Content-Type: application/json" \
  -d '{"db_lock_duration_ms": 8000}'
# → X-Ray で db.insert_order スパンが 8s になることを確認

# ── シナリオ 5: ランダムエラー増加 ───────────────────
curl -X POST http://${ALB_DNS}/chaos/set \
  -H "Content-Type: application/json" \
  -d '{"error_rate_pct": 50}'
# → CloudWatch Logs で level=error が約50%の割合で出現

# ── 全リセット ────────────────────────────────────────
curl -X POST http://${ALB_DNS}/chaos/reset
```

### 16-2. 負荷テスト（AWS上）

```bash
# ローカルから実行
API_URL="http://${ALB_DNS}" ./scripts/load-test.sh 5 120
```

### 16-3. どのメトリクスで異常を検知するか

| シナリオ | 確認場所 | 見るべき指標 |
|---------|---------|------------|
| API 高レイテンシ | X-Ray サービスマップ | `api` ノードのレイテンシ p95 |
| キュー滞留 | CloudWatch Logs Insights | `"DLQ"` ログ件数の増加 |
| Worker 停止 | ECS サービス画面 | `Running count = 0` |
| DB ロック | X-Ray トレース詳細 | `db.insert_order` スパン時間 |
| エラー率 | Logs Insights | `level=error` の件数比率 |

### 16-4. CloudWatch アラーム設定（推奨）

```bash
# ALB 5xx エラー率アラーム（10% 超で通知）
aws cloudwatch put-metric-alarm \
  --alarm-name "${PROJECT}-api-5xx-rate" \
  --alarm-description "API 5xx error rate > 10%" \
  --metric-name "HTTPCode_Target_5XX_Count" \
  --namespace "AWS/ApplicationELB" \
  --dimensions Name=LoadBalancer,Value=$(echo ${ALB_ARN} | awk -F':loadbalancer/' '{print $2}') \
  --statistic Sum \
  --period 60 \
  --evaluation-periods 2 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching

# ECS Worker タスク数ゼロアラーム
aws cloudwatch put-metric-alarm \
  --alarm-name "${PROJECT}-worker-stopped" \
  --alarm-description "Worker task count dropped to 0" \
  --metric-name "RunningTaskCount" \
  --namespace "ECS/ContainerInsights" \
  --dimensions Name=ClusterName,Value=${PROJECT} Name=ServiceName,Value="${PROJECT}-worker" \
  --statistic Average \
  --period 60 \
  --evaluation-periods 1 \
  --threshold 1 \
  --comparison-operator LessThanThreshold \
  --treat-missing-data breaching
```

---

## 17. 環境変数一覧

| 変数名 | 設定先 | 値 | 取得元 |
|--------|--------|-----|--------|
| `REDIS_URL` | API / Worker | `redis://<host>:6379` | Secrets Manager |
| `DATABASE_URL` | Worker | `postgresql://postgres:<pw>@<host>:5432/orders` | Secrets Manager |
| `OTEL_SERVICE_NAME` | API / Worker | `api` / `worker` | タスク定義 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | API / Worker | `http://localhost:4318` | タスク定義 (sidecar) |
| `NODE_ENV` | API / Worker | `production` | タスク定義 |
| `LOG_LEVEL` | API / Worker | `info` | タスク定義 |
| `METRICS_PORT` | Worker | `9091` | タスク定義 |
| `AWS_REGION` | ADOT sidecar | `ap-northeast-1` | タスク定義 |
| `ADOT_CONFIG` | ADOT sidecar | SSM Parameter | SSM valueFrom |

---

## 18. トラブルシューティング

### タスクが起動しない（STOPPED になる）

```bash
# 停止理由を確認
aws ecs describe-tasks \
  --cluster "${PROJECT}" \
  --tasks $(aws ecs list-tasks --cluster "${PROJECT}" --desired-status STOPPED --query 'taskArns[0]' --output text) \
  --query 'tasks[0].{status:lastStatus,reason:stoppedReason,containers:containers[*].{name:name,reason:reason,exitCode:exitCode}}'
```

**よくある原因と対処:**

| エラー | 原因 | 対処 |
|--------|------|------|
| `CannotPullContainerError` | ECR 認証失敗 or イメージ未存在 | `aws ecr list-images` で確認。NAT GW 経由でプライベートサブネットから ECR に到達できるか確認 |
| `ResourceInitializationError` | Secrets Manager 取得失敗 | Execution Role に `secretsmanager:GetSecretValue` 権限があるか確認 |
| `Essential container exited` | アプリ起動失敗 | CloudWatch Logs で起動時エラーを確認 |
| `OutOfMemoryError` | メモリ不足 | タスク定義の `memory` を増やす（最低 512MB） |

### Redis に接続できない

```bash
# セキュリティグループの確認
aws ec2 describe-security-groups --group-ids ${SG_REDIS} \
  --query 'SecurityGroups[0].IpPermissions'

# ECS タスクが正しい SG を使っているか確認
aws ecs describe-tasks \
  --cluster "${PROJECT}" \
  --tasks $(aws ecs list-tasks --cluster "${PROJECT}" \
    --service-name "${PROJECT}-api" --query 'taskArns[0]' --output text) \
  --query 'tasks[0].attachments[0].details'
```

### RDS に接続できない

```bash
# RDS エンドポイントが正しいか確認
aws rds describe-db-instances \
  --db-instance-identifier "${PROJECT}-postgres" \
  --query 'DBInstances[0].Endpoint'

# Worker タスク内から psql で直接接続テスト（ECS Exec）
WORKER_TASK=$(aws ecs list-tasks --cluster "${PROJECT}" \
  --service-name "${PROJECT}-worker" --query 'taskArns[0]' --output text | awk -F'/' '{print $NF}')

aws ecs execute-command \
  --cluster "${PROJECT}" --task ${WORKER_TASK} --container worker \
  --interactive --command "sh -c 'echo SELECT 1 | node -e \"const{Pool}=require(\\\"pg\\\");new Pool({connectionString:process.env.DATABASE_URL}).query(\\\"SELECT 1\\\").then(r=>console.log(\\\"DB OK\\\",r.rows)).catch(e=>console.error(\\\"DB ERR\\\",e.message))\"'"
```

### X-Ray にトレースが表示されない

```bash
# ADOT コンテナのログを確認
aws logs tail "/ecs/${PROJECT}/adot" --since 10m --format short

# タスクロールに X-Ray 権限があるか確認
aws iam list-attached-role-policies --role-name "${PROJECT}-task-role"
# AWSXRayDaemonWriteAccess が含まれていること

# X-Ray グループの確認
aws xray get-groups
```

### ALB ヘルスチェック失敗（Target が unhealthy）

```bash
# ターゲットのヘルス状態確認
aws elbv2 describe-target-health --target-group-arn ${TG_ARN}

# API コンテナ自体のヘルスは？
aws ecs describe-tasks \
  --cluster "${PROJECT}" \
  --tasks $(aws ecs list-tasks --cluster "${PROJECT}" \
    --service-name "${PROJECT}-api" --query 'taskArns[0]' --output text) \
  --query 'tasks[0].containers[0].healthStatus'

# → UNHEALTHY の場合はアプリのログを確認
aws logs tail "/ecs/${PROJECT}/api" --since 10m
```

### ECS Exec が使えない（NoSuchEntity エラー）

```bash
# Session Manager Plugin がインストールされているか確認
session-manager-plugin --version

# インストール（Mac）
brew install --cask session-manager-plugin

# ECS サービスで execute-command が有効か確認
aws ecs describe-services --cluster "${PROJECT}" \
  --services "${PROJECT}-api" \
  --query 'services[0].enableExecuteCommand'
# → true であること（サービス作成時に --enable-execute-command を指定済み）
```

---

## 19. リソース削除手順

> 課金を止めるために必ず実行してください。削除順序が重要です。

```bash
# 1. ECS サービスのタスク数をゼロに
aws ecs update-service --cluster "${PROJECT}" \
  --service "${PROJECT}-api"    --desired-count 0
aws ecs update-service --cluster "${PROJECT}" \
  --service "${PROJECT}-worker" --desired-count 0

sleep 30  # タスク停止を待つ

# 2. ECS サービス削除
aws ecs delete-service --cluster "${PROJECT}" --service "${PROJECT}-api"    --force
aws ecs delete-service --cluster "${PROJECT}" --service "${PROJECT}-worker" --force

# 3. ECS クラスター削除
aws ecs delete-cluster --cluster "${PROJECT}"

# 4. ALB / ターゲットグループ削除
LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn ${ALB_ARN} --query 'Listeners[0].ListenerArn' --output text)
aws elbv2 delete-listener     --listener-arn ${LISTENER_ARN}
aws elbv2 delete-target-group --target-group-arn ${TG_ARN}
aws elbv2 delete-load-balancer --load-balancer-arn ${ALB_ARN}

# 5. RDS 削除（スナップショットなし）
aws rds delete-db-instance \
  --db-instance-identifier "${PROJECT}-postgres" \
  --skip-final-snapshot
aws rds wait db-instance-deleted \
  --db-instance-identifier "${PROJECT}-postgres"

# 6. ElastiCache 削除
aws elasticache delete-cache-cluster --cache-cluster-id "${PROJECT}-redis"

# 7. NAT GW 削除（課金が大きいため早めに）
aws ec2 delete-nat-gateway --nat-gateway-id ${NAT_GW_ID}
aws ec2 wait nat-gateway-deleted --nat-gateway-ids ${NAT_GW_ID}  # or wait manually

# 8. Elastic IP 解放
aws ec2 release-address --allocation-id ${EIP_ALLOC}

# 9. Secrets Manager 削除
aws secretsmanager delete-secret \
  --secret-id "${PROJECT}/database-url" --force-delete-without-recovery
aws secretsmanager delete-secret \
  --secret-id "${PROJECT}/redis-url" --force-delete-without-recovery

# 10. ECR リポジトリ削除
aws ecr delete-repository --repository-name "${PROJECT}/api"    --force
aws ecr delete-repository --repository-name "${PROJECT}/worker" --force

# 11. IAM ロール削除
for role in "${PROJECT}-execution-role" "${PROJECT}-task-role"; do
  for policy in $(aws iam list-attached-role-policies --role-name ${role} \
    --query 'AttachedPolicies[*].PolicyArn' --output text); do
    aws iam detach-role-policy --role-name ${role} --policy-arn ${policy}
  done
  aws iam delete-role-policy --role-name ${role} --policy-name SecretsAccess 2>/dev/null || true
  aws iam delete-role --role-name ${role}
done

# 12. CloudWatch Log Groups 削除
aws logs delete-log-group --log-group-name "/ecs/${PROJECT}/api"
aws logs delete-log-group --log-group-name "/ecs/${PROJECT}/worker"
aws logs delete-log-group --log-group-name "/ecs/${PROJECT}/adot"

# 13. SSM Parameter 削除
aws ssm delete-parameter --name "/${PROJECT}/otel-config"

# 14. VPC リソース削除（セキュリティグループ → サブネット → ルートテーブル → VPC）
for sg in ${SG_ALB} ${SG_API} ${SG_WORKER} ${SG_REDIS} ${SG_RDS}; do
  aws ec2 delete-security-group --group-id ${sg} 2>/dev/null || true
done

for subnet in ${SUBNET_PUB_1A} ${SUBNET_PUB_1C} ${SUBNET_PRI_1A} ${SUBNET_PRI_1C}; do
  aws ec2 delete-subnet --subnet-id ${subnet}
done

aws ec2 detach-internet-gateway --internet-gateway-id ${IGW_ID} --vpc-id ${VPC_ID}
aws ec2 delete-internet-gateway --internet-gateway-id ${IGW_ID}

for rt in ${RT_PUB} ${RT_PRI}; do
  aws ec2 delete-route-table --route-table-id ${rt} 2>/dev/null || true
done

aws ec2 delete-vpc --vpc-id ${VPC_ID}

echo "全リソース削除完了"
```

---

## 補足: ローカル ↔ AWS の対応確認

| 確認項目 | ローカル | AWS |
|---------|---------|-----|
| API ログ | `docker compose logs api` | `aws logs tail /ecs/ai-devops-lab/api` |
| トレース | Jaeger UI :16686 | X-Ray コンソール |
| メトリクス | Grafana :3001 | CloudWatch Container Insights |
| カオス注入 | `localhost:3000/chaos` | `http://<ALB_DNS>/chaos` |
| キュー確認 | `redis-cli llen orders:queue` | ECS Exec + redis-cli |
| DB 確認 | `psql` ローカル | ECS Exec + node pg |

---

*最終更新: 2026-04-18*
