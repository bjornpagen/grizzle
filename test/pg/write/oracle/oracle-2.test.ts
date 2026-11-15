/**
 * The three-way write oracle's suite 2 (support.ts).
 *
 * @plant test/plants/pg/write/oracle/slot-carrier-from-another-slot.patch A staged member slot's carrier is filled from
 * another slot of the same heading (write/program/slot-carriers.ts), so every statement that reads the carrier reads
 * that slot's facts: the optimized program's outcome or stored state leaves the conservative realization's.
 */
import { writeOracleSuite, writeSuite } from "#test/pg/write/oracle/support.ts"

writeSuite(writeOracleSuite(2), "the three-way write oracle, suite 2")
