import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, type Gen, int, parents } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
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
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { inForce } from "#compiler/write/family/order.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
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
		installation: identity.schema(parsedSchemaName("nested"))
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
			derived: artifacts.derived
		})
	)

/** The program of the box's one ChangeSet shape, an insert of owners and one of tree roots, compiled once: its
 * Description names its members' slots, never their facts, so every case binds its own facts to it. */
let shaped: CompiledWrite | undefined
const programOf = (value: unknown): CompiledWrite => {
	shaped ??= compiled(value)
	return shaped
}

interface NestedCase {
	readonly docs: ReadonlyArray<ReadonlyArray<number>>
	readonly trees: ReadonlyArray<ReadonlyArray<number>>
	readonly oneRowEach: boolean
}

const caseGen: Gen<NestedCase> = (source) => ({
	docs: source.draw(array(array(int(0, 1), { min: 0, max: 2 }), { min: 1, max: 2 })),
	trees: source.draw(array(parents({ min: 1, max: 4 }), { min: 1, max: 2 })),
	oneRowEach: source.draw(int(0, 1)) === 1
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

type Feature = "an empty family" | "a chunked family" | "a deep tree" | "two trees"

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
						coverage: requiredInSpace<Feature>([
							"an empty family",
							"a chunked family",
							"a deep tree",
							"two trees"
						]),
						caseHang,
						box: "one or two owners of up to two lines of quantity 0 or 1, one or two trees of up to four nodes, two transports",
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
							const program = programOf(value)
							const members = yield* collectInputs(program.frontend, parsedOf(value).inputs)
							const transport = box.oneRowEach
								? { ...inForce(bindFrame), literalUnits: 40 }
								: inForce(bindFrame)
							const bound = succeeded(bindWrite(program, { members, params: {}, transport }))
							assert.equal(bound.kind, "bound", "the facts bind")
							if (bound.kind !== "bound") {
								return
							}
							const statements = program.artifacts.optimized.statements
							const family = Arr.filter(statements, (s) => s.step.kind === "family")
							const owner = defined(
								Arr.findFirst(
									statements,
									(s) => s.step.kind === "write" && s.step.relation === "Doc"
								).pipe((o) => (o._tag === "Some" ? o.value : undefined)),
								"the owner's own insert"
							)
							for (const s of family) {
								assert.ok(
									s.index > owner.index,
									"every family step follows its stratum's own statements"
								)
							}
							const slot = defined(bound.normalized.slots.values().next().value, "the owner's slot")
							const tops = Arr.map(slot.facts, (fact) => fact)
							for (const doc of docs) {
								const top = defined(
									Option.getOrUndefined(Arr.findFirst(tops, (t) => t["id"] === doc.id)),
									"each owner's own row"
								)
								assert.equal(
									top["lines"],
									BigInt(doc.lines.length),
									"the owner's count is its family's length"
								)
								assert.equal(
									top["total"],
									Arr.reduce(doc.lines, 0n, (s, l) => s + l.qty),
									"the owner's end is its members' sum"
								)
								if (doc.lines.length === 0) {
									c.note("an empty family")
								}
							}
							const lineStep = defined(
								Option.getOrUndefined(
									Arr.findFirst(
										family,
										(s) => s.step.kind === "family" && s.step.relation === "Line"
									)
								),
								"the family's insert step"
							)
							const lineChunks = succeeded(bound.chunks(lineStep))
							if (lineChunks.length > 1) {
								c.note("a chunked family")
							}
							const nodeStep = defined(
								Option.getOrUndefined(
									Arr.findFirst(
										family,
										(s) => s.step.kind === "family" && s.step.relation === "Node"
									)
								),
								"the tree's insert step"
							)
							const nodeChunks = succeeded(bound.chunks(nodeStep))
							const nodeIds = Arr.flatMap(nodeChunks, (chunk) =>
								arrayItems(defined(chunk[7], "the ids' array"))
							)
							const expectedIds = Arr.flatMap(box.trees, (parentOf, t) =>
								Arr.map(numberedOf(parentOf, 300 + 10 * t), (r) => r.id)
							)
							assert.deepEqual(nodeIds, expectedIds, "a tree's nodes go in pre-order, tree by tree")
							const starts = Arr.flatMap(nodeChunks, (chunk) =>
								arrayItems(defined(chunk[4], "the starts' array"))
							)
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
const arrayItems = (literal: string): ReadonlyArray<string> =>
	literal === "{}"
		? []
		: Arr.map(Str.split(Str.slice(1, -1)(literal), ","), (item) =>
				Str.startsWith('"')(item) && Str.endsWith('"')(item) ? Str.slice(1, -1)(item) : item
			)
