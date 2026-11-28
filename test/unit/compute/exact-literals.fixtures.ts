/** What exact-literals.test.ts reads: each position a bare literal meets an exact type at, and each value it states. */

import { Array as Arr } from "effect"
import { int8Max } from "#compiler/ir/carriers.ts"
import { Logic, Num, Type } from "#compiler/public/compute.ts"
import {
	exactInteger,
	generated,
	Money,
	variant,
	bool,
	int4,
	int8
} from "#compiler/public/fields.ts"
import { type AnyRelation, closed, relation, schema } from "#compiler/public/schema.ts"
import { moneyFractionDigits } from "#compiler/scalar/values/decimal.ts"
import { numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"

/** qti-pie's cell's roster, two of its handles (pantry's BaseType). */
const BaseType = closed.unordered("BaseType", ["boolean", "integer"] as const)

/** qti-pie's cell (ledger scalars.ts QtiValue, lane LEDGER-VALUECELL): its integer arm an exact integer. */
const QtiValue = variant("QtiValue", BaseType, {
	boolean: { value: bool },
	integer: { value: exactInteger }
})

/** The written fields every position's generated field `g` reads: an integer and an exact integer. */
const written = { k: int4, n: exactInteger } as const

/** The exact integer digits of a sum of two integers, |k + k| < 2^32 < 10^11: the bound a computed exact value has. */
const sumDigits = 11

/** The integer digits of every exact field, its type's at numeric's own limit. */
export const fieldDigits = numericMaxIntegerDigits

/** The schema of one relation, T of `written` and its generated field `g`, beside the cell's roster. */
const level = (t: AnyRelation) => schema("ExactLiterals", [BaseType, t], [])

/**
 * The positions an exact integer literal takes its type at, each the digits of the type it takes there and the schema
 * whose generated field states the literal there: a value's place its field's type, a branch its conditional's, and a
 * comparison's or an operation's operand any exact integer, the family's type at numeric's own limit.
 */
export const integerPositions = {
	/** The consumer's: a made value's field of an exact integer arm, `QtiValue.make("integer", { value: 1n })`. */
	"a made value's field": {
		digits: fieldDigits,
		schema: (value: bigint) =>
			level(
				relation.generated("T", written, ["k"], () => ({
					g: generated(QtiValue, QtiValue.make("integer", { value }))
				}))
			)
	},
	"a typed literal": {
		digits: fieldDigits,
		schema: (value: bigint) =>
			level(
				relation.generated("T", written, ["k"], () => ({
					g: generated(exactInteger, Type.literal(exactInteger, value))
				}))
			)
	},
	"a branch beside an exact field": {
		digits: fieldDigits,
		schema: (value: bigint) =>
			level(
				relation.generated("T", written, ["k"], (r) => ({
					g: generated(exactInteger, Logic.cond(Logic.eq(r.k, 1), r.n, value))
				}))
			)
	},
	"an operand beside an exact field": {
		digits: fieldDigits,
		schema: (value: bigint) =>
			level(
				relation.generated("T", written, ["k"], (r) => ({
					g: generated(exactInteger, Num.add(r.n, value))
				}))
			)
	},
	"a comparison opposite an exact field": {
		digits: fieldDigits,
		schema: (value: bigint) =>
			level(
				relation.generated("T", written, ["k"], (r) => ({
					g: generated(int4, Logic.cond(Logic.eq(r.n, value), r.k, 0))
				}))
			)
	},
	"a branch beside a sum of two integers": {
		digits: sumDigits,
		schema: (value: bigint) =>
			level(
				relation.generated("T", written, ["k"], (r) => ({
					g: generated(exactInteger, Logic.cond(Logic.eq(r.k, 1), Num.add(r.k, r.k), value))
				}))
			)
	},
	"a comparison opposite a sum of two integers": {
		digits: fieldDigits,
		schema: (value: bigint) =>
			level(
				relation.generated("T", written, ["k"], (r) => ({
					g: generated(int4, Logic.cond(Logic.eq(Num.add(r.k, r.k), value), r.k, 0))
				}))
			)
	},
	"an operand beside a sum of two integers": {
		digits: fieldDigits,
		schema: (value: bigint) =>
			level(
				relation.generated("T", written, ["k"], (r) => ({
					g: generated(exactInteger, Num.add(Num.add(r.k, r.k), value))
				}))
			)
	}
} as const

export type IntegerPosition = keyof typeof integerPositions

/** The integer positions, each once. */
export const integerPositionNames = [
	"a made value's field",
	"a typed literal",
	"a branch beside an exact field",
	"an operand beside an exact field",
	"a comparison opposite an exact field",
	"a branch beside a sum of two integers",
	"a comparison opposite a sum of two integers",
	"an operand beside a sum of two integers"
] as const satisfies ReadonlyArray<IntegerPosition>

/**
 * The integer values each integer position states: the consumer's 1, a negative, one past a bigint, the greatest
 * magnitude of a sum's digits and the least past it, and the least past an exact field's.
 */
export const integerValues: ReadonlyArray<bigint> = [
	1n,
	-7n,
	10n ** 30n,
	-(10n ** BigInt(sumDigits) - 1n),
	10n ** BigInt(sumDigits),
	10n ** BigInt(fieldDigits)
]

/** The integer digits of the computed exact money an amount meets: 99.99 at most. */
export const moneyDigits = 2

/** Where an amount meets a term of exact money of moneyDigits digits in a query: a branch beside it, or compared with it. */
export const moneyPlaces = [
	"a branch beside exact money of 2 digits",
	"a comparison opposite exact money of 2 digits"
] as const

export type MoneyPlace = (typeof moneyPlaces)[number]

/**
 * The amounts compared with each: 1.25, 99.99, the greatest of 2 integer digits, 100.00, the least past them, money's
 * greatest, and the least amount past an exact field's digits, which only a Money.exact the host built spells.
 */
export const moneyValues: ReadonlyArray<Money> = [
	Money.of(125n),
	Money.of(9999n),
	Money.of(10000n),
	Money.of(int8Max),
	Money.exact(10n ** BigInt(fieldDigits + moneyFractionDigits))
]

/**
 * A case: a literal of an exact integer at a position of a relation's generated field, the consumer's door; or an amount
 * beside or compared with a term of exact money of moneyDigits digits in a query.
 */
export type LiteralCase =
	| { readonly door: "position"; readonly position: IntegerPosition; readonly value: bigint }
	| { readonly door: "money"; readonly place: MoneyPlace; readonly value: Money }

/** The box: every integer position at every integer value, every amount at each place beside exact money. */
export const literalCases: ReadonlyArray<LiteralCase> = [
	...Arr.flatMap(integerPositionNames, (position) =>
		Arr.map(integerValues, (value): LiteralCase => ({ door: "position", position, value }))
	),
	...Arr.flatMap(moneyPlaces, (place) =>
		Arr.map(moneyValues, (value): LiteralCase => ({ door: "money", place, value }))
	)
]

/** The made value's field written as the consumer had to before: a bigint literal cast into the exact integer. */
export const castSchema = (value: bigint) =>
	level(
		relation.generated("T", written, ["k"], () => ({
			g: generated(
				QtiValue,
				QtiValue.make("integer", { value: Type.cast(Type.literal(int8, value), exactInteger) })
			)
		}))
	)
