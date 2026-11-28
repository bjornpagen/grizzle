/** What shares.test.ts reads: its schema, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Result, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import type { HostCall } from "#adapter/apply/run.ts"
import { type DrawnShares, drawShares, eachShare, sendsAlone } from "#adapter/apply/shares.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { accumulated, drawn, natural, int8 } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	fold,
	Monoid,
	on,
	ordered,
	relation,
	schema,
	tree
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { valueBytes } from "#compiler/runtime/write/read-call.ts"
import { inForce, writeBatching } from "#compiler/runtime/write/transport.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/support/unit/write/changeset/fixtures.ts"

const Text = str.bytes(512, str.regex("^.*$", "su"))

/** Nodes of documents, wide: learning-commons' standards are facts of this width, inserted by the hundred thousand. */
const Wide = relation("Wide", { doc: int8, path: Text, at: int8, body: Text }, [
	"doc",
	"path",
	"at"
])

const Shared = schema("Shares", [Wide], [])

const reality = realityWrite(succeeded(testArtifacts(Shared, testCompile)))

/** A case: how wide each fact's body is, and how the call's facts are drawn, one share at a time or all at once. */
export interface Drawn {
	readonly body: number
}

export const drawnGen: Gen<Drawn> = (s) => ({ body: s.draw(int(100, 300)) })

export type Feature = "a narrow body" | "a wide body"

/** Fact `i` of a case. */
const factOf = (c: Drawn, i: number) => ({
	doc: BigInt(i % 7),
	path: `document/${Str.padStart(6, "0")(String(i % 997))}/${Str.repeat(60)("p")}`,
	at: BigInt(i),
	body: `${Str.repeat(c.body)("b")}${String(i)}`
})

/** A call as drawShares draws it, its facts read; a refusal of the read fails the case. */
const drawnOf = (drawn: Result.Result<DrawnShares, EncodingFailure>): DrawnShares =>
	Result.isFailure(drawn)
		? assert.fail(`a call of lawful facts reads: ${Formatter.format(drawn.failure)}`)
		: drawn.success

/** The facts a call holds and their bytes, as a share counts them (runtime/write/read-call.ts valueBytes). */
const heldBy = (call: HostCall): { readonly facts: number; readonly bytes: number } => {
	let facts = 0
	let bytes = 0
	for (const given of call.members.values()) {
		for (const fact of Arr.isArray(given) ? given : Arr.fromIterable(given)) {
			facts += 1
			bytes += valueBytes(fact)
		}
	}
	return { facts, bytes }
}

/**
 * What one call of `shares` shares' worth of facts binds at once, drawn share by share (`drawShares`) and bound and sent
 * a share at a time (`eachShare`), each share's statements' executions built as the write sends them: the most shares
 * bound and not yet sent at any moment, which the work of binding and building holds, and each share's facts and bytes.
 * It counts the binder's own work, so its verdict is the program's and no collection's timing reads into it.
 */
const sharesOf = (c: Drawn, shares: number) =>
	Effect.gen(function* () {
		const perShare = Math.floor(writeBatching.bytes / valueBytes(factOf(c, 0)))
		const facts = Arr.map(
			Array.from({ length: shares * perShare }, (_, i) => i),
			(i) => factOf(c, i)
		)
		const change = ChangeSet.empty(Shared).insert(Wide, facts)
		const program = succeeded(compileWrite(checking(Shared), descOf(change), reality))
		const write = flightOf(servableWrite(program), program.frontend.codes, noAdvice)
		const members = collectInputs(program.binding.groups, parsedOf(change).inputs)
		const call = { params: {}, bound: new Map(), members }
		const read = drawnOf(drawShares(write, call, writeBatching.bytes, false))
		const drawn = read.shares ?? [read.whole]
		const held: Array<{ readonly facts: number; readonly bytes: number }> = []
		let pending = 0
		let most = 0
		const sent = yield* eachShare(
			drawn,
			(share) =>
				Effect.sync(() => {
					pending += 1
					most = Math.max(most, pending)
					held.push(heldBy(share))
					return bindWrite(write, {
						members: share.members,
						params: {},
						transport: inForce(bindFrame)
					})
				}),
			(bound) =>
				Effect.sync(() => {
					if (!bound.ok || bound.value.kind !== "bound") {
						throw new Error("a share of distinct facts binds")
					}
					const executions = Arr.flatMap(write.statements, (s) => {
						const built =
							bound.value.kind === "bound" ? bound.value.chunks(s, inForce(bindFrame)) : undefined
						return built?.ok === true ? built.value : []
					})
					pending -= 1
					return executions.length
				})
		)
		return { most, held, shares: sent.length, facts: facts.length }
	})

