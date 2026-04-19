'use strict';

// Must be required FIRST before any other imports for auto-instrumentation
require('./tracing');

const http = require('http');
const Redis = require('ioredis');
const { Pool } = require('pg');
const { context, propagation, trace, SpanStatusCode } = require('@opentelemetry/api');

const logger = require('./logger');
const {
  register,
  workerProcessedTotal,
  workerProcessingDurationSeconds,
  dbQueryDurationSeconds,
  queueDepthGauge,
  chaosActiveGauge,
} = require('./metrics');

// ─────────────────────────────────────────
// Connections
// ─────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy: (times) => Math.min(times * 100, 3000),
});
const redisMonitor = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/orders',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error('Redis error', { error: err.message, cause: 'redis_connection_failure' }));
db.on('error', (err) => logger.error('DB pool error', { error: err.message, cause: 'db_pool_error' }));

// ─────────────────────────────────────────
// Chaos state helpers
// ─────────────────────────────────────────
const CHAOS_KEYS = {
  WORKER_FAILURE_RATE:  'chaos:worker_failure_rate_pct',
  DB_LOCK_DURATION:     'chaos:db_lock_duration_ms',
};

async function getChaosState() {
  const [failureRate, dbLock] = await redisMonitor.mget(
    CHAOS_KEYS.WORKER_FAILURE_RATE,
    CHAOS_KEYS.DB_LOCK_DURATION,
  );
  return {
    worker_failure_rate_pct: parseInt(failureRate || '0', 10),
    db_lock_duration_ms:     parseInt(dbLock     || '0', 10),
  };
}

// ─────────────────────────────────────────
// Queue depth polling (for metrics)
// ─────────────────────────────────────────
setInterval(async () => {
  try {
    const depth = await redisMonitor.llen('orders:queue');
    queueDepthGauge.set(depth);
  } catch (_) {}
}, 5000);

