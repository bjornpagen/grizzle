/**
 * The three-way write oracle's suite 2 (support.ts).
 *
 * @plant test/plants/pg/write/oracle/slot-carrier-from-another-slot.patch A staged member slot's carrier is filled from
 * another slot of the same heading (write/program/slot-carriers.ts), so every statement that reads the carrier reads
 * that slot's facts: the optimized program's outcome or stored state leaves the conservative realization's.
 * @plant test/plants/pg/oracle/optimized/installations-without-params.patch The oracle harness installs a case's schema
 * without the parameter types its query declares (test/support/oracle/write/run.ts openTarget), so a parameter cast to a
 * pattern domain meets UninstalledDomain.
 */
import { writeOracleSuite, writeSuite } from "#test/pg/write/oracle/support.ts"

writeSuite(writeOracleSuite(2, []), "the three-way write oracle, suite 2")
