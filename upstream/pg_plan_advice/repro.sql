-- Reproduces the measurements in EVIDENCE.txt sections 2 and 3. Run with psql -X -a -f repro.sql in an empty
-- database of a patched master build with pg_plan_advice and auto_explain installed. The \! line runs VACUUM
-- from a second session while this one holds the filling transaction open, which leaves the tables "counted
-- empty" (relpages counted, reltuples 0). PGDATABASE and the connection settings must reach the same database.
\set ON_ERROR_STOP 0
\pset pager off
LOAD 'pg_plan_advice';
SET plan_cache_mode = force_generic_plan;
CREATE TABLE doc (doc int PRIMARY KEY, owner int NOT NULL) WITH (autovacuum_enabled = off);
CREATE TABLE node (doc int NOT NULL, f1 int NOT NULL, f2 int NOT NULL, v text NOT NULL, PRIMARY KEY (doc, f1, f2)) WITH (autovacuum_enabled = off);
CREATE INDEX node_doc_f1 ON node (doc, f1);
CREATE TABLE tgt (pkg int, id int, label text, PRIMARY KEY (pkg, id)) WITH (autovacuum_enabled = off);
CREATE INDEX tgt_label_id ON tgt (label, id);
CREATE TABLE ref (pkg int NOT NULL, id int NOT NULL, seq int NOT NULL, body text NOT NULL,
  PRIMARY KEY (pkg, id, seq), FOREIGN KEY (pkg, id) REFERENCES tgt) WITH (autovacuum_enabled = off);
CREATE INDEX ref_seq_pkg ON ref (seq, pkg);
BEGIN;
INSERT INTO doc SELECT d, d % 2 FROM generate_series(1, 4) d;
INSERT INTO node SELECT d, f, g, repeat('x', 40) FROM generate_series(1, 4) d, generate_series(1, 5) f, generate_series(1, 3000) g;
INSERT INTO tgt SELECT p, i, 'l' || (i % 5) FROM generate_series(1, 3) p, generate_series(1, 1000) i;
INSERT INTO ref SELECT p, i, s, repeat('x', 40) FROM generate_series(1, 3) p, generate_series(1, 1000) i, generate_series(1, 20) s;
\! psql -X -q -c 'VACUUM doc, node, tgt, ref'
COMMIT;
INSERT INTO tgt SELECT 2, g, 'gone' FROM generate_series(5001, 5020) g;
SELECT relname, relpages, reltuples FROM pg_class WHERE relname IN ('doc', 'node', 'tgt', 'ref') ORDER BY 1;

\echo ==== D1 plain join, counted empty, the 19.0 vocabulary (join order, method, index all pinned)
SET pg_plan_advice.advice = 'JOIN_ORDER(d n) NESTED_LOOP_PLAIN(n) SEQ_SCAN(d) INDEX_SCAN(n public.node_pkey) NO_GATHER(d n)';
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF, PLAN_ADVICE) SELECT n.v FROM doc d JOIN node n ON n.doc = d.doc AND n.f1 = 1 AND n.f2 = 2 WHERE d.owner = $1 \bind 1 \g
\echo ==== D2 the same plus PARAMETERIZED(n d)
SET pg_plan_advice.advice = 'JOIN_ORDER(d n) NESTED_LOOP_PLAIN(n) SEQ_SCAN(d) INDEX_SCAN(n public.node_pkey) PARAMETERIZED(n d) NO_GATHER(d n)';
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF, PLAN_ADVICE) SELECT n.v FROM doc d JOIN node n ON n.doc = d.doc AND n.f1 = 1 AND n.f2 = 2 WHERE d.owner = $1 \bind 1 \g
\echo ==== D3 correlated EXISTS (flattened), counted empty, no advice, then its index item alone, then plus PARAMETERIZED
RESET pg_plan_advice.advice;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF, PLAN_ADVICE) SELECT d.doc FROM doc d WHERE d.owner = $1 AND EXISTS (SELECT 1 FROM node n WHERE n.doc = d.doc AND n.f1 = 1 AND n.f2 = 2) \bind 1 \g
SET pg_plan_advice.advice = 'INDEX_ONLY_SCAN(n public.node_pkey)';
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) SELECT d.doc FROM doc d WHERE d.owner = $1 AND EXISTS (SELECT 1 FROM node n WHERE n.doc = d.doc AND n.f1 = 1 AND n.f2 = 2) \bind 1 \g
SET pg_plan_advice.advice = 'INDEX_ONLY_SCAN(n public.node_pkey) PARAMETERIZED(n d)';
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) SELECT d.doc FROM doc d WHERE d.owner = $1 AND EXISTS (SELECT 1 FROM node n WHERE n.doc = d.doc AND n.f1 = 1 AND n.f2 = 2) \bind 1 \g
RESET pg_plan_advice.advice;

LOAD 'auto_explain';
SET auto_explain.log_min_duration = 0;
SET auto_explain.log_nested_statements = on;
SET auto_explain.log_analyze = on;
SET auto_explain.log_buffers = on;
SET auto_explain.log_timing = off;
SET auto_explain.log_costs = off;
SET client_min_messages = log;
\echo ==== R1 delete of an unreferenced key, counted empty, no advice
BEGIN; DELETE FROM tgt WHERE pkg = 2 AND id = 5001; COMMIT;
\echo ==== R2 unqualified advice for both foreign-key checks in one string
BEGIN; SET LOCAL pg_plan_advice.advice = 'INDEX_SCAN(x public.ref_pkey) INDEX_SCAN(x public.tgt_pkey)'; DELETE FROM tgt WHERE pkg = 2 AND id = 5002; COMMIT;
\echo ==== R3 qualified advice for both checks (the generic plans were cached in R1)
BEGIN; SET LOCAL pg_plan_advice.advice = 'INDEX_SCAN(x:public.ref public.ref_pkey) INDEX_SCAN(x:public.tgt public.tgt_pkey)'; DELETE FROM tgt WHERE pkg = 2 AND id = 5003; COMMIT;
\echo ==== R4 next transaction, no advice: the advice does not outlive its scope
BEGIN; DELETE FROM tgt WHERE pkg = 2 AND id = 5004; COMMIT;
