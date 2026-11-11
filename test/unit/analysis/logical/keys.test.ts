/**
 * Keys the logical analysis proves, each property's own documentation beside its search:
 *
 * - Minimal keys (logical/closure.ts minimalKeys): from the whole heading alone, closed under the exchange of a
 *   dependency's determined columns for its determinants, every minimal key of a drawn dependency table is found.
 *   Oracle: every column set's closure by brute force. Plant: minimal-keys-no-exchange (no exchange after the
 *   heading's minimization).
 * - Class keys (logical/props.ts finish): k classes of equal columns are one key, its members every other column of
 *   each class, not 2^k keys. Oracle: the classes the filter states, as a specification. Plant: classes-ignored (every
 *   column its own class).
 * - Union class keys (logical/props.ts unionProps): two columns equal in every arm are equal in the union, and a key
 *   of the union is closed under them. Oracle: each arm's partition, intersected. Plant: union-equal-first-arm-alone
 *   (two columns the first arm makes equal are the union's equal columns).
 * - Forged union equalities (test/support/keys/kernel.ts): the key kernel accepts an arms witness only when each
 *   arm's derivation steps by equalities alone. Oracle: that rule. Plant: kernel-arms-unchained (the kernel reads an
 *   arms witness's implications and not its equality chain).
 *
 * Plants are patches in ~/.cache/grizzle-release/BR03/plants. Features: one or several minimal keys and a key of
 * several columns; each class shape and projection; each arm's copies and equalities; each forged mapping.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept, sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, constant, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	type Dependency,
	equalColumns,
	implication,
	keyIn,
	type KeyProof,
	projectionCloses
} from "#compiler/ir/keys.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { analyzeLogical, checkerEvidence } from "#compiler/logical/annotate.ts"
import { minimalKeys } from "#compiler/logical/closure.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { Ir } from "#test/support/fixtures/ir/build.ts"
import { workModel } from "#test/support/fixtures/ir/work.ts"
import { KeyKernel } from "#test/support/keys/kernel.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * The minimal keys a dependency table proves (logical/closure.ts minimalKeys): from the whole heading alone, closed
 * under the exchange of a dependency's determined columns for its determinants, every minimal key of the table is found,
 * with no bound.
 *
 * Each case draws a table of dependencies over at most six columns. The oracle enumerates every column set, computes
 * its closure under the dependencies by brute force, and keeps the sets that determine the heading and have no proper
 * subset that does: the table's minimal keys, ordered as minimalKeys orders them (by size, then heading position).
 * minimalKeys over the whole heading returns exactly those keys. A greedy minimization alone finds one key per
 * candidate, and misses every key no candidate minimizes to: a table where b determines a and a determines the rest has
 * the keys {a} and {b}, and minimizing the heading from its end gives only {a}; the exchange finds the other.
 */

/** A drawn table: its column count, and each dependency as the masks of its determinants and its determined columns. */
interface Table {
	readonly width: number
	readonly dependencies: ReadonlyArray<{ readonly from: number; readonly to: number }>
}

/** At most six columns, so the oracle's 64 column sets are few; at most six dependencies, enough for several keys. */
const tableGen: Gen<Table> = (source) => {
	const width = source.draw(int(1, 6))
	return {
		width,
		dependencies: source.draw(
			array(
				(dependency) => ({
					from: dependency.draw(int(0, 2 ** width - 1)),
					to: dependency.draw(int(1, 2 ** width - 1))
				}),
				{ min: 0, max: 6 }
			)
		)
	}
}

/**
 * Planted: c3 -> {c0, c1, c2}, {c0, c1} -> {c2, c3}, c2 -> {c0, c1, c3}. The heading minimizes to {c0, c1}; only the
 * exchange then finds {c2} and {c3}, smaller.
 */
const exchangeOnly: Kept<Table, KeysFeature> = {
	note: "the exchange missed a key the heading does not minimize to",
	sketch: {
		width: 4,
		dependencies: [
			{ from: 0b1000, to: 0b0111 },
			{ from: 0b0011, to: 0b1100 },
			{ from: 0b0100, to: 0b1011 }
		]
	},
	draws: "",
	reaches: ["several minimal keys"]
}

