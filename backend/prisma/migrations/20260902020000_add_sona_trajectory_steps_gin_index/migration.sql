-- GIN index on the JSONB steps column for efficient containment and path queries.
-- Supports:
--   WHERE steps @> '[{"tool": "write_file"}]'        (containment)
--   WHERE steps @? '$[*] ? (@.tool == "read_file")'  (path existence)
--   WHERE jsonb_array_length(steps) > 5               (array length)
CREATE INDEX "sona_trajectories_steps_idx" ON "sona_trajectories" USING GIN ("steps");
