# superkey

Tests whether grizzle's foreign keys should reference only their target's keys, the copies a containment carries
beyond the key checked by a rule over a query (deferred constraint triggers, physical/ddl/rules.ts), instead of
referencing a generated superkey UNIQUE per distinct column set (laws/model/plan.ts `#targetUnique`, `#reference`). The
verdict that ends it: node's insert CPU saved against the rules' added COMMIT CPU for the referencing rows, and the read
probes that touch node, measured at production scale on an rc1 cluster; positive lands the representation in grizzle
and deletes this package in that commit, negative is written here and the package is deleted in one commit.

## Verdict: negative

Rules over queries, as grizzle runs them (one deferred plpgsql constraint trigger per law and row, each probe one SPI
statement), cost about twice a native foreign key check per law and row. Dropping node's superkeys saves its index
maintenance on insert, but the rules' probes on the target side, which must run on every deleted node row (a node
row deleted and inserted again at the same key with other copies breaks nothing else), make deleting a package's rows
1.7 to 2.7 times dearer. A changed package's republish is a set difference, and a node's key holds its start
position, which an edit shifts for every later node of the document, so the delete path is hot, not rare.

Measured on edullm 62d9c0b93 (grizzle d15b3d4d, production's ...c schema), one private cluster from RC1TARGET's 19rc1
prefix as edullm-qti-db was rebuilt, 2026-11-15 04:24 to 05:36 UTC, cassowary at load 50 to 440. g3t01 published
(43,351 node rows). node's copies: 1,647,338 rows (production: 1,610,911); every referencing table's copies 1,660,116
rows. CPU is the backend's on-CPU time (/proc/self/schedstat), statements and COMMIT, per g3t01-sized package:

| step | today (v0, 7 rounds) | key references + rules |
| --- | --- | --- |
| node INSERT | 13.45 s (11.73 to 15.33) | 8.46 s (7.54 to 9.56, 7 rounds) |
| referencing INSERT + COMMIT | 4.55 s (4.15 to 5.34) | 5.41 to 5.66 s with a key into node's primary key, 6.43 s by rules alone |
| package DELETE + COMMIT | 116.98 s (109.88 to 123.91) | 303.67 to 337.40 s one trigger per rule, 295.23 s one trigger per node row, 193.41 s rules alone in one trigger |

- Insert path: 3.1 to 4.1 s saved per package (node -5.0 s, referencing +0.9 to +1.9 s).
- Delete path: +76 s (rules alone, one trigger per node row) to +204 s (a key plus one trigger per rule, mean) per
  package. Per law and deleted
  row, today's NO ACTION check is about 21 µs (117 s over 126 keys and 43,351 rows); a rule's probe about 37 µs.
- Indexes: node 68 (35 unique) to 46 (12 unique), the 46th a plain B-tree over (package, path, start, end) the
  publisher's set-difference read needs once the superkey that served it is gone; 5,212 MB to 2,688 MB at 1.65M rows
  (bulk-built). Schema-wide, scaled to the 43 packages' rows: 811 unique indexes to 462 (349 generated superkeys, the
  targets of 568 of 992 keys into qti tables; family axis targets kept), 10,392 MB of index bytes (push-db's
  COPYDIRECT measured 10.46 GB) to 5,854 MB before the read indexes the engine would place for reads the superkeys
  served.
- Reads: the app's four served reads plan identically. Of 414 served statements, 308 plan identically with every
  superkey dropped and 106 swap a superkey for the primary key or another key, at equal estimated cost but five: the
  publisher's set-difference read (statement 3, 19,608 to 85,395, which scans node's (package, path, start, end) and
  six other tables' superkeys), its node write (statement 390, 1,044 to 1,321), one attribute statement (499 to
  581), one declaration_identifier statement (339 to 392) and one app read (3,619 to 3,630).
- Not measured: the race property main asked for (one transaction updating a copied column while another inserts a
  row copying the old value), since the verdict came first.

What would turn it: rules checked set-based at COMMIT, one probe per statement and rule over the rows it touched,
instead of one per row. The per-row cost is the trigger and SPI statement around each probe, not the probe's index
work (folding node's 115 rules into one trigger per row saved under 10%). That is a change to the rule mechanism itself, and
it would cut today's rules' COMMIT cost too.

## Files

Everything runs against a private cluster built from RC1TARGET's prefix (read-only), with edullm's committed Qti
migrations and one published package:

- `setup.sh <port> <edullm checkout> <package dir> <name>`: the cluster (`init-cluster.sh`, BULKLOAD's), the roles and
  database, `grizzle migrate` through `importpar.config.edullm`, then the package published through
  `importpar-publish.edullm` (both IMPORTPAR's TypeScript, copied into the checkout under their .ts names).
- `superkeys.py <meta.json>`: the generated superkeys, the UNIQUEs whose violation the migration's constraint map
  reports as another constraint's key law.
- `prep.sql`, `indexes.sql`, `v1-reads.sql`: two node copies at production scale (37 renamed copies of the package's
  rows and the package itself), v0 with every index qti.node has, v1 without the generated superkeys a containment
  references (a family axis's target stays) and with the read index above.
- `refs.sql`, `fill-refs.sql`: every table with a key into node, twice, at production scale: v0 with today's keys, v1
  with a key into node's primary key over the key-paired columns and each superkey reference's containment a rule, a
  deferred constraint trigger on each side in rules.ts's shape. `fused.sql` folds node's rule triggers into one per
  row; `b2.sql` drops the keys into the primary key, leaving the rules alone.
- `measure.sh <port> <reps> <package> [tag]`: per round and variant, alternating which goes first, the CPU of the
  package's node rows inserted, of the referencing rows inserted and committed, and of both deleted and committed.
- `census.sql`, `census.py`: every qti table's indexes, uniques and superkeys, scaled to production's row counts.
- `reads.sh`, `reads-all.sh`: served statements planned generically with and without the superkeys.