type KeysFeature = "one minimal key" | "several minimal keys" | "a minimal key of several columns"

describe("minimal keys", () => {
	it.effect("are exactly the table's minimal keys, every one found from the whole heading", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "every column set's closure by brute force, the sets that determine the heading with no proper subset that does"
					},
					suite: "unit/analysis/logical/minimal-keys",
					draw: drawn(tableGen),
					literal: Formatter.format,
					coverage: required<KeysFeature>(
						["one minimal key", "several minimal keys", "a minimal key of several columns"],
						{ cases: 500, sense: notesOnly }
					),
					kept: [exchangeOnly],
					runs: 500,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(table, c) =>
					Effect.sync(() => {
						const columns = Arr.map(indices(table.width), (i) => `c${i}`)
						const of = (mask: number) =>
							Arr.flatMap([...columns.entries()], ([i, column]) =>
								(mask & (1 << i)) !== 0 ? [column] : []
							)
						const dependencies = Arr.map(table.dependencies, (d) => ({
							from: of(d.from),
							to: of(d.to)
						}))
						/** The closure of a column set: every column a chain of dependencies reaches from it. */
						const closure = (start: ReadonlyArray<string>): ReadonlySet<string> => {
							const known = new Set(start)
							let changed = true
							while (changed) {
								changed = false
								for (const d of dependencies) {
									if (Arr.every(d.from, (x) => known.has(x))) {
										for (const x of d.to) {
											if (!known.has(x)) {
												known.add(x)
												changed = true
											}
										}
									}
								}
							}
							return known
						}
						const isKey = (set: ReadonlyArray<string>) => closure(set).size === columns.length
						const keyMasks = Arr.filter([...indices(2 ** table.width)], (mask) => isKey(of(mask)))
						/** A key with no proper subset a key, ordered by size and then heading position. */
						const keyOrder = Order.combine(
							Order.mapInput(Order.Number, (key: ReadonlyArray<string>) => key.length),
							Arr.makeOrder(
								Order.mapInput(Order.Number, (column: string) => columns.indexOf(column))
							)
						)
						const oracle = Arr.sort(
							Arr.map(
								Arr.filter(
									keyMasks,
									(mask) =>
										!Arr.some(keyMasks, (other) => other !== mask && (other & mask) === other)
								),
								of
							),
							keyOrder
						)
						c.note(oracle.length > 1 ? "several minimal keys" : "one minimal key")
						if (Arr.some(oracle, (key) => key.length > 1)) {
							c.note("a minimal key of several columns")
						}
						const exchange = Arr.map(dependencies, (d) => ({ from: d.from, to: new Set(d.to) }))
						assert.deepEqual(
							Arr.map(
								minimalKeys(columns, [columns], (cs) => (isKey(cs) ? true : undefined), exchange),
								(k) => k.key
							),
							oracle
						)
					})
			)
		)
	)
})

/**
 * Keys over classes of equal columns (logical/props.ts finish): k pairs of equal columns are one key, not 2^k.
 *
 * Each case draws a heading of classes of one to three columns, k of them of several, in a drawn column order, as the
 * rows of a relation parameter, which only its whole heading keys; a filter states each class's columns equal,
 * chained in declaration order; and a projection may keep a subset of the columns, one at least of each class. Every
 * choice of a column per class is a minimal key, so the product of the class sizes, 2^k for k pairs. The analysis
 * proves exactly one key at the filter and at the projection: the first column of each class in heading order, its
 * members every other column of its classes, each proof one the key kernel accepts. So the number of keys is one,
 * polynomial in the heading, where listing every minimal key would be exponential in it.
 */

/**
 * A drawn heading: each class's size, a position key per column ordering the heading, and the columns a projection
 * keeps.
 */
interface Classed {
	readonly sizes: ReadonlyArray<number>
	readonly positions: ReadonlyArray<number>
	/** Per column, whether the projection keeps it beyond the one column of each class it always keeps. */
	readonly kept: ReadonlyArray<boolean>
	readonly projected: boolean
}

