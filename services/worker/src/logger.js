'use strict';

const winston = require('winston');
const { trace } = require('@opentelemetry/api');

const addTraceContext = winston.format((info) => {
  const span = trace.getActiveSpan();
  if (span) {
    const ctx = span.spanContext();
    info.trace_id = ctx.traceId;
    info.span_id = ctx.spanId;
  }
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    addTraceContext(),
    winston.format.timestamp({ format: 'ISO' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: {
    service: process.env.OTEL_SERVICE_NAME || 'worker',
    version: '1.0.0',
  },
  transports: [new winston.transports.Console()],
});

module.exports = logger;
