-- -----------------------------------------------------------------------
-- reset_circuit_breakers()
--
-- Resets all circuit breaker states whose openUntil time has passed.
-- Uses pg_try_advisory_lock(42) so only one concurrent caller executes
-- the reset — all others return immediately with rc=0 (already done).
--
-- Call from:
--   • A cron job:  SELECT reset_circuit_breakers();
--   • Before each provider call (idempotent, cheap when no-op).
--   • pg_cron schedule:  SELECT cron.schedule('cb-reset', '* * * * *', 'SELECT reset_circuit_breakers()');
--
-- Returns: TABLE(provider TEXT, was_reset BOOLEAN)
-- -----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reset_circuit_breakers()
RETURNS TABLE(provider TEXT, was_reset BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
  lock_acquired BOOLEAN;
  rec RECORD;
BEGIN
  -- Advisory lock key 42 — any constant works; chosen for simplicity.
  -- pg_try_advisory_lock returns true if the lock was acquired, false if
  -- another session already holds it (meaning a reset is in progress).
  lock_acquired := pg_try_advisory_lock(42);

  IF NOT lock_acquired THEN
    -- Another process is already running the reset — nothing to do.
    RETURN;
  END IF;

  BEGIN
    -- Find all providers whose openUntil has passed and reset them.
    FOR rec IN
      SELECT cb.provider, cb."openUntil"
      FROM circuit_breaker_states cb
      WHERE cb."isOpen" = TRUE
        AND cb."openUntil" IS NOT NULL
        AND cb."openUntil" < NOW()
    LOOP
      UPDATE circuit_breaker_states
      SET
        "isOpen"    = FALSE,
        "openUntil" = NULL,
        failures    = 0,
        "updatedAt" = NOW()
      WHERE circuit_breaker_states.provider = rec.provider;

      provider   := rec.provider;
      was_reset  := TRUE;
      RETURN NEXT;
    END LOOP;

  EXCEPTION WHEN OTHERS THEN
    -- Log the error but don't let it propagate — the lock must be released.
    RAISE WARNING 'reset_circuit_breakers: error resetting circuit breaker: %', SQLERRM;
  END;

  -- Always release the lock, even if an error occurred.
  PERFORM pg_advisory_unlock(42);
  RETURN;
END;
$$;

-- -----------------------------------------------------------------------
-- reset_provider_circuit_breaker(p_provider)
--
-- Resets a single provider's circuit breaker. Useful for targeted resets
-- from the application layer (e.g. after a successful health check).
-- Also acquires the advisory lock to coordinate with the bulk reset.
-- -----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reset_provider_circuit_breaker(p_provider TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  lock_acquired BOOLEAN;
  rows_updated  INTEGER;
BEGIN
  lock_acquired := pg_try_advisory_lock(42);

  IF NOT lock_acquired THEN
    -- Another process is running — try without lock (idempotent update).
    UPDATE circuit_breaker_states
    SET
      "isOpen"    = FALSE,
      "openUntil" = NULL,
      failures    = 0,
      "updatedAt" = NOW()
    WHERE circuit_breaker_states.provider = p_provider
      AND circuit_breaker_states."isOpen" = TRUE;

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RETURN rows_updated > 0;
  END IF;

  BEGIN
    UPDATE circuit_breaker_states
    SET
      "isOpen"    = FALSE,
      "openUntil" = NULL,
      failures    = 0,
      "updatedAt" = NOW()
    WHERE circuit_breaker_states.provider = p_provider
      AND circuit_breaker_states."isOpen" = TRUE;

    GET DIAGNOSTICS rows_updated = ROW_COUNT;

  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'reset_provider_circuit_breaker: error for %: %', p_provider, SQLERRM;
    rows_updated := 0;
  END;

  PERFORM pg_advisory_unlock(42);
  RETURN rows_updated > 0;
END;
$$;

-- -----------------------------------------------------------------------
-- next_open_circuit_breaker()
--
-- Returns the provider with the earliest openUntil that has already
-- expired — i.e. the next candidate for a half-open probe.
-- Returns NULL if no circuit breaker is ready to reset.
-- -----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION next_open_circuit_breaker()
RETURNS TABLE(provider TEXT, open_until TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
    SELECT cb.provider, cb."openUntil"
    FROM circuit_breaker_states cb
    WHERE cb."isOpen" = TRUE
      AND cb."openUntil" IS NOT NULL
      AND cb."openUntil" < NOW()
    ORDER BY cb."openUntil" ASC
    LIMIT 1;
END;
$$;
