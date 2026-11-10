import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, type Gen, subarray } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	type AuthoredStatementDesc,
	contained,
	f,
	field,
	fin,
	fold,
	mutable,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	accepts,
	assertWellFormed,
	breaks,
	checksOf,
	drawnColumn,
	familyLaw,
	foldLaws,
	type ForeignKeyShape,
	foreignKeyOrder,
	foreignKeyShapes,
	generatedColumn,
	generatedOn,
	keySets,
	modelOf,
	onRelation,
	ridingLaws
} from "#test/unit/laws/model/natives.ts"

/**
 * A tree's natives are exactly w4-w7 §2.2's table over trees.md's T0 to T6, read from the law model's native objects.
 * The oracle is the specification turned into a checker: the three axes with the tree's pairs on them (T0's root copy
 * r → r and T3's ‹ps› → start on the owner axis, T4's start → end on the predecessor, T5's end → end on the last), T1's
 * `UNIQUE (r, start)` and the family key over ‹parent₀›, and one CHECK, whose verdict on every row is the conjunction
 * of trees.md's predicates as the test states them:
 *
 * - the family bound, start = 0 or at < ‹n›;
 * - T2, (parent = id) = (start = 0);
 * - the root pin, start > 0 or at = 0;
 * - T3, start = 0 or at > 0 or start = ‹ps› + 1;
 * - T6, end > start and (children > 0 or end = start + 1).
 *
 * ‹parent₀› is the parent where start > 0 and NULL at the root, the one guarded group column, which the family key and
 * the predecessor and last axes read. The owner axis reads the plain parent, NO ACTION and immediate, mutable or not:
 * PostgreSQL refuses a cascade over a generated column (42601), and a tree is written whole and rewritten by deletion.
 * Its root references itself, so the axis holds the root's ‹n›, ‹ps› and every parent copy at the root's own values,
 * and no copy states a pin of its own.
 *
 * A count fold over the tree rides the predecessor and last axes, and its first-slot pin is `at > 0 OR before = ι`, the
 * root at slot 0 included, as the root pin holds it there: the root's before is no free value.
 *
 * Bound: every tree with a caller field's parent copy or none and an accumulated one or none, mutable or not, with a
 * hidden count fold or none, 16 schemas; the CHECK on every row with parent = id or not and at, children, start, end,
 * ‹ps› and ‹n› in 0 … 3 (8,192 rows), and the owner axis on every root of children, ‹n›, ‹ps› and copies in 0 … 1. The
 * named mutants: a cascading owner axis over ‹parent₀› (refused by PostgreSQL), the root's copies left free of the axis
 * (an owner axis from ‹parent₀›), the root pin dropped (the unpinned sentinel: a root at slot 1 accepted), T0's root copy
 * dropped (the owner axis without r → r) and T5's end dropped (the last axis without end → end), and the root's before
 * left unpinned (a first-slot pin exempting start 0: the root at slot 0 with a before of 1 accepted), each a different
 * set of natives or verdicts this box refuses.
 */

type Copy = "caller" | "accumulated"
interface Shape {
	readonly copies: ReadonlyArray<Copy>
	readonly mutable: boolean
	/** A count fold over the tree, its accumulators hidden: its first-slot pin holds the root's before too. */
	readonly fold: boolean
}

/** The box: a caller copy or none and an accumulated copy or none, in that order, mutable or not, with a fold or none. */
const shapeGen: Gen<Shape> = (source) => ({
	copies: source.draw(subarray(["caller", "accumulated"] as const)),
	mutable: source.draw(boolean),
	fold: source.draw(boolean)
})

type Feature =
	| "an immutable tree"
	| "a mutable tree"
	| "a parent copy"
	| "an accumulated parent copy"
	| "two copies"
	| "a fold over the tree"
const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"an immutable tree",
	"a mutable tree",
	"a parent copy",
	"an accumulated parent copy",
	"two copies",
	"a fold over the tree"
]

