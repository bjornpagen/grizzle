/**
 * The set judge runs one statement in each guarded block (physical/ddl/rules.ts addRules): a rule's block over one
 * table's delta of one side, the rows the transaction adds or those it found and removes, reads every row the write may
 * break the rule at once, in its probe (analysis/theory/query.ts probe), and each row of one key (probeKey, the same
 * query with its variables renamed) once, so no COMMIT reads one candidate twice, nor runs the rule's meeting part once
 * per candidate.
 *
 * Each case is a containment of S's k in a derived relation D of T: D has one to three arms, each matching T by k and
 * holding its a to a literal of its own or not at all, and each arm may join U by k. T's delete withdraws a fact of D
 * through each arm that matches it, and each such occurrence is a row of its probe (probeRows, its removed side); the
 * rows of arms that hold nothing of T's row apart are one key, read once.
 *
 * Oracle: universal, a set: the probe reads one arm of each key among its rows, and each guarded block of the judge
 * holds one statement.
 *
 * Features: a probe of several rows, and a probe whose rows outnumber its arms (two rows of one key).
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { judged, type Reached, shapeGen } from "#test/unit/physical/rule-probes.fixtures.ts"

/** The set judge runs one statement in each guarded block, its probe reading each row once. */
export const theSetJudgeRunsOneStatementInEachGuardedBlockReadingEachRowOfItsProbeOnce =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: [
			"a probe of several rows",
			"a probe whose rows outnumber its arms"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (shape) => Effect.sync(() => judged(shape, c.note)),
		oracle: {
			kind: "universal",
			name: "a set: the probe reads one arm of each key among its rows, and each guarded block holds one statement"
		},
		box: "every containment of S in a derived relation of T of one to three arms, each holding T's a to a literal of its own or not at all, each joining U by k or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\tif (seen.has(key)) {\n\t\t\treturn false",
				replacement: "\t\tif (seen.has(key) && false) {\n\t\t\treturn false",
				why: "A probe reads every row its table's occurrences give, each once per occurrence, so two arms of D that hold nothing of T's row apart are read twice; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\tif (!isNonEmpty(rest)) {\n\t\tconst head = first.rule.head",
				replacement: "\tif (true) {\n\t\tconst head = first.rule.head",
				why: "A probe reads its first row alone, so a fact of D only a later arm withdraws is never judged; the property fails."
			}
		]
	})
