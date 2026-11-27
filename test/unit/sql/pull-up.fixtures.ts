/**
 * What the property of pull-up.test.ts reads: drawn readers of one or two FROM items, each a table, a simple
 * sub-query (plain, filtered by a WHERE of its own, of a computed target, reading a simple sub-query in turn, or reading
 * one that only a second round flattens) or a sub-query PostgreSQL keeps as one, or the printer keeps, for one reason
 * each (an aggregate, a set-returning or a VOLATILE target, an ORDER BY, DISTINCT, a GROUP BY, LATERAL, a placeholder no
 * reference reads); a reader's WHERE, ORDER BY (of its first item's two columns, so it reads the first column again, as
 * the WHERE does) and a reference reading a column name unqualified, each drawn; the
 * statement a shape builds, a reader whose item reads the outer relation o standing LATERAL beside it; and the
 * statement print pulled up must print of it, built a second way: each simple sub-query flattened into its reader by
 * hand. A reader reading a column unqualified reads a name nothing binds in a query, which the printer refuses at the
 * statement as built (sql/scope.ts assertScoped, 962f3a9fd4), so it has no printed form.
 */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { array, boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import type {
	Expr,
	FromItem,
	OperandSelect,
	QualifiedFunctionRef,
	Select,
	Target
} from "#compiler/sql/ast.ts"
import {
	asc,
	binary,
	call,
	col,
	conjunction,
	core,
	derived,
	distinctCore,
	eq,
	grouped,
	lit,
	operandSelect,
	param,
	provedCore,
	qualifiedCall,
	select,
	table,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"

/** What a FROM item of a drawn reader is (the module header). */
const itemKinds = [
	"table",
	"plain",
	"filtered",
	"computed",
	"nested",
	"rounds",
	"aggregate",
	"setReturning",
	"volatile",
	"ordered",
	"distinct",
	"grouped",
	"lateral",
	"unreadParam",
	"aggregatedOwn",
	"aggregatedOuter",
	"keptOverBare"
] as const

export type ItemKind = (typeof itemKinds)[number]

/** A drawn reader: its FROM items, and whether it has a WHERE, an ORDER BY and an unqualified reference. */
export interface ReaderShape {
	readonly items: ReadonlyArray<ItemKind>
	readonly where: boolean
	readonly ordered: boolean
	readonly unqualified: boolean
}

export const readerGen: Gen<ReaderShape> = (source) => ({
	items: source.draw(array(element(itemKinds), { min: 1, max: 2 })),
	where: source.draw(boolean),
	ordered: source.draw(boolean),
	unqualified: source.draw(boolean)
})

/** What a case reaches: a sub-query flattened, a chain, rounds, a WHERE and an ORDER BY read through, each reason kept. */
export const pullUpFeatures = [
	"a sub-query flattened",
	"a chain of sub-queries flattened",
	"a sub-query flattened in a second round",
	"a sub-query's WHERE conjoined",
	"a computed target substituted",
	"a reader's ORDER BY read through a flattened sub-query",
	"a sub-query kept for a computed target read twice",
	"a computed target its reader's ORDER BY reads again, kept",
	"a sub-query kept for a placeholder no reference reads",
	"a sub-query kept for an aggregate",
	"a sub-query kept for a set-returning call",
	"a sub-query kept for a VOLATILE call",
	"a sub-query kept for its ORDER BY",
	"a sub-query kept for DISTINCT",
	"a sub-query kept for GROUP BY",
	"a LATERAL sub-query kept",
	"a reader naming a column unqualified, refused for its scope",
	"a target of the sub-query's own columns an aggregate reads substituted",
	"a sub-query kept for a correlated target an aggregate reads",
	"a kept sub-query's bare targets keeping their names over a flattened one"
] as const

export type PullUpFeature = (typeof pullUpFeatures)[number]

/** A VOLATILE function of pg_catalog, as a reference to it declares it. */
const random: QualifiedFunctionRef = {
	kind: "qualified",
	schema: "pg_catalog",
	name: "random",
	volatility: "VOLATILE"
}

const aliasOf = (i: number): string => `r${200 + i}`
const innerOf = (i: number): string => `t${200 + i}`
const nestedOf = (i: number): string => `n${200 + i}`

/**
 * A sub-query's targets named c0, c1 and on in order, the columns its reader reads it by (sql/ast.ts selectColumns):
 * c0 and c1, and c2 where its third target is one no reference reads.
 */
const named = (targets: NonEmptyReadonlyArray<Target>): NonEmptyReadonlyArray<Target> =>
	Arr.map(targets, (t, k) => targetAs(t.expr, `c${k}`))

/** The table item `i` reads, under `alias`: s.T<i>, of columns x and y. */
const tableOf = (i: number, alias: string): FromItem => table("s", `T${i}`, alias)

const one = lit.int(1, types.integer)

/** x + 1 over item `i`'s table: a computed target. */
const xPlusOne = (i: number): Expr => binary("+", col(innerOf(i), "x"), one)

/** The targets of item `i`'s sub-query over its table, by kind: x and y, a computed one or a call in their place. */
const innerTargets = (kind: ItemKind, i: number): NonEmptyReadonlyArray<Target> => {
	const x = col(innerOf(i), "x")
	const y = col(innerOf(i), "y")
	switch (kind) {
		case "computed":
			return [target(xPlusOne(i)), target(y)]
		case "aggregate":
			return [target(call("max", [x])), target(call("max", [y]))]
		case "setReturning":
			return [target(x), target(call("unnest", [y]))]
		case "volatile":
			return [target(x), target(qualifiedCall(random, []))]
		case "unreadParam":
			return [target(x), target(y), target(param(1, types.integer))]
		case "aggregatedOuter":
			return [target(x), target(col("o", "z"))]
		case "aggregatedOwn":
		case "keptOverBare":
		case "table":
		case "plain":
		case "filtered":
		case "nested":
		case "rounds":
		case "ordered":
		case "distinct":
		case "grouped":
		case "lateral":
			return [target(x), target(y)]
	}
}

/** Item `i`'s own WHERE: a filtered sub-query's. */
const innerWhere = (kind: ItemKind, i: number): Expr | undefined =>
	kind === "filtered" ? eq(col(innerOf(i), "x"), one) : undefined

/**
 * The sub-query a `rounds` item reads: x + 1 and y over its table, its computed c0 read twice by the item, so it is
 * kept inside the item and flattened only once the item, flattened into the reader, leaves it read once there.
 */
const roundsInner = (i: number): FromItem =>
	derived(
		operandSelect(
			core(
				named([target(xPlusOne(i)), target(col(innerOf(i), "y"))]),
				[tableOf(i, innerOf(i))],
				undefined
			)
		),
		nestedOf(i),
		false
	)

/** Item `i`'s sub-query of `kind` over its table (the module header), as the case builds it. */
const queryOf = (kind: ItemKind, i: number): OperandSelect => {
	const targets = named(innerTargets(kind, i))
	const from = [tableOf(i, innerOf(i))]
	const where = innerWhere(kind, i)
	const n = nestedOf(i)
	switch (kind) {
		case "nested":
			return operandSelect(
				core(
					named([target(col(n, "c0")), target(col(n, "c1"))]),
					[derived(operandSelect(core(targets, from, where)), n, false)],
					undefined
				)
			)
		case "rounds":
			return operandSelect(
				core(
					named([target(col(n, "c0")), target(col(n, "c1")), target(col(n, "c0"))]),
					[roundsInner(i)],
					undefined
				)
			)
		case "keptOverBare":
			return operandSelect(
				distinctCore(
					[target(col(n, "c0")), target(col(n, "c1"))],
					[derived(operandSelect(core(targets, from, where)), n, false)],
					undefined
				)
			)
		case "ordered":
			return { ...operandSelect(core(targets, from, where)), orderBy: [asc(col(innerOf(i), "x"))] }
		case "distinct":
			return operandSelect(distinctCore(targets, from, where))
		case "grouped":
			return operandSelect(
				grouped(core(targets, from, where), [col(innerOf(i), "x"), col(innerOf(i), "y")])
			)
		case "table":
		case "plain":
		case "filtered":
		case "computed":
		case "aggregate":
		case "setReturning":
		case "volatile":
		case "lateral":
		case "unreadParam":
		case "aggregatedOwn":
		case "aggregatedOuter":
			return operandSelect(core(targets, from, where))
	}
}

/** Item `i` of `kind` as the case builds it. */
const itemOf = (kind: ItemKind, i: number): FromItem =>
	kind === "table"
		? tableOf(i, aliasOf(i))
		: derived(queryOf(kind, i), aliasOf(i), kind === "lateral")

/**
 * The reader's reference to column `k` of item `i`: a table's x or y, a sub-query's c0 or c1, and an aggregated item's
 * c1 read by max, the reader's aggregate over it.
 */
const readOf = (kind: ItemKind, i: number, k: 0 | 1): Expr => {
	const column = col(aliasOf(i), kind === "table" ? (k === 0 ? "x" : "y") : k === 0 ? "c0" : "c1")
	return aggregates(kind) && k === 1 ? call("max", [column]) : column
}

/** Whether the reader reads an item's c1 by an aggregate: an aggregated item, its target its own column or an outer one. */
const aggregates = (kind: ItemKind): boolean =>
	kind === "aggregatedOwn" || kind === "aggregatedOuter"

/** What an item becomes in its reader: its FROM items, its WHERE's conjuncts, and what a reference to column `k` reads. */
interface Flat {
	readonly from: ReadonlyArray<FromItem>
	readonly wheres: ReadonlyArray<Expr>
	readonly read: (k: 0 | 1) => Expr
}

/**
 * Whether the reader reads column c0 of item `i` twice: the first item's, where the reader has a WHERE or an ORDER BY,
 * each reading it beside the reader's target. A query's ORDER BY reads its core's FROM list as the core does, so a
 * target it reads again is read twice: one the printer counted by the core's references alone was substituted at both,
 * a placeholder printed twice (found by test/pg/sql/fold against a twin no pull-up reads through).
 */
const readsTwice = (shape: ReaderShape, i: number): boolean =>
	i === 0 && (shape.where || shape.ordered)

/**
 * What item `i` of `kind` becomes in a reader of `shape` (the oracle's model): flattened where PostgreSQL pulls it up
 * and the printer can keep the reader's text, its table in its place and its targets read in place of its columns; a
 * `rounds` item's inner sub-query flattened too, in a second round, unless the reader reads its computed column twice.
 */
const flatOf = (shape: ReaderShape, kind: ItemKind, i: number): Flat => {
	const kept: Flat = { from: [itemOf(kind, i)], wheres: [], read: (k) => readOf(kind, i, k) }
	const intoTable = (read: (k: 0 | 1) => Expr): Flat => {
		const where = innerWhere(kind, i)
		return { from: [tableOf(i, innerOf(i))], wheres: where === undefined ? [] : [where], read }
	}
	const columnRead = (k: 0 | 1): Expr => col(innerOf(i), k === 0 ? "x" : "y")
	const aggregatedRead = (k: 0 | 1): Expr =>
		k === 0 ? col(innerOf(i), "x") : call("max", [col(innerOf(i), "y")])
	const computedRead = (k: 0 | 1): Expr => (k === 0 ? xPlusOne(i) : col(innerOf(i), "y"))
	switch (kind) {
		case "plain":
		case "filtered":
		case "nested":
			return intoTable(columnRead)
		case "aggregatedOwn":
			return intoTable(aggregatedRead)
		case "keptOverBare":
			return {
				from: [
					derived(
						operandSelect(
							distinctCore(
								[targetAs(col(innerOf(i), "x"), "c0"), targetAs(col(innerOf(i), "y"), "c1")],
								[tableOf(i, innerOf(i))],
								undefined
							)
						),
						aliasOf(i),
						false
					)
				],
				wheres: [],
				read: (k) => readOf(kind, i, k)
			}
		case "computed":
			return readsTwice(shape, i) ? kept : intoTable(computedRead)
		case "rounds":
			return readsTwice(shape, i)
				? {
						from: [roundsInner(i)],
						wheres: [],
						read: (k) => col(nestedOf(i), k === 0 ? "c0" : "c1")
					}
				: intoTable(computedRead)
		case "table":
		case "aggregate":
		case "setReturning":
		case "volatile":
		case "ordered":
		case "distinct":
		case "grouped":
		case "lateral":
		case "unreadParam":
		case "aggregatedOuter":
			return kept
	}
}

/** The reader of `shape` over its items as `flat` makes them, its WHERE after theirs. */
const readerOf = (shape: ReaderShape, flat: (kind: ItemKind, i: number) => Flat): Select => {
	const items = Arr.map(shape.items, (kind, i) => flat(kind, i))
	const first = items[0]
	const targets = [
		...Arr.flatMap(items, (item, i) => [
			targetAs(item.read(0), `o${i}a`),
			targetAs(item.read(1), `o${i}b`)
		]),
		...(shape.unqualified
			? [targetAs({ kind: "column", table: undefined, column: "c0" }, "u")]
			: [])
	]
	const where = conjunction([
		...Arr.flatMap(items, (item) => item.wheres),
		...(shape.where && first !== undefined ? [eq(first.read(0), lit.int(2, types.integer))] : [])
	])
	return {
		...select(
			provedCore(
				"certified",
				targets,
				Arr.flatMap(items, (item) => item.from),
				where
			)
		),
		orderBy: shape.ordered && first !== undefined ? [asc(first.read(0)), asc(first.read(1))] : []
	}
}

/**
 * The statement of `reader`, a reader of `shape`: itself, or, where an item's correlated target reads the outer relation
 * o, the reader as a LATERAL derived table w beside s.O AS o, delivering each of its columns, as a lowering's LATERAL
 * aggregate stands beside the rows it is correlated with: a name the statement binds nowhere is refused by the printer
 * (sql/scope.ts assertScoped, 962f3a9fd4).
 */
const statementOf = (shape: ReaderShape, reader: Select): Select => {
	if (!Arr.contains(shape.items, "aggregatedOuter")) {
		return reader
	}
	const names = Arr.flatMap(shape.items, (_, i) => [`o${i}a`, `o${i}b`])
	return select(
		provedCore(
			"certified",
			Arr.map(names, (n) => targetAs(col("w", n), n)),
			[table("s", "O", "o"), derived(reader, "w", true)],
			undefined
		)
	)
}

/** The statement a shape builds. */
export const readerStatementOf = (shape: ReaderShape): Select =>
	statementOf(
		shape,
		readerOf(shape, (kind, i) => ({
			from: [itemOf(kind, i)],
			wheres: [],
			read: (k) => readOf(kind, i, k)
		}))
	)

/**
 * The statement print pulled up prints of a shape, built by hand: each item it flattens its table in its place, its
 * WHERE before the reader's, and each reference to its columns its target; every other item as the case built it.
 */
export const flattenedByHand = (shape: ReaderShape): Select =>
	statementOf(
		shape,
		readerOf(shape, (kind, i) => flatOf(shape, kind, i))
	)

/**
 * Whether `error` is the printer's refusal of a reader's unqualified reference: a column named unqualified in a query
 * reads a name nothing binds there, an internal compiler error the printer raises at the statement as the lowering
 * built it (sql/scope.ts assertScoped, 962f3a9fd4), before it prints anything flattened.
 */
export const refusesUnqualified = (error: unknown): boolean =>
	Error.isError(error) &&
	Str.includes("print scope: ")(error.message) &&
	Str.includes('the column "c0"')(error.message) &&
	Str.includes("unqualified in a query")(error.message)

/**
 * Whether a shape holds a sub-query print pulled up flattens, which the invariant refuses printed as one: a plain,
 * filtered, nested or rounds item, whose sub-query reads its columns' targets once or as columns, or a computed one
 * read once.
 */
export const holdsFlattenable = (shape: ReaderShape): boolean =>
	Arr.some(
		shape.items,
		(kind, i) =>
			kind === "plain" ||
			kind === "filtered" ||
			kind === "nested" ||
			kind === "rounds" ||
			kind === "aggregatedOwn" ||
			kind === "keptOverBare" ||
			(kind === "computed" && !readsTwice(shape, i))
	)

/** The features a shape reaches. */
export const readerFeaturesOf = (shape: ReaderShape): ReadonlyArray<PullUpFeature> => {
	const keptFor: { readonly [K in ItemKind]?: PullUpFeature } = {
		aggregate: "a sub-query kept for an aggregate",
		setReturning: "a sub-query kept for a set-returning call",
		volatile: "a sub-query kept for a VOLATILE call",
		ordered: "a sub-query kept for its ORDER BY",
		distinct: "a sub-query kept for DISTINCT",
		grouped: "a sub-query kept for GROUP BY",
		lateral: "a LATERAL sub-query kept",
		unreadParam: "a sub-query kept for a placeholder no reference reads",
		aggregatedOuter: "a sub-query kept for a correlated target an aggregate reads",
		aggregatedOwn: "a target of the sub-query's own columns an aggregate reads substituted",
		keptOverBare: "a kept sub-query's bare targets keeping their names over a flattened one"
	}
	const flatOne = (kind: ItemKind): boolean =>
		kind === "plain" ||
		kind === "filtered" ||
		kind === "nested" ||
		kind === "computed" ||
		kind === "rounds" ||
		kind === "aggregatedOwn"
	return Arr.dedupe([
		...Arr.flatMap(shape.items, (kind, i): ReadonlyArray<PullUpFeature> => {
			if (shape.unqualified) {
				return ["a reader naming a column unqualified, refused for its scope"]
			}
			const twice = readsTwice(shape, i)
			return [
				...(flatOne(kind) && !(kind === "computed" && twice)
					? (["a sub-query flattened"] as const)
					: []),
				...(kind === "nested" ? (["a chain of sub-queries flattened"] as const) : []),
				...(kind === "rounds" && !twice
					? (["a sub-query flattened in a second round"] as const)
					: []),
				...(kind === "filtered" ? (["a sub-query's WHERE conjoined"] as const) : []),
				...((kind === "computed" || kind === "rounds") && !twice
					? (["a computed target substituted"] as const)
					: []),
				...(kind === "computed" && twice
					? (["a sub-query kept for a computed target read twice"] as const)
					: []),
				...((kind === "computed" || kind === "rounds") && twice && !shape.where
					? (["a computed target its reader's ORDER BY reads again, kept"] as const)
					: []),
				...(keptFor[kind] === undefined ? [] : [keptFor[kind]])
			]
		}),
		...(shape.ordered &&
		!shape.unqualified &&
		flatOne(shape.items[0] ?? "table") &&
		shape.items[0] !== "computed"
			? (["a reader's ORDER BY read through a flattened sub-query"] as const)
			: [])
	])
}
