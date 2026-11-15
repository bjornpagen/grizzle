WITH a AS (
  SELECT * FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
)
SELECT concat_ws(E'\t', 'S', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS'),
  count(*),
  count(*) FILTER (WHERE state = 'active'),
  count(*) FILTER (WHERE state LIKE 'idle in transaction%'),
  count(*) FILTER (WHERE wait_event_type = 'LWLock' AND wait_event IN ('SerializableFinishedList','SerializableXactHash','SerializablePredicateList')),
  count(*) FILTER (WHERE wait_event = 'SerializableFinishedList'),
  count(*) FILTER (WHERE wait_event = 'SerializableXactHash'),
  count(*) FILTER (WHERE wait_event = 'SerializablePredicateList'),
  count(*) FILTER (WHERE wait_event_type = 'LWLock'),
  coalesce(extract(epoch FROM max(clock_timestamp() - state_change) FILTER (WHERE state LIKE 'idle in transaction%' AND (backend_xmin IS NOT NULL OR backend_xid IS NOT NULL)))::numeric(12,1), 0),
  coalesce(extract(epoch FROM max(clock_timestamp() - xact_start) FILTER (WHERE backend_xmin IS NOT NULL OR backend_xid IS NOT NULL))::numeric(12,1), 0),
  coalesce(extract(epoch FROM max(clock_timestamp() - xact_start) FILTER (WHERE backend_xid IS NOT NULL))::numeric(12,1), 0),
  count(*) FILTER (WHERE state = 'active' AND wait_event IS NULL)
) FROM a
UNION ALL
SELECT concat_ws(E'\t', 'D', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS'), a.pid, coalesce(a.datname::text, '-'), coalesce(nullif(a.application_name, ''), '-'), a.state,
  extract(epoch FROM clock_timestamp() - a.xact_start)::numeric(12,1),
  extract(epoch FROM clock_timestamp() - a.state_change)::numeric(12,1),
  coalesce(a.wait_event_type || ':' || a.wait_event, '-'), coalesce(a.client_port::text, '-'), coalesce(a.backend_xid::text, '-'), coalesce(a.backend_xmin::text, '-'),
  regexp_replace(left(a.query, 300), E'[\\n\\t\\r]+', ' ', 'g'))
FROM a
WHERE (a.state LIKE 'idle in transaction%' AND clock_timestamp() - a.state_change > interval '1 second'
       AND (a.backend_xmin IS NOT NULL OR a.backend_xid IS NOT NULL))
   OR ((a.backend_xid IS NOT NULL OR a.backend_xmin IS NOT NULL) AND clock_timestamp() - a.xact_start > interval '5 seconds')
   OR (a.state = 'active' AND clock_timestamp() - a.query_start > interval '10 seconds')
UNION ALL
SELECT concat_ws(E'\t', 'W', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS'),
  string_agg(e || '=' || n, ' ' ORDER BY n DESC))
FROM (SELECT coalesce(wait_event_type || ':' || wait_event, 'CPU') AS e, count(*) AS n FROM a WHERE state = 'active' GROUP BY 1) AS w
UNION ALL
SELECT concat_ws(E'\t', 'C', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS'), a.pid, coalesce(nullif(a.application_name, ''), '-'),
  extract(epoch FROM clock_timestamp() - a.query_start)::numeric(12,1), coalesce(a.backend_xid::text, '-'),
  regexp_replace(left(a.query, 200), E'[\\n\\t\\r]+', ' ', 'g'))
FROM a WHERE a.state = 'active' AND a.wait_event IS NULL AND clock_timestamp() - a.query_start > interval '1 second'
