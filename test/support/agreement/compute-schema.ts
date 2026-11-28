import { Logic, Type } from "#compiler/public/compute.ts"
import {
	bit,
	closedId,
	domain,
	date,
	Numeric,
	mintOf,
	range,
	bool,
	float4,
	float8,
	int2,
	int4,
	int8,
	money,
	numeric,
	vector
} from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id, idKey } from "#test/support/ids.ts"

export const Tone = closed.ordered("Tone", ["low", "high"])
const Shade = closed.ordered("Shade", ["low", "dark"])
/** Tone's handles in a roster whose order means nothing: a closed id of it has no order, which no ordered operation reads. */
export const Hue = closed.unordered("Hue", ["low", "high"])
export const centsKey = Symbol("Cents")
const Cents = domain<typeof centsKey>()("Cents", int8, (x) => Logic.ge(x, 0n), {
	proves: ["nonnegative"]
})
export const epochDayKey = Symbol("EpochDay")
const EpochDay = domain<typeof epochDayKey>()("EpochDay", int8)
export const rateKey = Symbol("Rate")
const Rate = domain<typeof rateKey>()("Rate", numeric(7, 6), (x) => Logic.between(x, 0n, 1n))
export const divisorKey = Symbol("Divisor")
const Divisor = domain<typeof divisorKey>()("Divisor", int4, (x) => Logic.ne(x, 0), {
	proves: ["nonzero"]
})
export const bodyKey = Symbol("Body")
const Body = domain<typeof bodyKey>()("Body", str.regex("^.*$", "su"))

/**
 * The mints of Cell's contracts' values, which a program's typed constant and a conditional's literal arm of a contract
 * take (test/support/agreement/compute.ts); each contract's key above is what a cast into it takes.
 */
export const toCents = mintOf(centsKey)
export const toEpochDay = mintOf(epochDayKey)
export const toRate = mintOf(rateKey)
export const toDivisor = mintOf(divisorKey)
export const toBody = mintOf(bodyKey)

/**
 * The relation the scalar type/engine agreement draws its cases over (test/support/agreement/compute.ts), over a Rate
 * contract: Cell, with a field of every carrier a scalar operand may have, a contract over each base the catalogue
 * reads (a bigint that declares itself nonnegative and one with no predicate, a numeric in [0, 1], an integer that
 * declares itself nonzero, a text), a text of no bound and a word of a few letters, spans of a contract, of a contract
 * that declares a fact, of an integer and of a date, vectors of two dimensions, a closed id of an ordered roster and one
 * of an unordered roster of the same handles, and sets of two rosters that share a member.
 */
const cellOver = (rate: typeof Rate) =>
	relation(
		"Cell",
		{
			id: Id,
			small: int2,
			int: int4,
			big: int8,
			real: float4,
			dbl: float8,
			dec: numeric(10, 2),
			money: money,
			flag: bool,
			text: str.regex("^.*$", "su"),
			word: str.regex("^[a-z]{1,8}$"),
			day: date,
			cents: Cents,
			epoch: EpochDay,
			rate,
			divisor: Divisor,
			body: Body,
			centsSpan: range(Cents),
			intSpan: range(int4),
			daySpan: range(date),
			divisorSpan: range(Divisor),
			vec: vector(3),
			wide: vector(4),
			tone: closedId(Tone),
			hue: closedId(Hue),
			tones: bit(Tone),
			shades: bit(Shade)
		},
		["id"]
	)

/**
 * The key a cast into each of Cell's contract fields takes, by the field: its id's the tests' Id's, and each of the
 * catalogue's (types/fields MintKey).
 */
export const cellKeys: Readonly<Record<string, symbol>> = {
	id: idKey,
	cents: centsKey,
	epoch: epochDayKey,
	rate: rateKey,
	divisor: divisorKey,
	body: bodyKey
}

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
			dec: Numeric.of("12.50"),
			cents: toCents(0n),
			divisor: toDivisor(3)
		},
		{
			tone: "high",
			small: -7,
			int: -3,
			big: -5n,
			dec: Numeric.of("-99999999.99"),
			cents: toCents(42n),
			divisor: toDivisor(-2)
		}
	]
)

export const Cells = schema("Cells", [Tone, Shade, Hue, Cell], [])

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
			base: Type.base(cell.divisor),
			cast: Type.cast(cell.divisor, of.fields.int),
			cond: Logic.cond(Logic.gt(cell.int, 0), cell.divisor, cell.divisor),
			least: Logic.least(cell.divisor, cell.divisor),
			greatest: Logic.greatest(cell.divisor, cell.divisor),
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
const RateAsTyped = domain<typeof rateKey>()("Rate", numeric(7, 6))
const CellAsTyped = cellOver(RateAsTyped)
const CellsAsTyped = schema("Cells", [Tone, Shade, Hue, CellAsTyped], [])

/** The population's world as the types read it (CellsAsTyped). */
export const AsTyped = Object.freeze({
	Cell: CellAsTyped,
	Cells: CellsAsTyped,
	Heads: headsOver(CellsAsTyped, CellAsTyped)
})