/**
 * One case: what one call binds at once, at one share's worth of facts, at four and at sixteen. Drawn and bound a share
 * at a time, every call binds one share at a time, each share within one share's bytes, the shares together every fact
 * once.
 */
export const runShares = (c: Drawn, k: Case<Feature>) =>
	Effect.gen(function* () {
		const one = yield* sharesOf(c, 1)
		const four = yield* sharesOf(c, 4)
		const sixteen = yield* sharesOf(c, 16)
		k.note(c.body < 200 ? "a narrow body" : "a wide body")
		return { one, four, sixteen }
	})

/**
 * learning-commons' families in one schema: an owner and its ordered members, nested in its fact, as Standard and
 * StandardChild; a tree, every node nested in its root's fact, as Outline; and a counted family whose members are facts
 * of their own, as GuidanceArea and Guideline. And qti-pie's import, pantry's Node and Attribute: each tree's node owns
 * a counted family of Marks, facts of their own naming their node by its root and its `start`, which the walk draws and
 * no fact states, their values folded into the node's `weight`, as Attribute's slots into Node.attrs (AL2), which AL3
 * holds to the slots its governor requires.
 */
const Owner = relation("Owner", { id: int8, children: drawn(natural) }, ["id"])

const Child = relation("Child", { parent: int8, at: drawn(natural), value: int8 }, ["parent", "at"])

const Node = relation(
	"Node",
	{
		root: int8,
		start: drawn(natural),
		end: drawn(natural),
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		label: int8,
		marks: drawn(natural),
		weight: accumulated(int8, 0n)
	},
	["root", "start"]
)

const Mark = relation("Mark", { root: int8, start: natural, name: int8, v: int8 }, [
	"root",
	"start",
	"name"
])

const nodeMarks = counted(on(Mark, "root", "start"), fin(Node, "marks"))

const Area = relation("Area", { area: int8, members: drawn(natural) }, ["area"])

const Member = relation("Member", { member: int8, area: int8 }, ["member"])

const Families = schema(
	"ShareFamilies",
	[Owner, Child, Node, Mark, Area, Member],
	[
		ordered(on(Child, "parent", "at"), fin(Owner, "children")),
		tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["root"] }),
		nodeMarks,
		fold(
			nodeMarks,
			Monoid.sum,
			on(Mark, "root", "start", "v"),
			on(Node, "root", "start", "weight")
		),
		counted(on(Member, "area"), fin(Area, "members"))
	]
)

const familiesReality = realityWrite(succeeded(testArtifacts(Families, testCompile)))

/**
 * A case of the families: how many owners, trees and areas, how many members each holds (an owner's ordered members,
 * a tree's nodes under its root, an area's counted members, a node's marks), and the bytes a share holds, small, so a
 * call is many shares.
 */
export interface Grouped {
	readonly owners: number
	readonly trees: number
	readonly areas: number
	readonly members: number
	readonly bytes: number
}

export const groupedGen: Gen<Grouped> = (s) => ({
	owners: s.draw(int(3, 12)),
	trees: s.draw(int(2, 8)),
	areas: s.draw(int(3, 12)),
	members: s.draw(int(1, 9)),
	bytes: s.draw(int(200, 1200))
})

export type GroupedFeature =
	| "a call of several shares"
	| "a group past a share"
	| "a tree's nodes and their marks past a share"

/** A tree's node below its root, `label` its own, with `width` children each until depth 2. */
interface TreeNode {
	readonly label: bigint
	readonly children: ReadonlyArray<TreeNode>
}

/** How many nodes nodeOf's tree of `width` holds: its root, its children and theirs. */
const treeSize = (width: number): number => 1 + width + width * width

/** A tree's node at `depth` below its root, `label` its own, with `width` children each until depth 2. */
const nodeOf = (label: number, depth: number, width: number): TreeNode => ({
	label: BigInt(label),
	children:
		depth >= 2
			? []
			: Arr.map(
					Array.from({ length: width }, (_, i) => i + 1),
					(i) => nodeOf(label * 10 + i, depth + 1, width)
				)
})

