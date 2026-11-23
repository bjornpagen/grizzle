/**
 * A workload's type cost at metis's composition width (query/budget/workloads.ts): a workload of a query, a ChangeSet,
 * a primary key and a candidate key over a schema of levels of relations of distinct headings, checked alone at 810,
 * 1,620 and 2,430 relations in 30 levels, the widest past the 2,374 relations of metis's operator role's levels.
 *
 * Properties: every program typechecks with no diagnostic, so no member's check against the programs of its levels is
 * past what the checker represents (TS2590); each step adds types and instantiations; and its instantiations grow no
 * faster than linearly. Oracle: the compiler's own counts, compared step against step.
 */
import { growthGate } from "#test/types/batch/measured.ts"
import { workloadWidths } from "#test/types/query/budget/workloads.dictionary.ts"

/** The workload's program typechecks at each width with no diagnostic, its instantiations growing no faster than linearly. */
export const workloadWidth = growthGate(workloadWidths, {
	box: "a workload of every kind of member a key, a read and a write make, over levels of relations of distinct headings",
	kills: [
		{
			file: "packages/engine/src/types/db/workload.ts",
			original:
				'interface KeyOn<R> {\n\treadonly kind: "key"\n\treadonly side: Side<R, ReadonlyArray<string>>\n}',
			replacement:
				'type KeyOn<R> = import("#compiler/types/schema/statements.ts").Key<Side<R, ReadonlyArray<string>>>',
			why: "A candidate key member is matched against one key over every relation of the workload's levels, whose records the checker infers as the union of all of theirs and reduces by subtype: each member's check is past what it represents (TS2590), as metis's operator workload was at c8cf6d6fb; the program fails."
		}
	]
})
