'use strict';

// Must be required FIRST before any other imports for auto-instrumentation
require('./tracing');

const path    = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');
const { context, propagation, trace, SpanStatusCode } = require('@opentelemetry/api');

const logger = require('./logger');
const {
  register,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  queuePublishTotal,
  chaosActiveGauge,
} = require('./metrics');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────
// Static dashboard
// ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ─────────────────────────────────────────
// Redis connection
// ─────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy: (times) => Math.min(times * 100, 3000),
  lazyConnect: false,
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error('Redis error', { error: err.message, cause: 'redis_connection_failure' }));

// ─────────────────────────────────────────
// SSE — Live event stream for dashboard
// ─────────────────────────────────────────
const sseClients = new Set();

function emitEvent(type, payload) {
  if (sseClients.size === 0) return;
  const data = JSON.stringify({ type, ...payload, timestamp: new Date().toISOString() });
  for (const res of sseClients) {
    res.write(`data: ${data}\n\n`);
  }
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(':ping\n\n'), 20000);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
  });
});

// ─────────────────────────────────────────
// Chaos state helpers
// ─────────────────────────────────────────
const CHAOS_KEYS = {
  API_LATENCY:          'chaos:api_latency_ms',
  ERROR_RATE:           'chaos:error_rate_pct',
  QUEUE_DELAY:          'chaos:queue_delay_ms',
  WORKER_FAILURE_RATE:  'chaos:worker_failure_rate_pct',
  DB_LOCK_DURATION:     'chaos:db_lock_duration_ms',
};

async function getChaosState() {
  const vals = await redis.mget(...Object.values(CHAOS_KEYS));
  const keys = Object.keys(CHAOS_KEYS);
  const state = {};
  keys.forEach((k, i) => {
    state[CHAOS_KEYS[k]] = parseInt(vals[i] || '0', 10);
  });
  return state;
}

async function updateChaosMetrics(state) {
  chaosActiveGauge.set({ scenario: 'api_latency' },   state[CHAOS_KEYS.API_LATENCY]   > 0 ? 1 : 0);
  chaosActiveGauge.set({ scenario: 'error_rate' },     state[CHAOS_KEYS.ERROR_RATE]    > 0 ? 1 : 0);
  chaosActiveGauge.set({ scenario: 'queue_delay' },    state[CHAOS_KEYS.QUEUE_DELAY]   > 0 ? 1 : 0);
}

// ─────────────────────────────────────────
// HTTP metrics middleware
// ─────────────────────────────────────────
app.use((req, res, next) => {
  const startMs = Date.now();
  res.on('finish', () => {
    const route = req.route?.path || req.path;
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, (Date.now() - startMs) / 1000);
  });
  next();
});

// ─────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────
app.get('/health', async (req, res) => {
  const tracer = trace.getTracer('api');
  const span = tracer.startSpan('health.check');

  try {
    await redis.ping();
    span.setStatus({ code: SpanStatusCode.OK });
    res.json({
      status: 'ok',
      service: 'api',
      timestamp: new Date().toISOString(),
      redis: 'connected',
    });
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    logger.error('Health check failed', { error: err.message, cause: 'redis_ping_failed' });
    res.status(503).json({ status: 'error', error: err.message, cause: 'redis_ping_failed' });
  } finally {
    span.end();
  }
});

// ─────────────────────────────────────────
// GET /status  (dashboard JSON)
// ─────────────────────────────────────────
app.get('/status', async (req, res) => {
  const [redisPing, queueDepth, dlqDepth, rawChaos] = await Promise.all([
    redis.ping().then(() => 'ok').catch(() => 'error'),
    redis.llen('orders:queue').catch(() => 0),
    redis.llen('orders:dlq').catch(() => 0),
    getChaosState(),
  ]);

  // Extract counters from prom-client registry
  const metricsJSON = await register.getMetricsAsJSON();
  let requestsTotal = 0;
  let errorsTotal   = 0;

  for (const metric of metricsJSON) {
    if (metric.name === 'api_http_requests_total') {
      for (const { labels, value } of metric.values) {
        requestsTotal += value;
        if (labels.status_code && labels.status_code.startsWith('5')) {
          errorsTotal += value;
        }
      }
    }
  }

  res.json({
    timestamp: new Date().toISOString(),
    health: { api: 'ok', redis: redisPing },
    queue:  { depth: queueDepth, dlq_depth: dlqDepth },
    chaos: {
      api_latency_ms:          rawChaos[CHAOS_KEYS.API_LATENCY],
      error_rate_pct:          rawChaos[CHAOS_KEYS.ERROR_RATE],
      queue_delay_ms:          rawChaos[CHAOS_KEYS.QUEUE_DELAY],
      worker_failure_rate_pct: rawChaos[CHAOS_KEYS.WORKER_FAILURE_RATE],
      db_lock_duration_ms:     rawChaos[CHAOS_KEYS.DB_LOCK_DURATION],
    },
    counters: {
      requests_total: requestsTotal,
      errors_total:   errorsTotal,
    },
  });
});

