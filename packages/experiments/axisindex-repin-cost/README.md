# axisindex-repin-cost

Tests what edullm's next repin pays for grizzle's referencing-side indexes (3adc7e17 through 3315086c and c0c1bb17), and
which verdict ends it: main relays the repin cost to push-db and edullm's repin is priced, then this package is deleted
in one commit.

- `served.py <migration folder>`: the structural property of test/support/laws/referencing.ts over a migration's DDL,
  every foreign key served by an index led by exactly its key-paired referencing columns or by a unique index within
  them, constant generated columns left out. edullm staging 8c9ef817c's qti-database: 90 of 1,011 unserved at main
  without these commits, 0 with them.
- `indexbounds.py <migration folder>`: every B-tree entry's worst case from the DDL's declared types (bit(n), an
  octet_length-bounded text domain, fixed widths), against BTMaxItemSize.
- `repincost.py <02-indexes.sql> <rowcounts dir> <old sizes> <rc1target sizes>`: the heap each CREATE INDEX
  CONCURRENTLY of a repin reads and the entries it sorts, by table, from the 41 packages' dry-run row counts and the
  new schema's bytes per row (RC1TARGET's rc2 cluster at edullm's committed init).
- `build-throughput.sql` (`psql -v rows=N -v width=W`): times a successor-key UNIQUE and a (package, path, parent)
  index built CONCURRENTLY over a node-shaped table.
