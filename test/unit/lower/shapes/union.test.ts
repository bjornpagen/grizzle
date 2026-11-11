/**
 * The union shape (shapes/union): attachments on heading groups, the in-statement bounded union, and the runtime merge
 * of group statements. What a union delivers is the optimized differential's on PostgreSQL, and a match narrowed to one
 * heading group of a bounded union, joined back on every common field, is test/pg/oracle/union-take's.
 *
 * - An attachment on the lone arm of its heading group is delivered, and one on an arm of a group of several refused,
 *   by the optimized lowering and the conservative one alike.
 * - Inside a statement, each arm of a bounded union is bounded by k under the take's order, deduplicated on the common
 *   fields before its bound exactly when the facts do not key it there; exhausted over k, the facts and overlapping
 *   arms.
 * - The runtime merge (runtime/lower/union.ts mergeHeadingGroups) keeps the first k of the union under the common
 *   order: over drawn heading groups of floats (NaN, signed zeros, infinities named beside drawn ones), enums in either
 *   roster direction and ids, each group in that order, against a reference sort of every row under PostgreSQL's B-tree
 *   order; exact decimals compare by value against a reference over their digits.
 *
 * Oracle: the shape's statement over exhaustive planted spaces (a specification); a reference sort of every row, and
 * a reference order of decimals by their digits (second implementations).
 *
 * Features: delivered and refused; keyed and deduplicated arms; every row, the first k, a NaN, a descending order;
 * decimals equal at different scales, and ordered.
 *
 * Plants, each failing its search: the optimized delivery taking an attachment on an arm of several
 * (union-attachments-optimized); every bounded arm deduplicated (union-arm-distinct); the merge keeping one row past its
 * take (union-merge-take); decimals compared by coefficient whatever their scale (decimal-scale-ignored).
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, constant, element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Ordering,
	pipe,
	String as Str
} from "effect"
import { structural } from "#compiler/analysis/physical/fds.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	type CompletedOrder,
	conservativeMeta,
	type NodeOf,
	type RelDag
} from "#compiler/ir/rel.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { emptyCtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import { OptimizedDelivery, optimizedDispatch, ShapeState } from "#compiler/lower/shapes/index.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { mergeHeadingGroups } from "#compiler/runtime/lower/union.ts"

import { type Direction, directions } from "#compiler/core/order.ts"
import { orderIsTotal } from "#compiler/lower/shapes/take/order.ts"
import { armBoundedUnion } from "#compiler/lower/shapes/union/index.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { OperandBody, OperandSelect } from "#compiler/sql/ast.ts"
import { lit, types } from "#compiler/sql/build.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { mergeComparator } from "#test/support/merge.ts"
import { fixtureCodes } from "#test/unit/ir/fixture.ts"
import { keyed, Posting, Q, T, Task } from "#test/unit/lower/conservative/fixtures.ts"
import { tasksByKind } from "#test/unit/lower/shapes/queries.ts"
import {
	context,
	shapedFacts,
	shapedProgram,
	testOptions
} from "#test/unit/lower/shapes/support.ts"

const takeOf = (dag: RelDag): NodeOf<"Take"> =>
	Option.getOrThrowWith(
		Arr.findFirst(topoOrder(dag), (n): n is NodeOf<"Take"> => n.kind === "Take"),
		() => new Error("a take")
	)

/** The bounded arms of an arm-bounded union, in arm order. */
const boundedArms = (query: OperandSelect): ReadonlyArray<OperandSelect> => {
	const arms: Array<OperandSelect> = []
	const visit = (body: OperandBody): void => {
		if (body.kind === "setOp") {
			for (const arm of body.arms) {
				visit(arm)
			}
		} else if (body.kind === "select") {
			if (body.limit === undefined) {
				visit(body.body)
			} else {
				arms.push(body)
			}
		}
	}
	visit(query.body)
	return arms
}

const unionOf = (dag: RelDag): NodeOf<"Union"> =>
	Option.getOrThrowWith(
		Arr.findFirst(topoOrder(dag), (n): n is NodeOf<"Union"> => n.kind === "Union"),
		() => new Error("a union")
	)

const conservative = (built: LogicalQuery): number =>
	Arr.filter(
		flight(
			shapedProgram(
				conservativeInput(built),
				shapedFacts(built.dag, {}, "placement").facts,
				testOptions("Ledger")
			).roots
		),
		(s) => s.role.kind === "attachment"
	).length