/** Each parent copy's fields: its source on the child, and the parent field it copies, numbered against the sources. */
const copiesOf = (s: Shape) =>
	Arr.map(s.copies, (copy, j) => ({
		copy,
		from: `copy${j}`,
		to: `value${s.copies.length - 1 - j}`
	}))

const schemaOf = (s: Shape): SchemaDesc => {
	const copies = copiesOf(s)
	const tree: AuthoredStatementDesc = {
		kind: "tree",
		member: on("Node", ["parent", "at"]),
		slots: fin("Node", "children"),
		root: "doc"
	}
	const members = {
		kind: "compare" as const,
		op: "gt" as const,
		left: field("start"),
		right: { kind: "literal" as const, value: 0n }
	}
	return {
		name: "Trees",
		relations: [
			relation(
				"Node",
				{
					id: f.uuid,
					parent: f.uuid,
					doc: f.uuid,
					at: f.drawn,
					children: f.drawn,
					start: f.drawn,
					end: f.drawn,
					...(s.fold ? { size: f.accumulated(f.natural, 0n) } : {}),
					...Rec.fromEntries(
						Arr.flatMap(copies, (c) => [
							[c.from, c.copy === "caller" ? f.bigint : f.accumulated(f.bigint, 0n)] as const,
							[c.to, f.bigint] as const
						])
					)
				},
				["id"]
			)
		],
		statements: [
			tree,
			...(s.mutable ? [mutable("Node")] : []),
			...(s.fold
				? [
						fold(
							fin("Node", "children"),
							"count",
							on("Node", ["parent"]),
							on("Node", ["id", "size"])
						)
					]
				: []),
			...Arr.map(copies, (c) =>
				contained(onWhere("Node", ["parent", c.from], members), on("Node", ["id", c.to]))
			)
		],
		extends: undefined
	}
}

const sortText = (xs: ReadonlyArray<string>): ReadonlyArray<string> => Arr.sort(xs, Order.String)
const setText = (xs: ReadonlyArray<string>): string => Arr.join(sortText(xs), ", ")

const parent0 = "‹generated parent›"

/**
 * A fold over the tree: its hidden before and after ride the predecessor axis, its end the last, and its first-slot pin
 * is `at > 0 OR before = 0`, the root at slot 0 included, so the root's before is no free value (the unpinned sentinel,
 * which a pin exempting start 0 would leave). Its combine holds every row, a step of one.
 */
const checkFold = (model: LawModel): void => {
	const [law, ...more] = foldLaws(model)
	assert.ok(law !== undefined && more.length === 0, "one fold over the tree")
	const [check, ...extra] = checksOf(model, "Node", law)
	assert.ok(check !== undefined && extra.length === 0, "the fold states one CHECK on the tree")
	const before = drawnColumn(model, "Node", "before 0.0")
	const after = drawnColumn(model, "Node", "after 0.0")
	for (const start of [0n, 1n]) {
		for (const at of [0n, 1n]) {
			for (const b of [0n, 1n, 2n]) {
				for (const a of [0n, 1n, 2n, 3n]) {
					for (const n of [0n, 1n]) {
						for (const size of [0n, 1n]) {
							const row = new Map<string, CarrierValue>([
								["start", start],
								["at", at],
								["children", n],
								["size", size],
								[before, b],
								[after, a]
							])
							assert.equal(
								accepts(check, row),
								a === b + 1n && (at > 0n || b === 0n) && (n > 0n || size === 0n),
								`start ${start}, at ${at}, children ${n}, size ${size}, before ${b}, after ${a}`
							)
						}
					}
				}
			}
		}
	}
}

