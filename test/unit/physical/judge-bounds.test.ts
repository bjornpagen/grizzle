/**
 * Every read a rule's judge makes of a learner's rows is a lookup of that learner's alone (analysis/theory/navigate.ts
 * implied): navigation binds a read by each column an equality chain of its rule fixes to a value the steps before it
 * hold, a key's channel or a column a step read, where it bound only the columns equated with such a value directly.
 * An import inlined into an arm of a definition read at a written row's keys binds its relation's column to the arm's
 * variable, which the arm equates with the key's channel, two equalities away: the ledger's "Response in time" and
 * "Inside a candidate session" read ResponseSnapshot at (at, n, package, path) alone, every learner's snapshots at an
 * instant, so every save's predicate locks covered every learner's snapshots there and independent learners' saves
 * failed each other with 40001 (PERF-COMMIT, edullm's installation A at f87b2aaab: 36% of saves at 16 learners).
 *
 * Property: over the shapes of the ledger's sittings (judge-bounds.fixtures.ts), each a check over a definition of
 * several rules, each reading an import of a learner's snapshots beside a visit (the ledger's shape, its first rule
 * unnegated, its budget left out, its import nested in an import): every index the judge asks for a read of a
 * learner's relation holds the learner key among its columns.
 *
 * Oracle: the request's own columns, the lookup a step makes (physical/ddl/rules.ts requestsOf), against the learner
 * key every learner relation leads with.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { type Feature, judged, shapeGen } from "#test/unit/physical/judge-bounds.fixtures.ts"

/** Every read a judge makes of a learner's relation is looked up by the learner. */
export const everyReadAJudgeMakesOfALearnersRowsIsALookupByTheLearner = property.exhaust(
	finite(shapeGen),
	{
		needs: {},
		situations: [
			"a definition of three rules",
			"an import nested in an import",
			"a negated rule",
			"no rule negating"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c) => (shape) => Effect.sync(() => judged(shape, (f) => c.note(f))),
		oracle: {
			kind: "universal",
			name: "bound: every law-maintenance request on a learner's relation holds the learner key among its columns"
		},
		box: "the four shapes: the ledger's, unnegated, without the budget, and its import nested in an import",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\tappendAll(pending, implied(pending, isKnown))\n",
				replacement: "",
				why: "A read is bound only by the columns an equality equates with a held value directly: the snapshots import's read of RS, placed first, is looked up by (n, at) alone, every learner's snapshots at an instant, and the property fails."
			}
		]
	}
)
