import { Array as Arr, Option } from "effect"
import { indices } from "#compiler/core/array.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { BudgetEntries } from "#test/types/query/budget/generate.ts"

/**
 * The family-scale program, one type test of families, trees, folds and nested additions at scale
 * (test/types/schema/budget/families.test.ts). It writes one TypeScript program over the public barrels with
 * `families` families and as many folds, all in one schema(...) call, in units of two families and two folds each:
 *
 * - a **nested** unit: an owner O with an ordered family of lines F over its drawn count n, each line itself the owner
 *   of an ordered family of parts G over its drawn count m (nesting depth 2), and a sum fold at each level, into an
 *   accumulated end of the owner above;
 * - every fourth unit, a **tree** unit: a tree T over its drawn children, start and end, with its root field doc and a
 *   count fold of each node's children, beside a counted family of items I in a pool P (an unordered set of member
 *   rows) with a count fold, flat: rows first (rows-first.md §1), the pool and its items are each inserted as rows, an
 *   item's group key naming its pool.
 *
 * The program asserts the additions at the first and the last unit of each kind (an owner's addition nests its lines
 * at n and each line's parts at m, each less its group; a tree's addition names no parent and its rows below the root
 * no root field, through two levels; a pool's and an item's additions are their written rows), inserts the last of each
 * kind, and keeps the refusals that must fire at scale, each held by its `@ts-expect-error` directive (an unused
 * directive is a diagnostic of its own, TS2578): an ordered member is written under its owner, never alone, and a
 * counted member is never nested under its owner.
 *
 * A nested addition is indexed by mapping over the owner's families (types/changeset/changeset.ts AdditionIn), never
 * by a count field's name: an index by name failed with TS2859 at 1,000 families (U1's budget proof, 2026-11-05).
 */

/** The family counts the scale test checks, each a program of its own: linearity is read from their instantiations. */
export const familySizes = [500, 1000, 2000] as const

/** Whether unit u is a tree unit: every fourth, from the fourth, so the first and last units of each kind exist. */
const isTreeUnit = (u: number): boolean => u % 4 === 3

const nestedUnit = (
	u: number
): string => `export const O${u} = relation("O${u}", { id: uuid, n: drawn(natural), total: accumulated(pg.bigint, 0n) }, ["id"])
export const F${u} = relation("F${u}", { owner: uuid, at: drawn(natural), m: drawn(natural), x: pg.bigint, parts: accumulated(pg.bigint, 0n) }, ["owner", "at"])
export const G${u} = relation("G${u}", { owner: uuid, line: natural, at: drawn(natural), y: pg.bigint }, ["owner", "line", "at"])
export const lines${u} = ordered(on(F${u}, "owner", "at"), fin(O${u}, "n"))
export const parts${u} = ordered(on(G${u}, "owner", "line", "at"), fin(F${u}, "m"))
export const lineSum${u} = fold(lines${u}, Monoid.sum, on(F${u}, "owner", "x"), on(O${u}, "id", "total"))
export const partSum${u} = fold(parts${u}, Monoid.sum, on(G${u}, "owner", "line", "y"), on(F${u}, "owner", "at", "parts"))
`

const treeUnit = (
	u: number
): string => `export const T${u} = relation("T${u}", { id: uuid, parent: uuid, at: drawn(natural), children: drawn(natural), start: drawn(natural), end: drawn(natural), doc: uuid, size: accumulated(natural, 0n) }, ["id"])
export const P${u} = relation("P${u}", { id: uuid, k: drawn(natural), size: accumulated(natural, 0n) }, ["id"])
export const I${u} = relation("I${u}", { pool: uuid, v: pg.integer }, ["pool", "v"])
export const nodes${u} = tree(on(T${u}, "parent", "at"), fin(T${u}, "children"), { root: "doc" })
export const nodeCount${u} = fold(nodes${u}, Monoid.count, on(T${u}, "parent"), on(T${u}, "id", "size"))
export const items${u} = counted(on(I${u}, "pool"), fin(P${u}, "k"))
export const itemCount${u} = fold(items${u}, Monoid.count, on(I${u}, "pool"), on(P${u}, "id", "size"))
`

/** A unit's relations, in declaration order. */
const relationsOf = (u: number): ReadonlyArray<string> =>
	isTreeUnit(u) ? [`T${u}`, `P${u}`, `I${u}`] : [`O${u}`, `F${u}`, `G${u}`]