/** The attachments a program delivers, pipelined or fused into their parent statement. */
const optimized = (built: LogicalQuery): number => {
	const { facts } = shapedFacts(built.dag, {}, "placement")
	const state = new ShapeState<RelationInput>("small", emptyCtePlan)
	const cx = new LowerContext(built.dag, testOptions("Ledger"), optimizedDispatch(facts, state))
	return Arr.reduce(
		flight(
			new OptimizedDelivery<never>(cx, facts, state).optimizedProgram(built.dag.roots[0]).roots
		),
		0,
		(n, s) => n + (s.role.kind === "attachment" ? 1 : 0) + s.fused.length
	)
}

describe("attachments on heading groups", () => {
	/**
	 * Automatic tasks (id, kind, amount) as the lone arm of their group, and two arms of manual tasks (id, kind), the
	 * postings of each task attached to the lone arm or to one of the two.
	 */
	const tasksWithPostings = (on: "lone" | "shared") => {
		const q = new Q()
		const arm = (handle: "Automatic" | "Manual", withAmount: boolean, small: boolean) => {
			const kind = q.lit({ kind: "handle", handle }, T.kind)
			const r = q.region([
				{
					source: q.base(Task, conservativeMeta),
					bind: { id: "id", amount: "amount" },
					constants: { kind }
				}
			])
			const f = q.filter(
				r,
				q.op(small ? "int8le" : "int8gt", [q.col(r, "amount"), q.int(20, T.int8)], T.bool)
			)
			return q.project(
				f,
				[
					["kind", [q.lit({ kind: "handle", handle }, T.kind), T.kind]],
					["id", "id"],
					...(withAmount ? [["amount", "amount"] as const] : [])
				],
				keyed(["id"], "many")
			)
		}
		const postings = () =>
			q.project(
				q.region([
					{
						source: q.base(Posting, conservativeMeta),
						bind: { id: "pid", account: "task" },
						constants: {}
					}
				]),
				[
					["task", "task"],
					["pid", "pid"]
				],
				conservativeMeta
			)
		const [lone, first, second] = [
			arm("Automatic", true, true),
			arm("Manual", false, true),
			arm("Manual", false, false)
		]
		const attached = q.attach(
			on === "lone" ? lone : first,
			postings(),
			"postings",
			[["id", "task"]],
			"array",
			undefined
		)
		const arms = on === "lone" ? [attached, first, second] : [lone, attached, second]
		return q.build(q.union(arms, ["kind"]))
	}

	it.effect(
		"deliver the lone arm's attachment and refuse one on an arm of a group of several, in both lowerings",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "the postings attached to a heading group's lone arm or to an arm of a group of two, under either lowering",
						oracle: {
							kind: "specification",
							name: "an attachment on a lone arm delivered, one on an arm of several refused, in both lowerings"
						},
						suite: "unit/lower/shapes/union/attachments",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(element<"lone" | "shared">(["lone", "shared"])),
								source.draw(element<"optimized" | "conservative">(["optimized", "conservative"]))
							] as const,
						limit: 4,
						coverage: requiredInSpace<"delivered" | "refused">(["delivered", "refused"]),
						caseHang
					},
					([on, lowering], c) =>
						Effect.sync(() => {
							const count = catchRefusal(() =>
								(lowering === "optimized" ? optimized : conservative)(tasksWithPostings(on))
							)
							if (on === "lone") {
								assert.equal(succeeded(count), 1)
								c.note("delivered")
							} else {
								refused(count, "UnsupportedOperation")
								c.note("refused")
							}
						})
				)
			)
	)
})

describe("the bounded union consumed inside a statement", () => {
	it.effect(
		"bounds every arm by k, deduplicating it on the common fields first exactly when the facts do not key it",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "k of one to three, arms keyed by the facts or not, overlapping or not",
						oracle: {
							kind: "specification",
							name: "each arm bounded by k, deduplicated on the common fields exactly where unkeyed"
						},
						suite: "unit/lower/shapes/union/arm-bounded",
						literal: Formatter.format,
						generator: (source) =>
							[source.draw(int(1, 3)), source.draw(boolean), source.draw(boolean)] as const,
						limit: 12,
						coverage: requiredInSpace<"keyed" | "deduplicated">(["keyed", "deduplicated"]),
						caseHang
					},
					([k, keyedArms, overlap], c) =>
						Effect.sync(() => {
							const built = tasksByKind({ kind: "first", k: BigInt(k) }, overlap)
							const union = unionOf(built.dag)
							const take = takeOf(built.dag)
							const { facts } = shapedFacts(
								built.dag,
								{
									keyedBy: (_, columns) =>
										keyedArms ? { just: structural, key: columns } : undefined
								},
								"placement"
							)
							const cx = context(built.dag, facts, testOptions("Ledger"))
							const bound = lit.int(BigInt(k), types.bigint)
							const arms = boundedArms(
								armBoundedUnion(
									cx,
									facts,
									union,
									take.order,
									orderIsTotal(facts, union, take.order, union.heading),
									() => bound,
									new Map()
								)
							)
							assert.equal(
								arms.length,
								Arr.reduce(union.groups, 0, (n, g) => n + g.arms.length)
							)
							for (const arm of arms) {
								assert.equal(arm.limit, bound)
								assert.equal(arm.body.kind === "core" && arm.body.distinct === true, !keyedArms)
							}
							c.note(keyedArms ? "keyed" : "deduplicated")
						})
				)
			)
	)
})

