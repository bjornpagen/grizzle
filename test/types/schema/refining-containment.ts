import { Array as Arr, Effect } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The refining-containment programs: a containment of a field of one type into a field of another, each int8,
 * natural, a contract over int8, a contract over natural, a clock instant, a stored instant, int4, a closed id
 * of a roster, one of another roster of the same handles, or a contract over the first roster's closed id. Each cell is
 * printed into one program the type batch checks.
 *
 * The oracle is the rule the engine pairs a containment's fields by (scalar/compute/types.ts sameCarrier), stated here
 * apart from the types: two fields pair exactly when their base carriers are one, one SQL type once their contracts
 * are stripped at every level, a closed id's roster kept: int8 for the first six, int4 for int4, and each
 * roster's closed id for the last three.
 */

/** A type a cell's source or target field is of. */
export type RefiningKind =
	| "bigint"
	| "natural"
	| "contract"
	| "nested"
	| "instant"
	| "stored"
	| "integer"
	| "roster"
	| "other roster"
	| "roster contract"

/** A cell: a containment of a field of `from`'s type into one of `into`'s. */
export interface RefiningCell {
	readonly from: RefiningKind
	readonly into: RefiningKind
}

const kinds: Arr.NonEmptyReadonlyArray<RefiningKind> = [
	"bigint",
	"natural",
	"contract",
	"nested",
	"instant",
	"stored",
	"integer",
	"roster",
	"other roster",
	"roster contract"
]

/**
 * The cells of refiningBox, minted as a dictionary in its door (test/types/schema/refining-containment.dictionary.ts):
 * every type into every type.
 */
export const refiningBoxItems: Arr.NonEmptyReadonlyArray<RefiningCell> = Arr.flatMap(
	kinds,
	(from) => Arr.map(kinds, (into): RefiningCell => ({ from, into }))
)

/** Each kind's base carrier, as the engine pairs it: its contracts stripped, its roster kept. */
const carrierOf: { readonly [K in RefiningKind]: string } = {
	bigint: "int8",
	natural: "int8",
	contract: "int8",
	nested: "int8",
	instant: "int8",
	stored: "int8",
	integer: "int4",
	roster: "closed id of Hue",
	"other roster": "closed id of Tint",
	"roster contract": "closed id of Hue"
}

/** Each kind's relation of the header: a field `v` of its type in its primary key after `o`, as a clock stands. */
const relationOf: { readonly [K in RefiningKind]: string } = {
	bigint: "Big",
	natural: "Count",
	contract: "Moments",
	nested: "Unit",
	instant: "Clock",
	stored: "Stored",
	integer: "Whole",
	roster: "Shade",
	"other roster": "Tone",
	"roster contract": "Bright"
}

const sidesDiffer: Refused = "the sides' field types differ"

/** A cell's line: the containment, refused where its fields' base carriers differ. */
const cellLines = (c: RefiningCell, at: number): ReadonlyArray<string> => [
	`// ${c.from} contained in ${c.into}`,
	...(carrierOf[c.from] === carrierOf[c.into]
		? []
		: [`// @ts-expect-error -- refusal: ${sidesDiffer}`]),
	`export const C${at} = contained(on(${relationOf[c.from]}, "o", "v"), on(${relationOf[c.into]}, "o", "v"))`,
	""
]

/** The types and relations every cell reads: each kind's relation, keyed by `o` and its field `v`. */
const header = (): ReadonlyArray<string> => [
	'export const momentKey = Symbol("Moment")',
	'export const Moment = domain<typeof momentKey>()("Moment", int8, (t) => Logic.ge(t, 0n))',
	'export const onesKey = Symbol("Ones")',
	'export const Ones = domain<typeof onesKey>()("Ones", natural, (n) => Logic.le(n, 1n))',
	'export const Hue = closed.ordered("Hue", ["red", "blue"])',
	'export const Tint = closed.ordered("Tint", ["red", "blue"])',
	'export const litKey = Symbol("Lit")',
	'export const Lit = domain<typeof litKey>()("Lit", closedId(Hue), (h) => Logic.ne(h, Hue.handle("blue")))',
	'export const Big = relation("Big", { o: int4, v: int8 }, ["o", "v"])',
	'export const Count = relation("Count", { o: int4, v: natural }, ["o", "v"])',
	'export const Moments = relation("Moments", { o: int4, v: Moment }, ["o", "v"])',
	'export const Unit = relation("Unit", { o: int4, v: Ones }, ["o", "v"])',
	'export const Clock = relation("Clock", { o: int4, v: instant }, ["o", "v"])',
	'export const Stored = relation("Stored", { o: int4, v: instant.stored }, ["o", "v"])',
	'export const Whole = relation("Whole", { o: int4, v: int4 }, ["o", "v"])',
	'export const Shade = relation("Shade", { o: int4, v: closedId(Hue) }, ["o", "v"])',
	'export const Tone = relation("Tone", { o: int4, v: closedId(Tint) }, ["o", "v"])',
	'export const Bright = relation("Bright", { o: int4, v: Lit }, ["o", "v"])',
	""
]

/** The program's prelude (test/support/programs/refining-containment.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/refining-containment.ts"))

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const refiningProgram = (
	cells: Arr.NonEmptyReadonlyArray<RefiningCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/schema/refining-containment.ts: a containment of a field of each type into one of each type.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: header() },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(c, at) }))
		]
	)
]
