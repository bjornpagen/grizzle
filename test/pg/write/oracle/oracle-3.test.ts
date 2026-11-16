/**
 * The three-way write oracle's suite 3 (support.ts), the suite TREECOST's unorderable case came from
 * (oracle-4bce37a3.log: TEST_SEED=582966255, the rotating stream, case 7).
 */
import { writeOracleSuite, writeSuite } from "#test/pg/write/oracle/support.ts"

writeSuite(writeOracleSuite(3, []), "the three-way write oracle, suite 3")
