-- Prisma's pg adapter sends timestamps as UTC wall-clock time without an offset, and Postgres reads such values in the
-- session time zone. Make UTC the default for every new session on this database (docs/adr/0010).
-- No-op where the default is already UTC (Supabase, CI). The application also refuses to start on a non-UTC session.
DO $$
BEGIN
  IF current_setting('TimeZone') NOT IN ('UTC', 'Etc/UTC') THEN
    EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
  END IF;
END
$$;
