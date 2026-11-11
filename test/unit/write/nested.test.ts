import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, int, parents } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Stream, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { accumulated, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	fin,
	fold,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema,
	tree
} from "#compiler/public/schema.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { fieldKey } from "#compiler/runtime/write/fill.ts"
import { inputSlotsOf } from "#compiler/runtime/write/normalize.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { runnableWrite } from "#compiler/write/program/bind.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { assert, assertVariant, defined, succeeded } from "#test/support/assert.ts"
import { nestedRowsColumn, testArtifacts, testCompile } from "#test/support/compile.ts"
import { lawNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, owning } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A nested write through the whole program (write/frontend, write/family/nesting.ts, program/compile's family steps,
 * bind's chunks): an insert of an owner with its ordered family nested at its count field, a sum folded over it into
 * the owner's end, and an insert of a tree's roots with their children nested to any depth.
 *
 * The oracles: the specification as a checker. Each family step follows its stratum's own statements and its
 * nesting's shallower families; the owner's own row carries its drawn count and its folded end, a direct sum; every
 * member placed by a family step's chunks is at its slot, copying its owner's count, its group its owner's key; and a
 * tree's nodes come in pre-order with the intervals a direct numbering gives (`numberedOf`, a second implementation).
 *
 * Bound: one or two owners of zero to two lines each, of quantities 0 or 1; one or two trees of one to four nodes;
 * the transport in force and one that holds one row per statement. The program depends on the ChangeSet's shape alone,
 * so it is compiled once for each count of owners and trees, and each case binds its own facts.
 *
 * Features: each box's shapes (owners, trees, the transport), a set's repeated facts and keys, each tree depth and
 * shape.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): nested-tree-interval-unsized, nested-signature-own-row-only.
 */