/**
 * The merge's reference: PostgreSQL's B-tree order over the decoded values, written out per type.
 *
 * float8: -0 equals 0, NaN equals NaN and sorts above every other value.
 */
const compareFloat = (a: number, b: number): Ordering.Ordering =>
	Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : Number.isNaN(b) ? -1 : a < b ? -1 : a > b ? 1 : 0

const roster = ["Automatic", "Manual"] as const
type Handle = (typeof roster)[number]

/** A decoded row of the groups, readable by column as the merge reads it. */
type ScoredRow = { readonly score: number; readonly kind: Handle; readonly id: number }

/** An ordering in a key's direction: as it is ascending, reversed descending. */
const directed = (d: Direction, o: Ordering.Ordering): Ordering.Ordering =>
	d === "asc" ? o : Ordering.reverse(o)

const referenceCompare =
	(dirs: { readonly score: Direction; readonly kind: Direction }): Order.Order<ScoredRow> =>
	(a, b) => {
		const byScore = directed(dirs.score, compareFloat(a.score, b.score))
		if (byScore !== 0) {
			return byScore
		}
		const byKind = directed(dirs.kind, Order.Number(roster.indexOf(a.kind), roster.indexOf(b.kind)))
		if (byKind !== 0) {
			return byKind
		}
		return Order.Number(a.id, b.id)
	}

