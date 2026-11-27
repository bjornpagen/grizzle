/**
 * A bare literal opposite a column takes the column's type as written, wherever it meets one: a select() side's
 * selection, a rule's match binding a containment reads, a read's match binding, a negated match's, and a predicate's
 * operand by `eq`, `between` and `in` (literal-opposite.fixtures.ts places). It compiles where the type holds it, and is
 * refused at compile, MalformedDescription naming the literal and the type, where it has more digits than the type
 * holds (README, Arithmetic: "A bare literal takes its term's type ... and is refused where it has more digits than that
 * type holds"; scalar/compute/literal.ts oppositeLiteralProblem). It is never rounded: PostgreSQL resolves `x = '1.25'`
 * at numeric of no typmod and compares exactly, coercing to a typmod only on assignment, so 1.25 rounded to a
 * numeric(5, 1) x's 1.3 would select rows the comparison never does. Before, three readings held: the selector, a match
 * binding and a negated match's rounded 1.25 to 1.3, and a predicate compared it exactly, so a containment into a rule
 * binding x to 1.25 lowered to a foreign key at 1.3 and committed A(1) beside B(1, 1.3), a row the rule never holds.
 *
 * The theory's selector (analysis/theory/laws.ts LawSides.selector) reads a bare literal through the same rule
 * (oppositeLiteral), but every literal it reads is one the checker or the predicate's typing has held to the rule
 * first, so its own refusal is unobservable here and no kill is claimed of it.
 *
 * Oracle: the README's rule for a bare literal, over each place and each literal of the box: 1.3, a value of
 * numeric(5, 1) as written, and 0.5, a value of real, compile; 1.25 and 0.1, which numeric(5, 1) and real would round
 * into themselves, are refused for their digits.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type LiteralForm,
	literals,
	type Place,
	type Placed,
	places,
	verdictOf
} from "#test/unit/analysis/literal-opposite.fixtures.ts"

/** Each place at each literal. */
const placedGen: Gen<Placed> = (source) => ({
	place: source.draw(element(places)),
	literal: source.draw(element(literals))
})

type Feature = `${Place} at ${LiteralForm}`

/** A bare literal opposite a column takes the column's type as written: compiled where the type holds it, refused for its digits where it has more than the type holds, at every place it meets a column. */
export const aBareLiteralOppositeAColumnTakesTheColumnsTypeAsWrittenCompiledWhereTheTypeHoldsItRefusedForItsDigitsWhereItHasMoreThanTheTypeHoldsAtEveryPlaceItMeetsAColumn =
	property.exhaust(finite(placedGen), {
		box: "each place a bare literal meets a numeric(5, 1) column, at 1.3 and at 1.25, and a real column, at 0.5 and at 0.1",
		needs: {},
		situations: Arr.flatMap(places, (place) =>
			Arr.map(literals, (literal): Feature => `${place} at ${literal}`)
		) satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (placed) =>
			Effect.sync(() => {
				c.note(`${placed.place} at ${placed.literal}`)
				const verdict = verdictOf(placed)
				const expected = placed.literal === "as written" ? "compiled" : "refused for its digits"
				assert.equal(
					verdict.kind,
					expected,
					`${placed.place} at ${placed.literal}: ${verdict.kind === "refused otherwise" ? verdict.message : verdict.kind}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "README's rule for a bare literal: it takes its term's type, and is refused where it has more digits than that type holds"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/literal.ts",
				original:
					"\tif (exact.ok) {\n\t\treturn undefined\n\t}\n\tconst shown = parsed.value.toString()\n",
				replacement:
					'\tif (exact.ok || exact.error === "numericScale") {\n\t\treturn undefined\n\t}\n\tconst shown = parsed.value.toString()\n',
				why: "A bare decimal of more digits than its numeric(p, s) column holds is accepted: 1.25 compiles at every place, a read comparing exactly and a binding rounded to 1.3."
			},
			{
				file: "packages/engine/src/scalar/compute/literal.ts",
				original:
					'\t\treturn !real.ok && real.error === "realInexact" ? more(String(value)) : undefined\n',
				replacement: "\t\treturn undefined\n",
				why: "A bare number no real holds is accepted opposite a real column: 0.1 compiles, rounded to binary32's nearest where the comparison reads it exactly."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					'\t\t\tconst literal = this.cx.schema.literal(\n\t\t\t\te.value,\n\t\t\t\tcolumn.type,\n\t\t\t\tloc,\n\t\t\t\tthis.cx.patterns,\n\t\t\t\t"compared"\n\t\t\t)\n',
				replacement:
					'\t\t\tconst literal = this.cx.schema.literal(\n\t\t\t\te.value,\n\t\t\t\tcolumn.type,\n\t\t\t\tloc,\n\t\t\t\tthis.cx.patterns,\n\t\t\t\t"stored"\n\t\t\t)\n',
				why: "A match binding rounds a bare literal to its column's type: a read binding x to 1.25 compiles to x = 1.3::numeric(5, 1)."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\t\t\tif (role === "compare") {\n\t\t\t\tthis.asWritten(desc.value, against, at)\n\t\t\t}\n',
				replacement: "",
				why: "A predicate's bare operand is held to no type: a read's x = 1.25 compiles, comparing exactly a value x never holds."
			}
		]
	})
