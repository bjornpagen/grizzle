/**
 * What the property of drawn-types.test.ts reads: its schema, the series of each drawn type, its programs, its space and
 * its model.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic } from "#compiler/public/compute.ts"
import { closedId, contract, drawn, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	contained,
	fin,
	key,
	mutable,
	on,
	ordered,
	relation,
	schema,
	select,
	unit
} from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"

/** The one series, and whether a test holds an issued number. */
const Series = closed.unordered("DrawnSeries", ["test"])
const Issue = closed.unordered("DrawnIssue", ["held", "unused"])

/** A count from 0 to 3 over each integer width, which a family of four members passes. */
export const Small = contract("DrawnSmall", pg.smallint, (n) =>
	Logic.and(Logic.ge(n, 0), Logic.le(n, 3))
)
export const Whole = contract("DrawnWhole", pg.integer, (n) =>
	Logic.and(Logic.ge(n, 0), Logic.le(n, 3))
)
export const Big = contract("DrawnBig", pg.bigint, (n) =>
	Logic.and(Logic.ge(n, 0n), Logic.le(n, 3n))
)
/** metis's test number: every int4 from 0, its bound its carrier's. */
export const Wide = contract("DrawnWide", pg.integer, (n) =>
	Logic.and(Logic.ge(n, 0), Logic.le(n, 2147483647))
)
/** A count over int2 bounded by its carrier alone, 32767, which no CHECK states. */
export const Tall = contract("DrawnTall", pg.smallint, (n) => Logic.ge(n, 0))

/**
 * Each drawn type's series: an owner counting its issued numbers, `issued`, the numbers an ordered family indexes by
 * `number`, each held or unused, and the tests holding the held ones, `number` of the drawn type, contained in the held
 * numbers and they in it, as metis's catalog states its test numbers.
 */
const NaturalSeries = relation(
	"NaturalSeries",
	{ series: closedId(Series), issued: drawn(natural) },
	["series"]
)
const NaturalIssued = relation(
	"NaturalIssued",
	{ series: closedId(Series), number: drawn(natural), issue: closedId(Issue) },
	["series", "number"]
)
const NaturalNumber = relation("NaturalNumber", { test: pg.integer, number: natural }, ["test"])
const naturalHeld = select(NaturalIssued, (i) =>
	i.and(i.eq(i.series, "test"), i.eq(i.issue, "held"))
)

const SmallSeries = relation("SmallSeries", { series: closedId(Series), issued: drawn(Small) }, [
	"series"
])
const SmallIssued = relation(
	"SmallIssued",
	{ series: closedId(Series), number: drawn(Small), issue: closedId(Issue) },
	["series", "number"]
)
const SmallNumber = relation("SmallNumber", { test: pg.integer, number: Small }, ["test"])
const smallHeld = select(SmallIssued, (i) => i.and(i.eq(i.series, "test"), i.eq(i.issue, "held")))

const WholeSeries = relation("WholeSeries", { series: closedId(Series), issued: drawn(Whole) }, [
	"series"
])
const WholeIssued = relation(
	"WholeIssued",
	{ series: closedId(Series), number: drawn(Whole), issue: closedId(Issue) },
	["series", "number"]
)
const WholeNumber = relation("WholeNumber", { test: pg.integer, number: Whole }, ["test"])
const wholeHeld = select(WholeIssued, (i) => i.and(i.eq(i.series, "test"), i.eq(i.issue, "held")))

const BigSeries = relation("BigSeries", { series: closedId(Series), issued: drawn(Big) }, [
	"series"
])
const BigIssued = relation(
	"BigIssued",
	{ series: closedId(Series), number: drawn(Big), issue: closedId(Issue) },
	["series", "number"]
)
const BigNumber = relation("BigNumber", { test: pg.integer, number: Big }, ["test"])
const bigHeld = select(BigIssued, (i) => i.and(i.eq(i.series, "test"), i.eq(i.issue, "held")))

