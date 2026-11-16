/**
 * The three-way write oracle's suite 0 (support.ts).
 */
import { writeOracleSuite, writeSuite } from "#test/pg/write/oracle/support.ts"

writeSuite(writeOracleSuite(0, []), "the three-way write oracle, suite 0")
