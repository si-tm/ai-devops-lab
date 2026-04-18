-- Orders table (SoR)
CREATE TABLE IF NOT EXISTS orders (
  id           UUID PRIMARY KEY,
  product_id   VARCHAR(255)             NOT NULL,
  quantity     INTEGER                  NOT NULL DEFAULT 1,
  status       VARCHAR(50)              NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL,
  processed_at TIMESTAMP WITH TIME ZONE,
  trace_id     VARCHAR(128),
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_trace_id   ON orders(trace_id);

-- View for SLO metrics (used by AI agent queries)
CREATE OR REPLACE VIEW orders_summary AS
SELECT
  DATE_TRUNC('minute', created_at) AS minute,
  COUNT(*)                          AS total,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
  COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
  AVG(EXTRACT(EPOCH FROM (processed_at - created_at)))
    FILTER (WHERE processed_at IS NOT NULL)    AS avg_processing_sec
FROM orders
GROUP BY 1
ORDER BY 1 DESC;