const WideSeries = relation("WideSeries", { series: closedId(Series), issued: drawn(Wide) }, [
	"series"
])
const WideIssued = relation(
	"WideIssued",
	{ series: closedId(Series), number: drawn(Wide), issue: closedId(Issue) },
	["series", "number"]
)
const WideNumber = relation("WideNumber", { test: pg.integer, number: Wide }, ["test"])
const wideHeld = select(WideIssued, (i) => i.and(i.eq(i.series, "test"), i.eq(i.issue, "held")))

const TallSeries = relation("TallSeries", { series: closedId(Series), issued: drawn(Tall) }, [
	"series"
])
const TallIssued = relation(
	"TallIssued",
	{ series: closedId(Series), number: drawn(Tall), issue: closedId(Issue) },
	["series", "number"]
)
const TallNumber = relation("TallNumber", { test: pg.integer, number: Tall }, ["test"])
const tallHeld = select(TallIssued, (i) => i.and(i.eq(i.series, "test"), i.eq(i.issue, "held")))

/**
 * A family over the carrier-bounded contract whose members a put moves between groups: each member keyed by its own
 * id, its group `g` its caller's, so a put that changes `g` re-places it, and the family's statement draws the group it
 * joins in SQL, past the members stored there.
 */
const MoveOwner = relation("MoveOwner", { g: pg.integer, n: drawn(Tall) }, ["g"])
const MoveMember = relation("MoveMember", { id: pg.integer, g: pg.integer, at: drawn(Tall) }, [
	"id"
])

export const Drawn = schema(
	"drawn_types",
	[
		Series,
		Issue,
		NaturalSeries,
		NaturalIssued,
		NaturalNumber,
		SmallSeries,
		SmallIssued,
		SmallNumber,
		WholeSeries,
		WholeIssued,
		WholeNumber,
		BigSeries,
		BigIssued,
		BigNumber,
		WideSeries,
		WideIssued,
		WideNumber,
		TallSeries,
		TallIssued,
		TallNumber,
		MoveOwner,
		MoveMember
	],
	[
		mutable(NaturalSeries),
		ordered(on(NaturalIssued, "series", "number"), fin(NaturalSeries, "issued")),
		key(on(NaturalNumber, "number")),
		contained(on(NaturalNumber, "number"), on(naturalHeld, "number")),
		contained(on(naturalHeld, "number"), on(NaturalNumber, "number")),
		mutable(SmallSeries),
		ordered(on(SmallIssued, "series", "number"), fin(SmallSeries, "issued")),
		key(on(SmallNumber, "number")),
		contained(on(SmallNumber, "number"), on(smallHeld, "number")),
		contained(on(smallHeld, "number"), on(SmallNumber, "number")),
		mutable(WholeSeries),
		ordered(on(WholeIssued, "series", "number"), fin(WholeSeries, "issued")),
		key(on(WholeNumber, "number")),
		contained(on(WholeNumber, "number"), on(wholeHeld, "number")),
		contained(on(wholeHeld, "number"), on(WholeNumber, "number")),
		mutable(BigSeries),
		ordered(on(BigIssued, "series", "number"), fin(BigSeries, "issued")),
		key(on(BigNumber, "number")),
		contained(on(BigNumber, "number"), on(bigHeld, "number")),
		contained(on(bigHeld, "number"), on(BigNumber, "number")),
		mutable(WideSeries),
		ordered(on(WideIssued, "series", "number"), fin(WideSeries, "issued")),
		key(on(WideNumber, "number")),
		contained(on(WideNumber, "number"), on(wideHeld, "number")),
		contained(on(wideHeld, "number"), on(WideNumber, "number")),
		mutable(TallSeries),
		ordered(on(TallIssued, "series", "number"), fin(TallSeries, "issued")),
		key(on(TallNumber, "number")),
		contained(on(TallNumber, "number"), on(tallHeld, "number")),
		contained(on(tallHeld, "number"), on(TallNumber, "number")),
		mutable(MoveOwner),
		mutable(MoveMember),
		ordered(on(MoveMember, "g", "at"), fin(MoveOwner, "n")),
		unit("Catalog", { series: closedId(Series) }),
		unit("Group", { g: pg.integer }),
		unit("Moved", { id: pg.integer })
	]
)

