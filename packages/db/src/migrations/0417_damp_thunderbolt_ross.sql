CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_updated_at_idx" ON "heartbeat_runs" USING btree ("updated_at");
