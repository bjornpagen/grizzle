import * as Result from "@bjornpagen/grizzle-text/base/result"
import { nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { Distance } from "#compiler/public/compute.ts"
import { pg, Vector } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import type { QueryValue } from "#compiler/query/build/query.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplateOver, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The take-bound program: the box of every bound a query takes its rows by, Ordered.take(k) and a search's take
 * (approximateNearest({ by, take })), by every spelling of the bound, exhausted and printed as one program the type
 * batch checks.
 *
 * The oracle is the run time: each literal bound is built and compiled as the engine builds and compiles a query
 * (query/build/query.ts takeOf and positiveInteger, check/checker.ts int4TakeBound), against the program's own schema,
 * and a call typechecks exactly when the engine admits its bound. Ordered.take admits a positive integer of at most
 * 2147483647, int4's, or a parameter's nonempty name; a search's take a positive integer of at most 9007199254740991,
 * the largest safe integer. A union of literals is admitted exactly when the engine admits each of its members, and a
 * widened number or string, whose value only the run time reads, is admitted.
 */

/** The bounds a query takes its rows by. */
const sites = ["take", "search"] as const

type Site = (typeof sites)[number]

/** The number literals a bound is spelled as: in range, at each range's edge and past it, and no positive integer. */
const numbers = [
	1, 2, 2147483647, 2147483648, 9007199254740991, 9007199254740992, 0, -1, 1.5, 1e21
] as const

/** The names Ordered.take's parameter is spelled as: a declared name, a name of other characters, and none. */
const names = ["batch", "my-batch", ""] as const

/** How a cell spells its bound. */
type Spelling =
	| Readonly<{ kind: "number"; value: number }>
	| Readonly<{ kind: "name"; value: string }>
	| Readonly<{ kind: "union"; values: readonly [number, number] }>
	| Readonly<{ kind: "widened"; type: "number" | "string" }>

/** One cell: the bound's site and its spelling. */
interface TakeCell {
	readonly site: Site
	readonly spelling: Spelling
}

/** Every spelling of each site's bound: a name or a widened string only where the bound may name a parameter. */
const spellingsOf = (site: Site): ReadonlyArray<Spelling> => [
	...Arr.map(numbers, (value): Spelling => ({ kind: "number", value })),
	{ kind: "union", values: [1, 2] },
	{ kind: "union", values: [1, 0] },
	{ kind: "widened", type: "number" },
	...(site === "take"
		? [
				...Arr.map(names, (value): Spelling => ({ kind: "name", value })),
				{ kind: "widened", type: "string" } as const
			]
		: [])
]

/** The cells of takeBox, minted as a dictionary in its door (test/types/query/take.dictionary.ts). */
export const takeBoxItems: Arr.NonEmptyReadonlyArray<TakeCell> = nonEmpty(
	Arr.flatMap(sites, (site) =>
		Arr.map(spellingsOf(site), (spelling): TakeCell => ({ site, spelling }))
	),
	"a cell of the take box"
)

/** The refusal each site's type states of a bound the engine refuses. */
const refusalOf: { readonly [S in Site]: Refused } = {
	take: "take's k is a positive integer of at most 2147483647, int4's, or a parameter's nonempty name",
	search:
		"a search's take, the requested result bound, is a positive integer of at most 9007199254740991, the largest safe integer"
}

/** The schema the program and the oracle read: a relation of a value to order by and a vector to rank by. */
const Point = relation("Point", { id: Id, n: pg.integer, at: pg.vector(3) }, ["id"])
const Points = schema("Points", [Point], [])
const artifacts = succeeded(testArtifacts(Points, testCompile), "the take program's artifacts")
const origin = Vector.make(Float32Array.from([1, 0, 0]), 3)

/** The query every cell bounds, its rows ordered by n for a take, ranked by their distance d for a search. */
const scored = () =>
	query(Points).rule((r) => {
		const { id, n, at } = v(Point, "point")
		return r.match(Point, { id, n, at }).find({ id, n, d: Distance.cosine(at, origin) })
	})

/** The query a bound value makes at a site, through the builder's JavaScript view, as a JavaScript caller's would. */
const bounded = (site: Site, value: number | string): unknown => {
	const q: QueryValue = scored()
	switch (site) {
		case "take":
			return q.orderBy(["n", "asc"]).take(value)
		case "search":
			return q.approximateNearest({ by: "d", take: value })
	}
}

/** Whether the engine admits a bound value at a site: it builds the query and compiles it against the schema. */
const admits = (site: Site, value: number | string): boolean =>
	Result.flatMap(
		catchCompileError(() => bounded(site, value)),
		(q) => compileTemplateOver(q, Points, artifacts, testCompile)
	).ok

/** The oracle's verdict on a cell: admitted where the engine admits each value its spelling may hold. */
const admitted = (c: TakeCell): boolean => {
	switch (c.spelling.kind) {
		case "number":
		case "name":
			return admits(c.site, c.spelling.value)
		case "union":
			return Arr.every(c.spelling.values, (value) => admits(c.site, value))
		case "widened":
			return true
	}
}

/** A number as the program spells it: an exponent's numeral as a literal of its own, every other numeral as it is. */
const numberText = (value: number): string => (value === 1e21 ? "1e21" : String(value))

/** The declaration a cell's bound reads, none for a literal. */
const declarationOf = (c: TakeCell, index: number): ReadonlyArray<string> => {
	switch (c.spelling.kind) {
		case "number":
		case "name":
			return []
		case "union":
			return [
				`export declare const k${index}: ${Arr.join(Arr.map(c.spelling.values, numberText), " | ")}`
			]
		case "widened":
			return [`export declare const k${index}: ${c.spelling.type}`]
	}
}

/** The bound expression a cell's call is handed. */
const boundText = (c: TakeCell, index: number): string => {
	switch (c.spelling.kind) {
		case "number":
			return numberText(c.spelling.value)
		case "name":
			return jsonText(c.spelling.value)
		case "union":
		case "widened":
			return `k${index}`
	}
}

/** A cell's lines: its declaration, and its call under the refusal its site states where the engine refuses it. */
const cellLines = (c: TakeCell, index: number): ReadonlyArray<string> => {
	const directive = admitted(c) ? [] : [`\t// @ts-expect-error -- refusal: ${refusalOf[c.site]}`]
	const call =
		c.site === "take"
			? [`export const c${index} = ordered.take(`, ...directive, `\t${boundText(c, index)}`, ")"]
			: [
					`export const c${index} = scored.approximateNearest({`,
					'\tby: "d",',
					...directive,
					`\ttake: ${boundText(c, index)}`,
					"})"
				]
	return [
		`// ${c.site}, its bound ${jsonText(c.spelling)}`,
		...declarationOf(c, index),
		...call,
		""
	]
}

/** The program's prelude (test/support/programs/take.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/take.ts"))

/** The schema and the queries every cell bounds, the batch's own. */
const takeHeader = `export const Point = relation("Point", { id: Id, n: pg.integer, at: pg.vector(3) }, ["id"])
export const Points = schema("Points", [Point], [])
export const origin = Vector.make(Float32Array.from([1, 0, 0]), 3)
export const scored = query(Points).rule((r) => {
	const { id, n, at } = v(Point, "point")
	return r.match(Point, { id, n, at }).find({ id, n, d: Distance.cosine(at, origin) })
})
export const ordered = scored.orderBy(["n", "asc"])
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const takeProgram = (cells: Arr.NonEmptyReadonlyArray<TakeCell>, entry: Entry): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/query/take.ts: the bounds a query takes its rows by, by every spelling of the bound.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(takeHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(c, at) }))
		]
	)
]
