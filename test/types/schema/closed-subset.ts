import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/types/batch/batch.ts"

/**
 * The closed-subset programs: a closed id of a subset of its roster's handles, stated as `{ only }` (its handles listed
 * out of the roster's order) and as `{ except }`, beside a closed id of the whole roster, each a relation's key, read
 * back by a query, met by an equality and contained into the whole roster's key, and at every handle of the roster one
 * use of the program's: an addition, an equality with the handle in a query and in a row check, or a containment of the
 * key in a set of it over the roster, exhausted and printed as one program the type batch checks.
 *
 * The oracle is the subset as the declaration states it, computed here apart from the types: `only`'s handles, or every
 * handle of the roster but `except`'s. A handle is a value of a subset's field exactly when the subset holds it: an
 * addition at it is admitted, at any other refused, and a query's column of the field is the subset's handles. The
 * field's domain and language are the roster's, so it meets the whole roster's field in an equality and a containment,
 * a parameter of the whole roster's closed id, and every handle of the roster in an equality and a set. A selection by
 * a handle outside the subset stays refused: no row of the source delivers it. A declared function's result of the
 * whole roster is a type, and one of the subset is refused: no function's body is a value of a subset.
 */

/** The roster's handles, in its order. */
const handles = ["p", "q", "r", "s"] as const

type Handle = (typeof handles)[number]

/** The subsets the program declares: `only` lists its handles out of the roster's order, `except` the one it leaves out. */
const subsets = {
	Only: { form: "only", listed: ["s", "q"] },
	Except: { form: "except", listed: ["p"] }
} as const satisfies Readonly<
	Record<string, { readonly form: "only" | "except"; readonly listed: ReadonlyArray<Handle> }>
>

type Subset = keyof typeof subsets

/** The handles a subset holds, as the declaration states them: only's, or every one but except's. */
const heldBy = (s: Subset): ReadonlyArray<Handle> => {
	const { form, listed } = subsets[s]
	const named = new Set<string>(listed)
	return Arr.filter(handles, (h) => (form === "only" ? named.has(h) : !named.has(h)))
}

/** A cell: a relation of the program, a subset's or the whole roster's, and a handle written at its key. */
interface SubsetCell {
	readonly relation: Subset | "Whole"
	readonly handle: Handle
}

/** What a program does with each cell's handle: write it, equate the key to it, or hold the key in a set of it. */
export type Use = "addition" | "equality" | "containment"

/** The cells of closedSubsetBox, minted as a dictionary in its door (test/types/schema/closed-subset.dictionary.ts). */
export const closedSubsetBoxItems: Arr.NonEmptyReadonlyArray<SubsetCell> = Arr.flatMap(
	["Only", "Except", "Whole"] as const,
	(relation) => Arr.map(handles, (handle): SubsetCell => ({ relation, handle }))
)

/** Whether a cell's relation holds its handle: every handle for the whole roster's, else its subset's. */
const holds = (c: SubsetCell): boolean =>
	c.relation === "Whole" || heldBy(c.relation).includes(c.handle)

/** A subset's declaration as its relation's key field states it. */
const subsetText = (s: Subset): string =>
	`{ ${subsets[s].form}: [${Arr.join(Arr.map(subsets[s].listed, jsonText), ", ")}] }`

/** The handles a subset holds as a type: the union of their literals. */
const unionOf = (held: ReadonlyArray<Handle>): string => Arr.join(Arr.map(held, jsonText), " | ")

/**
 * The schema every cell reads: the roster, a relation keyed by each subset's closed id and one by the whole roster's,
 * a query over each subset's relation, its column the subset's handles, and each subset's equality with and containment
 * into the whole roster's key, which meet whatever the subset.
 */
