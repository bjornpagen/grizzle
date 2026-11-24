/** What the properties of union.test.ts read: its spaces, models and helpers. */

import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf
} from "@bjornpagen/testing/gen"
import { bigint, double } from "@bjornpagen/testing/values"
import { Array as Arr, Option, Order, Ordering, pipe, String as Str } from "effect"
import { type Direction, directions } from "#compiler/core/order.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { conservativeMeta, type NodeOf, type RelDag } from "#compiler/ir/rel.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { emptyCtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import { OptimizedDelivery, optimizedDispatch, ShapeState } from "#compiler/lower/shapes/index.ts"
import { noKeys } from "#compiler/lower/shapes/share/keyed.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { OperandBody, OperandSelect } from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { mergeComparator } from "#test/support/merge.ts"
import { keyed, Posting, Q, T, Task } from "#test/unit/lower/conservative/fixtures.ts"
import { shapedFacts, shapedProgram, testOptions } from "#test/unit/lower/shapes/support.ts"

export const takeOf = (dag: RelDag): NodeOf<"Take"> =>
	Option.getOrThrowWith(
		Arr.findFirst(topoOrder(dag), (n): n is NodeOf<"Take"> => n.kind === "Take"),
		() => new Error("a take")
	)

/** The bounded arms of an arm-bounded union, in arm order. */
export const boundedArms = (query: OperandSelect): ReadonlyArray<OperandSelect> => {
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

export const unionOf = (dag: RelDag): NodeOf<"Union"> =>
	Option.getOrThrowWith(
		Arr.findFirst(topoOrder(dag), (n): n is NodeOf<"Union"> => n.kind === "Union"),
		() => new Error("a union")
	)

export const conservative = (built: LogicalQuery): number =>
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
export const optimized = (built: LogicalQuery): number => {
	const { facts } = shapedFacts(built.dag, {}, "placement")
	const state = new ShapeState<RelationInput>("small", emptyCtePlan, noKeys)
	const cx = new LowerContext(
		built.dag,
		testOptions("Ledger"),
		optimizedDispatch(facts, state),
		state.evaluationHolding
	)
	return Arr.reduce(
		flight(
			new OptimizedDelivery<never>(cx, facts, state).optimizedProgram(built.dag.roots[0]).roots
		),
		0,
		(n, s) => n + (s.role.kind === "attachment" ? 1 : 0) + s.fused.length
	)
}

/**
 * Automatic tasks (id, kind, amount) as the lone arm of their group, and two arms of manual tasks (id, kind), the
 * postings of each task attached to the lone arm or to one of the two.
 */
export const tasksWithPostings = (on: "lone" | "shared") => {
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
export type ScoredRow = { readonly score: number; readonly kind: Handle; readonly id: number }

/** An ordering in a key's direction: as it is ascending, reversed descending. */
const directed = (d: Direction, o: Ordering.Ordering): Ordering.Ordering =>
	d === "asc" ? o : Ordering.reverse(o)

export const referenceCompare =
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

export const mergeCaseGen: Gen<MergeCase> = (source) => {
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

/** An exact decimal as a coefficient and a scale, its text and its value's sign against another's by their digits. */
export type DecimalCase =
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
export const value = (d: DecimalCase) => succeeded(Decimal.fromString(decimalText(d)))

export const decimalOrder = (a: DecimalCase, b: DecimalCase): number => {
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

export const exact = succeeded(
	mergeComparator({
		order: { keys: [{ column: "x", dir: "asc" }] },
		types: { x: T.numeric },
		codes: emptyCodebook
	})
)

/** Two drawn decimals, or one beside itself written at a larger scale. */
export const decimalPairs = oneOf<readonly [DecimalCase, DecimalCase]>([
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
