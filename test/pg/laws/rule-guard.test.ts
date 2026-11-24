/**
 * A probe whose every row reads a learner's rows at the unit of the content it was written over runs only where the
 * written units hold such a row (analysis/theory/query.ts probeGuard, physical/ddl/rules.ts probedBlocks): the judge
 * runs the guard, the rows of that relation at the written rows' units, first, and the probe, which PL/pgSQL plans
 * when it first runs it, only where the guard finds one. On PostgreSQL 19, a check over a learner's values joined to
 * the content they read: a write of the content with no value of its package stands runs no probe, nor where only
 * another package's value stands; one with a lawful value runs it; and a
 * value over its bound, written in the same transaction as the content, is refused; and an arm that reaches the written
 * relation through a match binding the learner's package to nothing of the written row is never guarded, so another
 * package's mark that breaks it is refused; and a containment whose target reaches the written relation two ways, an
 * odd one at the unit and an even one at any package, is guarded on the side only the odd one yields rows of, and on
 * the other side is not, so another package's withdrawn row that breaks it is refused (rule-guard.fixtures.ts).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type GuardFeature,
	guardTemplate,
	learnerGen,
	type RaceFeature,
	raceGen,
	runGuard,
	runRace
} from "#test/pg/laws/rule-guard.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The judge of a write of the content runs its probe only where a learner's row stands at the written package, and
 * judges every such row as it stands at COMMIT, one the same transaction wrote among them.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aProbeOfTheContentRunsOnlyWhereALearnersRowStandsAtItsUnit = property.explore(
	learnerGen,
	{
		needs: { substrate: Substrate.rolledBack(guardTemplate) },
		situations: [
			"skipped where no value of the package stands",
			"skipped where another package's value stands",
			"run where a lawful value stands",
			"refused where a value of the same transaction breaks it",
			"refused where another package's mark breaks an arm read past the unit",
			"skipped on the added side where no session of the document stands",
			"refused on the added side by a session of the document",
			"refused on the removed side, unguarded, by another package's withdrawn template"
		] satisfies ReadonlyArray<Reached<GuardFeature>>,
		check:
			({ substrate }, c) =>
			(learner) =>
				Effect.gen(function* () {
					const { connection, value } = yield* substrate
					yield* runGuard(value, connection, learner, c)
				}),
		oracle: {
			kind: "postgresql",
			name: "the scans of Node the judge adds to the transaction's, which only the probe makes (pg_stat_xact_user_tables), and the judge's verdict: no scan without a value at the written package, some with one, 23514 for a value over its bound written in the same transaction, 23514 for another package's mark joined past the unit, and 23503 for a session of an item a part of the same document makes unready (the added side, guarded) or another package's withdrawn template makes unready (the removed side, unguarded)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					'\t\t\t\t\t\t\t\tsource: { kind: "relation", name: guard.relation },\n\t\t\t\t\t\t\t\tbindings: Object.fromEntries(\n\t\t\t\t\t\t\t\t\tguard.fields.map(\n',
				replacement:
					'\t\t\t\t\t\t\t\tsource: { kind: "relation", name: guard.relation },\n\t\t\t\t\t\t\t\tbindings: Object.fromEntries(\n\t\t\t\t\t\t\t\t\tguard.fields.filter(() => false).map(\n',
				why: "The guard reads the relation without the written rows' units, any row of it anywhere: a write of one package's content beside another package's value runs the probe, which reads Node."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t\t\t\t\t\t\tbody: [guarded === undefined ? judged : whenFound(guarded.statement, [judged])]",
				replacement: "\t\t\t\t\t\t\tbody: [judged]",
				why: "No probe is guarded, as before: a write of the content with no learner's value at its package still runs the probe, which reads Node."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					'\t\t\tif (e?.kind !== "var" || unit.get(e.var) !== k) {\n\t\t\t\treturn false\n\t\t\t}\n\t\t\tthis.#at[k] = f',
				replacement:
					'\t\t\tif (e?.kind !== "var") {\n\t\t\t\treturn false\n\t\t\t}\n\t\t\tthis.#at[k] = f',
				why: "An occurrence of the written relation that binds the unit's field to a variable other than the unit's carries it all the same: Linked's arm, which reaches the written node of package 2 through a match that binds the Mark's package to nothing of it, is guarded by Mark's rows at package 2, finds none, and the mark of package 1 over its cap is accepted."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					"\t\t\tif (unit.size !== fields.length || !carry.arm(arm, unit, flipped(gains))) {",
				replacement: "\t\t\tif (unit.size !== fields.length || !carry.arm(arm, unit, gains)) {",
				why: "A target's arms are carried at the breaking side's polarity, an odd way read as the even one: on the removed side Ready's way through the published template, which yields its rows, is passed over, the probe is guarded by Sess at the deleted part's package, finds none, and the session of package 1's unready item is accepted."
			}
		]
	}
)

/**
 * A publish whose guard sees no learner's row at its unit, racing a learner's write there, never commits beside it into a
 * broken state: the learner's own probe refuses its session, or PostgreSQL's SSI refuses one of the two, the guard's read
 * of Sess at the unit and the learner's probe's read of Doc at the item each written into by the other. A session
 * standing before the publish, or written by the publish after its part, runs the publish's probe, which refuses it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aGuardedPublishRacingALearnersWriteAtItsUnitNeverCommitsBesideItIntoABrokenState =
	property.explore(raceGen, {
		needs: { fresh: Substrate.fresh(guardTemplate) },
		situations: [
			"the publish refused beside a standing session",
			"the publish refused by its own later session",
			"a race refused by a serialization failure"
		] satisfies ReadonlyArray<Reached<RaceFeature>>,
		check:
			({ fresh }, c) =>
			(race) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* fresh
					yield* runRace(value, substrate, race, c.note)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "Sess in Ready's whole violation query, read after both transactions end: it finds nothing, whichever PostgreSQL refused, and each refusal is the rule's (23503) or a serialization failure (40001)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: '\t\t\t\t\t\t\t\tsource: { kind: "delta", side, relation },',
				replacement:
					'\t\t\t\t\t\t\t\tsource: { kind: "delta", side: side === "added" ? "removed" : "added", relation },',
				why: "The guard reads the units off the other side of the written relation, what the transaction found and removed, never what it wrote: a publish's part leaves that side empty, so its guard finds no session though one stands or the publish wrote one after its part, skips the probe, and commits the session of an unready item."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\t\t\t\t\t\t\t\t\t\tvarRef(guardId(k)),\n",
				replacement: "\t\t\t\t\t\t\t\t\t\t\t\t\tvarRef(guardId(guard.fields.length - 1 - k)),\n",
				why: "The guard reads Sess with the unit's fields crossed, package 2's item 1 where the part is package 1's item 2: it finds no session where one stands, skips the probe whose learner's row exists, and commits it beside an unready item."
			}
		]
	})
