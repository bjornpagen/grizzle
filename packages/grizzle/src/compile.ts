/**
 * @bjornpagen/grizzle/compile: grizzle's one compile of a login's served workload, in process, for an application's
 * tests: compileServed compiles a login, with its own workloads or others in their place, into the served file
 * `grizzle generate` would commit for them, which served(...) and DbLayer.make serve; compileServedMoved compiles it for
 * a moved clock, whose roles a test opens with Db.openMoved to read the database's clock at an instant it states;
 * indexesOf reads each index a
 * plan names, its key columns and why the installation holds it, from the snapshot. A running application never loads
 * it: it loads the schema, the law model and the compiler.
 */
export {
	compileServed,
	compileServedMoved,
	type IndexKeyColumn,
	type IndexReason,
	indexesOf,
	type InstalledIndexes,
	type LawColumnHolds,
	type ServedRefusal,
	type SnapshotIndex,
	type WorkloadPlace
} from "#adapter/public/compile.ts"