// ─────────────────────────────────────────
// Core order processor
// ─────────────────────────────────────────
async function processOrder(rawMessage) {
  const message = JSON.parse(rawMessage);
  const { _otel_carrier, ...order } = message;

  // Re-attach trace context from the producer
  const parentCtx = propagation.extract(context.active(), _otel_carrier || {});
  const tracer = trace.getTracer('worker');

  const span = tracer.startSpan(
    'worker.process_order',
    {
      attributes: {
        'order.id':         order.id,
        'order.product_id': order.product_id,
        'order.quantity':   order.quantity,
        'queue.name':       'orders:queue',
      },
    },
    parentCtx,
  );

  const activeCtx = trace.setSpan(parentCtx, span);
  const logCtx = { orderId: order.id, traceId: order.trace_id };

  return context.with(activeCtx, async () => {
    const startMs = Date.now();
    try {
      const chaos = await getChaosState();
      chaosActiveGauge.set({ scenario: 'worker_failure' }, chaos.worker_failure_rate_pct > 0 ? 1 : 0);
      chaosActiveGauge.set({ scenario: 'db_lock' },        chaos.db_lock_duration_ms     > 0 ? 1 : 0);

      // Chaos: worker random failure
      if (chaos.worker_failure_rate_pct > 0 && Math.random() * 100 < chaos.worker_failure_rate_pct) {
        throw new Error(`chaos_worker_failure: simulated processing failure (rate=${chaos.worker_failure_rate_pct}%)`);
      }

      logger.info('Processing order', { ...logCtx, product_id: order.product_id });

      await saveOrderToDb(order, chaos.db_lock_duration_ms, activeCtx);

      const durationSec = (Date.now() - startMs) / 1000;
      workerProcessedTotal.inc({ status: 'success' });
      workerProcessingDurationSeconds.observe({ status: 'success' }, durationSec);
      span.setStatus({ code: SpanStatusCode.OK });
      logger.info('Order processed successfully', { ...logCtx, duration_ms: Date.now() - startMs });
    } catch (err) {
      const durationSec = (Date.now() - startMs) / 1000;
      workerProcessedTotal.inc({ status: 'error' });
      workerProcessingDurationSeconds.observe({ status: 'error' }, durationSec);
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      logger.error('Order processing failed', {
        ...logCtx,
        error: err.message,
        cause: err.message.startsWith('chaos_') ? 'chaos_injection' : 'processing_error',
        stack: err.stack,
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

// ─────────────────────────────────────────
// DB write with lock simulation
// ─────────────────────────────────────────
async function saveOrderToDb(order, dbLockDurationMs, activeCtx) {
  const tracer = trace.getTracer('worker');
  const span = tracer.startSpan('db.insert_order', {
    attributes: {
      'db.system':    'postgresql',
      'db.operation': 'INSERT',
      'db.name':      'orders',
      'order.id':     order.id,
    },
  }, activeCtx);

  const dbCtx = trace.setSpan(activeCtx, span);
  const startMs = Date.now();

  return context.with(dbCtx, async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Chaos: DB lock simulation using pg_sleep inside transaction
      if (dbLockDurationMs > 0) {
        span.setAttribute('chaos.db_lock_duration_ms', dbLockDurationMs);
        logger.warn('Chaos DB lock injected', {
          orderId: order.id,
          chaos_type: 'db_lock',
          lock_duration_ms: dbLockDurationMs,
        });
        await client.query('SELECT pg_sleep($1)', [dbLockDurationMs / 1000]);
      }

      await client.query(
        `INSERT INTO orders (id, product_id, quantity, status, created_at, processed_at, trace_id)
         VALUES ($1, $2, $3, 'completed', $4, NOW(), $5)
         ON CONFLICT (id) DO UPDATE SET status = 'completed', processed_at = NOW()`,
        [order.id, order.product_id, order.quantity, order.created_at, order.trace_id],
      );

      await client.query('COMMIT');

      const duration = (Date.now() - startMs) / 1000;
      dbQueryDurationSeconds.observe({ operation: 'insert', status: 'success' }, duration);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const duration = (Date.now() - startMs) / 1000;
      dbQueryDurationSeconds.observe({ operation: 'insert', status: 'error' }, duration);
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      client.release();
      span.end();
    }
  });
}

// ─────────────────────────────────────────
// Main worker loop (blocking pop with timeout)
// ─────────────────────────────────────────
let running = true;

async function workerLoop() {
  logger.info('Worker loop started', { queue: 'orders:queue' });

  while (running) {
    try {
      // BRPOP blocks for up to 5s waiting for a message
      const result = await redis.brpop('orders:queue', 5);
      if (!result) continue; // timeout, loop again

      const [, rawMessage] = result;
      await processOrder(rawMessage).catch((err) => {
        // On failure: push to dead-letter queue for later analysis
        redis.lpush('orders:dlq', rawMessage).catch(() => {});
        logger.error('Message sent to DLQ', { cause: err.message });
      });
    } catch (err) {
      if (running) {
        logger.error('Worker loop error', { error: err.message, cause: 'worker_loop_exception' });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// ─────────────────────────────────────────
// Prometheus metrics HTTP server
// ─────────────────────────────────────────
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9091', 10);

const metricsServer = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  } else if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    let dbStatus = 'ok';
    let processedCount = 0;
    try {
      await db.query('SELECT 1');
      const r = await db.query(
        "SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'orders'"
      );
      processedCount = parseInt(r.rows[0]?.count ?? 0, 10);
    } catch (err) {
      dbStatus = 'error';
      logger.error('DB health check failed', { error: err.message, cause: 'db_health_query_failed' });
    }
    const overall = dbStatus === 'ok' ? 'ok' : 'degraded';
    res.end(JSON.stringify({
      status: overall, service: 'worker',
      db: dbStatus, db_rows: processedCount,
      timestamp: new Date().toISOString(),
    }));
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
});

metricsServer.listen(METRICS_PORT, () => {
  logger.info('Worker metrics server started', { port: METRICS_PORT });
});

// ─────────────────────────────────────────
// Start & shutdown
// ─────────────────────────────────────────
workerLoop().catch((err) => {
  logger.error('Worker loop crashed', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('SIGTERM', async () => {
  logger.info('Worker shutting down gracefully');
  running = false;
  await redis.quit();
  await redisMonitor.quit();
  await db.end();
  metricsServer.close(() => process.exit(0));
});