const expectedForeignKeys = (s: Shape): ReadonlyArray<ForeignKeyShape> =>
	Arr.sort(
		[
			{
				from: "Node",
				to: "Node",
				pairs: sortText([
					"parent → id",
					"‹copy› → children",
					"doc → doc",
					"‹parentStart› → start",
					...Arr.map(copiesOf(s), (c) => `${c.from} → ${c.to}`)
				]),
				onUpdate: "noAction" as const,
				deferrable: false
			},
			{
				from: "Node",
				to: "Node",
				pairs: sortText([
					`${parent0} → ${parent0}`,
					"‹generated at› → at",
					"start → end",
					...(s.fold ? ["‹before 0.0› → ‹after 0.0›"] : [])
				]),
				onUpdate: "noAction" as const,
				deferrable: false
			},
			{
				from: "Node",
				to: "Node",
				pairs: sortText([
					`id → ${parent0}`,
					"‹generated children› → at",
					"end → end",
					...(s.fold ? ["size → ‹after 0.0›"] : [])
				]),
				onUpdate: "noAction" as const,
				deferrable: true
			}
		],
		foreignKeyOrder
	)

const expectedKeys = (s: Shape): ReadonlyArray<string> =>
	sortText([
		"id",
		setText([parent0, "at"]),
		setText(["doc", "start"]),
		setText(["id", "children", "doc", "start", ...Arr.map(copiesOf(s), (c) => c.to)]),
		setText([parent0, "at", "end", ...(s.fold ? ["‹after 0.0›"] : [])])
	])

/** trees.md's predicates on one row, as the specification states them. */
const specified = (row: {
	readonly root: boolean
	readonly at: bigint
	readonly children: bigint
	readonly start: bigint
	readonly end: bigint
	readonly ps: bigint
	readonly n: bigint
}): boolean => {
	const bound = row.start === 0n || row.at < row.n
	const t2 = row.root === (row.start === 0n)
	const rootPin = row.start > 0n || row.at === 0n
	const t3 = row.start === 0n || row.at > 0n || row.start === row.ps + 1n
	const t6 = row.end > row.start && (row.children > 0n || row.end === row.start + 1n)
	return bound && t2 && rootPin && t3 && t6
}

const small = [0n, 1n, 2n, 3n] as const
const rootId = "6f1c2a3b-0000-4000-8000-000000000001"
const otherId = "6f1c2a3b-0000-4000-8000-000000000002"

const checkConditions = (model: LawModel): void => {
	const law = familyLaw(model, { owner: "Node", count: "children" })
	const [check, ...more] = checksOf(model, "Node", law)
	assert.ok(check !== undefined && more.length === 0, "the tree states one CHECK")
	const copy = drawnColumn(model, "Node", "copy")
	const ps = drawnColumn(model, "Node", "parentStart")
	for (const root of [true, false]) {
		for (const at of small) {
			for (const children of small) {
				for (const start of small) {
					for (const end of small) {
						for (const parentStart of small) {
							for (const n of small) {
								const row = new Map<string, CarrierValue>([
									["id", rootId],
									["parent", root ? rootId : otherId],
									["at", at],
									["children", children],
									["start", start],
									["end", end],
									[ps, parentStart],
									[copy, n]
								])
								assert.equal(
									accepts(check, row),
									specified({ root, at, children, start, end, ps: parentStart, n }),
									`root ${root}, at ${at}, children ${children}, [${start}, ${end}), ‹ps› ${parentStart}, ‹n› ${n}`
								)
							}
						}
					}
				}
			}
		}
	}
	const p0 = generatedColumn(model, "Node", "parent")
	for (const start of small) {
		assert.equal(
			generatedOn(
				p0,
				new Map<string, CarrierValue>([
					["parent", otherId],
					["start", start]
				])
			),
			start > 0n ? otherId : undefined,
			`‹parent₀› at start ${start}`
		)
	}
}

/**
 * The owner axis from the plain parent: every parent copy rides it and states no pin of its own, since the root
 * references itself, so the axis's foreign key holds the root's ‹n›, ‹ps› and every copy at its own values. Judged by
 * the host model of the foreign key (natives.ts `breaks`) on every root of children 0 or 1 with each copy, ‹n› and ‹ps›
 * at 0 or 1: the axis holds exactly where each is the root's own.
 */