const classedGen: Gen<Classed> = (source) => {
	const sizes = source.draw(array(int(1, 3), { min: 1, max: 12 }))
	const width = Arr.reduce(sizes, 0, (n, size) => n + size)
	return {
		sizes,
		positions: source.draw(array(int(0, 2 ** 31 - 1), { min: width, max: width })),
		kept: source.draw(array(boolean, { min: width, max: width })),
		projected: source.draw(boolean)
	}
}

type ClassFeature =
	| "eight or more classes of several columns"
	| "a class of three columns"
	| "a column of no other's class"
	| "a projection dropping a class's first column"

const int4 = plainType("int4")

describe("keys over classes of equal columns", () => {
	it.effect(
		"are one key for k pairs of equal columns, never 2^k: each class's first column, the others its members",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "one key, each class's first column in heading order, its members every other column of its class"
						},
						suite: "unit/analysis/logical/class-keys",
						draw: drawn(classedGen),
						literal: Formatter.format,
						coverage: required<ClassFeature>(
							[
								"eight or more classes of several columns",
								"a class of three columns",
								"a column of no other's class",
								"a projection dropping a class's first column"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(drawnCase, c) =>
						Effect.sync(() => {
							/** Class i's columns c<i>_<j>, in the order the filter chains them. */
							const classes = Arr.map(drawnCase.sizes, (size, i) =>
								Arr.map(indices(size), (j) => `c${i}_${j}`)
							)
							const declared = Arr.flatten(classes)
							const position = (column: string) =>
								defined(drawnCase.positions[declared.indexOf(column)], "a column's position")
							const heading = Arr.sort(
								declared,
								Order.combine(
									Order.mapInput(Order.Number, position),
									Order.mapInput(Order.Number, (column: string) => declared.indexOf(column))
								)
							)
							const several = Arr.filter(classes, (members) => members.length > 1)
							if (several.length >= 8) {
								c.note("eight or more classes of several columns")
							}
							if (Arr.some(classes, (members) => members.length === 3)) {
								c.note("a class of three columns")
							}
							if (Arr.some(classes, (members) => members.length === 1)) {
								c.note("a column of no other's class")
							}
							const q = new Ir(workModel())
							const rows = q.input(
								"rows",
								Arr.map(heading, (column) => [column, int4] as const)
							)
							const equalities = Arr.flatMap(several, (members) =>
								Arr.map(Arr.zip(members, Arr.drop(members, 1)), ([x, y]) =>
									q.eq(q.col(rows, x), q.col(rows, y))
								)
							)
							const [firstEquality, ...laterEqualities] = equalities
							const pred =
								firstEquality === undefined
									? undefined
									: Arr.reduce(laterEqualities, firstEquality, (all: ScalarExpr, e) =>
											q.op("and", [all, e])
										)
							const filtered = pred === undefined ? rows : q.filter(rows, pred)
							/** The projection keeps the columns drawn kept, and each class's first column in declaration order. */
							const keptColumns = Arr.filter(
								heading,
								(column) =>
									defined(drawnCase.kept[declared.indexOf(column)], "a column's kept draw") ||
									Arr.some(classes, (members) => members[0] === column)
							)
							const root = drawnCase.projected
								? q.project(
										filtered,
										Arr.map(keptColumns, (column) => [column, column] as const),
										conservativeMeta
									)
								: filtered
							const built = q.build(root)
							const analysis = succeeded(analyzeLogical(built.dag, checkerEvidence))
							const kernel = new KeyKernel(analysis.dag, {
								keyedViews: false
							})
							const check = (at: RelNode, columns: ReadonlyArray<string>) => {
								const { props } = analysis.of(at)
								/** Each class's columns the node has, in its heading order. */
								const present = Arr.filter(
									Arr.map(classes, (members) =>
										Arr.filter(columns, (column) => members.includes(column))
									),
									Arr.isReadonlyArrayNonEmpty
								)
								assert.equal(
									props.keys.length,
									1,
									`one key over ${present.length} classes of ${columns.length} columns, not ${Arr.reduce(present, 1, (n, members) => n * members.length)}`
								)
								const [key] = props.keys
								const proof = defined(key, "the one key")
								assert.deepEqual(
									proof.key,
									Arr.filter(columns, (column) =>
										Arr.some(present, (members) => members[0] === column)
									),
									"the key is each class's first column in heading order"
								)
								assert.deepEqual(
									Arr.sort(
										Arr.map(proof.members, (m) => `${m.of}->${m.column}`),
										Order.String
									),
									Arr.sort(
										Arr.flatMap(present, ([first, ...others]) =>
											Arr.map(others, (other) => `${first}->${other}`)
										),
										Order.String
									),
									"its members are every other column of its classes, each standing for its class's first"
								)
								assert.deepEqual(kernel.check(proof), [], "the key kernel accepts the proof")
							}
							check(filtered, heading)
							if (drawnCase.projected) {
								const dropsFirst = Arr.some(several, (members) =>
									Option.exists(
										Arr.findFirst(heading, (column) => members.includes(column)),
										(first) => !keptColumns.includes(first)
									)
								)
								if (dropsFirst) {
									c.note("a projection dropping a class's first column")
								}
								check(root, keptColumns)
							}
						})
				)
			)
	)
})