const scoreGen: Gen<number> = oneOf([
	element([Number.NaN, -0, 0, 1, 2.5, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
	double(-Number.MAX_VALUE, Number.MAX_VALUE)
])

/**
 * Heading groups of one kind each, in a drawn group order, their rows with distinct ids so the order is total; the
 * order's directions; and the take: every row, or the first k for k up to one past the rows.
 */
interface MergeCase {
	readonly groups: ReadonlyArray<ReadonlyArray<ScoredRow>>
	readonly dirs: { readonly score: Direction; readonly kind: Direction }
	readonly take: { readonly kind: "every row" } | { readonly kind: "first"; readonly k: number }
}

const direction = element(directions)
const mergeCaseGen: Gen<MergeCase> = (source) => {
	const manualFirst = source.draw(boolean)
	const automatic = source.draw(array(scoreGen, { min: 0, max: 5 }))
	const manual = source.draw(array(scoreGen, { min: 0, max: 5 }))
	const dirs = { score: source.draw(direction), kind: source.draw(direction) }
	const rows = (kind: Handle, scores: ReadonlyArray<number>) =>
		Arr.map(scores, (score, i): ScoredRow => ({ score, kind, id: i }))
	const compare = referenceCompare(dirs)
	const kinds: ReadonlyArray<readonly [Handle, ReadonlyArray<number>]> = manualFirst
		? [
				["Manual", manual],
				["Automatic", automatic]
			]
		: [
				["Automatic", automatic],
				["Manual", manual]
			]
	/** Each group as its statement delivers it: in the common order. */
	const groups = Arr.map(kinds, ([kind, scores]) => Arr.sort(rows(kind, scores), compare))
	const total = automatic.length + manual.length
	const take = source.draw(
		oneOf<MergeCase["take"]>([
			constant({ kind: "every row" }),
			map(int(0, total + 1), (k): MergeCase["take"] => ({ kind: "first", k }))
		])
	)
	return { groups, dirs, take }
}

/** A finite decimal's coefficient with its sign. */
const signedCoefficient = (d: {
	readonly negative: boolean
	readonly coefficient: bigint
}): bigint => (d.negative ? -d.coefficient : d.coefficient)

describe("the runtime merge of heading groups", () => {
	it.effect(
		"keeps the first k of every group's rows under the common order, NaN above all and the roster breaking ties",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "a sort of every row under PostgreSQL's B-tree order, cut at k"
						},
						suite: "unit/lower/shapes/union/merge",
						literal: Formatter.format,
						kept: [],
						draw: drawn(mergeCaseGen),
						runs: 200,
						shrink: completeShrink,
						coverage: required<"every row" | "first k" | "a NaN" | "descending">(
							["every row", "first k", "a NaN", "descending"],
							{ cases: 200, sense: notesOnly }
						),
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(m, c) =>
						Effect.sync(() => {
							const order: CompletedOrder = {
								keys: [
									{ column: "score", dir: m.dirs.score },
									{ column: "kind", dir: m.dirs.kind },
									{ column: "id", dir: "asc" }
								]
							}
							const compare = succeeded(
								mergeComparator({
									order,
									types: { score: T.float8, kind: T.kind, id: T.int4 },
									codes: fixtureCodes
								})
							)
							const merged = mergeHeadingGroups(
								m.groups,
								compare,
								m.take.kind === "every row" ? undefined : m.take.k
							)
							const all = Arr.sort(
								Arr.flatMap(m.groups, (rows, group) => Arr.map(rows, (row) => ({ group, row }))),
								Order.mapInput(referenceCompare(m.dirs), (x: { readonly row: ScoredRow }) => x.row)
							)
							const expected = m.take.kind === "every row" ? all : all.slice(0, m.take.k)
							assert.deepEqual(
								Arr.map(merged, (x) => [x.group, x.row.kind, x.row.id]),
								Arr.map(expected, (x) => [x.group, x.row.kind, x.row.id])
							)
							c.note(m.take.kind === "every row" ? "every row" : "first k")
							if (Arr.some(m.groups, (rows) => Arr.some(rows, (r) => Number.isNaN(r.score)))) {
								c.note("a NaN")
							}
							if (m.dirs.score === "desc") {
								c.note("descending")
							}
						})
				)
			)
	)

	/** An exact decimal as a coefficient and a scale, its text and its value's sign against another's by their digits. */
	type DecimalCase =
		| {
				readonly kind: "finite"
				readonly negative: boolean
				readonly coefficient: bigint
				readonly scale: number
		  }
		| { readonly kind: "nan" }
	const decimalGen: Gen<DecimalCase> = oneOf<DecimalCase>([
		(source) => ({
			kind: "finite",
			negative: source.draw(boolean),
			coefficient: source.draw(bigint(0n, 2000n)),
			scale: source.draw(int(0, 3))
		}),
		constant({ kind: "nan" })
	])
	const decimalText = (d: DecimalCase): string => {
		if (d.kind === "nan") {
			return "NaN"
		}
		const digits = pipe(d.coefficient.toString(), Str.padStart(d.scale + 1, "0"))
		const point = digits.length - d.scale
		return `${d.negative ? "-" : ""}${Str.slice(0, point)(digits)}${d.scale > 0 ? `.${Str.slice(point)(digits)}` : ""}`
	}
	/** numeric orders NaN above every number and equal to itself; numbers by value, whatever their scale. */
	const value = (d: DecimalCase) => succeeded(Decimal.fromString(decimalText(d)))
	const decimalOrder = (a: DecimalCase, b: DecimalCase): number => {
		if (a.kind === "nan") {
			return b.kind === "nan" ? 0 : 1
		}
		if (b.kind === "nan") {
			return -1
		}
		const left = signedCoefficient(a) * 10n ** BigInt(b.scale)
		const right = signedCoefficient(b) * 10n ** BigInt(a.scale)
		return left < right ? -1 : left > right ? 1 : 0
	}

	it.effect("compares exact decimals by value, whatever their scale", (ctx) => {
		const exact = succeeded(
			mergeComparator({
				order: { keys: [{ column: "x", dir: "asc" }] },
				types: { x: T.numeric },
				codes: emptyCodebook
			})
		)
		return searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "decimals ordered by their digits at a common scale, NaN above every number"
					},
					suite: "unit/lower/shapes/union/decimal-order",
					literal: Formatter.format,
					kept: [],
					/** Two drawn decimals, or one beside itself written at a larger scale. */
					draw: drawn(
						oneOf<readonly [DecimalCase, DecimalCase]>([
							(source) => [source.draw(decimalGen), source.draw(decimalGen)] as const,
							(source) => {
								const d = source.draw(decimalGen)
								const more = source.draw(int(1, 3))
								return [
									d,
									d.kind === "finite"
										? {
												...d,
												coefficient: d.coefficient * 10n ** BigInt(more),
												scale: d.scale + more
											}
										: d
								] as const
							}
						])
					),
					runs: 200,
					shrink: completeShrink,
					coverage: required<"equal at different scales" | "ordered">(
						["equal at different scales", "ordered"],
						{ cases: 200, sense: notesOnly }
					),
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([a, b], c) =>
					Effect.sync(() => {
						assert.equal(Math.sign(exact({ x: value(a) }, { x: value(b) })), decimalOrder(a, b))
						if (
							decimalOrder(a, b) === 0 &&
							a.kind === "finite" &&
							b.kind === "finite" &&
							a.scale !== b.scale
						) {
							c.note("equal at different scales")
						} else {
							c.note("ordered")
						}
					})
			)
		)
	})
})