// ─────────────────────────────────────────
// POST /order
// ─────────────────────────────────────────
app.post('/order', async (req, res) => {
  const tracer = trace.getTracer('api');
  const orderId = uuidv4();

  const span = tracer.startSpan('api.create_order', {
    attributes: {
      'order.id': orderId,
      'order.product_id': req.body.product_id || 'unknown',
      'order.quantity': req.body.quantity || 0,
    },
  });

  const activeCtx = trace.setSpan(context.active(), span);
  const traceId = span.spanContext().traceId;
  const logCtx = { orderId, traceId };

  return context.with(activeCtx, async () => {
    try {
      const chaos = await getChaosState();
      await updateChaosMetrics(chaos);

      // Chaos: random error injection
      const errorRate = chaos[CHAOS_KEYS.ERROR_RATE];
      if (errorRate > 0 && Math.random() * 100 < errorRate) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'chaos_error_injection' });
        span.setAttribute('chaos.type', 'error_rate');
        logger.error('Chaos error injected', { ...logCtx, chaos_type: 'error_rate', error_rate_pct: errorRate });
        queuePublishTotal.inc({ status: 'chaos_error' });
        emitEvent('order', { status: 'error', orderId, productId: req.body.product_id, quantity: req.body.quantity, cause: 'chaos_error_injection' });
        return res.status(500).json({
          error: 'Internal Server Error',
          cause: 'chaos_error_injection',
          orderId,
          trace_id: traceId,
        });
      }

      // Chaos: API latency injection
      const latencyMs = chaos[CHAOS_KEYS.API_LATENCY];
      if (latencyMs > 0) {
        span.setAttribute('chaos.latency_ms', latencyMs);
        logger.warn('Chaos latency injected', { ...logCtx, chaos_type: 'api_latency', latency_ms: latencyMs });
        await new Promise((r) => setTimeout(r, latencyMs));
      }

      const order = {
        id:         orderId,
        product_id: req.body.product_id || 'unknown',
        quantity:   req.body.quantity   || 1,
        created_at: new Date().toISOString(),
        trace_id:   traceId,
      };

      // Inject OTel trace context so the worker can continue the trace
      const carrier = {};
      propagation.inject(activeCtx, carrier);
      const message = { ...order, _otel_carrier: carrier };

      // Chaos: queue delay
      const queueDelayMs = chaos[CHAOS_KEYS.QUEUE_DELAY];
      if (queueDelayMs > 0) {
        span.setAttribute('chaos.queue_delay_ms', queueDelayMs);
        logger.warn('Chaos queue delay injected', { ...logCtx, chaos_type: 'queue_delay', queue_delay_ms: queueDelayMs });
        await new Promise((r) => setTimeout(r, queueDelayMs));
      }

      await redis.lpush('orders:queue', JSON.stringify(message));
      queuePublishTotal.inc({ status: 'success' });

      span.setAttribute('queue.name', 'orders:queue');
      span.setStatus({ code: SpanStatusCode.OK });
      logger.info('Order queued successfully', { ...logCtx, product_id: order.product_id, quantity: order.quantity });

      emitEvent('order', { status: 'queued', orderId, productId: order.product_id, quantity: order.quantity });

      return res.status(202).json({
        status: 'queued',
        orderId,
        trace_id: traceId,
      });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      queuePublishTotal.inc({ status: 'error' });
      logger.error('Failed to queue order', { ...logCtx, error: err.message, cause: 'queue_publish_failed', stack: err.stack });
      emitEvent('error', { message: 'Failed to queue order', cause: 'queue_publish_failed', orderId });
      return res.status(500).json({
        error: 'Failed to queue order',
        cause: 'queue_publish_failed',
        orderId,
        trace_id: traceId,
      });
    } finally {
      span.end();
    }
  });
});

// ─────────────────────────────────────────
// Chaos Admin Endpoints
// ─────────────────────────────────────────
app.get('/chaos', async (req, res) => {
  const raw = await getChaosState();
  res.json({
    api_latency_ms:          raw[CHAOS_KEYS.API_LATENCY],
    error_rate_pct:          raw[CHAOS_KEYS.ERROR_RATE],
    queue_delay_ms:          raw[CHAOS_KEYS.QUEUE_DELAY],
    worker_failure_rate_pct: raw[CHAOS_KEYS.WORKER_FAILURE_RATE],
    db_lock_duration_ms:     raw[CHAOS_KEYS.DB_LOCK_DURATION],
    _note: 'POST /chaos/set to change values, POST /chaos/reset to clear all',
  });
});

app.post('/chaos/set', async (req, res) => {
  const mapping = {
    api_latency_ms:          CHAOS_KEYS.API_LATENCY,
    error_rate_pct:          CHAOS_KEYS.ERROR_RATE,
    queue_delay_ms:          CHAOS_KEYS.QUEUE_DELAY,
    worker_failure_rate_pct: CHAOS_KEYS.WORKER_FAILURE_RATE,
    db_lock_duration_ms:     CHAOS_KEYS.DB_LOCK_DURATION,
  };

  const ops = [];
  for (const [field, redisKey] of Object.entries(mapping)) {
    if (req.body[field] !== undefined) {
      ops.push(redis.set(redisKey, String(req.body[field])));
    }
  }

  if (ops.length === 0) {
    return res.status(400).json({ error: 'No valid chaos parameters provided', valid_fields: Object.keys(mapping) });
  }

  await Promise.all(ops);
  logger.warn('Chaos state updated', { chaos_config: req.body });
  emitEvent('chaos', { message: `Chaos updated: ${JSON.stringify(req.body)}` });
  const current = await getChaosState();
  res.json({ status: 'ok', applied: req.body, current });
});

app.post('/chaos/reset', async (req, res) => {
  await redis.del(...Object.values(CHAOS_KEYS));
  logger.info('All chaos scenarios disabled');
  emitEvent('chaos', { message: 'All chaos scenarios disabled' });
  res.json({ status: 'ok', message: 'All chaos scenarios disabled' });
});

// ─────────────────────────────────────────
// Prometheus metrics endpoint
// ─────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

// ─────────────────────────────────────────
// Start
// ─────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  logger.info('API server started', { port: PORT, endpoints: ['/health', '/order', '/chaos', '/metrics', '/status', '/events'] });
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down API server');
  await redis.quit();
  process.exit(0);
});