/**
 * A union's keys over the columns every arm makes equal (logical/props.ts unionProps): two columns equal in every row of
 * every arm are equal in every row of the union, so a key of the union is closed under them. With either column in the
 * key it is a key, as db.get reads one; and two columns some arm keeps apart stand for nothing.
 *
 * Each case draws two or three arms over the columns c0..c<w-1> and a column `tag` each arm fixes to its own literal,
 * which tells the arms apart. An arm reads a relation parameter of its own over those columns; its filter states drawn
 * pairs of them equal, and its projection outputs each column as a copy of its own input column or of an earlier one,
 * so two outputs copying one column are equal. The oracle partitions each arm's outputs by those copies and equalities
 * and intersects the arms' partitions. Every key the analysis proves of the union lists, for each of its columns,
 * exactly the other columns equal to it in every arm as its members; with any of them in its column's place it is a
 * key of the union, by its class (keyIn, which db.get reads) and by the union's own proof; and the key kernel accepts
 * every such proof. The kept case is the worlds model's: two rules each copying one variable into two head fields.
 */

/** A drawn arm: per column the input column its output copies, as an index wrapped below the column's own. */
interface UnionArm {
	readonly copies: ReadonlyArray<number>
	readonly equalities: ReadonlyArray<readonly [number, number]>
	/** Whether the arm groups its filtered rows by every column before it projects them. */
	readonly grouped: boolean
}

interface UnionCase {
	readonly width: number
	readonly arms: ReadonlyArray<UnionArm>
}

const unionCaseGen: Gen<UnionCase> = (source) => {
	const width = source.draw(int(2, 4))
	const column = int(0, width - 1)
	return {
		width,
		arms: source.draw(
			array(
				(arm): UnionArm => ({
					copies: arm.draw(array(column, { min: width, max: width })),
					equalities: arm.draw(
						array((pair) => [pair.draw(column), pair.draw(column)] as const, { min: 0, max: 3 })
					),
					grouped: arm.draw(boolean)
				}),
				{ min: 2, max: 3 }
			)
		)
	}
}

type UnionFeature =
	| "an equality every arm holds"
	| "an equality some arm lacks"
	| "an equality every arm holds by copying one column"
	| "an equality every arm holds by its filter"
	| "an equality every arm holds through its group"
	| "three arms"

/** The worlds model's case: each of two rules copies org into the head fields org and org_again. */
const copiedTwice: Kept<UnionCase, UnionFeature> = {
	note: "a get by a column every arm copies from a key column's variable was refused",
	draws: "",
	sketch: {
		width: 2,
		arms: [
			{ copies: [0, 0], equalities: [], grouped: false },
			{ copies: [0, 0], equalities: [], grouped: false }
		]
	},
	reaches: ["an equality every arm holds", "an equality every arm holds by copying one column"]
}

