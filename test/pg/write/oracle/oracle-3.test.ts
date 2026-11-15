/**
 * The three-way write oracle's suite 3 (support.ts), the suite TREECOST's unorderable case came from
 * (oracle-4bce37a3.log: TEST_SEED=582966255, the rotating stream, case 7), on whose replay each plant below is red.
 *
 * @plant test/plants/pg/write/oracle/write-oracle-model-orders-every-stratum.patch The oracle's orderability model
 * orders every stratum (test/support/oracle/write/expect.ts unorderableStrata), so the run's installation compiles a
 * ChangeSet whose stratum the keys order in a cycle and is refused with UnorderableStratum.
 * @plant test/plants/pg/write/oracle/schedule-drops-referencing-removal-edge.patch The scheduler no longer runs a
 * referencing relation's removals before the referenced one's across an immediate foreign key, so a stratum the keys
 * order in a cycle compiles where the oracle expects UnorderableStratum.
 * @plant test/plants/pg/laws/families/stratum-order-drops-generated-class.patch The order model
 * (test/support/stratum-order.ts) drafts no generated insertion from an enumerated insert into a relation with an
 * identity column, so the installation compiles TREECOST's stratum, which grizzle refuses.
 * @plant test/plants/pg/write/oracle/schedule-drops-nowhere-exception.patch The scheduler runs a deletion where facts
 * meet nowhere before every addition of its relation, so it refuses the planted arm "deletion meeting nowhere", which
 * only that exception orders.
 */
import { writeOracleSuite, writeSuite } from "#test/pg/write/oracle/support.ts"

writeSuite(writeOracleSuite(3, []), "the three-way write oracle, suite 3")
