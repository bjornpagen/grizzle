/**
 * A rule's closure from a start is the determinations its facts give, read off its matches, conditions and head
 * (analysis/theory/unit.ts ruleClosures): each match a key of which the bound variables hold is reached by that key,
 * binding its variables; each equality of bound variables binds the variable it determines, forwards or, where its
 * form is injective in the one variable it leaves, solved backwards (unit.ts solvedOf); a match left is a probe of one
 * witness only where no variable of it is delivered by the head or read by a negation, the negation running once for
 * each of its rows. Lane DELTAUP2's dispatch reads it from the head's variables (a delta rule checked at the fact),
 * unitRooted from each root's.
 *
 * The box is each shape of rule-closures.fixtures.ts, stored at the place under the unit of the document, closed from
 * its head and from each root: a place a mark of which names by its value no mark of the place, the value read by
 * the negation alone (metis's AssignmentStatus rule 2, a sitting whose start event names a next step no event stands
 * at), and a mark beside the mark numbered one less, delivered at the later number (ledger's SittingOrder, the suspension of session k from the visit of session
 * k + 1).
 *
 * The oracle is the closure restated as a model (a specification): rule-closures.fixtures.ts closureOf.
 *
 * Features: each shape closed from its head and from a root.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { succeeded } from "#test/support/assert.ts"
import { compiledOf } from "#test/support/unit/analysis/theory/rule-query.fixtures.ts"
import {
	closureCase,
	closureOf,
	closureSchemaOf,
	closureStated,
	type Shape
} from "#test/unit/analysis/theory/rule-closures.fixtures.ts"

type ClosureFeature = `${Shape} from ${"its head" | "a root"}`

/**
 * A rule's closure reaches each match its start's determinations key, binds what each equality determines forwards or
 * solved backwards, and leaves a match whose variable a negation reads.
 */
export const aRulesClosureReachesEachMatchItsDeterminationsKeyAndLeavesOneANegationReadsOnceForEachRow =
	property.exhaust(finite(closureCase), {
		needs: {},
		situations: [
			"mark naming no mark from its head",
			"mark naming no mark from a root",
			"previous number's mark from its head",
			"previous number's mark from a root"
		] satisfies ReadonlyArray<Reached<ClosureFeature>>,
		check: (_, c: Case<ClosureFeature>) => (closed) =>
			Effect.sync(() => {
				const artifacts = succeeded(
					compiledOf(closureSchemaOf(closed.shape)),
					"every schema of the box compiles"
				)
				assert.deepEqual(
					closureStated(artifacts, closed.start),
					closureOf(closed),
					Formatter.format(closed)
				)
				c.note(`${closed.shape} from ${closed.start.kind === "head" ? "its head" : "a root"}`)
			}),
		oracle: {
			kind: "specification",
			name: "analysis/theory/unit.ts ruleClosures: a match is reached by a key its start's determinations hold, an equality of bound variables binding what it determines, forwards or solved backwards, a match left a probe of one witness only where neither the head delivers nor a negation reads a variable of it"
		},
		box: "a place a mark of which names no mark of the place and a mark beside the previous number's, each stored at the place under the unit of the document, closed from its head and from each root",
		kept: [
			{
				token: ReplayToken(
					"test/unit/analysis/theory/rule-closures.test.ts#aRulesClosureReachesEachMatchItsDeterminationsKeyAndLeavesOneANegationReadsOnceForEachRow:-:0.0"
				),
				reason:
					"A place a mark of which names no mark of the place, closed from its head: metis's AssignmentStatus rule 2, a sitting whose start event names a next step no event of the sitting stands at, the next step read by the negation alone, so the closure from the head leaves the start event and lane DELTAUP2's dispatch checks no fact of it by probes (its lost fact)",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/unit/analysis/theory/rule-closures.test.ts#aRulesClosureReachesEachMatchItsDeterminationsKeyAndLeavesOneANegationReadsOnceForEachRow:-:1.0"
				),
				reason:
					"A mark beside the previous number's, closed from its head: ledger's SittingOrder, the suspension of session k read from the visit of session k + 1, the equality solved backwards binding k, so lane DELTAUP's delta rule probes the suspension's key",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\t\t\t!negated.has(v) &&\n",
				replacement: "",
				why: "A match whose variable a negation reads is read as a probe of one witness, where the negation runs once for each of its rows: from the head, a sitting whose start event names a next step no event stands at is reached, its events read across the sitting's key, each against the negation, for each fact; and a definition each of whose roots leaves another such match, two events each naming a step no event stands at, is stored with an upkeep reading the other's events at the unit for each row of the root."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\t\tconst solved = vars.has(v) ? solvedOf(e, v) : undefined\n",
				replacement: "\t\t\t\tconst solved: Solved | undefined = undefined\n",
				why: "No equality solved backwards: the suspension of session k, read from the visit of session k + 1, is a probe and no key, so the delta rule reads the sitting's suspensions across its key where one probe of it finds the row."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					"\tconst bound = (n: bigint): number | bigint =>\n\t\tintegerHostOf(subject.domain.carrier, n < sLeast ? sLeast : n > sGreatest ? sGreatest : n)\n",
				replacement: "\tconst bound = (n: bigint): number | bigint => n\n",
				why: "A solved conjunct's guard bounds held as int8's, whatever the subject's type: the mark beside the previous number's, numbers of integer, has its guard's bound below integer's least, a bigint, compared with an integer, and the schema is refused (MalformedDescription in Typing.when), as ledger's SittingOrder, a suspension beside the next session's visit, would be."
			}
		]
	})
