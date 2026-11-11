import { Compute } from "#compiler/public/compute.ts"
import { bits, closedId, contract, Decimal, date, pg, span, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

export const Tone = closed("Tone", ["low", "high"])
const Shade = closed("Shade", ["low", "dark"])
const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n), { proves: ["nonnegative"] })
const EpochDay = contract("EpochDay", pg.bigint)
const Rate = contract("Rate", pg.numeric(7, 6), (x) => x.between(0n, 1n))
const Divisor = contract("Divisor", pg.integer, (x) => x.ne(0), { proves: ["nonzero"] })
const Body = contract("Body", str.regex("^.*$", "su"))

/**
 * The relation the Compute type/engine agreement draws its cases over (test/support/agreement/compute.ts), over a Rate
 * contract: Cell, with a field of every carrier a Compute operand may have, a contract over each base the catalogue
 * reads (a bigint that declares itself nonnegative and one with no predicate, a numeric in [0, 1], an integer that
 * declares itself nonzero, a text), a text of no bound and a word of a few letters, spans of a contract, of a contract
 * that declares a fact, of an integer and of a date, vectors of two dimensions, a closed id and sets of two rosters that
 * share a member.
 */
const cellOver = (rate: typeof Rate) =>
	relation(
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
			rate,
			divisor: Divisor,
			body: Body,
			centsSpan: span(Cents),
			intSpan: span(pg.integer),
			daySpan: span(date),
			divisorSpan: span(Divisor),
			vec: pg.vector(3),
			wide: pg.vector(4),
			tone: closedId(Tone),
			tones: bits(Tone),
			shades: bits(Shade)
		},
		["id"]
	)

/** Cell over Rate, the relation the population's programs read. */
export const Cell = cellOver(Rate)

/**
 * Tuning, the closed relation a closed read's case reads at a row's tone: a payload of each integer field of Cell, its
 * numeric, and its contracts over an integer, Cents, which declares nonnegative, and Divisor, which declares nonzero,
 * each of its field's type, at both tones.
 */
export const Tuning = closed.relation(
	"Tuning",
	{
		tone: closedId(Tone),
		small: Cell.fields.small,
		int: Cell.fields.int,
		big: Cell.fields.big,
		dec: Cell.fields.dec,
		cents: Cents,
		divisor: Divisor
	},
	["tone"],
	[
		{
			tone: "low",
			small: 3,
			int: 2,
			big: 1_000_000_000_000n,
			dec: Decimal.of("12.50"),
			cents: Cents(0n),
			divisor: Divisor(3)
		},
		{
			tone: "high",
			small: -7,
			int: -3,
			big: -5n,
			dec: Decimal.of("-99999999.99"),
			cents: Cents(42n),
			divisor: Divisor(-2)
		}
	]
)

export const Cells = schema("Cells", [Tone, Shade, Cell], [])

/**
 * Cell's divisor read back through a query's heading, one column per kind of head term that delivers it: the variable
 * itself, its base, its cast into an integer, a conditional, LEAST and GREATEST of Divisor terms, its least and greatest
 * value and its sum, each grouped by its cell. A variable read from a column has the facts its column's type declares,
 * whatever the head term proved (compute.ts's heading operand): Divisor's nonzero where the column is of Divisor, none
 * where it is of a plain integer.
 */
const headsOver = (cells: typeof Cells, of: typeof Cell) =>
	query(cells).rule((r) => {
		const cell = v(of, "cell")
		return r.match(of, { id: cell.id, divisor: cell.divisor, int: cell.int }).find({
			id: cell.id,
			divisor: cell.divisor,
			base: Compute.base(cell.divisor),
			cast: Compute.cast(cell.divisor, of.fields.int),
			cond: Compute.cond(Compute.gt(cell.int, 0), cell.divisor, cell.divisor),
			least: Compute.least(cell.divisor, cell.divisor),
			greatest: Compute.greatest(cell.divisor, cell.divisor),
			min: r.min(cell.divisor),
			max: r.max(cell.divisor),
			sum: r.sum(cell.divisor)
		})
	})

/** Heads over Cell. */
export const Heads = headsOver(Cells, Cell)

/**
 * Cell's schema as the types read its contracts: each one its declared facts alone, since no type states a contract's
 * predicate. Rate declares none, so it holds every value of its base here; Cents, EpochDay, Divisor and Body are their
 * declared facts already. Where the engine refuses a case for a contract's predicate (ContractLiteral), the population
 * judges it over this schema too: a refusal here is one the types decide, and any other is theirs to state.
 */
const RateAsTyped = contract("Rate", pg.numeric(7, 6))
const CellAsTyped = cellOver(RateAsTyped)
const CellsAsTyped = schema("Cells", [Tone, Shade, CellAsTyped], [])

/** The population's world as the types read it (CellsAsTyped). */
export const AsTyped = Object.freeze({
	Cell: CellAsTyped,
	Cells: CellsAsTyped,
	Heads: headsOver(CellsAsTyped, CellAsTyped)
})
