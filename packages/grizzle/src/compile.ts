/**
 * @bjornpagen/grizzle/compile: grizzle's one compile of a login's served workload, in process, for an application's
 * tests: compileServed compiles a login, with its own workloads or others in their place, into the served file
 * `grizzle generate` would commit for them, which served(...) and DbLayer.make serve; compileServedMoved compiles it for
 * a moved clock, whose roles a test opens with Db.openMoved to read the database's clock at an instant it states;
 * plannedQueriesOf bounds the pg_stat_statements entries one call of each of its programs makes;
 * indexesOf reads each index a
 * plan names, its key columns and why the installation holds it, from the snapshot. The host's readings of a schema,
 * each compiling it, are here too: lawsOf, lawsByStatement and constraintNamesOf, which read its laws and their
 * installed names, installedIdentifiersOf, every PostgreSQL identifier its installation names an object by, and
 * insertPreview, factsDecoder, rowEvaluator, codecText, rowText and contractCheck (adapter/public/host.ts), which read
 * its rows and its values as PostgreSQL would, sending no SQL. And assembled, the runtime's own assembly of a single
 * statement's units (runtime/write/parted.ts), the one function a served file's parted statement becomes the text and
 * placeholders a call sends by: a test or a budget that measures a served statement reads it through this export,
 * never a copy of its own. A running application never loads it, nor does a schema
 * module or a configuration (packages/grizzle/src/index.ts, the authoring entry): it loads the schema, the law model
 * and the compiler.
 */
export {
	compileServed,
	compileServedMoved,
	type IndexKeyColumn,
	type IndexReason,
	indexesOf,
	type InstalledIndexes,
	type LawColumnHolds,
	type PlannedLogin,
	type PlannedQueries,
	plannedQueriesOf,
	type ServedRefusal,
	type SnapshotIndex,
	type WorkloadPlace
} from "#adapter/public/compile.ts"
export {
	assembled,
	type AssembledText,
	type CutText,
	type Parted,
	type PartedUnit
} from "#compiler/plan/serve.ts"
export {
	codecText,
	contractCheck,
	factsDecoder,
	insertPreview,
	rowEvaluator,
	rowText
} from "#adapter/public/host.ts"
export {
	type AdmittedRow,
	type CheckNameOf,
	type CheckVerdict,
	constraintNamesOf,
	type DomainRefused,
	type EvaluatedRow,
	type GeneratedFieldOf,
	lawsByStatement,
	lawsOf,
	type RowEvaluation,
	type RowEvaluator,
	type RowSource,
	type SourceRelation,
	type Unevaluated,
	type ValueRefused
} from "#compiler/plan/common.ts"
export { type InstalledIdentifier, installedIdentifiersOf } from "#compiler/plan/migration.ts"
