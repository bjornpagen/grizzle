import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The variant-subset program: a variant over a subset of its roster's handles, the ones its arms name, listed out of
 * the roster's order, its value a relation's field with its tag generated as a closed id of the subset, read back by a
 * query; and at every handle of the roster a value of it written as an addition and made with `make`, exhausted and
 * printed as one program the type batch checks.
 *
 * The oracle is the subset as the arms name it, computed here apart from the types. A handle is a value of the variant
 * exactly when an arm names it: an addition and a make at it are admitted, at any other refused; a query's column of
 * the variant is the union of the subset's arms alone, and its tag's, the subset's handles. A variant of no arm, and
 * one with an arm named by a handle off the roster, are refused.
 */

/** The roster's handles, in its order. */
const handles = ["p", "q", "r", "s"] as const

type Handle = (typeof handles)[number]

/**
 * The handles the variant holds, as its arms name them, in the roster's order: its declaration lists them out of it, s
 * with a field and then q of none (variantSubsetHeader).
 */
const held: ReadonlyArray<Handle> = ["q", "s"]

/** A cell: a handle of the roster a value of the variant is written at. */
interface SubsetCell {
	readonly handle: Handle
}

/** The cells of variantSubsetBox, minted as a dictionary in its door (test/types/schema/variant-subset.dictionary.ts). */
export const variantSubsetBoxItems: Arr.NonEmptyReadonlyArray<SubsetCell> = Arr.map(
	handles,
	(handle): SubsetCell => ({ handle })
)

/** Whether the variant holds a cell's handle: an arm names it. */
const holds = (c: SubsetCell): boolean => held.includes(c.handle)

/** The literals of `values` as a TypeScript union. */
const unionOf = (values: ReadonlyArray<string>): string =>
	Arr.join(Arr.map(values, jsonText), " | ")

/**
 * The schema every cell reads: the roster, the variant over the subset its arms name, a relation holding it with its
 * tag generated as a closed id of the subset, a query of both and of the tag term, and the two variants the
 * constructor refuses.
 */
const variantSubsetHeader = (): ReadonlyArray<string> => [
	`export const Mark = closed.ordered("Mark", [${Arr.join(Arr.map(handles, jsonText), ", ")}])`,
	'export const Some = variant("Some", Mark, { s: { n: pg.integer }, q: {} })',
	'export const Held = relation.generated("Held", { id: pg.integer, value: Some }, ["id"], (r) => ({',
	`\tkind: generated(closedId(Mark, { only: [${Arr.join(Arr.map(held, jsonText), ", ")}] }), Some.tag(r.value))`,
	"}))",
	'export const Marks = schema("Marks", [Mark, Held], [])',
	"export const readHeld = query(Marks).rule((r) => {",
	'\tconst { id, value, kind } = v(Held, "held")',
	"\treturn r.match(Held, { id, value, kind }).find({ id, value, kind, tag: Some.tag(value) })",
	"})",
	'export type heldValue = Expect<Equals<HeadOf<typeof readHeld>["value"], { readonly tag: "q" } | { readonly tag: "s"; readonly n: number }>>',
	`export type heldKind = Expect<Equals<HeadOf<typeof readHeld>["kind"], ${unionOf(held)}>>`,
	`export type heldTag = Expect<Equals<HeadOf<typeof readHeld>["tag"], ${unionOf(held)}>>`,
	"// @ts-expect-error -- refusal: a variant holds at least one arm, each named by a handle of its roster",
	'export const None = variant("None", Mark, {})',
	"// @ts-expect-error -- refusal: a variant holds at least one arm, each named by a handle of its roster",
	'export const Off = variant("Off", Mark, { q: {}, t: {} })',
	"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"export type Expect<T extends true> = T",
	""
]

/** A value at a handle as its lines write it: the s arm's field beside its tag, none beside another's. */
const valueText = (handle: Handle, fields: string): string =>
	handle === "s" || handle === "r"
		? `{ tag: ${jsonText(handle)}, ${fields} }`
		: `{ tag: ${jsonText(handle)} }`

/** A cell's lines: an addition of a value at its handle and a make of one, each admitted exactly where an arm names it. */
const cellLines = (c: SubsetCell, at: number): ReadonlyArray<string> => {
	const handle = jsonText(c.handle)
	const refused = holds(c)
		? []
		: [`// @ts-expect-error -- refused: ${handle} is no handle an arm of Some names`]
	const madeFields = c.handle === "s" || c.handle === "r" ? "{ n: 1 }" : "{}"
	return [
		`// at ${c.handle}: ${holds(c) ? "held" : "outside"}`,
		...refused,
		`export const w${at}: Addition<typeof Held> = { id: ${at}, value: ${valueText(c.handle, "n: 1")} }`,
		...refused,
		`export const m${at} = Some.make(${handle}, ${madeFields})`,
		""
	]
}

/** The program's prelude (test/support/programs/variant-subset.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/variant-subset.ts"))

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const variantSubsetProgram = (
	cells: Arr.NonEmptyReadonlyArray<SubsetCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/schema/variant-subset.ts: a variant over a subset of its roster, at every handle.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: variantSubsetHeader() },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(c, at) }))
		]
	)
]
