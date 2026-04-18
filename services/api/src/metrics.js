'use strict';

const client = require('prom-client');

client.collectDefaultMetrics({
  prefix: 'api_process_',
  labels: { service: 'api' },
});

const httpRequestsTotal = new client.Counter({
  name: 'api_http_requests_total',
  help: 'Total number of HTTP requests received',
  labelNames: ['method', 'route', 'status_code'],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: 'api_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const queuePublishTotal = new client.Counter({
  name: 'api_queue_publish_total',
  help: 'Total messages published to the queue',
  labelNames: ['status'],
});

const chaosActiveGauge = new client.Gauge({
  name: 'api_chaos_active',
  help: 'Whether a chaos scenario is currently active (1=on, 0=off)',
  labelNames: ['scenario'],
});

module.exports = {
  register: client.register,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  queuePublishTotal,
  chaosActiveGauge,
};
