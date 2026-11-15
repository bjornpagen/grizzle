WITH vx AS (
  SELECT pid, virtualxid FROM pg_locks WHERE locktype = 'virtualxid' AND granted
), sx AS (
  SELECT DISTINCT virtualtransaction FROM pg_locks WHERE mode = 'SIReadLock'
)
SELECT concat_ws(E'\t', 'R', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS'), a.pid, coalesce(nullif(a.application_name, ''), '-'), a.state,
  extract(epoch FROM clock_timestamp() - a.xact_start)::numeric(12,1), coalesce(a.wait_event_type || ':' || a.wait_event, '-'),
  regexp_replace(left(a.query, 200), E'[\\n\\t\\r]+', ' ', 'g'))
FROM pg_stat_activity a JOIN vx USING (pid) JOIN sx ON sx.virtualtransaction = vx.virtualxid
WHERE clock_timestamp() - a.xact_start > interval '5 seconds'
