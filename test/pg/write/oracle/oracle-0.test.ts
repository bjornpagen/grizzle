/**
 * The three-way write oracle's suite 0 (support.ts).
 *
 * @plant test/plants/pg/write/oracle/slot-carrier-from-another-slot.patch A staged member slot's carrier is filled from
 * another slot of the same heading (write/program/slot-carriers.ts), so every statement that reads the carrier reads
 * that slot's facts: the optimized program's outcome or stored state leaves the conservative realization's.
 * @plant test/plants/pg/write/oracle/write-oracle-removal-keeps-addition.patch A later stratum's removal no longer
 * cancels an earlier stratum's addition of the same fact (runtime/write/net.ts netStrata), so a removal keeps the
 * addition it should cancel across strata; the property fails on the planted arm "added then removed" ("expected
 * no-change, got accepted").
 * @plant test/plants/pg/write/oracle/net-stratum-kept-added.patch A fact a stratum both removes and adds identically
 * stays added (runtime/write/net.ts stratumChange); the property fails on the outcome ("expected no-change, got
 * accepted").
 * @plant test/plants/pg/write/oracle/oracle-parents-one-stratum.patch The planted arms "parent present" and "parent
 * absent" write the parent and the child in one stratum (test/support/oracle/write/changeset.ts plantedChangeSet), so
 * neither arm reaches the read-back across strata it is drawn for; the property must fail.
 * @plant test/plants/pg/oracle/optimized/installations-without-params.patch The oracle harness installs a case's schema
 * without the parameter types its query declares (test/support/oracle/write/run.ts openTarget), so a parameter cast to a
 * pattern domain meets UninstalledDomain.
 */
import { writeOracleSuite, writeSuite } from "#test/pg/write/oracle/support.ts"

writeSuite(writeOracleSuite(0, []), "the three-way write oracle, suite 0")