/** A drawn type of the box, by the name its relations are prefixed with. */
export type Kind = "Natural" | "Small" | "Whole" | "Big" | "Wide" | "Tall"

/**
 * Each kind's greatest counts: its contract's bound, the greatest its CHECK holds, and its carrier's, the greatest its
 * column holds, natural's and a bigint's past every case; and how a value of it is read, a JavaScript integer for
 * smallint and integer, a bigint for bigint.
 */
export const kinds: {
	readonly [K in Kind]: {
		readonly most: number
		readonly carrier: number
		readonly host: "number" | "bigint"
	}
} = {
	Natural: { most: Number.MAX_SAFE_INTEGER, carrier: Number.MAX_SAFE_INTEGER, host: "bigint" },
	Small: { most: 3, carrier: 32767, host: "number" },
	Whole: { most: 3, carrier: 2147483647, host: "number" },
	Big: { most: 3, carrier: Number.MAX_SAFE_INTEGER, host: "bigint" },
	Wide: { most: 2147483647, carrier: 2147483647, host: "number" },
	Tall: { most: Number.MAX_SAFE_INTEGER, carrier: 32767, host: "number" }
}

/** The contract each kind's values are of, by its name; natural for natural's. */
export const contractOf: { readonly [K in Kind]: string } = {
	Natural: "natural",
	Small: "DrawnSmall",
	Whole: "DrawnWhole",
	Big: "DrawnBig",
	Wide: "DrawnWide",
	Tall: "DrawnTall"
}

/** Each kind's issued numbers as a query reads them back: each number and whether a test holds it. */
const reads = Object.freeze({
	Natural: () =>
		query(Drawn).rule((r) => {
			const { series, number, issue } = v(NaturalIssued, "i")
			return r.match(NaturalIssued, { series, number, issue }).find({ number, issue })
		}),
	Small: () =>
		query(Drawn).rule((r) => {
			const { series, number, issue } = v(SmallIssued, "i")
			return r.match(SmallIssued, { series, number, issue }).find({ number, issue })
		}),
	Whole: () =>
		query(Drawn).rule((r) => {
			const { series, number, issue } = v(WholeIssued, "i")
			return r.match(WholeIssued, { series, number, issue }).find({ number, issue })
		}),
	Big: () =>
		query(Drawn).rule((r) => {
			const { series, number, issue } = v(BigIssued, "i")
			return r.match(BigIssued, { series, number, issue }).find({ number, issue })
		}),
	Wide: () =>
		query(Drawn).rule((r) => {
			const { series, number, issue } = v(WideIssued, "i")
			return r.match(WideIssued, { series, number, issue }).find({ number, issue })
		}),
	Tall: () =>
		query(Drawn).rule((r) => {
			const { series, number, issue } = v(TallIssued, "i")
			return r.match(TallIssued, { series, number, issue }).find({ number, issue })
		})
})

/** Each kind's write: its series with its issued numbers nested, and its tests, its issued numbers read back. */
const programs = Object.freeze({
	moveOwners: ChangeSet.empty(Drawn).insert(MoveOwner, []),
	moveMembers: ChangeSet.empty(Drawn).put(MoveMember, []),
	Natural: ChangeSet.empty(Drawn)
		.insert(NaturalSeries, [])
		.insert(NaturalNumber, [])
		.read("issued", reads.Natural),
	Small: ChangeSet.empty(Drawn)
		.insert(SmallSeries, [])
		.insert(SmallNumber, [])
		.read("issued", reads.Small),
	Whole: ChangeSet.empty(Drawn)
		.insert(WholeSeries, [])
		.insert(WholeNumber, [])
		.read("issued", reads.Whole),
	Big: ChangeSet.empty(Drawn).insert(BigSeries, []).insert(BigNumber, []).read("issued", reads.Big),
	Wide: ChangeSet.empty(Drawn)
		.insert(WideSeries, [])
		.insert(WideNumber, [])
		.read("issued", reads.Wide),
	Tall: ChangeSet.empty(Drawn)
		.insert(TallSeries, [])
		.insert(TallNumber, [])
		.read("issued", reads.Tall)
})

export const drawnInstall = Object.freeze({ label: "drawn_types", programs })

