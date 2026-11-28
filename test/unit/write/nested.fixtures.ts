/** What the properties of nested.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { array, type Gen, int, parents } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	fin,
	fold,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema,
	tree,
	unit
} from "#compiler/public/schema.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { lawNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { checking, owning } from "#test/support/policy.ts"
import { descOf, uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** Doc(id, lines drawn, total accumulated): the owner of the ordered family of Line. */
export const Doc = relation(
	"Doc",
	{ id: Id, lines: drawn(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)

export const Line = relation("Line", { id: Id, doc: Id, at: drawn(natural), qty: pg.bigint }, [
	"id"
])

export const Node = relation(
	"Node",
	{
		root: Id,
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		label: pg.bigint
	},
	["root", "start"]
)

const lines = ordered(on(Line, "doc", "at"), fin(Doc, "lines"))

export const Nested = schema(
	"Nested",
	[Doc, Line, Node],
	[
		unit("Row", { id: Id }),
		mutable(Doc),
		lines,
		fold(lines, Monoid.sum, on(Line, "doc", "qty"), on(Doc, "id", "total")),
		tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["root"] })
	]
)

const nested = owning(Nested)

const names: WriteNames = succeeded(
	compileInstallation(nested, {
		...installOptions(nested),
		levels: [identity.schema(parsedSchemaName("nested"))]
	})
).names

const artifacts = succeeded(testArtifacts(Nested, testCompile))

/** A ChangeSet value compiled over the nested schema, at SERIALIZABLE. */
export const nestedCompiled = (value: unknown): CompiledWrite =>
	succeeded(
		compileWrite(checking(Nested), descOf(value), {
			names,
			reads: names,
			claims: { kind: "every" },
			world: { kind: "reality" },
			laws: artifacts.laws,
			derived: artifacts.derived,
			level: "serializable",
			clock: noClock,
			source: transactionClock
		})
	)

interface NestedCase {
	readonly docs: ReadonlyArray<ReadonlyArray<number>>
	readonly trees: ReadonlyArray<ReadonlyArray<number>>
}

export const caseGen: Gen<NestedCase> = (source) => ({
	docs: source.draw(array(array(int(0, 1), { min: 0, max: 2 }), { min: 1, max: 2 })),
	trees: source.draw(array(parents({ min: 1, max: 4 }), { min: 1, max: 2 }))
})

/** A node as its tree's facts nest it: its label and its children at `children`. */
interface LabelledNode {
	readonly label: bigint
	readonly children: ReadonlyArray<LabelledNode>
}

/** A tree's nested facts, node labels from `base`: each node its label and its children at `children`. */
export const treeFacts = (parentOf: ReadonlyArray<number>, base: number): LabelledNode => {
	const count = parentOf.length + 1
	const kids: Array<Array<number>> = Array.from({ length: count }, () => [])
	for (const [i, p] of parentOf.entries()) {
		defined(kids[p], "a parent").push(i + 1)
	}
	const built: Array<LabelledNode> = []
	for (let n = count - 1; n >= 0; n -= 1) {
		built[n] = {
			label: BigInt(base + n),
			children: Arr.map(defined(kids[n], "a node's children"), (c) =>
				defined(built[c], "a child built before its parent")
			)
		}
	}
	return defined(built[0], "the root")
}

/** A tree's direct pre-order numbering: each node's label, start and end. */
export const numberedOf = (
	parentOf: ReadonlyArray<number>,
	base: number
): ReadonlyArray<{ readonly label: string; readonly start: number; readonly end: number }> => {
	const count = parentOf.length + 1
	const kids: Array<Array<number>> = Array.from({ length: count }, () => [])
	for (const [i, p] of parentOf.entries()) {
		defined(kids[p], "a parent").push(i + 1)
	}
	const rows: Array<{ readonly label: string; readonly start: number; readonly end: number }> = []
	const size = (n: number): number => Arr.reduce(defined(kids[n], "kids"), 1, (s, c) => s + size(c))
	const visit = (n: number, start: number): void => {
		rows.push({ label: String(base + n), start, end: start + size(n) })
		let next = start + 1
		for (const c of defined(kids[n], "kids")) {
			visit(c, next)
			next += size(c)
		}
	}
	visit(0, 0)
	return rows
}

export type Feature = "an empty family" | "a deep tree" | "two trees"

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

export const setCaseGen: Gen<SetCase> = (source) => {
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

export const docFact = (f: StatedFact) => ({
	id: uuidOf(100 + f.doc),
	lines: Arr.map(f.lines, (l) => ({ id: uuidOf(200 + l), qty: 1n }))
})

/** A fact's identity in the specification's model: its doc and its lines, in order. */
export const statedIdentity = (f: StatedFact): string =>
	`${f.doc}:${Arr.join(Arr.map(f.lines, String), ",")}`

/** The schema's law names, which the set box's refusals name: compiled once, since compiling the laws is costly. */
export const lawNames = lawNamesOf(Nested)

export type SetFeature =
	| "an identical repeat in one member"
	| "an identical repeat across members"
	| "a conflict at the owner's key"
	| "a member under two owners"
	| "a member twice under one owner"
	| "accepted with members"

/** A chain of `n` nodes, each the one child of the one before, labels from `base`, built from its leaf up. */
export const chainOf = (n: number, base: number): LabelledNode => {
	let node: LabelledNode = { label: BigInt(base + n - 1), children: [] }
	for (let k = n - 2; k >= 0; k -= 1) {
		node = { label: BigInt(base + k), children: [node] }
	}
	return node
}

/** A star of `n` nodes: a root and its n − 1 leaves. */
export const starOf = (n: number, base: number): LabelledNode => ({
	label: BigInt(base),
	children: Array.from({ length: n - 1 }, (_, i) => ({ label: BigInt(base + 1 + i), children: [] }))
})

export type ShapeFeature = "a chain" | "a star" | "a hundred thousand nodes"