/** The partition of a heading's columns by equal pairs: each column's class, as its first column's index. */
const partition = (width: number, pairs: ReadonlyArray<readonly [number, number]>) => {
	const root = Arr.map(indices(width), (j) => j)
	const find = (j: number): number => {
		let at = j
		for (
			let up = defined(root[at], "a column's root");
			up !== at;
			up = defined(root[at], "a root")
		) {
			at = up
		}
		return at
	}
	for (const [x, y] of pairs) {
		root[find(y)] = find(x)
	}
	return find
}

describe("keys of a union", () => {
	it.effect("are closed under the columns every arm makes equal, and only those", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "each arm's outputs partitioned by their copies and equalities, the arms' partitions intersected"
					},
					suite: "unit/analysis/logical/union-class-keys",
					draw: drawn(unionCaseGen),
					literal: Formatter.format,
					kept: [copiedTwice],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang,
					coverage: required<UnionFeature>(
						[
							"an equality every arm holds",
							"an equality some arm lacks",
							"an equality every arm holds by copying one column",
							"an equality every arm holds by its filter",
							"an equality every arm holds through its group",
							"three arms"
						],
						{ cases: 300, sense: notesOnly }
					)
				},
				(drawnCase, c) =>
					Effect.sync(() => {
						const columns = Arr.map(indices(drawnCase.width), (j) => `c${j}`)
						const name = (j: number) => defined(columns[j], "a column")
						const q = new Ir(workModel())
						/** Per arm, the input column each output copies, and the classes of its outputs. */
						const arms = Arr.map(drawnCase.arms, (arm, i) => {
							const copyOf = (j: number) => defined(arm.copies[j], "a copy draw") % (j + 1)
							const pairs = Arr.filter(arm.equalities, ([x, y]) => x !== y)
							const inputClass = partition(drawnCase.width, pairs)
							const classOf = (j: number) => inputClass(copyOf(j))
							const rows = q.input(
								`rows${i}`,
								Arr.map(columns, (column) => [column, int4] as const)
							)
							const equalities = Arr.map(pairs, ([x, y]) =>
								q.eq(q.col(rows, name(x)), q.col(rows, name(y)))
							)
							const [firstEquality, ...laterEqualities] = equalities
							const filtered =
								firstEquality === undefined
									? rows
									: q.filter(
											rows,
											Arr.reduce(laterEqualities, firstEquality, (all: ScalarExpr, e) =>
												q.op("and", [all, e])
											)
										)
							const grouped = arm.grouped
								? q.group(filtered, columns, columns, [], conservativeMeta)
								: filtered
							const node = q.project(
								grouped,
								[
									["tag", q.lit(i, int4)],
									...Arr.map(indices(drawnCase.width), (j) => [name(j), name(copyOf(j))] as const)
								],
								conservativeMeta
							)
							return { node, copyOf, classOf }
						})
						if (arms.length > 2) {
							c.note("three arms")
						}
						const union = q.union(
							Arr.map(arms, (a) => a.node),
							[],
							conservativeMeta
						)
						const everyArm = (x: number, y: number) =>
							Arr.every(arms, (a) => a.classOf(x) === a.classOf(y))
						for (const x of indices(drawnCase.width)) {
							for (const y of indices(drawnCase.width)) {
								if (x >= y) {
									continue
								}
								if (everyArm(x, y)) {
									c.note("an equality every arm holds")
									if (Arr.every(arms, (a) => a.copyOf(x) === a.copyOf(y))) {
										c.note("an equality every arm holds by copying one column")
									}
									if (Arr.every(arms, (a) => a.copyOf(x) !== a.copyOf(y))) {
										c.note("an equality every arm holds by its filter")
										if (Arr.every(drawnCase.arms, (a) => a.grouped)) {
											c.note("an equality every arm holds through its group")
										}
									}
								} else if (Arr.some(arms, (a) => a.classOf(x) === a.classOf(y))) {
									c.note("an equality some arm lacks")
								}
							}
						}
						const analysis = succeeded(analyzeLogical(q.build(union).dag, checkerEvidence))
						const kernel = new KeyKernel(analysis.dag, {
							keyedViews: false
						})
						const { props } = analysis.of(union)
						assert.ok(props.keys.length > 0, "the union is keyed by tag and its columns")
						const index = (column: string) => columns.indexOf(column)
						for (const proof of props.keys) {
							assert.deepEqual(kernel.check(proof), [], "the key kernel accepts the union's key")
							assert.deepEqual(
								Arr.sort(
									Arr.map(proof.members, (m) => `${m.of}->${m.column}`),
									Order.String
								),
								Arr.sort(
									Arr.flatMap(proof.key, (k) =>
										Arr.flatMap(columns, (o) =>
											k !== "tag" && o !== k && everyArm(index(k), index(o)) ? [`${k}->${o}`] : []
										)
									),
									Order.String
								),
								"its members are exactly the columns equal to a key column in every arm"
							)
							for (const k of proof.key) {
								for (const o of Arr.filter(
									columns,
									(o) => o !== k && k !== "tag" && everyArm(index(k), index(o))
								)) {
									const swapped = Arr.map(proof.key, (x) => (x === k ? o : x))
									assert.ok(
										keyIn(proof, (x) => swapped.includes(x)) !== undefined,
										`[${Arr.join(swapped, ", ")}] is a key by the class of [${Arr.join(proof.key, ", ")}]`
									)
									const direct = defined(
										props.prove(swapped),
										`the union proves [${Arr.join(swapped, ", ")}]`
									)
									assert.deepEqual(kernel.check(direct), [], "the key kernel accepts it")
								}
							}
						}
					})
			)
		)
	)
})

