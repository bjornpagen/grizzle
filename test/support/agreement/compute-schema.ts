import { bits, closedId, contract, date, pg, span, uuid } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/**
 * The schema the Compute type/engine agreement draws its cases over (test/support/agreement/compute.ts): one relation,
 * Cell, with a field of every carrier a Compute operand may have, a contract over each base the catalogue reads (a
 * bigint with and without a predicate, a numeric, an integer that proves itself nonzero, a text), a text of no bound
 * and a word of a few letters, spans of a contract and of an integer, vectors of two dimensions, a closed id and sets of
 * two rosters that share a member.
 */
export const Tone = closed("Tone", ["low", "high"])
const Shade = closed("Shade", ["low", "dark"])
const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
const EpochDay = contract("EpochDay", pg.bigint)
const Rate = contract("Rate", pg.numeric(7, 6), (x) => x.between(0n, 1n))
const Divisor = contract("Divisor", pg.integer, (x) => x.ne(0), { proves: ["nonzero"] })
const Body = contract("Body", str.regex("^.*$", "su"))

export const Cell = relation(
	"Cell",
	{
		id: uuid,
		small: pg.smallint,
		int: pg.integer,
		big: pg.bigint,
		real: pg.real,
		dbl: pg["double precision"],
		dec: pg.numeric(10, 2),
		money: pg.money,
		flag: pg.boolean,
		text: str.regex("^.*$", "su"),
		word: str.regex("^[a-z]{1,8}$"),
		day: date,
		cents: Cents,
		epoch: EpochDay,
		rate: Rate,
		divisor: Divisor,
		body: Body,
		centsSpan: span(Cents),
		intSpan: span(pg.integer),
		vec: pg.vector(3),
		wide: pg.vector(4),
		tone: closedId(Tone),
		tones: bits(Tone),
		shades: bits(Shade)
	},
	["id"]
)

export const Cells = schema("Cells", { Tone, Shade, Cell }, [])
