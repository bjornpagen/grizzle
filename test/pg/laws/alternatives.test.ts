/**
 * `alternatives` through grizzle's lowering, on PostgreSQL 19rc2 (fin.md §7, w4-w7 §2.5): `alternatives(Item, "kind",
 * Kind, arms)` is its own statement, expanded with no head into plain containments: per arm relation, its key into the
 * parent selected by the handles it is the arm of (the forward), and per armed handle, the parent selected by it into
 * its arm (the reverse, deferred on the parent ↔ arm cycle). Each is refused natively, by a foreign key, never by a law
 * function or trigger.
 *
 * - **The specification turned into a checker:** fin.md §7's reading of alternatives: a state commits exactly when every
 *   arm row's parent exists with a kind the arm is armed for, and every parent of an armed kind has its arm's row; an
 *   unarmed handle needs no arm. A refusal must be 23503 by a foreign key of the relation whose write broke it, an arm's
 *   forward or the parent's reverse, reporting a law of the expansion.
 *
 * That an alternatives law's installed objects grow linearly in its roster's armed handles, never one column per pair,
 * is test/unit/laws/scaling.test.ts's roster-handles dimension.
 *
 * The box (doctrine rule 9): roster {a, b, c}, a armed by relation A, b by B, c unarmed; at most two parents of any kind
 * and every subset of arm rows for them, written parents first, then the arm rows, in one transaction.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { codeOf } from "#compiler/ir/codes.ts"
import { cleared, seatOf } from "#test/pg/fin/installed.ts"
import {
	Alternatives,
	type AlternativesFeature,
	type Broken,
	brokenOf,
	Disagreed,
	type Handle,
	Kind,
	RELATIONS,
	sketchGen
} from "#test/pg/laws/alternatives.fixtures.ts"
import { attempt, momentText, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Alternatives through grizzle's lowering on PostgreSQL 19rc2 commit exactly the states whose every arm row has its armed parent and every armed parent its arm, refusing each arm's forward and reverse natively.
 */
export const alternativesThroughGrizzlesLoweringOnPostgreSQL19rc2CommitExactlyTheStatesWhoseEveryArmRowHasItsArmedParentAndEveryArmedParentItsArmRefusingEachArmsForwardAndReverseNatively =
	property.exhaust(finite(sketchGen), {
		needs: { substrate: Substrate.installing },
		situations: [
			"committed",
			"committed an unarmed parent",
			"refused forward",
			"refused reverse"
		] satisfies ReadonlyArray<Reached<AlternativesFeature>>,
		check:
			({ substrate }, c: Case<AlternativesFeature>) =>
			(s) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const seat = yield* seatOf(Alternatives, RELATIONS, "alternatives")
						const codec = Arr.findFirst(
							[...seat.installed.names.codes.rosters.values()],
							(r) => r.roster === Kind.name
						)
						const code = (h: Handle) => codeOf(Option.getOrThrow(codec), h)
						const laws = seat.lawsOf("containment")

						const parents = Arr.flatMap(s.kinds, (k, id) =>
							k === undefined ? [] : [`(${id}, ${code(k)})`]
						)
						const col = (r: string, f: string) => seat.column(r, f)
						const statements = [
							...(parents.length === 0
								? []
								: [
										`INSERT INTO ${seat.table("Item")} (${col("Item", "id")}, ${col("Item", "kind")}) VALUES ${Arr.join(parents, ", ")}`
									]),
							...Arr.flatMap(["A", "B"] as const, (arm) => {
								const ids = arm === "A" ? s.a : s.b
								return ids.length === 0
									? []
									: [
											`INSERT INTO ${seat.table(arm)} (${col(arm, "item")}) VALUES ${Arr.join(
												Arr.map(ids, (id) => `(${id})`),
												", "
											)}`
										]
							})
						]
						const real = yield* attempt(seat.session, statements)
						const broken = brokenOf(s)
						if (real.kind === "committed") {
							yield* cleared(seat, RELATIONS)
							if (broken.length > 0) {
								return yield* new Disagreed({
									message: `committed a state that breaks the ${Arr.join(broken, " and ")}: ${Formatter.format(s)}`
								})
							}
							c.note(Arr.contains(s.kinds, "c") ? "committed an unarmed parent" : "committed")
							return
						}
						const named = seat.refusedBy(real.fields)
						const by: Option.Option<Broken> = Option.flatMap(named, (k) =>
							k.kind !== "foreign"
								? Option.none()
								: k.relation === "Item"
									? Option.some("reverse")
									: Option.some("forward")
						)
						if (
							real.fields.code !== "23503" ||
							Option.isNone(by) ||
							!broken.includes(by.value) ||
							!Option.exists(named, (k) => Option.exists(k.law, (l) => laws.includes(l)))
						) {
							return yield* new Disagreed({
								message: `refused ${momentText(real.moment)} by ${refusalText(real.fields)}, where the state breaks ${Formatter.format(broken)}: ${Formatter.format(s)}`
							})
						}
						c.note(`refused ${by.value}`)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "fin.md §7's alternatives as a checker: every arm row's parent of an armed kind, every armed parent its arm"
		},
		box: "roster {a, b, c} with a armed by A, b by B and c unarmed: parents 0 and 1 each absent or of a kind, and every subset of A rows and of B rows over them, parents written first",
		kept: [],
		kills: []
	})
