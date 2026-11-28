/** What the properties of integration.test.ts read: its spaces, models and helpers. */

import { Logic } from "#compiler/public/compute.ts"
import { closedId, domain, int4, int8 } from "#compiler/public/fields.ts"
import { closed, relation, type RowScalars } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

const Slug = str.regex("^[a-z]{1,20}$")

const centsKey = Symbol("Cents")
export const Cents = domain<typeof centsKey>()("Cents", int8, (v) => Logic.ge(v, 0n))

export const Kind = closed.ordered("Kind", ["a", "b"])

export const Account = relation(
	"Account",
	{ id: int4, slug: Slug, bal: Cents, kind: closedId(Kind) },
	["id"]
)

export type Row = RowScalars<typeof Account>

/**
 * Rows a refused callback is written against: what a JavaScript caller assumed the row to be. Their types admit the
 * operands Account's and Pair's real rows refuse; the values are never declared in a schema.
 */
const Loose = relation(
	"Account",
	{
		id: int4,
		slug: Slug,
		bal: int4,
		kind: closedId(closed.ordered("Kind", ["a", "b", "c"]))
	},
	["id"]
)

export type LooseRow = RowScalars<typeof Loose>

const SamePair = relation("Pair", { a: Cents, b: Cents }, ["a"])

export type SamePairRow = RowScalars<typeof SamePair>

/**
 * A check the vocabulary composes: arithmetic over a contract field, a cast to numeric, or charLength and a handle test.
 */
export type Composed = "arithmetic" | "a cast" | "charLength and a handle"

/**
 * A check a JavaScript caller writes against the wrong row: a number for a bigint field, a handle off the roster, or two
 * contracts of different identity meeting.
 */
export type Refused = "a number for a bigint" | "a handle off the roster" | "two contracts meeting"
