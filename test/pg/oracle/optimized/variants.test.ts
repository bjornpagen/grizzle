/**
 * The per-execution take forms, and the one fused attachment, against the conservative lowering: the optimized output
 * equals the conservative output in every form the runtime may execute.
 *
 * The cases are built over one fixed schema, their shapes and facts generated, so every one of them reaches a
 * per-execution choice and the runner's variant path (support.ts): a take of a relation's first k rows per parent, in a
 * total order, whose parent set is the input of the execution:
 *
 * - an attachment's delivered parent keys: accounts P(id, a, e) with each one's first k entries C(k, p, v) attached by
 *   p = id, through a narrow child over a region of C, a wide one that also delivers C's further columns, and one that
 *   delivers only the entry's key. Each is pipelined over the parent-key recordset, its parents reading no approximate
 *   search, and its take chooses by the parent count between LATERAL and the whole-relation form (DISTINCT ON for
 *   k = 1, row_number() otherwise);
 * - the same attachments to the accounts nearest a probe vector by the cosine distance of their embedding e, one
 *   ApproximateNearest search over one rule's projection, which keeps the account's key id or only its group a (so the
 *   search deduplicates its candidates), the entries attached by p equal to that column. This is the one case an
 *   attachment fuses: its parent's rows read an approximate search, which a pipelined statement would run a second
 *   time (lower/shapes/index.ts rowsStatement), so the child is an array column of the parent statement, one field
 *   as text[] and several as jsonb[], which the runner unfuses and compares with the conservative lowering's pipelined
 *   statement. The oracle installation builds no HNSW index, so both lowerings' searches are the exact top k, ties at
 *   the cutoff settled by the heading's other column in both;
 * - a relation parameter: a region binding each id of the parameter to the first k entries with that p, which chooses
 *   by the parameter's row count.
 *
 * Every case runs through the differential (support.ts): the default program, each per-execution variant statement, and
 * the VALUES transport of a small relation parameter, each compared with the conservative run as raw text sets
 * with no repeated row. Each case installs the schema in its own database (runner.ts installedPlacement), and loads
 * its facts in its own rolled-back transaction.
 *
 * Oracle: the conservative lowering's raw text sets, no repeated row on the optimized side.
 *
 * Features: the population's required features (suite.ts and the file's own).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { differentialProperty, type OptimizedFeature } from "#test/pg/oracle/optimized/suite.ts"
import {
	resolve,
	sketchGen,
	variantSituations
} from "#test/pg/oracle/optimized/variants.fixtures.ts"
import { installedPlacement } from "#test/support/oracle/runner.ts"

/** Correlated-take cases agree with the conservative lowering in the program and every per-execution variant. */
export const variants = differentialProperty(sketchGen, resolve, installedPlacement("variants"), {
	situations: variantSituations satisfies ReadonlyArray<Reached<OptimizedFeature>>,
	/** Its pre-conversion budget: runs 250, coverage cases 250 (variants.test.ts:76 at fe79ac6b2^). */
	budget: { runs: 250, steered: 250 },
	kills: [
		{
			file: "packages/engine/src/lower/optimize/dedup/place.ts",
			original: "\t\tconst outstanding = a.obligations.flatMap((o) => (o.discharged ? [] : [o]))",
			replacement: "\t\tconst outstanding = a.obligations.flatMap(() => [])",
			why: "The dedup placement discharges no obligation (lower/optimize/dedup/place.ts), so a DISTINCT owed is never placed and the optimized artifact repeats rows."
		}
	]
})