/** A unit's statements: its two families and its two folds. */
const statementsOf = (u: number): ReadonlyArray<string> =>
	isTreeUnit(u)
		? [`nodes${u}`, `nodeCount${u}`, `items${u}`, `itemCount${u}`]
		: [`lines${u}`, `parts${u}`, `lineSum${u}`, `partSum${u}`]

const nestedAssertions = (
	u: number
): string => `export type Lines${u} = Expect<Equals<keyof AdditionIn<typeof S, typeof O${u}>, "id" | "n">>
export type Line${u} = Expect<Equals<keyof AdditionIn<typeof S, typeof O${u}>["n"][number], "x" | "m">>
export type Part${u} = Expect<Equals<keyof AdditionIn<typeof S, typeof O${u}>["n"][number]["m"][number], "y">>
`

const treeAssertions = (
	u: number
): string => `export type Root${u} = Expect<Equals<keyof AdditionIn<typeof S, typeof T${u}>, "id" | "doc" | "children">>
export type Child${u} = Expect<Equals<keyof AdditionIn<typeof S, typeof T${u}>["children"][number], "id" | "children">>
export type Grandchild${u} = Expect<Equals<keyof AdditionIn<typeof S, typeof T${u}>["children"][number]["children"][number], "id" | "children">>
export type Pool${u} = Expect<Equals<keyof AdditionIn<typeof S, typeof P${u}>, "id">>
export type Item${u} = Expect<Equals<keyof AdditionIn<typeof S, typeof I${u}>, "pool" | "v">>
`

/**
 * A complete program of `families` families (an even count, two per unit) and as many folds, importing the schema,
 * fields, ChangeSet and ChangeSet-types barrels from `entries`.
 */
export const generateFamiliesSource = (families: number, entries: BudgetEntries): string => {
	const units = indices(Math.floor(families / 2))
	const nested = Arr.filter(units, (u) => !isTreeUnit(u))
	const trees = Arr.filter(units, isTreeUnit)
	const ends = (list: ReadonlyArray<number>): ReadonlyArray<number> =>
		Arr.dedupe(Arr.getSomes([Arr.head(list), Arr.last(list)]))
	const lastNested = Arr.last(nested)
	const lastTree = Arr.last(trees)
	if (Option.isNone(lastNested) || Option.isNone(lastTree)) {
		throw new Error(
			`a family-scale program of ${families} families holds a nested unit and a tree unit`
		)
	}
	return `// Generated by test/types/schema/budget/families.ts with ${families} families and ${families} folds.
import { ChangeSet } from ${jsonText(entries.changeset)}
import { accumulated, drawn, natural, pg, type Uuid, uuid } from ${jsonText(entries.fields)}
import { counted, fin, fold, Monoid, on, ordered, relation, schema, tree } from ${jsonText(entries.schema)}
import type { AdditionIn } from ${jsonText(entries.changesetTypes)}

type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

${Arr.join(
	Arr.map(units, (u) => (isTreeUnit(u) ? treeUnit(u) : nestedUnit(u))),
	""
)}
export const S = schema("FamilyScale", { ${Arr.join(Arr.flatMap(units, relationsOf), ", ")} }, [
${Arr.join(
	Arr.map(Arr.flatMap(units, statementsOf), (s) => `\t${s}`),
	",\n"
)}
])

${Arr.join(Arr.map(ends(nested), nestedAssertions), "")}${Arr.join(Arr.map(ends(trees), treeAssertions), "")}
declare const id: Uuid

/** The last sequence owner of each kind inserted with its members nested, two levels deep; the last pool flat. */
export const nestedWrites = ChangeSet.empty(S)
	.insert(O${lastNested.value}, [{ id, n: [{ x: 1n, m: [{ y: 2n }, { y: 3n }] }, { x: 4n, m: [] }] }])
	.insert(T${lastTree.value}, [{ id, doc: id, children: [{ id, children: [{ id, children: [] }] }] }])
	.insert(P${lastTree.value}, [{ id }])
	.insert(I${lastTree.value}, [{ pool: id, v: 1 }, { pool: id, v: 2 }])

/** The refusals that must keep firing at scale. */
export const memberAlone = ChangeSet.empty(S).insert(
	// @ts-expect-error -- TS2345 refusal: a sequence's member is written under its owner: nest it in order at the owner's count field
	F${lastNested.value},
	[{ owner: id, x: 1n, m: [] }]
)
export const countedNested = ChangeSet.empty(S).insert(
	P${lastTree.value},
	// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
	[{ id, k: [{ v: 1 }] }]
)
`
}
