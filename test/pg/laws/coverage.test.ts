/**
 * Coverage through grizzle's lowering, on PostgreSQL 19rc2 (fin.md §7, w4-w7 §2.5): a containment of a selected source's
 * span into a selected target's, `contained(on(select(Source, on), "k", "during"), on(select(Target, on), "k",
 * "during"))`, with the target keyed by `key(on(select(Target, on), "k", "during"))`, which over a span term is
 * WITHOUT OVERLAPS; grizzle lowers it to a PERIOD foreign key over the sides' law columns, NO ACTION, deferred only by
 * its deferral rule.
 *
 * - **The specification turned into a checker:** G2's coverage model (test/pg/substrate/temporal.ts), the same one the
 *   substrate's hand-written lowering is proved against: a source row is covered when it is outside its selection
 *   (its law columns NULL, skipped) or its span lies inside the union of its key's selected target spans; the target
 *   key refuses two selected spans of one key that overlap (23P01). PostgreSQL must commit exactly what the model
 *   commits and refuse the rest at the statement the model names, by the installed native of the model's SQLSTATE.
 * - **The named non-empty CHECK:** an empty span is refused by the span field's own shape CHECK, 23514 naming that
 *   CHECK on the row's table, before WITHOUT OVERLAPS's unattributed 23514 could, selected or not.
 * - **Deferral:** a PERIOD foreign key is always deferred (laws/model/model.ts #deferral), since it references its
 *   target's span as a period, never as a plain column, and the facts covering a span can be replaced by others that
 *   cover it; so a gap is refused at COMMIT, and the empty span and the overlap are refused at their statements.
 *
 * The box is G2's (doctrine rule 9): keys 0 and 1, points 0 to 3, each span one of the six non-empty intervals over
 * them, the empty one, or outside the selection; at most two target rows in one INSERT, then one source row. A refusal
 * is told by the law its constraint reports, the key's or the coverage's, or by a CHECK over the span field, its shape.
 *
 * Features: a commit, one with the source outside its selection, each refusal, and a coverage refused across a gap,
 * every one required of the space.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Pool } from "effect"
import { cleared, seatOf, seatPool } from "#test/pg/fin/installed.ts"
import {
	Coverage,
	type CoverageFeature,
	Disagreed,
	insertSql,
	modelOf,
	refusalOf,
	RELATIONS,
	sketchGen,
	SQLSTATE
} from "#test/pg/laws/coverage.fixtures.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import {
	attempt,
	type Attempted,
	momentText,
	refusalText,
	sameMoment
} from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Coverage through grizzle's lowering on PostgreSQL 19rc2 commit exactly the covered states of G2's box, refuse a gap or an overlap by its native, and an empty span by the span's named CHECK, each at its statement.
 */
export const coverageThroughGrizzlesLoweringOnPostgreSQL19rc2CommitExactlyTheCoveredStatesOfG2sBoxRefuseAGapOrAnOverlapByItsNativeAndAnEmptySpanByTheSpansNamedCHECKEachAtItsStatement =
	property.exhaust(finite(sketchGen), {
		needs: { substrate: Substrate.installing },
		situations: [
			"committed",
			"committed with a source outside its selection",
			"refused empty span",
			"refused key",
			"refused coverage",
			"refused coverage across a gap"
		] satisfies ReadonlyArray<Reached<CoverageFeature>>,
		check:
			({ substrate }, c: Case<CoverageFeature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const seats = yield* seatPool(seatOf(Coverage, RELATIONS, "coverage"))

						const seat = yield* Pool.get(seats)
						const laws = namesOf(seat.installed)
						const model = modelOf(sketch)
						const statements = [
							...(Arr.isReadonlyArrayNonEmpty(sketch.targets)
								? [insertSql(seat, "Target", sketch.targets, 0)]
								: []),
							insertSql(seat, "Source", [sketch.source], 100)
						]
						const real: Attempted = yield* attempt(seat.session, statements)
						const disagree = (why: string) =>
							new Disagreed({
								message: `${why}: the model predicts ${Formatter.format(model)}, PostgreSQL gave ${real.kind === "committed" ? "commit" : `refusal ${momentText(real.moment)}: ${refusalText(real.fields)}`}, for ${Formatter.format(sketch)}`
							})
						if (real.kind === "committed") {
							yield* cleared(seat, RELATIONS)
							if (model.kind !== "committed") {
								return yield* disagree("PostgreSQL committed")
							}
							c.note(
								sketch.source.span.kind === "null"
									? "committed with a source outside its selection"
									: "committed"
							)
							return
						}
						if (model.kind !== "refused") {
							return yield* disagree("PostgreSQL refused")
						}
						const named = Option.flatMap(seat.refusedBy(real.fields), refusalOf(laws))
						if (
							!sameMoment(real.moment, model.moment) ||
							!Option.contains(named, model.by) ||
							real.fields.code !== SQLSTATE[model.by]
						) {
							return yield* disagree("the moment, the native or the SQLSTATE differs")
						}
						c.note(`refused ${model.by}`)
						if (model.by === "coverage" && sketch.source.span.kind === "span") {
							const { lo, hi } = sketch.source.span
							if (
								Arr.some(
									sketch.targets,
									(t) =>
										t.k === sketch.source.k &&
										t.span.kind === "span" &&
										t.span.lo < hi &&
										lo < t.span.hi
								)
							) {
								c.note("refused coverage across a gap")
							}
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "G2's coverage model (test/pg/substrate/temporal.ts covered, keyRefusal) as a checker, an empty span refused first by its field's shape CHECK"
		},
		box: "keys 0 and 1, points 0 to 3, each span a non-empty interval, the empty one, or outside its selection: at most two target rows in one INSERT, then one source row",
		kept: [],
		kills: []
	})