/**
 * The key kernel's side of a union's equal columns (test/support/keys/kernel.ts): an `arms` witness proves two union
 * columns equal only when each arm's derivation steps by equalities alone, since two arms may each determine b from a
 * by a different function of it.
 *
 * Each case draws two or three arms, each reading a relation parameter of its own over x and y, with the outputs tag
 * (the arm's literal), a (x), c (y) and b, which the arm makes from a by a drawn mapping: a copy of x, a copy of y under
 * a filter stating x = y, or x plus a drawn amount. A forged step stating a = b, with each arm's derivation that a
 * determines b, is appended to the derivation of the union's key the analysis proved, which the kernel accepts, so the
 * step is all that changes. Each arm's derivation is a valid step under every mapping; the kernel accepts the forged
 * step exactly when no arm shifts. A step citing a column the union lacks, and a witness whose arm derivations start
 * from a column the arms lack, are refused under every mapping.
 */

type Mapping =
	| { readonly kind: "copy" }
	| { readonly kind: "filtered" }
	| { readonly kind: "shift"; readonly by: number }

const mappingGen: Gen<Mapping> = oneOf<Mapping>([
	constant({ kind: "copy" }),
	constant({ kind: "filtered" }),
	map(int(1, 3), (by): Mapping => ({ kind: "shift", by }))
])

/** The first arm's mapping and the others'. */
type Mappings = readonly [Mapping, ReadonlyArray<Mapping>]

const mappingsGen: Gen<Mappings> = (source) => [
	source.draw(mappingGen),
	source.draw(array(mappingGen, { min: 1, max: 2 }))
]

type ForgeFeature =
	| "every arm makes b equal to a"
	| "an arm shifts"
	| "arms shifting by different amounts"
	| "an equality through a filter"
	| "three arms"

/** Two arms each determining b from a, by different amounts: a union where a does not determine b. */
const shiftedApart: Kept<Mappings, ForgeFeature> = {
	note: "an arms witness of two arms that map a to b differently was accepted",
	draws: "",
	sketch: [{ kind: "shift", by: 1 }, [{ kind: "shift", by: 2 }]],
	reaches: ["an arm shifts", "arms shifting by different amounts"]
}

/** A column no node of the cases has. */
const ghost = "ghost"