const Doc = relation(
	"Doc",
	{ id: uuid, lines: drawn(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
const Line = relation("Line", { id: uuid, doc: uuid, at: drawn(natural), qty: pg.bigint }, ["id"])
const Node = relation(
	"Node",
	{
		id: uuid,
		parent: uuid,
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		root: uuid
	},
	["id"]
)
const lines = ordered(on(Line, "doc", "at"), fin(Doc, "lines"))
const Nested = schema("Nested", { Doc, Line, Node }, [
	mutable(Doc),
	lines,
	fold(lines, Monoid.sum, on(Line, "doc", "qty"), on(Doc, "id", "total")),
	tree(on(Node, "parent", "at"), fin(Node, "children"), { root: "root" })
])

const nested = owning(Nested)
const names: WriteNames = succeeded(
	compileInstallation(nested, {
		...installOptions(nested, "owner"),
		levels: [identity.schema(parsedSchemaName("nested"))]
	})
).names
const artifacts = succeeded(testArtifacts(Nested, testCompile))

const compiled = (value: unknown): CompiledWrite =>
	succeeded(
		compileWrite(checking(Nested), descOf(value), {
			names,
			reads: names,
			claims: { kind: "every" },
			world: { kind: "reality" },
			laws: artifacts.laws,
			derived: artifacts.derived,
			level: "serializable"
		})
	)

interface NestedCase {
	readonly docs: ReadonlyArray<ReadonlyArray<number>>
	readonly trees: ReadonlyArray<ReadonlyArray<number>>
}

const caseGen: Gen<NestedCase> = (source) => ({
	docs: source.draw(array(array(int(0, 1), { min: 0, max: 2 }), { min: 1, max: 2 })),
	trees: source.draw(array(parents({ min: 1, max: 4 }), { min: 1, max: 2 }))
})

/** A tree's nested facts, node ids from `base`: each node its id and its children at `children`. */
const treeFacts = (
	parentOf: ReadonlyArray<number>,
	base: number
): { readonly id: string; readonly children: ReadonlyArray<unknown> } => {
	const count = parentOf.length + 1
	const kids: Array<Array<number>> = Array.from({ length: count }, () => [])
	for (const [i, p] of parentOf.entries()) {
		defined(kids[p], "a parent").push(i + 1)
	}
	const built: Array<{ readonly id: string; readonly children: ReadonlyArray<unknown> }> = []
	for (let n = count - 1; n >= 0; n -= 1) {
		built[n] = {
			id: uuidOf(base + n),
			children: Arr.map(defined(kids[n], "a node's children"), (c) => built[c])
		}
	}
	return defined(built[0], "the root")
}

/** A tree's direct pre-order numbering: each node's id, start and end. */
const numberedOf = (
	parentOf: ReadonlyArray<number>,
	base: number
): ReadonlyArray<{ readonly id: string; readonly start: number; readonly end: number }> => {
	const count = parentOf.length + 1
	const kids: Array<Array<number>> = Array.from({ length: count }, () => [])
	for (const [i, p] of parentOf.entries()) {
		defined(kids[p], "a parent").push(i + 1)
	}
	const rows: Array<{ readonly id: string; readonly start: number; readonly end: number }> = []
	const size = (n: number): number => Arr.reduce(defined(kids[n], "kids"), 1, (s, c) => s + size(c))
	const visit = (n: number, start: number): void => {
		rows.push({ id: uuidOf(base + n), start, end: start + size(n) })
		let next = start + 1
		for (const c of defined(kids[n], "kids")) {
			visit(c, next)
			next += size(c)
		}
	}
	visit(0, 0)
	return rows
}

type Feature = "an empty family" | "a deep tree" | "two trees"

describe("a nested write through the program", () => {
	it.effect(
		"writes owners with their folded families and trees with their nodes as their own rows and family steps, in order",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/nested/program",
						generator: caseGen,
						literal: Formatter.format,
						limit: 20_000,
						coverage: requiredInSpace<Feature>(["an empty family", "a deep tree", "two trees"]),
						caseHang,
						box: "one or two owners of up to two lines of quantity 0 or 1, one or two trees of up to four nodes",
						oracle: { kind: "specification", name: "the nested write's rows (w4-w7 §3.10)" }
					},
					(box, c) =>
						Effect.gen(function* () {
							const docs = Arr.map(box.docs, (qtys, d) => ({
								id: uuidOf(100 + d),
								lines: Arr.map(qtys, (qty, i) => ({
									id: uuidOf(200 + 10 * d + i),
									qty: BigInt(qty)
								}))
							}))
							const roots = Arr.map(box.trees, (parentOf, t) => ({
								...treeFacts(parentOf, 300 + 10 * t),
								root: uuidOf(900 + t)
							}))
							const value = ChangeSet.empty(Nested).insert(Doc, docs).insert(Node, roots)
							const program = compiled(value)
							const members = yield* collectInputs(program.binding.groups, parsedOf(value).inputs)
							const bound = succeeded(
								bindWrite(runnableWrite(program, program.frontend.codes), {
									members,
									params: {},
									transport: inForce(bindFrame)
								})
							)
							assert.equal(bound.kind, "bound", "the facts bind")
							if (bound.kind !== "bound") {
								return
							}
							assertVariant(
								bound.flights,
								"kind",
								"write",
								"a nested write reads nothing first: every group it writes is its own new owner's"
							)
							const { chunks } = bound.flights
							const statements = program.artifact.statements
							const additions = defined(
								Option.getOrUndefined(
									Arr.findFirst(
										statements,
										(s) => s.step.kind === "familyWrite" && s.step.statement === "additions"
									)
								),
								"the stratum's family additions"
							)
							const owner = defined(
								Arr.findFirst(
									statements,
									(s) => s.step.kind === "write" && s.step.relation === "Doc"
								).pipe((o) => (o._tag === "Some" ? o.value : undefined)),
								"the owner's own insert"
							)
							assert.ok(
								additions.index > owner.index,
								"the stratum's family additions follow its own statements"
							)
							const group = defined(program.binding.groups[0], "the owner's slot group")
							const [input] = group.inputs
							const [slot] = inputSlotsOf(input)
							const tops = bound.flights.stated.slot(group, input, slot)
							for (const doc of docs) {
								const top = defined(
									Option.getOrUndefined(Arr.findFirst(tops, (t) => t.stated["id"] === doc.id)),
									"each owner's own row"
								)
								assert.deepEqual(
									top.filled(fieldKey("lines")),
									{ kind: "filled", value: BigInt(doc.lines.length) },
									"the owner's count, as the write fills it, is its family's length"
								)
								assert.deepEqual(
									top.filled(fieldKey("total")),
									{ kind: "filled", value: Arr.reduce(doc.lines, 0n, (s, l) => s + l.qty) },
									"the owner's end, as the write fills it, is its members' sum"
								)
								if (doc.lines.length === 0) {
									c.note("an empty family")
								}
							}
							const nodeIds = nestedRowsColumn(program, chunks, "Node", 0)
							const expectedIds = Arr.flatMap(box.trees, (parentOf, t) =>
								Arr.map(numberedOf(parentOf, 300 + 10 * t), (r) => r.id)
							)
							assert.deepEqual(nodeIds, expectedIds, "a tree's nodes go in pre-order, tree by tree")
							const starts = nestedRowsColumn(program, chunks, "Node", 4)
							const expectedStarts = Arr.flatMap(box.trees, (parentOf, t) =>
								Arr.map(numberedOf(parentOf, 300 + 10 * t), (r) => String(r.start))
							)
							assert.deepEqual(
								starts,
								expectedStarts,
								"each node's start is its pre-order position"
							)
							if (Arr.some(box.trees, (p) => p.length >= 3 && Arr.every(p, (x, i) => x === i))) {
								c.note("a deep tree")
							}
							if (box.trees.length === 2) {
								c.note("two trees")
							}
						})
				)
			)
	)
})

