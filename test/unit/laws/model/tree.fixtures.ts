/** What the properties of tree.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, type Gen, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { succeeded } from "#test/support/assert.ts"
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
	type SchemaDesc,
	unit
} from "#test/support/fixtures/ir/desc.ts"
import { assertReferencesServed } from "#test/support/laws/referencing.ts"
import type { ModelValue } from "#test/support/oracle/evaluate/catalog.ts"
import { owning } from "#test/support/policy.ts"
import {
	accepts,
	assertWellFormed,
	breaks,
	checksOf,
	drawnColumn,
	familyLaw,
	foldLaws,
	foreignKeyOrder,
	type ForeignKeyShape,
	foreignKeyShapes,
	generatedColumn,
	generatedOn,
	keySets,
	modelOf,
	onRelation,
	reverseSets,
	ridingLaws
} from "#test/unit/laws/model/natives.ts"

type Copy = "caller" | "accumulated"

interface Shape {
	readonly copies: ReadonlyArray<Copy>
	readonly mutable: boolean
	/** A count fold over the tree, its accumulators hidden: its first-slot pin holds the root's before too. */
	readonly fold: boolean
}

/** The box: a caller copy or none and an accumulated copy or none, in that order, mutable or not, with a fold or none. */
export const shapeGen: Gen<Shape> = (source) => ({
	copies: source.draw(subarray(["caller", "accumulated"] as const)),
	mutable: source.draw(boolean),
	fold: source.draw(boolean)
})