describe("the key kernel's union equalities", () => {
	it.effect(
		"refuses a forged equal step whose arms only determine the column, or that cites a column pair none has",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "an arms witness proves two union columns equal only when each arm's derivation steps by equalities alone"
						},
						suite: "unit/analysis/logical/forged-union-equalities",
						draw: sketched(mappingsGen, ([head, tail]) => [head, ...tail] as const),
						literal: Formatter.format,
						kept: [shiftedApart],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<ForgeFeature>(
							[
								"every arm makes b equal to a",
								"an arm shifts",
								"arms shifting by different amounts",
								"an equality through a filter",
								"three arms"
							],
							{ cases: 200, sense: notesOnly }
						)
					},
					(mappings, c) =>
						Effect.sync(() => {
							const shifts = Arr.flatMap(mappings, (m) => (m.kind === "shift" ? [m.by] : []))
							const equal = shifts.length === 0
							c.note(equal ? "every arm makes b equal to a" : "an arm shifts")
							if (new Set(shifts).size > 1) {
								c.note("arms shifting by different amounts")
							}
							if (Arr.some(mappings, (m) => m.kind === "filtered")) {
								c.note("an equality through a filter")
							}
							if (mappings.length > 2) {
								c.note("three arms")
							}
							const q = new Ir(workModel())
							const arms = Arr.map(mappings, (mapping, i) => {
								const rows = q.input(`rows${i}`, [
									["x", int4],
									["y", int4]
								])
								const input =
									mapping.kind === "filtered"
										? q.filter(rows, q.eq(q.col(rows, "x"), q.col(rows, "y")))
										: rows
								const b =
									mapping.kind === "copy"
										? q.col(input, "x")
										: mapping.kind === "filtered"
											? q.col(input, "y")
											: q.op("add", [q.col(input, "x"), q.lit(mapping.by, int4)])
								const node = q.project(
									input,
									[
										["tag", q.lit(i, int4)],
										["a", "x"],
										["b", b],
										["c", "y"]
									],
									conservativeMeta
								)
								return { node, input, mapping }
							})
							const union = q.union(
								Arr.map(arms, (a) => a.node),
								[],
								conservativeMeta
							)
							const analysis = succeeded(analyzeLogical(q.build(union).dag, checkerEvidence))
							const kernel = new KeyKernel(analysis.dag, {
								keyedViews: false
							})
							const proof = defined(analysis.of(union).props.keys[0], "a key of the union")
							assert.deepEqual(
								kernel.check(proof),
								[],
								"the kernel accepts the union's key as proved"
							)
							const basis = proof.basis
							if (basis.kind !== "rows") {
								assert.fail("a union of one heading group proves its keys by its rows")
							}
							/** The union's key with `step` appended to its derivation, once every column is known. */
							const forged = (step: Dependency): KeyProof => ({
								...proof,
								basis: {
									...basis,
									implication: implication(proof.node, basis.implication.from, [
										...basis.implication.steps,
										step
									])
								}
							})
							/** Each arm's derivation that `from` determines b: a projection step over its input's x and y. */
							const derivations = (from: string) =>
								Arr.map(arms, ({ node, input, mapping }) => {
									const inputProps = analysis.of(input).props
									const through =
										mapping.kind === "filtered"
											? [
													defined(
														Option.getOrUndefined(
															Arr.findFirst(
																inputProps.dependencies,
																(d) =>
																	d.rule.rule === "equal" && d.from[0] === "x" && d.to[0] === "y"
															)
														),
														"the filter's equality of x and y"
													)
												]
											: []
									return implication(
										analysis.of(node).props.node.id,
										[from],
										[
											projectionCloses(
												[from],
												["b"],
												implication(inputProps.node.id, ["x"], through)
											)
										]
									)
								})
							const faults = kernel.check(
								forged(equalColumns("a", "b", { kind: "arms", arms: derivations("a") }))
							)
							assert.equal(
								faults.length === 0,
								equal,
								equal
									? "the kernel accepts a = b where every arm makes b a copy of a"
									: "the kernel refuses a = b where an arm only determines b"
							)
							assert.ok(
								kernel.check(
									forged(equalColumns("a", ghost, { kind: "arms", arms: derivations("a") }))
								).length > 0,
								"the kernel refuses an equal step citing a column the union lacks"
							)
							assert.ok(
								kernel.check(
									forged(equalColumns("a", "b", { kind: "arms", arms: derivations(ghost) }))
								).length > 0,
								"the kernel refuses arm derivations from a column the arms lack"
							)
						})
				)
			)
	)
})