/** An array literal's elements, `{"a","b"}` or `{a,b}`: uuids and naturals, which hold no quote or comma, unquoted. */

interface StatedFact {
	readonly doc: number
	readonly lines: ReadonlyArray<number>
}

interface SetCase {
	readonly facts: ReadonlyArray<StatedFact>
	/** How many of the facts, from the first, the array member states; the Stream member states the rest. */
	readonly inArray: number
}

const setCaseGen: Gen<SetCase> = (source) => {
	const facts = source.draw(
		array(
			(s: typeof source): StatedFact => ({
				doc: s.draw(int(0, 1)),
				lines: s.draw(array(int(0, 1), { min: 0, max: 2 }))
			}),
			{ min: 1, max: 3 }
		)
	)
	return { facts, inArray: source.draw(int(0, facts.length)) }
}

const docFact = (f: StatedFact) => ({
	id: uuidOf(100 + f.doc),
	lines: Arr.map(f.lines, (l) => ({ id: uuidOf(200 + l), qty: 1n }))
})

/** A fact's identity in the specification's model: its doc and its lines, in order. */
const statedIdentity = (f: StatedFact): string =>
	`${f.doc}:${Arr.join(Arr.map(f.lines, String), ",")}`

/** The schema's law names, which the set box's refusals name: compiled once, since compiling the laws is costly. */
const lawNames = lawNamesOf(Nested)

type SetFeature =
	| "an identical repeat in one member"
	| "an identical repeat across members"
	| "a conflict at the owner's key"
	| "a member under two owners"
	| "a member twice under one owner"
	| "accepted with members"

describe("a nested write's facts are a set by identity (rule 0, ruling 1)", () => {
	it.effect(
		"writes a fact stated twice once, and refuses two facts at one key by that key's law before any SQL",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/nested/set",
						generator: setCaseGen,
						literal: Formatter.format,
						limit: 20_000,
						coverage: requiredInSpace<SetFeature>([
							"an identical repeat in one member",
							"an identical repeat across members",
							"a conflict at the owner's key",
							"a member under two owners",
							"a member twice under one owner",
							"accepted with members"
						]),
						caseHang,
						box: "one to three Doc facts of two ids, each nesting up to two Lines of two ids, split between an array and a Stream member",
						oracle: {
							kind: "specification",
							name: "a ChangeSet's facts are a set by identity, two at one key refused by its key law"
						}
					},
					(box, c) =>
						Effect.gen(function* () {
							const stated = Arr.map(box.facts, docFact)
							const value = ChangeSet.empty(Nested)
								.insert(Doc, Arr.take(stated, box.inArray))
								.insert(Doc, Stream.fromIterable(Arr.drop(stated, box.inArray)))
							const setShaped = compiled(value)
							const members = yield* collectInputs(setShaped.binding.groups, parsedOf(value).inputs)
							const bound = succeeded(
								bindWrite(runnableWrite(setShaped, setShaped.frontend.codes), {
									members,
									params: {},
									transport: inForce(bindFrame)
								})
							)
							/** The specification: the stated facts as a set by identity, then the keys it holds twice. */
							const distinct = Arr.dedupeWith(
								box.facts,
								(a, b) => statedIdentity(a) === statedIdentity(b)
							)
							const repeated = distinct.length < box.facts.length
							const docs = Arr.map(distinct, (f) => f.doc)
							const lineIds = Arr.flatMap(distinct, (f) => f.lines)
							const docConflict = Arr.dedupe(docs).length < docs.length
							const lineConflict = Arr.dedupe(lineIds).length < lineIds.length
							if (repeated) {
								const ids = Arr.map(box.facts, statedIdentity)
								const front = Arr.take(ids, box.inArray)
								const back = Arr.drop(ids, box.inArray)
								c.note(
									Arr.some(front, (id) => Arr.contains(back, id))
										? "an identical repeat across members"
										: "an identical repeat in one member"
								)
							}
							if (docConflict) {
								c.note("a conflict at the owner's key")
								assertVariant(bound, "kind", "invariant-rejected", "two Docs at one key")
								assert.equal(bound.law, lawNames.primaryKeyLaw(Doc), "refused by Doc's key law")
								return
							}
							if (lineConflict) {
								c.note(
									Arr.some(distinct, (f) => Arr.dedupe(f.lines).length < f.lines.length)
										? "a member twice under one owner"
										: "a member under two owners"
								)
								assertVariant(bound, "kind", "invariant-rejected", "two Lines at one key")
								assert.equal(bound.law, lawNames.primaryKeyLaw(Line), "refused by Line's key law")
								return
							}
							assertVariant(bound, "kind", "bound", "a set with one fact at each key binds")
							assertVariant(
								bound.flights,
								"kind",
								"write",
								"a nested write reads nothing first: every group it writes is its own new owner's"
							)
							const written = nestedRowsColumn(setShaped, bound.flights.chunks, "Line", 0)
							assert.deepEqual(
								Arr.sort(written, Str.Order),
								Arr.sort(
									Arr.map(lineIds, (l) => uuidOf(200 + l)),
									Str.Order
								),
								"each Line of the set is written once"
							)
							if (lineIds.length > 0) {
								c.note("accepted with members")
							}
						})
				)
			)
	)
})