const checkCopies = (model: LawModel, s: Shape): void => {
	const riding = ridingLaws(model, "owner")
	const copies = copiesOf(s)
	assert.equal(riding.length, copies.length, "every parent copy rides the owner axis")
	for (const r of riding) {
		assert.equal(
			checksOf(model, "Node", r).length,
			0,
			"a parent copy states no pin: the root references itself"
		)
	}
	const [axis, ...more] = Arr.filter(
		onRelation(model, "ForeignKey", "Node"),
		(fk) =>
			fk.onUpdate === "noAction" &&
			Arr.some(fk.targetColumns, (c) => c.kind === "field" && c.field.name === "id")
	)
	assert.ok(axis !== undefined && more.length === 0, "one owner axis into the parent's id")
	const n = drawnColumn(model, "Node", "copy")
	const ps = drawnColumn(model, "Node", "parentStart")
	const bits = [0n, 1n] as const
	const assignments = (k: number): ReadonlyArray<ReadonlyArray<bigint>> =>
		k === 0 ? [[]] : Arr.flatMap(assignments(k - 1), (t) => Arr.map(bits, (b) => [...t, b]))
	for (const children of bits) {
		for (const [copyN, copyPs, ...values] of assignments(2 + 2 * copies.length)) {
			const row = new Map<string, CarrierValue>([
				["id", rootId],
				["parent", rootId],
				["doc", otherId],
				["at", 0n],
				["children", children],
				["start", 0n],
				["end", 1n],
				[n, defined(copyN)],
				[ps, defined(copyPs)],
				...Arr.flatMap(copies, (c, k) => [
					[c.from, defined(values[2 * k])] as const,
					[c.to, defined(values[2 * k + 1])] as const
				])
			])
			const own =
				copyN === children &&
				copyPs === 0n &&
				Arr.every(copies, (_, k) => values[2 * k] === values[2 * k + 1])
			assert.equal(
				breaks(model, axis, new Map([["Node", [row]]])),
				!own,
				`a root of ${children} children, ‹n› ${copyN}, ‹ps› ${copyPs}, copies ${Arr.join(Arr.map(values, String), " ")}`
			)
		}
	}
}

const checkShape = (s: Shape): void => {
	const model = modelOf(schemaOf(s))
	assertWellFormed(model)
	assert.deepEqual(foreignKeyShapes(model), expectedForeignKeys(s))
	assert.deepEqual(keySets(model, "Node"), expectedKeys(s))
	assert.deepEqual(
		onRelation(model, "ReverseIndex", "Node"),
		[],
		"a tree's axes need no reverse index"
	)
	checkConditions(model)
	checkCopies(model, s)
	if (s.fold) {
		checkFold(model)
	}
}

describe("a tree's natives are §2.2's: the family on three axes, T0 to T6, and one CHECK", () => {
	it.effect("every tree with 0 to 2 parent copies, mutable or not", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/laws/model/tree",
					generator: shapeGen,
					literal: Formatter.format,
					/** The space: 4 copy sets, mutable or not, with a fold or none. */
					limit: 16,
					coverage: requiredInSpace<Feature>(features),
					caseHang,
					box: "every tree with 0 to 2 parent copies, mutable or not, with a count fold or none; its CHECK on 8,192 rows",
					oracle: {
						kind: "specification",
						name: "trees.md's T0 to T6 and w4-w7 §2.2's table as a checker"
					}
				},
				(s, c) =>
					Effect.sync(() => {
						c.note(s.mutable ? "a mutable tree" : "an immutable tree")
						if (s.copies.length > 0) {
							c.note("a parent copy")
						}
						if (Arr.contains(s.copies, "accumulated")) {
							c.note("an accumulated parent copy")
						}
						if (s.copies.length > 1) {
							c.note("two copies")
						}
						if (s.fold) {
							c.note("a fold over the tree")
						}
						checkShape(s)
					})
			)
		)
	)
})