/** Drawn installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const drawnTemplate = fixtureTemplate(import.meta, Drawn, drawnInstall)

/** One call's issued numbers, in order: whether a test holds each. */
export type Issues = ReadonlyArray<"held" | "unused">

/**
 * A case: a kind, and the numbers one call issues to a fresh series, each held or unused, which the host draws. A tall
 * series' call issues 32,765 to 32,768 numbers, all unused, so its count meets its carrier's bound and passes it.
 */
export interface Issuing {
	readonly kind: Kind
	readonly issues: Issues
}

const issuesGen =
	(min: number, max: number, held: boolean): Gen<Issues> =>
	(source) =>
		Array.from({ length: source.draw(int(min, max)) }, () =>
			held ? source.draw(element(["held", "unused"] as const)) : "unused"
		)

export const issuingGen: Gen<Issuing> = (source) => {
	const kind = source.draw(element(["Natural", "Small", "Whole", "Big", "Wide", "Tall"] as const))
	return {
		kind,
		issues: source.draw(kind === "Tall" ? issuesGen(32765, 32768, false) : issuesGen(0, 5, true))
	}
}

/**
 * What the call answers, by the model: accepted, its series' count and its numbers; refused on the kind's contract, a
 * count past its bound; or its input refused before any statement, a count past its carrier.
 */
export type Expected =
	| {
			readonly kind: "accepted"
			readonly count: number
			readonly numbers: ReadonlyArray<{
				readonly number: number
				readonly issue: "held" | "unused"
			}>
	  }
	| { readonly kind: "refused" }
	| { readonly kind: "input" }

/**
 * The model of a call issuing `issues` to a fresh series of kind `kind`: each number its place, from 0, the count their
 * number, every value compared as an integer, whatever its host type. A count past the carrier is no value of the
 * column, never wrapped into one: the host refuses it as the call's input before any statement; a count within the
 * carrier past the contract's bound is the contract's CHECK's to refuse.
 */
export const expectedOf = (kind: Kind, issues: Issues): Expected => {
	const count = issues.length
	const { most, carrier } = kinds[kind]
	return count > carrier
		? { kind: "input" }
		: count > most
			? { kind: "refused" }
			: {
					kind: "accepted",
					count,
					numbers: Arr.map(issues, (issue, number) => ({ number, issue }))
				}
}

export type DrawnFeature =
	| "a contract over smallint"
	| "a contract over integer"
	| "a contract over bigint"
	| "natural"
	| "metis's test number"
	| "a count at its contract's bound"
	| "a count past its contract's bound, refused"
	| "a count at its carrier's bound"
	| "a count past its carrier's bound, refused"
	| "a held number in each direction of the containments"
	| "a series of no numbers"

export const situations = [
	"a contract over smallint",
	"a contract over integer",
	"a contract over bigint",
	"natural",
	"metis's test number",
	"a count at its contract's bound",
	"a count past its contract's bound, refused",
	"a count at its carrier's bound",
	"a count past its carrier's bound, refused",
	"a held number in each direction of the containments",
	"a series of no numbers"
] as const satisfies ReadonlyArray<Reached<DrawnFeature>>

/**
 * A move: owner 1's group of two members and owner 2's of `full` members, each member's id its place in the call, and
 * `moved` of owner 1's members put into owner 2's group, which the family's statement draws past its stored members:
 * owner 2's count is `full + moved`, past the carrier's 32,767 where it is greater.
 */
export interface Move {
	readonly full: number
	readonly moved: 1 | 2
}

/** Owner 2's group at the carrier's bound less one or at it, one or two of owner 1's members moved into it. */
export const moveGen: Gen<Move> = (source) => ({
	full: source.draw(int(kinds.Tall.carrier - 1, kinds.Tall.carrier)),
	moved: source.draw(element([1, 2] as const))
})

export type MoveFeature =
	| "a group drawn to its carrier's bound"
	| "a group drawn past its carrier's bound, refused"

export const moveSituations = [
	"a group drawn to its carrier's bound",
	"a group drawn past its carrier's bound, refused"
] as const satisfies ReadonlyArray<Reached<MoveFeature>>