export type Feature =
	| "an immutable tree"
	| "a mutable tree"
	| "a parent copy"
	| "an accumulated parent copy"
	| "two copies"
	| "a fold over the tree"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
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
		root: ["doc"]
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
					doc: f.uuid,
					parent: f.drawn,
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
				["doc", "start"]
			)
		],
		statements: [
			tree,
			...(s.mutable ? [unit("Document", { doc: f.uuid }), mutable("Node")] : []),
			...(s.fold
				? [
						fold(
							fin("Node", "children"),
							"count",
							on("Node", ["doc", "parent"]),
							on("Node", ["doc", "start", "size"])
						)
					]
				: []),
			...Arr.map(copies, (c) =>
				contained(
					onWhere("Node", ["doc", "parent", c.from], members),
					on("Node", ["doc", "start", c.to])
				)
			)
		],
		bases: []
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
							const row = new Map<string, ModelValue>([
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
					"doc → doc",
					`${parent0} → start`,
					"‹copy› → children",
					...Arr.map(copiesOf(s), (c) => `${c.from} → ${c.to}`)
				]),
				onUpdate: "noAction" as const,
				deferrable: false
			},
			{
				from: "Node",
				to: "Node",
				pairs: sortText([
					"doc → doc",
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
					"doc → doc",
					`start → ${parent0}`,
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

/** The primary key, the family key, its successor key (doc, ‹parent₀›, ‹p›), each node the predecessor of at most one
 * sibling, and the superkeys the axes reference. */
const expectedKeys = (s: Shape): ReadonlyArray<string> =>
	sortText([
		setText(["doc", "start"]),
		setText(["doc", parent0, "at"]),
		setText(["doc", parent0, "‹generated at›"]),
		setText(["doc", "start", "children", ...Arr.map(copiesOf(s), (c) => c.to)]),
		setText(["doc", parent0, "at", "end", ...(s.fold ? ["‹after 0.0›"] : [])])
	])

/** trees.md's predicates on one row, as the specification states them. */
const specified = (row: {
	readonly parent: bigint
	readonly at: bigint
	readonly children: bigint
	readonly start: bigint
	readonly end: bigint
	readonly n: bigint
}): boolean => {
	const bound = row.start === 0n || row.at < row.n
	const t2 = (row.parent === row.start) === (row.start === 0n)
	const rootPin = row.start > 0n || row.at === 0n
	const rootCount = row.start > 0n || row.n === row.children
	const t3 = row.start === 0n || row.at > 0n || row.start === row.parent + 1n
	const t6 = row.end > row.start && (row.children > 0n || row.end === row.start + 1n)
	return bound && t2 && rootPin && rootCount && t3 && t6
}

const small = [0n, 1n, 2n, 3n] as const

const docId = "6f1c2a3b-0000-4000-8000-000000000001"

const checkConditions = (model: LawModel): void => {
	const law = familyLaw(model, { owner: "Node", count: "children" })
	const [check, ...more] = checksOf(model, "Node", law)
	assert.ok(check !== undefined && more.length === 0, "the tree states one CHECK")
	const copy = drawnColumn(model, "Node", "copy")
	for (const parent of small) {
		for (const at of small) {
			for (const children of small) {
				for (const start of small) {
					for (const end of small) {
						for (const n of small) {
							const row = new Map<string, ModelValue>([
								["doc", docId],
								["parent", parent],
								["at", at],
								["children", children],
								["start", start],
								["end", end],
								[copy, n]
							])
							assert.equal(
								accepts(check, row),
								specified({ parent, at, children, start, end, n }),
								`parent ${parent}, at ${at}, children ${children}, [${start}, ${end}), ‹n› ${n}`
							)
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
				new Map<string, ModelValue>([
					["parent", 1n],
					["start", start]
				])
			),
			start > 0n ? 1n : undefined,
			`‹parent₀› at start ${start}`
		)
	}
}

/**
 * The owner axis from the guarded group, (doc, ‹parent₀›) into (doc, start): every parent copy rides it, and no root
 * references anything, since the root has no parent: an accumulated copy states its pin, start > 0 or the copy at its
 * start, 0, which holds the root's copy there, a caller's copy none, and the tree's CHECK holds the root's ‹n› at its
 * own count (`checkConditions`). Judged by the host model of the foreign key and of each pin (natives.ts `breaks`,
 * `accepts`) on every root, at start 0, of children 0 or 1 with its parent, each copy and ‹n› at 0 or 1: the axis never
 * breaks there, and each pin holds exactly where its copy is 0.
 */
const checkCopies = (model: LawModel, s: Shape): void => {
	const riding = ridingLaws(model, "owner")
	const copies = copiesOf(s)
	assert.equal(riding.length, copies.length, "every parent copy rides the owner axis")
	const pins = Arr.flatMap(riding, (r) => checksOf(model, "Node", r))
	assert.equal(
		pins.length,
		Arr.filter(copies, (c) => c.copy === "accumulated").length,
		"an accumulated parent copy states its pin at the root, a caller's none"
	)
	const [axis, ...more] = Arr.filter(
		onRelation(model, "ForeignKey", "Node"),
		(fk) =>
			fk.onUpdate === "noAction" &&
			Arr.some(fk.targetColumns, (c) => c.kind === "field" && c.field.name === "children")
	)
	assert.ok(axis !== undefined && more.length === 0, "one owner axis into the parent's count")
	const n = drawnColumn(model, "Node", "copy")
	const bits = [0n, 1n] as const
	const assignments = (k: number): ReadonlyArray<ReadonlyArray<bigint>> =>
		k === 0 ? [[]] : Arr.flatMap(assignments(k - 1), (t) => Arr.map(bits, (b) => [...t, b]))
	for (const children of bits) {
		for (const [copyN, parent, ...values] of assignments(2 + 2 * copies.length)) {
			const row = new Map<string, ModelValue>([
				["doc", docId],
				["parent", defined(parent)],
				["at", 0n],
				["children", children],
				["start", 0n],
				["end", 1n],
				[n, defined(copyN)],
				...Arr.flatMap(copies, (c, k) => [
					[c.from, defined(values[2 * k])] as const,
					[c.to, defined(values[2 * k + 1])] as const
				])
			])
			const label = `a root of ${children} children, ‹n› ${copyN}, parent ${parent}, copies ${Arr.join(Arr.map(values, String), " ")}`
			assert.equal(
				breaks(model, axis, new Map([["Node", [row]]])),
				false,
				`${label}: the axis names no row`
			)
			const accumulated = Arr.filter(
				Arr.map(copies, (c, k) => ({ c, value: values[2 * k] })),
				({ c }) => c.copy === "accumulated"
			)
			assert.equal(
				Arr.every(pins, (pin) => accepts(pin, row)),
				Arr.every(accumulated, ({ value }) => value === 0n),
				`${label}: the pins hold each accumulated copy at its start`
			)
		}
	}
}

/** Each axis's reverse index, over its referencing columns that pair with its target's key, as a set: the owner
 * axis's (doc, ‹parent₀›) from the guarded parent, the predecessor's (doc, ‹parent₀›, ‹p›) and the last's (doc, start,
 * ‹pn›); never over a copy an axis carries. */
const expectedReverse = (): ReadonlyArray<string> =>
	sortText([
		setText(["doc", parent0]),
		setText(["doc", parent0, "‹generated at›"]),
		setText(["doc", "start", "‹generated children›"])
	])

export const checkShape = (s: Shape): void => {
	const desc = schemaOf(s)
	const model = modelOf(desc)
	assertWellFormed(model)
	const owned = owning(desc)
	assertReferencesServed(succeeded(compileInstallation(owned, installOptions(owned))).statements)
	assert.deepEqual(foreignKeyShapes(model), expectedForeignKeys(s))
	assert.deepEqual(keySets(model, "Node"), expectedKeys(s))
	assert.deepEqual(
		reverseSets(model, "Node"),
		expectedReverse(),
		"each axis carries its reverse index"
	)
	checkConditions(model)
	checkCopies(model, s)
	if (s.fold) {
		checkFold(model)
	}
}
