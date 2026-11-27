import { Array as Arr, Effect } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/types/batch/batch.ts"

/**
 * The drawn-types programs: an ordered family whose index is drawn of one type and its owner's count of another, each
 * natural, a contract over smallint, integer or bigint, a contract over a numeric or a text, or a plain integer, and a
 * field of the index's type contained in the family's indexes and they in it, as metis's test number is. Each cell is
 * printed into one program the type batch checks.
 *
 * The oracle is the rules the engine holds a drawn field and an ordered family to, stated here apart from the types:
 * drawn(type) takes natural or a contract whose base is an integer (scalar/natural.ts isDrawnType), an ordered family's
 * index is of its count's type (analysis/theory/families.ts indexOfCount), and a containment pairs fields of one
 * base carrier, which a field of the contract and a drawn field of it are.
 */

/** A type a cell draws its index or its count of. */
export type DrawnKind = "natural" | "int2" | "int4" | "int8" | "numeric" | "text" | "plain"

/** A cell: an ordered family's index type and count type, or a counted family's count type. */
export type DrawnTypesCell =
	| { readonly family: "ordered"; readonly index: DrawnKind; readonly count: DrawnKind }
	| { readonly family: "counted"; readonly count: DrawnKind }

const kinds: Arr.NonEmptyReadonlyArray<DrawnKind> = [
	"natural",
	"int2",
	"int4",
	"int8",
	"numeric",
	"text",
	"plain"
]

/**
 * The cells of drawnTypesBox, minted as a dictionary in its door (test/types/schema/drawn-types.dictionary.ts): every
 * index type with every count type.
 */
export const drawnTypesBoxItems: Arr.NonEmptyReadonlyArray<DrawnTypesCell> = [
	...Arr.flatMap(kinds, (index) =>
		Arr.map(kinds, (count): DrawnTypesCell => ({ family: "ordered", index, count }))
	),
	...Arr.map(kinds, (count): DrawnTypesCell => ({ family: "counted", count }))
]

/** Each kind's type as the program spells it: natural, a contract of the header, or pg.integer. */
const typeText: { readonly [K in DrawnKind]: string } = {
	natural: "natural",
	int2: "Small",
	int4: "Whole",
	int8: "Big",
	numeric: "Exact",
	text: "Named",
	plain: "pg.integer"
}

/** Each kind's drawn field as the program spells it: of its type, a contract's under its key (types/fields MintKey). */
const drawnText: { readonly [K in DrawnKind]: string } = {
	natural: "drawn(natural)",
	int2: "drawn(Small, smallKey)",
	int4: "drawn(Whole, wholeKey)",
	int8: "drawn(Big, bigKey)",
	numeric: "drawn(Exact, exactKey)",
	text: "drawn(Named, namedKey)",
	plain: "drawn(pg.integer)"
}

/** Whether grizzle draws a kind's values: natural, and a contract whose base is an integer. */
const drawable = (kind: DrawnKind): boolean =>
	kind === "natural" || kind === "int2" || kind === "int4" || kind === "int8"

const drawnTypes: Refused =
	"drawn(type): natural or a contract over an integer, the types a family's index and count are of"
const indexOfCount: Refused = "an ordered family's index is of its count's type"
const countedNatural: Refused =
	"a counted family's count is a drawn natural, as its hidden index is"

/** A directive for a line `refusal` refuses, none for one it admits. */
const directive = (refusal: Refused | undefined): ReadonlyArray<string> =>
	refusal === undefined ? [] : [`// @ts-expect-error -- refusal: ${refusal}`]

/**
 * A cell's lines: its owner, counting by a drawn field of the count's type, and its member, indexed by one of the
 * index's, each refused where its type is no drawn type; where both are, a field of the index's type, the family,
 * refused where its index is not of its count's type, and the containments of that field in the indexes and of the
 * indexes in it, each admitted.
 */
const cellLines = (c: DrawnTypesCell, at: number): ReadonlyArray<string> =>
	c.family === "ordered" ? orderedLines(c, at) : countedLines(c, at)

