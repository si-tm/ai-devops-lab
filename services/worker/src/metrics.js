'use strict';

const client = require('prom-client');

client.collectDefaultMetrics({
  prefix: 'worker_process_',
  labels: { service: 'worker' },
});

const workerProcessedTotal = new client.Counter({
  name: 'worker_processed_total',
  help: 'Total number of orders processed by the worker',
  labelNames: ['status'],
});

const workerProcessingDurationSeconds = new client.Histogram({
  name: 'worker_processing_duration_seconds',
  help: 'Duration of order processing in seconds',
  labelNames: ['status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
});

const dbQueryDurationSeconds = new client.Histogram({
  name: 'worker_db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
});

const queueDepthGauge = new client.Gauge({
  name: 'worker_queue_depth',
  help: 'Current number of messages waiting in the queue',
});

const chaosActiveGauge = new client.Gauge({
  name: 'worker_chaos_active',
  help: 'Whether a chaos scenario is currently active (1=on, 0=off)',
  labelNames: ['scenario'],
});

module.exports = {
  register: client.register,
  workerProcessedTotal,
  workerProcessingDurationSeconds,
  dbQueryDurationSeconds,
  queueDepthGauge,
  chaosActiveGauge,
};
