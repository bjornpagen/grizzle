-- gistcostestimate() costs a GiST scan by the selectivity of all its quals, whichever index columns they constrain.
--
-- genericcostestimate() takes the index tuples a scan visits as the selectivity of every qual times the table's rows,
-- and the leaf pages as that fraction of the index's pages (selfuncs.c). btcostestimate() counts only the quals that
-- bound a B-tree scan (the leading equalities and the next column's inequalities, with skip arrays since 18);
-- gistcostestimate() passes no count, so a qual on a later GiST column is costed as if it led the index. A GiST
-- scan nevertheless tests every key at every level (gistget.c gistindex_keytest), and inserts and splits order
-- the tree by the first column whose penalty separates the entries (gistutil.c gistchoose, gistsplit.c), so a qual
-- on a later column of uncorrelated data prunes nothing and the scan reads the whole index. Whenever the result fits
-- in one leaf of the GiST index by that pro-rata count, the GiST and the B-tree are both costed at one page, and
-- the descent charge decides: ceil(ln N) comparisons for GiST against ceil(log2 N) for B-tree, and a tree height of
-- (int) log100(pages) for GiST against the B-tree's real height.
--
-- Run with psql -X as a role that may create databases (btree_gist is a trusted extension). The script creates the
-- database gist_cost_repro, works in it, and drops it at the end, returning to the database it started in.
-- Defaults: 100000 bookings over 5000 rooms, about 20 per room. Scale with -v rows=1000000 -v rooms=50000.
-- Every EXPLAIN runs twice; read the second, warm run.

\set ON_ERROR_STOP on
\if :{?rows}
\else
	\set rows 100000
\endif
\if :{?rooms}
\else
	\set rooms 5000
\endif
SELECT current_database() AS home \gset
CREATE DATABASE gist_cost_repro;
\c gist_cost_repro
SELECT version();
SELECT name, setting FROM pg_settings
WHERE name IN ('random_page_cost', 'seq_page_cost', 'cpu_operator_cost', 'cpu_index_tuple_cost', 'cpu_tuple_cost',
	'effective_cache_size', 'shared_buffers', 'jit')
ORDER BY name;
CREATE EXTENSION btree_gist;

-- 1. Bookings under an exclusion constraint that leads with the span (no two bookings of one room overlap), and a
-- plain B-tree for lookups by room. room is spread over :rooms values by hash, uncorrelated with the spans, which
-- are disjoint and in physical order. The constraint's index is built as the rows arrive.
CREATE TABLE booking (
	id int NOT NULL,
	room int NOT NULL,
	during int4range NOT NULL,
	note text NOT NULL,
	CONSTRAINT booking_no_overlap EXCLUDE USING gist (during WITH &&, room WITH =)
);
CREATE INDEX booking_room ON booking (room);
INSERT INTO booking
SELECT g, ((hashint8extended(g, 1) % :rooms + :rooms) % :rooms)::int, int4range(g * 10, g * 10 + 5), 'booking ' || g
FROM generate_series(0, :rows - 1) AS g;
VACUUM (ANALYZE) booking;
SELECT relname, relpages, reltuples FROM pg_class
WHERE relname IN ('booking', 'booking_no_overlap', 'booking_room')
ORDER BY relname;
SELECT attname, n_distinct, correlation FROM pg_stats WHERE tablename = 'booking' AND attname IN ('room', 'during')
ORDER BY attname;
SELECT room AS probe_room, lower(during) AS probe_lo FROM booking WHERE id = :rows / 2 \gset

-- 2. A lookup by room, the column the B-tree leads and the GiST index holds second. The planner reads the GiST
-- index, and its Bitmap Index Scan touches every page of it (Buffers = its relpages).
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room = :probe_room;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room = :probe_room;

-- The same with bitmap scans off: the plain Index Scan takes the GiST index too.
SET enable_bitmapscan = off;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room = :probe_room;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room = :probe_room;
RESET enable_bitmapscan;

-- 3. The same lookup with the constraint dropped (rolled back): the B-tree plan, estimated 0.0125 dearer, reads 2
-- index pages.
BEGIN;
ALTER TABLE booking DROP CONSTRAINT booking_no_overlap;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room = :probe_room;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room = :probe_room;
ROLLBACK;

-- 4. Column position never reaches the estimate. Each GiST index alone (the other indexes dropped, rolled back):
-- first (room, during), built after the load, then the constraint's (during, room). The lookup by room costs the
-- same on both; (room, during) reads 3 pages, (during, room) every page.
BEGIN;
DROP INDEX booking_room;
CREATE INDEX booking_room_during ON booking USING gist (room, during);
SELECT relname, relpages FROM pg_class WHERE relname = 'booking_room_during';
ALTER TABLE booking DROP CONSTRAINT booking_no_overlap;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room = :probe_room;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room = :probe_room;
ROLLBACK;
BEGIN;
DROP INDEX booking_room;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room = :probe_room;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room = :probe_room;
ROLLBACK;

-- 5. Leading the constraint with room instead exposes the search by span alone. Beside a GiST index on (during),
-- the room-led constraint index costs exactly the same for it (one leaf page each, the same descent), so creation
-- order decides: plancat.c builds the index list with lcons(), newest first, and add_path() keeps the first of
-- equal paths. Constraint created last: it is chosen and swept. GiST (during) created last: 4 buffers in all.
BEGIN;
ALTER TABLE booking DROP CONSTRAINT booking_no_overlap;
DROP INDEX booking_room;
CREATE INDEX booking_during ON booking USING gist (during);
ALTER TABLE booking ADD CONSTRAINT booking_room_no_overlap EXCLUDE USING gist (room WITH =, during WITH &&);
SELECT relname, relpages FROM pg_class WHERE relname IN ('booking_during', 'booking_room_no_overlap') ORDER BY relname;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE during && int4range(:probe_lo, :probe_lo + 1);
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE during && int4range(:probe_lo, :probe_lo + 1);
ROLLBACK;
BEGIN;
ALTER TABLE booking DROP CONSTRAINT booking_no_overlap;
DROP INDEX booking_room;
ALTER TABLE booking ADD CONSTRAINT booking_room_no_overlap EXCLUDE USING gist (room WITH =, during WITH &&);
CREATE INDEX booking_during ON booking USING gist (during);
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE during && int4range(:probe_lo, :probe_lo + 1);
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE during && int4range(:probe_lo, :probe_lo + 1);
ROLLBACK;

-- 6. Where the B-tree wins again: a range of 10 rooms, about 200 rows, is costed at two pages of the GiST index
-- (pro rata) and one of the B-tree, so the B-tree is chosen. With the B-tree dropped (rolled back), the GiST
-- index is still costed at two pages and still read whole.
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room BETWEEN :probe_room AND :probe_room + 9;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room BETWEEN :probe_room AND :probe_room + 9;
BEGIN;
DROP INDEX booking_room;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room BETWEEN :probe_room AND :probe_room + 9;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM booking WHERE room BETWEEN :probe_room AND :probe_room + 9;
ROLLBACK;

-- 7. A later column prunes as far as it follows the earlier ones. One GiST index on (during, slot, room): slot
-- follows the spans' order (20 rows a slot), room is spread by hash as before. A lookup on either costs the same;
-- slot reads 3 pages, room reads every page.
CREATE TABLE slotted (g int NOT NULL, slot int NOT NULL, room int NOT NULL, during int4range NOT NULL);
CREATE INDEX slotted_during_slot_room ON slotted USING gist (during, slot, room);
INSERT INTO slotted
SELECT g, g / 20, ((hashint8extended(g, 1) % :rooms + :rooms) % :rooms)::int, int4range(g * 10, g * 10 + 5)
FROM generate_series(0, :rows - 1) AS g;
VACUUM (ANALYZE) slotted;
SELECT relname, relpages FROM pg_class WHERE relname = 'slotted_during_slot_room';
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM slotted WHERE slot = :rows / 40;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM slotted WHERE slot = :rows / 40;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM slotted WHERE room = :probe_room;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM slotted WHERE room = :probe_room;

-- 8. A first column of few distinct values partitions the tree rather than defeating it: page splits redistribute
-- the entries that tie on it by the next column (gistsplit.c). On (kind, room, during), kind of 3 values, the lookup
-- on room alone takes about one descent per kind, at the same estimate.
CREATE TABLE kinded (kind int NOT NULL, room int NOT NULL, during int4range NOT NULL, note text NOT NULL);
CREATE INDEX kinded_kind_room_during ON kinded USING gist (kind, room, during);
INSERT INTO kinded
SELECT ((hashint8extended(g, 7) % 3 + 3) % 3)::int, ((hashint8extended(g, 1) % :rooms + :rooms) % :rooms)::int,
	int4range(g * 10, g * 10 + 5), 'booking ' || g
FROM generate_series(0, :rows - 1) AS g;
VACUUM (ANALYZE) kinded;
SELECT relname, relpages FROM pg_class WHERE relname = 'kinded_kind_room_during';
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM kinded WHERE room = :probe_room;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM kinded WHERE room = :probe_room;

\c :"home"
DROP DATABASE gist_cost_repro;