/**
 * A counted family's lines: its owner, counting by a drawn field of the count's type, refused where its type is no
 * drawn type, and where it is one, the family, refused where its count is no natural, as its hidden index is.
 */
const countedLines = (
	c: Extract<DrawnTypesCell, { readonly family: "counted" }>,
	at: number
): ReadonlyArray<string> => [
	`// a counted family counted by ${c.count}`,
	...directive(drawable(c.count) ? undefined : drawnTypes),
	`export const Owner${at} = relation("Owner${at}", { id: pg.integer, n: ${drawnText[c.count]} }, ["id"])`,
	`export const Member${at} = relation("Member${at}", { id: pg.integer, owner: pg.integer }, ["id"])`,
	...(drawable(c.count)
		? [
				`export const S${at} = schema("S${at}", [Owner${at}, Member${at}], [`,
				...directive(c.count === "natural" ? undefined : countedNatural),
				`\tcounted(on(Member${at}, "owner"), fin(Owner${at}, "n"))`,
				"])"
			]
		: []),
	""
]

/** An ordered family's lines (see `cellLines`). */
const orderedLines = (
	c: Extract<DrawnTypesCell, { readonly family: "ordered" }>,
	at: number
): ReadonlyArray<string> => {
	const index = typeText[c.index]
	const declared = drawable(c.index) && drawable(c.count)
	return [
		`// an index of ${c.index} counted by ${c.count}`,
		...directive(drawable(c.count) ? undefined : drawnTypes),
		`export const Owner${at} = relation("Owner${at}", { id: pg.integer, n: ${drawnText[c.count]} }, ["id"])`,
		...directive(drawable(c.index) ? undefined : drawnTypes),
		`export const Member${at} = relation("Member${at}", { id: pg.integer, at: ${drawnText[c.index]} }, ["id", "at"])`,
		...(declared
			? [
					`export const Holder${at} = relation("Holder${at}", { holder: pg.integer, at: ${index} }, ["holder"])`,
					`export const S${at} = schema("S${at}", [Owner${at}, Member${at}, Holder${at}], [`,
					...directive(c.index === c.count ? undefined : indexOfCount),
					`\tordered(on(Member${at}, "id", "at"), fin(Owner${at}, "n")),`,
					`\tcontained(on(Holder${at}, "at"), on(Member${at}, "at")),`,
					`\tcontained(on(Member${at}, "at"), on(Holder${at}, "at"))`,
					"])"
				]
			: []),
		""
	]
}

/**
 * The contracts every cell reads: one from 0 over smallint, integer and bigint, which grizzle draws, and one over a
 * numeric and one over a text, which it does not.
 */
const drawnTypesHeader = (): ReadonlyArray<string> => [
	'export const smallKey = Symbol("Small")',
	'export const Small = contract<typeof smallKey>()("Small", pg.smallint, (n) => Logic.ge(n, 0))',
	'export const wholeKey = Symbol("Whole")',
	'export const Whole = contract<typeof wholeKey>()("Whole", pg.integer, (n) => Logic.and([Logic.ge(n, 0), Logic.le(n, 2147483647)]))',
	'export const bigKey = Symbol("Big")',
	'export const Big = contract<typeof bigKey>()("Big", pg.bigint, (n) => Logic.ge(n, 0n))',
	'export const exactKey = Symbol("Exact")',
	'export const Exact = contract<typeof exactKey>()("Exact", pg.numeric(9, 0), (n) => Logic.ge(n, 0n))',
	'export const namedKey = Symbol("Named")',
	'export const Named = contract<typeof namedKey>()("Named", str.regex("^[0-9]+$", "u"), (n) => Logic.ne(n, "0"))',
	""
]

/** The program's prelude (test/support/programs/drawn-types.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/drawn-types.ts"))

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const drawnTypesProgram = (
	cells: Arr.NonEmptyReadonlyArray<DrawnTypesCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/schema/drawn-types.ts: an ordered family drawn of each type, and a field of its index's type contained in it both ways.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: drawnTypesHeader() },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(c, at) }))
		]
	)
]
