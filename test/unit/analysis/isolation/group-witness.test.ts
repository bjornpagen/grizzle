/**
 * A whole rule's witness reads a group its query folds as a group, never as one row (analysis/theory/query.ts
 * witnesses): an occurrence of both polarities, which only an aggregate reads (RelationRead), stands among the witness's
 * `present` and `absent`, never among its `rows`, so the isolation certifier (analysis/isolation/certify.ts monotone)
 * never takes a writer's one row of the group for the one occurrence its write makes true. Over GroupWitness
 * (group-witness.fixtures.ts): T immutable, keyed by its unit first, a whole check over each unit's count, sum, min or
 * max of T's rows, or over each row of T apart, and a writer that inserts T alone.
 *
 * Where a writer is certified READ COMMITTED, each of its transactions judges the rule at COMMIT under a snapshot of its
 * own, so two that each insert a row of one unit both pass a check over the unit's count before either commits, and
 * together break it: the group's rows are read by every judge of the unit, never one row of the writer's own.
 *
 * Oracle: universal: a writer of rows a whole check reads as a group runs SERIALIZABLE, its certificate naming T's laws,
 * and one whose row a whole check reads as one row of a match runs READ COMMITTED.
 *
 * Features: a count, a sum, a min, a max, and one row of a match.
 */
import { property } from "@bjornpagen/testing/property"
import {
	drawnGen,
	type GroupWitnessFeature,
	runCertified
} from "#test/unit/analysis/isolation/group-witness.fixtures.ts"

/**
 * A writer of rows a whole rule folds is certified SERIALIZABLE, and a writer of rows it reads one at a time READ
 * COMMITTED.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aWholeRulesWitnessReadsAGroupItFoldsAsAGroupSoAnInsertOnlyWriterOfItRunsSERIALIZABLE =
	property.explore(drawnGen, {
		needs: {},
		situations: [
			"a count",
			"a sum",
			"a min",
			"a max",
			"one row of a match"
		] satisfies ReadonlyArray<GroupWitnessFeature>,
		check: (_, c) => (drawn) => runCertified(drawn, c),
		oracle: {
			kind: "universal",
			name: "a writer of rows a whole check reads as a group runs SERIALIZABLE for T's laws, one whose row it reads as one row of a match READ COMMITTED"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					'\t\t\tconst [first, ...rest] = at(["positive"])\n\t\t\treturn [\n\t\t\t\t{\n\t\t\t\t\trows: first === undefined ? mapNonEmpty(rule.reads, (r) => r.relation) : [first, ...rest],\n\t\t\t\t\tpresent: at(["both"]),',
				replacement:
					'\t\t\tconst [first, ...rest] = at(["positive", "both"])\n\t\t\treturn [\n\t\t\t\t{\n\t\t\t\t\trows: first === undefined ? mapNonEmpty(rule.reads, (r) => r.relation) : [first, ...rest],\n\t\t\t\t\tpresent: [],',
				why: "A read a whole rule folds stands among its witness's rows, one row of a match, as before: the writer's one row of the group is the one occurrence its write makes true, so a writer beside a whole check over a count, a sum, a min or a max certifies READ COMMITTED, and two of its calls break the check together."
			}
		]
	})
