/**
 * C4, no judge for a proven check (PIN 3's "every check provable at compile time emits nothing"): a write compiles no
 * statement of a law's judge whose rows, for every row the write can add, are empty by the installation's keys,
 * containments and closed relations alone, and keeps every statement whose rows are not.
 *
 * The bound is zero: a delta the declared facts prove empty can produce no violation, so a statement over it is a
 * statement planned and run at every COMMIT that writes its relation for nothing (edullm's start ran ten such copies at
 * its 1x bar, __judge_attempt_gq5ysdihtw 82 rule checks at start, answer and submit, about 700 pages a start). The claim
 * is the compiler's: its judge (support/judge.ts judgeStatementsOf), every statement of every stored relation's upkeep and
 * every rule's, each with the deltas it reads; the oracle is the model of what the declared facts prove
 * (no-proved-judge.fixtures.ts provedEmpty):
 *
 * - a closed relation's olds: no write updates or deletes its rows, so its olds hold none, ever;
 * - the parent's news, where the parent is closed and a child is held to it at (doc, p) by a foreign key: a fresh parent
 *   row's key is one no stored parent row held, so no stored child row references it, and the join of X meets it only
 *   at a child row the same write adds, which that child's news drives.
 *
 * And the judge stays whole where no fact proves a delta empty: each child's news is read, and so is the parent's where
 * it is mutable or no child is held to it, so pruning a delta by its gate alone, or a mutable relation's, fails here.
 *
 * Space: exhausted, a parent closed or mutable and one or two children, each closed or mutable and held to the parent
 * by a containment or not; the law a check over X, the join of the parent and its children (no-proved-judge.fixtures.ts).
 * Oracle: the specification above, the model of the declared facts.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { judgeStatementsOf, raisedRule } from "#test/support/judge.ts"
import {
	deltasOf,
	installationOf,
	lawRelations,
	lawShapeGen,
	parentName,
	provedEmpty,
	readersOfDelta
} from "#test/unit/contracts/no-proved-judge.fixtures.ts"

type Situation =
	| "a closed parent a child is held to"
	| "a mutable parent"
	| "a parent no child is held to"
	| "two children"
	| "the check held by the rule judge"
	| "the check held by X's stored table"

/** A judge's statement, named for a failure: its rule, or the stored relation whose upkeep it is. */
const labelOf = (st: ReturnType<typeof judgeStatementsOf>[number]): string =>
	st.kind === "rule"
		? `the rule statement of ${Option.getOrElse(raisedRule(st.statement), () => "no rule")}`
		: `the upkeep of ${st.relation}`

/** No statement of a law's judge reads a delta the declared facts prove empty, and every other delta is read. */
export const noStatementOfALawsJudgeReadsADeltaTheDeclaredFactsProveEmpty = property.exhaust(
	finite(lawShapeGen),
	{
		needs: {},
		situations: [
			"a closed parent a child is held to",
			"a mutable parent",
			"a parent no child is held to",
			"two children",
			"the check held by the rule judge",
			"the check held by X's stored table"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (s) =>
			Effect.sync(() => {
				const installation = installationOf(s)
				const statements = judgeStatementsOf(installation)
				const deltas = deltasOf(installation, s)
				c.note(
					installation.checked.holdings.get("X")?.kind === "stored"
						? "the check held by X's stored table"
						: "the check held by the rule judge"
				)
				if (s.children.length === 2) {
					c.note("two children")
				}
				c.note(
					s.parent.mutable
						? "a mutable parent"
						: Arr.some(s.children, (child) => child.contained)
							? "a closed parent a child is held to"
							: "a parent no child is held to"
				)
				const proved = provedEmpty(s)
				const pruned = Arr.flatMap(proved, ({ relation, side }) => {
					const delta = deltas.get(relation)?.get(side)
					return delta === undefined
						? []
						: Arr.map(
								readersOfDelta(statements, delta),
								(st) =>
									`${labelOf(st)} reads ${relation}'s ${side}, which the declared facts prove empty`
							)
				})
				const kept = Arr.flatMap(lawRelations(s), ({ name }) =>
					Arr.flatMap(["news"] as const, (side) => {
						const delta = deltas.get(name)?.get(side)
						return Arr.some(proved, (p) => p.relation === name && p.side === side) ||
							(delta !== undefined && readersOfDelta(statements, delta).length > 0)
							? []
							: [
									`no statement of the judge reads ${name}'s ${side}, which a write can make violate the law`
								]
					})
				)
				assert.deepEqual(
					[...pruned, ...kept],
					[],
					`the judge of ${Formatter.format(s)} reads exactly the deltas the declared facts leave open (${parentName}'s and its children's)`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the model of the declared facts: a closed relation's olds, and a closed parent's news where a child is held to it by a foreign key, are empty; every other news can violate the law"
		},
		box: "a parent closed or mutable, one or two children each closed or mutable and held to it by a containment or not, a check over their join",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\t\tif (side === "removed" ? closed || withdrawn.has(place) : proofs.has(place)) {',
				replacement:
					'\t\t\tif (side === "removed" ? closed || withdrawn.has(place) : proofs.has(place) || closed) {',
				why: "A closed parent's news pruned by its gate alone, no foreign key holding a child to it: a stored child row may reference a key a parent row the write adds first holds, and no statement reads P's news."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\tif (keyed !== undefined || !laws.closed(relation)) {",
				replacement: "\t\tif (keyed !== undefined) {",
				why: "A mutable parent's news pruned by a child's foreign key: a row P gains at a key a stored child references may replace the one that stood there, and no statement reads P's news."
			}
		]
	}
)
