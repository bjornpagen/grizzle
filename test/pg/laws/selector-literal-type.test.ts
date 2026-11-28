/**
 * A containment into a side selected by `field = literal`, through grizzle's lowering on PostgreSQL 19, where the
 * literal is bare, typed at the field's own type, or typed at another: `select(B, (b) => b.eq(b.x,
 * Type.literal(pg.numeric(10, 2), "1.25")))` over a numeric(5, 1) field x compares at numeric(10, 2), as a query
 * compares it, so no x equals it. A bare literal takes the field's type as written, 1.3 a value of numeric(5, 1), and
 * one of more digits than the type holds is refused at compile, never rounded (test/unit/analysis/literal-opposite);
 * a typed one fixes the field only where the field's type holds its value exactly (analysis/theory/laws.ts
 * LawSides.selector), on a select() side and on a rule over a query whose match binds the field to it alike.
 *
 * - **The specification turned into a checker:** each source row's containment read row by row: a source row commits
 *   exactly when B holds its id with an x the literal equals as the selection compares them, the exact decimal value
 *   at numeric and the text itself at text. A refusal must be 23503 with an unlawful source row written, and a foreign
 *   key it names must be one of those rows' relations.
 *
 * The space, drawn: one of three B relations (numeric(5, 1) keyed by id, the same keyed by id and x, text of up to 3
 * letters), its row at id 1 absent or at one of two values, and a subset of that relation's sources holding id 1, B's
 * row written first, in one transaction; each source refused alone and held alone is a case constructed to reach it
 * (aims), which a drawn subset reaches one case in hundreds. Types of two carriers never meet without Type.base, so a literal of another
 * type than its field's is one of another numeric typmod or text refinement. Over the B keyed by id and x, a
 * containment into its selection over id holds a key only where the literal fixes x, so the space holds the fixing
 * literals' select() sides, the bare and the typed, and the rules of each, the other keeping its triggers.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import {
	aims,
	B_OF,
	Disagreed,
	type Feature,
	FEATURES,
	lawful,
	literalOf,
	RELATIONS,
	selectorLiteralTemplate,
	sketchGen
} from "#test/pg/laws/selector-literal-type.fixtures.ts"
import { seatIn } from "#test/support/pg/fin/installed.ts"
import { attempt, momentText, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A containment into a side a literal selects, bare, at its field's type or at another, on PostgreSQL 19 commit exactly the states whose every source row's B row holds an x the literal equals as the selection compares them, refusing the rest by 23503.
 *
 * Its budget is the runner's: its catch, a bare 1.25 the selector rounded to 1.3 where its judge compared 1.25
 * (47f8516e7, red in the pin's pg tier at bafa0de1c and 50de8a880), re-plants as no kill here, since a bare literal of
 * more digits than x holds is refused at compile now and every literal the space reads fits its field.
 */
export const aContainmentIntoASideALiteralSelectsBareAtItsFieldsTypeOrAtAnotherOnPostgreSQL19CommitExactlyTheStatesWhoseEverySourceRowsBRowHoldsAnXTheLiteralEqualsAsTheSelectionComparesThemRefusingTheRestBy23503 =
	property.explore(aimed(sketchGen, aims), {
		needs: { fresh: Substrate.fresh(selectorLiteralTemplate) },
		situations: FEATURES satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fresh }, c: Case<Feature>) =>
			(s) =>
				Effect.gen(function* () {
					const taken = yield* fresh
					const seat = yield* seatIn(taken, RELATIONS, "selector_literal")
					const col = (r: string, f: string) => seat.column(r, f)

					const b = B_OF[s.family]
					const statements = [
						...(s.stored === undefined
							? []
							: [
									`INSERT INTO ${seat.table(b)} (${col(b, "id")}, ${col(b, "x")}) VALUES (1, ${s.stored.sql})`
								]),
						...Arr.map(
							s.sources,
							(x) => `INSERT INTO ${seat.table(x.relation)} (${col(x.relation, "id")}) VALUES (1)`
						)
					]
					const unlawful = Arr.filter(s.sources, (x) => !lawful(s, x))
					const real = yield* attempt(seat.session, statements)
					if (real.kind === "committed") {
						if (unlawful.length > 0) {
							return yield* new Disagreed({
								message: `committed a state whose rows of ${Arr.join(
									Arr.map(unlawful, (x) => x.relation),
									", "
								)} meet no B row their literal selects: ${literalOf(s)}`
							})
						}
						for (const x of s.sources) {
							c.note(`held ${x.relation}`)
						}
						return
					}
					const named = seat.refusedBy(real.fields)
					const namesLawful = Option.exists(
						named,
						(k) => k.kind === "foreign" && !Arr.some(unlawful, (x) => x.relation === k.relation)
					)
					if (real.fields.code !== "23503" || unlawful.length === 0 || namesLawful) {
						return yield* new Disagreed({
							message: `refused ${momentText(real.moment)} by ${refusalText(real.fields)}, where the unlawful rows are ${Formatter.format(
								Arr.map(unlawful, (x) => x.relation)
							)}: ${literalOf(s)}`
						})
					}
					if (unlawful.length === 1) {
						c.note(`refused ${Arr.getUnsafe(unlawful, 0).relation}`)
					}
				}),
		oracle: {
			kind: "specification",
			name: "each source row's containment as a checker: B holds its id at an x its literal equals as the selection compares them"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/laws/selector-literal-type.test.ts#aContainmentIntoASideALiteralSelectsBareAtItsFieldsTypeOrAtAnotherOnPostgreSQL19CommitExactlyTheStatesWhoseEverySourceRowsBRowHoldsAnXTheLiteralEqualsAsTheSelectionComparesThemRefusingTheRestBy23503:-:0.2.8"
				),
				reason:
					"BNumeric's row at x 1.3 beside a NumericBare row: the state the pin's pg tier refused by 23503 with no unlawful row at bafa0de1c and 50de8a880, the select() side's selector fixing x at the bare 1.25 rounded to 1.3 while its judge compared 1.25 (47f8516e7); the bare literal is 1.3 as written since, and the state commits",
				since: "2026-11-23"
			}
		],
		kills: []
	})