const closedSubsetHeader = (): ReadonlyArray<string> => [
	`export const Mark = closed.ordered("Mark", [${Arr.join(Arr.map(handles, jsonText), ", ")}])`,
	...Arr.flatMap(["Only", "Except"] as const, (s) => [
		`export const ${s} = relation(${jsonText(s)}, { mark: closedId(Mark, ${subsetText(s)}), n: pg.integer }, ["mark"])`
	]),
	'export const Whole = relation("Whole", { mark: closedId(Mark), n: pg.integer }, ["mark"])',
	"export const Marks = schema(",
	'\t"Marks",',
	"\t[Mark, Only, Except, Whole],",
	'\t[contained(on(Only, "mark"), on(Whole, "mark")), contained(on(Except, "mark"), on(Whole, "mark"))]',
	")",
	...Arr.flatMap(["Only", "Except"] as const, (s) => [
		`export const read${s} = query(Marks).rule((r) => {`,
		`\tconst { mark, n } = v(${s}, "held")`,
		`\treturn r.match(${s}, { mark, n }).find({ mark, n })`,
		"})",
		`export type held${s} = Expect<Equals<HeadOf<typeof read${s}>["mark"], ${unionOf(heldBy(s))}>>`,
		`export const meets${s} = query(Marks).rule((r) => {`,
		`\tconst held = v(${s}, "held")`,
		'\tconst whole = v(Whole, "whole")',
		`\treturn r`,
		`\t\t.match(${s}, { mark: held.mark, n: held.n })`,
		"\t\t.match(Whole, { mark: whole.mark, n: whole.n })",
		"\t\t.where(r.eq(held.mark, whole.mark))",
		"\t\t.find({ mark: held.mark, n: whole.n })",
		"})",
		`export const param${s} = query(Marks).rule((r) => {`,
		`\tconst held = v(${s}, "held")`,
		`\treturn r`,
		`\t\t.match(${s}, { mark: held.mark, n: held.n })`,
		'\t\t.where(r.eq(held.mark, r.param("k", closedId(Mark))))',
		"\t\t.find({ n: held.n })",
		"})"
	]),
	'export const wholeResult = fn("wholeResult", { calls: [], args: { n: pg.integer }, returns: closedId(Mark), volatility: "immutable", nullInput: "called", language: "sql", body: fn.body`SELECT 0::int2` })',
	"// @ts-expect-error -- refusal: a declared function's closed id is of its whole roster: no function's body is a value of a subset",
	`export const subsetResult = fn("subsetResult", { calls: [], args: { n: pg.integer }, returns: closedId(Mark, ${subsetText("Only")}), volatility: "immutable", nullInput: "called", language: "sql", body: fn.body\`SELECT 0::int2\` })`,
	"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"export type Expect<T extends true> = T",
	""
]

/** A cell's lines under `use`: an addition at its handle, admitted exactly where its relation holds the handle; and an
 * equality with it and a containment in a set of it, each admitted at every handle of the roster. */
const cellLines = (use: Use, c: SubsetCell, at: number): ReadonlyArray<string> => {
	const handle = jsonText(c.handle)
	const lines = ((): ReadonlyArray<string> => {
		switch (use) {
			case "addition":
				return [
					...(holds(c)
						? []
						: [
								`// @ts-expect-error -- refused: ${handle} is no handle ${c.relation}'s subset holds`
							]),
					`export const w${at}: Addition<typeof ${c.relation}> = { mark: ${handle}, n: ${at} }`
				]
			case "equality":
				return [
					`export const e${at} = query(Marks).rule((r) => {`,
					`\tconst held = v(${c.relation}, "held")`,
					`\treturn r.match(${c.relation}, { mark: held.mark, n: held.n }).where(r.eq(held.mark, ${handle})).find({ n: held.n })`,
					"})",
					`export const k${at} = check("k${at}", ${c.relation}, (o) => o.ne(o.mark, ${handle}))`
				]
			case "containment":
				return [
					`export const c${at} = query(Marks).rule((r) => {`,
					`\tconst held = v(${c.relation}, "held")`,
					`\treturn r`,
					`\t\t.match(${c.relation}, { mark: held.mark, n: held.n })`,
					`\t\t.where(r.eq(Bits.subset(Bits.singleton(held.mark), Bits.of(Mark, [${handle}])), true))`,
					"\t\t.find({ n: held.n })",
					"})"
				]
		}
	})()
	return [`// ${c.relation}, at ${c.handle}: ${holds(c) ? "held" : "outside"}`, ...lines, ""]
}

/** The program's prelude (test/support/programs/closed-subset.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/closed-subset.ts"))

/** The program of `use` over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const closedSubsetProgram =
	(use: Use) =>
	(cells: Arr.NonEmptyReadonlyArray<SubsetCell>, entry: Entry): Program => [
		preludeModule(
			"index.ts",
			`// Generated by test/types/schema/closed-subset.ts: a closed id of a subset of its roster, at every handle by ${use}.`,
			preludeFrom(prelude, entry),
			[
				{ owner: batchOwned, lines: closedSubsetHeader() },
				...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(use, c, at) }))
			]
		)
	]
