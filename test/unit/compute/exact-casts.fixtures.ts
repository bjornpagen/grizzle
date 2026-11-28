/** What exact-casts.test.ts reads: each shape of a cast into an exact integer, as a relation's generated field. */

import { Logic, Num, Text, Type } from "#compiler/public/compute.ts"
import { exactInteger, generated, numeric } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { lexicalForm, str } from "#compiler/public/text.ts"
import { numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import { Id } from "#test/support/ids.ts"

/**
 * qti-pie's integer text, a cell's integer's lexical guard (its ledger's walks.ts integerText at 7ea6419c), xs:integer's
 * numeral: the guard of its parse into a cell's integer, QtiValue's integer arm, an exact integer.
 */
const integerText = Text.pattern("^[+-]?[0-9]+$")

/** qti-pie's greatest integer magnitude, 10^825 - 1 (walks.ts integerBound), Num.within's bound in its parseNumeric form. */
const integerBound = 10n ** 825n - 1n

/** Any text of at most 40 bytes, a stored text's (an attribute's value), and any text of no byte bound. */
const Bounded = str.bytes(40, str.regex("^.*$", "su"))
const Unbounded = str.regex("^.*$", "su")

/**
 * The shapes of a cast into an exact integer the box holds, each the relation whose generated field `v` is it, and the
 * verdict the cast's preconditions give it: admitted, or the PartialOperation of the precondition it leaves unproved.
 */
export const shapes = {
	/** The parse in one step: a bounded text under the integer guard, cast into the exact integer itself. */
	"a guarded parse of a bounded text in one step": {
		relation: relation.generated("R", { id: Id, t: Bounded }, ["id"], (r) => ({
			v: generated(
				exactInteger,
				Logic.when(Text.matches(r.t, integerText), (d) => Type.cast(d, exactInteger), 0n)
			)
		})),
		verdict: { kind: "admitted" }
	},
	/** The same parse of a text of no byte bound under the guard and an octetLength bound at the form's. */
	"a guarded parse of an unbounded text within the form's bytes": {
		relation: relation.generated("R", { id: Id, t: Unbounded }, ["id"], (r) => ({
			v: generated(
				exactInteger,
				Logic.when(
					Text.matches(r.t, lexicalForm(exactInteger)),
					(d) =>
						Logic.when(
							Num.within(Text.octetLength(d), 0, numericMaxIntegerDigits),
							() => Type.cast(d, exactInteger),
							0n
						),
					0n
				)
			)
		})),
		verdict: { kind: "admitted" }
	},
	/** The integer guard alone over a text of no byte bound: its bytes past the form's are unproved. */
	"a guarded parse of an unbounded text": {
		relation: relation.generated("R", { id: Id, t: Unbounded }, ["id"], (r) => ({
			v: generated(
				exactInteger,
				Logic.when(Text.matches(r.t, integerText), (d) => Type.cast(d, exactInteger), 0n)
			)
		})),
		verdict: { kind: "refused", precondition: "lexical" }
	},
	/**
	 * qti-pie's form at 7ea6419c (walks.ts, a cell's integer): the guarded text read by Text.parseNumeric, bounded by
	 * Num.within, cast into the exact integer, whose value's fraction digits nothing bounds.
	 */
	"the consumer's parseNumeric form": {
		relation: relation.generated("R", { id: Id, t: Bounded }, ["id"], (r) => ({
			v: generated(
				exactInteger,
				Logic.when(
					Text.matches(r.t, integerText),
					(d) =>
						Logic.when(
							Num.within(Text.parseNumeric(d), -integerBound, integerBound),
							(i) => Type.cast(i, exactInteger),
							0n
						),
					0n
				)
			)
		})),
		verdict: { kind: "refused", precondition: "integral" }
	},
	/** A numeric of scale 0 widened into the exact integer: finite, of no fraction digits, within its digits. */
	"numeric(30, 0) widened": {
		relation: relation.generated("R", { id: Id, n: numeric(30, 0) }, ["id"], (r) => ({
			v: generated(exactInteger, Type.cast(r.n, exactInteger))
		})),
		verdict: { kind: "admitted" }
	}
} as const

/** A shape of the box. */
export type Shape = keyof typeof shapes

/** The box's shapes, each once. */
export const shapeNames = [
	"a guarded parse of a bounded text in one step",
	"a guarded parse of an unbounded text within the form's bytes",
	"a guarded parse of an unbounded text",
	"the consumer's parseNumeric form",
	"numeric(30, 0) widened"
] as const satisfies ReadonlyArray<Shape>

/** The schema of one shape. */
export const schemaOf = (shape: Shape) => schema("ExactCasts", [shapes[shape].relation], [])