/** Each relation's inserted rows, every cell as text, sorted: what a bind fills before any SQL. */
const insertedRows = (
	bound: ReturnType<typeof bindWrite>
): ReadonlyMap<string, ReadonlyArray<string>> => {
	if (!bound.ok || bound.value.kind !== "bound") {
		throw new Error("a call of distinct facts binds")
	}
	const out = new Map<string, Array<string>>()
	for (const stratum of bound.value.inserted()) {
		for (const [relation, rows] of stratum.rows) {
			const held = out.get(relation) ?? []
			for (const row of rows) {
				held.push(
					Arr.join(
						Arr.map(row.values, (cell) => String(cell)),
						"|"
					)
				)
			}
			out.set(relation, held)
		}
	}
	return new Map(
		Arr.map([...out], ([relation, rows]) => [relation, Arr.sort(rows, Order.String)] as const)
	)
}

/**
 * One case: the call of every family's facts bound whole, and drawn in shares of `bytes` (drawShares) each bound alone:
 * every share's inserted rows together are the whole call's, every count, end, slot, tree position and member slot the
 * host draws as the whole call draws it, since a share holds whole groups.
 */
export const runGrouped = (c: Grouped, k: Case<GroupedFeature>) =>
	Effect.gen(function* () {
		const owners = Arr.map(
			Array.from({ length: c.owners }, (_, i) => i + 1),
			(id) => ({
				id: BigInt(id),
				children: Arr.map(
					Array.from({ length: c.members }, (_, i) => i + 1),
					(i) => ({ value: BigInt(id * 100 + i) })
				)
			})
		)
		const trees = Arr.map(
			Array.from({ length: c.trees }, (_, i) => i + 1),
			(root) => ({
				root: BigInt(root),
				...nodeOf(root, 0, Math.max(1, Math.min(3, c.members)))
			})
		)
		const areas = Arr.map(
			Array.from({ length: c.areas }, (_, i) => i + 1),
			(area) => ({ area: BigInt(area) })
		)
		const members = Arr.flatMap(
			Array.from({ length: c.areas }, (_, i) => i + 1),
			(area) =>
				Arr.map(
					Array.from({ length: c.members }, (_, i) => i + 1),
					(i) => ({
						member: BigInt(area * 100 + i),
						area: BigInt(area)
					})
				)
		)
		/** Each tree's every node, by its start in pre-order (a root's 0), marked `members` times, each mark's value its
		 * name, as an import states each element's attributes beside its document's tree. */
		const nodes = treeSize(Math.max(1, Math.min(3, c.members)))
		const marks = Arr.flatMap(trees, (t) =>
			Arr.flatMap(
				Array.from({ length: nodes }, (_, start) => start),
				(start) =>
					Arr.map(
						Array.from({ length: c.members }, (_, i) => i + 1),
						(name) => ({ root: t.root, start: BigInt(start), name: BigInt(name), v: BigInt(name) })
					)
			)
		)
		const change = ChangeSet.empty(Families).insertAll({
			Owner: owners,
			Node: trees,
			Mark: marks,
			Area: areas,
			Member: members
		})
		const program = succeeded(compileWrite(checking(Families), descOf(change), familiesReality))
		const write = flightOf(servableWrite(program), program.frontend.codes, noAdvice)
		const membersOf = collectInputs(program.binding.groups, parsedOf(change).inputs)
		const call = { params: {}, bound: new Map(), members: membersOf }
		const whole = insertedRows(
			bindWrite(write, { members: membersOf, params: {}, transport: inForce(bindFrame) })
		)
		const none = new Map(Arr.map(write.binding.members, (m) => [m.slot, []] as const))
		const empty = bindWrite(write, { members: none, params: {}, transport: inForce(bindFrame) })
		if (!empty.ok || empty.value.kind !== "bound") {
			return yield* Effect.die(new Error("a call of no facts binds"))
		}
		const drawn = drawnOf(
			drawShares(write, call, c.bytes, sendsAlone(write, empty.value.skip))
		).shares
		if (drawn === undefined) {
			return { whole, shared: whole, shares: 1 }
		}
		const shared = new Map<string, Array<string>>()
		let shares = 0
		for (const share of drawn) {
			shares += 1
			const rows = insertedRows(
				bindWrite(write, { members: share.members, params: {}, transport: inForce(bindFrame) })
			)
			for (const [relation, held] of rows) {
				shared.set(relation, [...(shared.get(relation) ?? []), ...held])
			}
		}
		if (shares > 1) {
			k.note("a call of several shares")
		}
		if (shares > 1 && c.members * 60 > c.bytes) {
			k.note("a group past a share")
		}
		if (shares > 1 && nodes * c.members * 40 > c.bytes) {
			k.note("a tree's nodes and their marks past a share")
		}
		return {
			whole,
			shared: new Map(
				Arr.map([...shared], ([r, rows]) => [r, Arr.sort(rows, Order.String)] as const)
			),
			shares
		}
	})