/** A chain of `n` nodes, each the one child of the one before, ids from `base`, built from its leaf up. */
const chainOf = (
	n: number,
	base: number
): { readonly id: string; readonly children: ReadonlyArray<unknown> } => {
	let node: { readonly id: string; readonly children: ReadonlyArray<unknown> } = {
		id: uuidOf(base + n - 1),
		children: []
	}
	for (let k = n - 2; k >= 0; k -= 1) {
		node = { id: uuidOf(base + k), children: [node] }
	}
	return node
}

/** A star of `n` nodes: a root and its n − 1 leaves. */
const starOf = (
	n: number,
	base: number
): { readonly id: string; readonly children: ReadonlyArray<unknown> } => ({
	id: uuidOf(base),
	children: Array.from({ length: n - 1 }, (_, i) => ({ id: uuidOf(base + 1 + i), children: [] }))
})

type ShapeFeature = "a chain" | "a star" | "a hundred thousand nodes"

describe("a nested tree at depth and width", () => {
	it.effect(
		"numbers a chain's and a star's nodes in pre-order at sizes up to a hundred thousand, with no recursion",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/nested/depth",
						generator: (source) => ({
							shape: source.draw(element(["chain", "star"] as const)),
							n: source.draw(element([1, 2, 3, 99_999, 100_000] as const))
						}),
						literal: Formatter.format,
						limit: 20,
						coverage: requiredInSpace<ShapeFeature>([
							"a chain",
							"a star",
							"a hundred thousand nodes"
						]),
						caseHang,
						box: "a chain and a star of 1, 2, 3, 99,999 and 100,000 nodes",
						oracle: {
							kind: "specification",
							name: "a chain's and a star's pre-order numbering in closed form"
						}
					},
					(box, c) =>
						Effect.gen(function* () {
							const root = box.shape === "chain" ? chainOf(box.n, 1000) : starOf(box.n, 1000)
							const value = ChangeSet.empty(Nested).insert(Node, [{ ...root, root: uuidOf(999) }])
							const treeShaped = compiled(value)
							const members = yield* collectInputs(
								treeShaped.binding.groups,
								parsedOf(value).inputs
							)
							const bound = succeeded(
								bindWrite(runnableWrite(treeShaped, treeShaped.frontend.codes), {
									members,
									params: {},
									transport: inForce(bindFrame)
								})
							)
							assertVariant(bound, "kind", "bound", "a tree binds")
							assertVariant(bound.flights, "kind", "write", "a fresh tree reads nothing first")
							const { chunks } = bound.flights
							const starts = nestedRowsColumn(treeShaped, chunks, "Node", 4)
							const ends = nestedRowsColumn(treeShaped, chunks, "Node", 5)
							assert.equal(starts.length, box.n, "every node is written once")
							for (let k = 0; k < box.n; k += 1) {
								const [start, end] =
									box.shape === "chain" ? [k, box.n] : k === 0 ? [0, box.n] : [k, k + 1]
								assert.equal(
									Number(defined(starts[k], "a start")),
									start,
									"a node's start is its pre-order position"
								)
								assert.equal(
									Number(defined(ends[k], "an end")),
									end,
									"a node's end is past its subtree"
								)
							}
							c.note(box.shape === "chain" ? "a chain" : "a star")
							if (box.n === 100_000) {
								c.note("a hundred thousand nodes")
							}
						})
				)
			)
	)
})
