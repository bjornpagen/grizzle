/** What the properties of existence.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { exprClosure, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	conservativeMeta,
	exprsOf,
	type NodeOf,
	type RelDag,
	type RelNode
} from "#compiler/ir/rel.ts"
import { query, v } from "#compiler/public/query.ts"
import { Agree, Item, Owned, Slot } from "#test/support/agreement/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { keyConstraintName } from "#test/support/evidence.ts"
import type { CountedFunction } from "#test/support/kernel/calls.ts"
import {
	Account as AccountRelation,
	Edge,
	type OccurrenceSpec,
	plainRegion,
	Posting,
	Q,
	type RelationSpec,
	T,
	uuidOf
} from "#test/support/unit/lower/conservative/fixtures.ts"
import {
	deliversAlikeOn,
	factSubsets,
	type HandFacts,
	ledgerCatalog,
	lowersConservatively,
	passContext,
	queryOf,
	type Ran,
	runPasses
} from "#test/support/unit/lower/rewrite/support.ts"
import { correlatedSources } from "#test/unit/lower/rewrite/guarded.ts"

/** A uuid literal of the ledger fixture's n-th id (conservative/fixtures.ts uuidOf). */
const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })

/** A bigint literal. */
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** A text literal. */
const text = (s: string): TypedLiteral => ({ kind: "text", value: s })

/**
 * Every database of these posting and account facts: two postings of account 10, one of account 11, one of account
 * 12, which no account holds, and two accounts named apart.
 */
export const databases = factSubsets({
	Posting: [
		[u(1), u(10), i8(5)],
		[u(2), u(10), i8(5)],
		[u(3), u(11), i8(7)],
		[u(4), u(12), i8(7)]
	],
	Account: [
		[u(10), text("a")],
		[u(11), text("b")]
	]
})

/**
 * The Account occurrence of a posting's match: existence only (it binds its id, which the posting binds too), or the
 * same with its name fixed. One that binds a witness of its own, which the query delivers, is never touched: a semi-join's
 * right side delivers nothing, so the generated pass-alone search (generated.test.ts) would see the witness go.
 */
export type Account = "existence only" | "with a constant"

/**
 * Who reads the region: a projection onto the posting's id, with the region's heading every bound variable or the id
 * alone (the shared account outside it), the query delivering that region as it is, or a fold over the complete bound
 * tuple.
 */
export type Reader =
	| "projection"
	| "projection, shared variable outside the heading"
	| "root, shared variable outside the heading"
	| "fold"

/**
 * The Posting occurrence's source: the stored relation, or a rule of its own projecting Posting through variables named
 * as the outer region's are, whose column references name the outer region's variables without reading them.
 */
export type PostingSource = "a scan" | "its own rule"

/**
 * A posting matched with the account it names, under the Account occurrence, the reader and the posting's source
 * drawn; the group node when the reader folds.
 */
export const matched = (account: Account, reader: Reader, posting: PostingSource) => {
	const q = new Q()
	const postingVariables = { id: "id", account: "acct", amount: "amount" }
	const postings =
		posting === "a scan"
			? q.base(Posting, conservativeMeta)
			: q.project(
					q.region([
						{ source: q.base(Posting, conservativeMeta), bind: postingVariables, constants: {} }
					]),
					[
						["id", "id"],
						["account", "acct"],
						["amount", "amount"]
					],
					conservativeMeta
				)
	const occurrences: ReadonlyArray<OccurrenceSpec> = [
		{
			source: postings,
			bind: postingVariables,
			constants: {}
		},
		account === "with a constant"
			? {
					source: q.base(AccountRelation, conservativeMeta),
					bind: { id: "acct" },
					constants: { name: q.lit(text("a"), T.text) }
				}
			: {
					source: q.base(AccountRelation, conservativeMeta),
					bind: { id: "acct" },
					constants: {}
				}
	]
	if (reader === "fold") {
		const region = q.region(occurrences)
		const group = q.group(
			region,
			["id", "acct", "amount"],
			["acct"],
			[{ name: "total", fn: "sum", op: "sum(bigint)", args: ["amount"], type: T.numeric }],
			conservativeMeta
		)
		return {
			dag: q.build(q.project(group, [["total", "total"]], conservativeMeta)).dag,
			group: [group]
		}
	}
	if (reader === "root, shared variable outside the heading") {
		return {
			dag: q.build(
				q.regionWith(occurrences, { ...plainRegion, heading: { kind: "named", names: ["id"] } })
			).dag,
			group: []
		}
	}
	const region =
		reader === "projection"
			? q.region(occurrences)
			: q.regionWith(occurrences, { ...plainRegion, heading: { kind: "named", names: ["id"] } })
	return { dag: q.build(q.project(region, [["id", "id"]], conservativeMeta)).dag, group: [] }
}

/** The databases a box's rewrites are held to, and the relations they read. */
export interface Facts {
	readonly databases: ReadonlyArray<HandFacts>
	readonly relations: ReadonlyArray<RelationSpec>
}

/** The posting and account facts (`databases`). */
export const ledgerFacts: Facts = { databases, relations: [Posting, AccountRelation] }

/**
 * Runs `passes` over the DAG in a snapshot, holding the result to every database of `facts`' delivery and to the
 * conservative lowering.
 */
export const rewritten = (
	dag: RelDag,
	passes: ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>,
	facts: Facts
): Ran => {
	const query = queryOf(dag, [])
	const ran = succeeded(
		runPasses(query, passes, passContext({ catalog: ledgerCatalog, evidence: "snapshot" }))
	)
	deliversAlikeOn(facts.databases, facts.relations, [], query, ran.query)
	lowersConservatively(ran.query, emptyCodebook)
	return ran
}

/**
 * Whether the region's other occurrences join the source the carrier relates to them beside the carrier too, so its
 * removal leaves the region connected; or only through it.
 */
export type Beside = "joined beside the carrier" | "joined through the carrier alone"

/** Whether a test of the carried column alone stands beside the carrier, another binder of the column. */
export type Dominated = "with a test of the carried column alone" | "with no other test"

/** The source the carrier relates to the rest: the stored relation, or a rule of its own. */
export type CarriedSource = "a scan" | "its own rule"

/**
 * Every edge of a few nodes, a cycle among them, a chord and a loop: the databases of the carried box, every subset of
 * them.
 */
export const edgeFacts: Facts = {
	databases: factSubsets({
		Edge: [
			[i8(1), i8(2)],
			[i8(2), i8(3)],
			[i8(3), i8(1)],
			[i8(2), i8(1)],
			[i8(3), i8(3)]
		]
	}),
	relations: [Edge]
}

/**
 * A region whose `carrier` occurrence is the only one relating a column of another to the rest of it, as the test's
 * member under qti-pie's ItemSessionControl relates the attempts in force to the item session: an edge s → p, the
 * carrier p → c, and the carried c → s, which shares s with the first where `beside` joins them, or reaches a node of
 * its own, x, where they are joined through the carrier alone; with a loop at c beside them, a test of the carried
 * column alone, where `dominated` asks. The carrier binds only what the others bind, an existence-only occurrence by
 * R02's own reading; the loop's column is the carried source's own, so it relates nothing.
 */
export const carried = (beside: Beside, dominated: Dominated, source: CarriedSource) => {
	const q = new Q()
	const edge = () => q.base(Edge, conservativeMeta)
	const far = beside === "joined beside the carrier" ? "s" : "x"
	const carriedSource =
		source === "a scan"
			? edge()
			: q.project(
					q.region([{ source: edge(), bind: { src: "c", dst: far }, constants: {} }]),
					[
						["src", "c"],
						["dst", far]
					],
					conservativeMeta
				)
	const carrier = edge()
	const tests = dominated === "with a test of the carried column alone" ? [edge()] : []
	const region = q.region([
		{ source: edge(), bind: { src: "s", dst: "p" }, constants: {} },
		{ source: carrier, bind: { src: "p", dst: "c" }, constants: {} },
		{ source: carriedSource, bind: { src: "c", dst: far }, constants: {} },
		...Arr.map(tests, (t) => ({ source: t, bind: { src: "c", dst: "c" }, constants: {} }))
	])
	const delivered: ReadonlyArray<readonly [string, string]> =
		beside === "joined beside the carrier"
			? [
					["s", "s"],
					["p", "p"]
				]
			: [
					["s", "s"],
					["p", "p"],
					["x", "x"]
				]
	return { dag: q.build(q.project(region, delivered, conservativeMeta)).dag, carrier, tests }
}

/** Every shape of the carried box. */
export const carriedShapes: Gen<readonly [Beside, Dominated, CarriedSource]> = (source) =>
	[
		source.draw(element<Beside>(["joined beside the carrier", "joined through the carrier alone"])),
		source.draw(
			element<Dominated>(["with a test of the carried column alone", "with no other test"])
		),
		source.draw(element<CarriedSource>(["a scan", "its own rule"]))
	] as const

/**
 * Postings some of whose accounts are postings' ids, so a posting's account may name another posting: every subset of
 * them, the databases of the checked box.
 */
export const checkedFacts: Facts = {
	databases: factSubsets({
		Posting: [
			[u(1), u(2), i8(5)],
			[u(2), u(3), i8(5)],
			[u(3), u(1), i8(7)],
			[u(4), u(4), i8(5)]
		]
	}),
	relations: [Posting]
}

/**
 * A region a check of a row its keys single out leaves rooted, as pantry's operands are: a posting p with its amount a,
 * the posting its account q names, read at that posting's key, with that posting's own account and amount, and the
 * check, the named posting again at the first posting's amount. The check binds only what the others bind, the
 * region's one existence-only occurrence, and its removal takes the named posting's restriction (the first posting
 * relates it to the rest only through the amount the check shares); but the first posting binds the named posting's key,
 * a root of the region left, and the check binds no key of it, the named posting's id being no key of the first, so the
 * check can only filter, one probe at its own key per row, as the operator's placement binds no key of the operand's.
 * The named posting is read as stored or through a rule of its own.
 */
export const checked = (source: CarriedSource) => {
	const q = new Q()
	const posting = () => q.base(Posting, conservativeMeta)
	const namedVariables = { id: "q", account: "w", amount: "m" }
	const named =
		source === "a scan"
			? posting()
			: q.project(
					q.region([{ source: posting(), bind: namedVariables, constants: {} }]),
					[
						["id", "q"],
						["account", "w"],
						["amount", "m"]
					],
					conservativeMeta
				)
	const check = posting()
	const region = q.region([
		{ source: posting(), bind: { id: "p", account: "q", amount: "a" }, constants: {} },
		{ source: named, bind: namedVariables, constants: {} },
		{ source: check, bind: { id: "q", amount: "a" }, constants: {} }
	])
	return {
		dag: q.build(
			q.project(
				region,
				[
					["p", "p"],
					["a", "a"],
					["w", "w"]
				],
				conservativeMeta
			)
		).dag,
		check
	}
}

/**
 * Postings and accounts some of whose ids are postings' too, so an account's id may name a posting: every subset of
 * them, the databases of the driving box.
 */
export const drivingFacts: Facts = {
	databases: factSubsets({
		Posting: [
			[u(1), u(10), i8(5)],
			[u(2), u(11), i8(5)],
			[u(3), u(10), i8(7)]
		],
		Account: [
			[u(1), text("a")],
			[u(10), text("b")],
			[u(11), text("c")]
		]
	}),
	relations: [Posting, AccountRelation]
}

/**
 * A region whose check binds its root's key, as an operand's Expression binds its Node's: a posting p with its amount,
 * the account its account q names with that account's name, and the check, an account whose id is the posting's own.
 * The check binds only what the posting binds, the region's one existence-only occurrence, and its removal takes the
 * named account's restriction (the posting relates it to the rest only through the check's column); the posting left
 * binds the named account's key, a root, but the check binds the posting's key, so it may be the smaller side the
 * region is read from, the postings looked up from it, and it stays a join operand. The posting is read as stored or
 * through a rule of its own.
 */
export const driving = (source: CarriedSource) => {
	const q = new Q()
	const postingVariables = { id: "p", account: "q", amount: "a" }
	const posting =
		source === "a scan"
			? q.base(Posting, conservativeMeta)
			: q.project(
					q.region([
						{ source: q.base(Posting, conservativeMeta), bind: postingVariables, constants: {} }
					]),
					[
						["id", "p"],
						["account", "q"],
						["amount", "a"]
					],
					conservativeMeta
				)
	const check = q.base(AccountRelation, conservativeMeta)
	const region = q.region([
		{ source: posting, bind: postingVariables, constants: {} },
		{
			source: q.base(AccountRelation, conservativeMeta),
			bind: { id: "q", name: "n" },
			constants: {}
		},
		{ source: check, bind: { id: "p" }, constants: {} }
	])
	return {
		dag: q.build(
			q.project(
				region,
				[
					["p", "p"],
					["a", "a"],
					["n", "n"]
				],
				conservativeMeta
			)
		).dag,
		check
	}
}

/** Every Account occurrence, reader and posting source of the box. */
export const shapes: Gen<readonly [Account, Reader, PostingSource]> = (source) =>
	[
		source.draw(element<Account>(["existence only", "with a constant"])),
		source.draw(
			element<Reader>([
				"projection",
				"projection, shared variable outside the heading",
				"root, shared variable outside the heading",
				"fold"
			])
		),
		source.draw(element<PostingSource>(["a scan", "its own rule"]))
	] as const

/**
 * Where the left input's rows come from: the accounts' ids, unique by Account's key, or the postings' accounts, which
 * repeat.
 */
export type Left = "account ids" | "posting accounts"

/** The evidence context a case runs the pass in. */
export type Evidence = "snapshot" | "transaction"

/** The name of Account's primary key in the ledger's catalog. */
export const accountKey = keyConstraintName(ledgerCatalog, "Account", ["id"])

/** The names of the region's variables a source reads: the variables an occurrence over it is correlated on. */
const regionReads = (region: NodeOf<"MatchRegion">, source: RelNode): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(
			exprClosure(Arr.flatMap(topoOrder({ roots: [source] }), (node) => exprsOf(node))),
			(expr) => (expr.kind === "column" && expr.column.node === region.id ? [expr.column.name] : [])
		)
	)

/** An occurrence of a region. */
type Occurrence = NodeOf<"MatchRegion">["occurrences"][number]

/**
 * How many groups `occurrences` fall in, joined by the variables they bind and the region's equalities: the inputs a
 * region over them joins without a condition between them are each a group (existence/index.ts groups).
 */
const groupsOf = (
	region: NodeOf<"MatchRegion">,
	occurrences: ReadonlyArray<Occurrence>
): number => {
	const parent = new Map<string, string>()
	const find = (x: string): string => {
		const up = parent.get(x)
		if (up === undefined || up === x) {
			return x
		}
		const root = find(up)
		parent.set(x, root)
		return root
	}
	const union = (a: string, b: string): void => {
		parent.set(find(a), find(b))
	}
	for (const e of region.equalities) {
		union(`v${e.a.id}`, `v${e.b.id}`)
	}
	for (const o of occurrences) {
		for (const b of o.bindings) {
			union(`o${o.id}`, `v${b.var.id}`)
		}
	}
	return new Set(Arr.map(occurrences, (o) => find(`o${o.id}`))).size
}

/**
 * Whether a region of `dag` holds an occurrence over a correlated source that the existence rule would make a
 * semi-join's right side but for its correlation (existence/index.ts shapedExistence, existenceRule): another
 * occurrence, not itself reading the variable, binds every variable it binds; no constant of it reads a column; no
 * expression of the query reads a column of its source; and its removal joins no two of the region's other inputs
 * without a condition. Only its correlation keeps it in its region.
 */
export const existenceOnlyOverCorrelated = (dag: RelDag): boolean => {
	const nodes = topoOrder(dag)
	const readLaterally = new Set(
		Arr.flatMap(exprClosure(Arr.flatMap(nodes, (node) => exprsOf(node))), (expr) =>
			expr.kind === "column" ? [expr.column.node] : []
		)
	)
	return Arr.some(nodes, (node) => {
		if (node.kind !== "MatchRegion" || node.occurrences.length < 2) {
			return false
		}
		const correlated = correlatedSources(node)
		const whole = groupsOf(node, node.occurrences)
		return Arr.some(node.occurrences, (o) => {
			const others = Arr.filter(node.occurrences, (x) => x.id !== o.id)
			const elsewhere = new Set(
				Arr.flatMap(others, (x) => {
					const reads = regionReads(node, x.source)
					return Arr.flatMap(x.bindings, (b) => (reads.has(b.var.name) ? [] : [b.var.id]))
				})
			)
			return (
				correlated.has(o.source.id) &&
				!readLaterally.has(o.source.id) &&
				Arr.every(o.bindings, (b) => elsewhere.has(b.var.id)) &&
				Arr.every(
					exprClosure(Arr.map(o.constants, (k) => k.expr)),
					(expr) => expr.kind !== "column"
				) &&
				groupsOf(node, others) === whole - (o.bindings.length === 0 ? 1 : 0)
			)
		})
	})
}

/** What the shape property counts: each working out of a region's existence-only occurrences (existence/index.ts). */
export const regionShapeSites = Object.freeze({
	shapedExistence: {
		file: "packages/engine/src/lower/optimize/existence/index.ts",
		name: "shapedExistence"
	}
} satisfies Readonly<Record<string, CountedFunction>>)

/** What the shape property reaches: a region an edit reached, and one it left as it was. */
export type RegionShapeFeature = "a region an edit reached" | "a region an edit left as it was"

/**
 * An item beside Owned, a correlated source bound at one of the item's variables, which a `where` equates to a variable
 * of another occurrence, written from either side, with what the existence rule makes of the item's match:
 *
 * - Owned bound at the item's owner, matched at its n, beside Slot at an item `item.owner = slot.item` equates to it: the
 *   agreement's shrunk #reordered counterexample (test/types/evidence/agreement.test.ts kept, seed 0x437f2318), Tone's
 *   match and the span filter dropped. Slot binds the owner's class without reading it, so the item's match is an
 *   existence test, and Owned, which read the item's owner, reads Slot's item, the class's kept member.
 * - Owned bound at the item's id and matched at a variable `item.id = owned.id` equates to it: the agreement's shrunk
 *   #faults counterexample (seed 0xc0714ea1). Owned reads the class it binds, so the item's match is its one binder,
 *   no kept member to read instead, and stays in the region.
 *
 * Each compiles, the region with an order in which Owned follows what it reads.
 */
export const correlatedReaders = {
	"a kept member, the equality read from the item": {
		item: "an existence test",
		build: () =>
			query(Agree).rule((r) => {
				const item = v(Item, "item")
				const slot = v(Slot, "slot")
				const ownedSource = Owned.bind({ owner: item.owner })
				const owned = v(ownedSource, "owned")
				return r
					.match(Item, { owner: item.owner })
					.match(ownedSource, { n: owned.n })
					.match(Slot, { item: slot.item })
					.where(r.eq(item.owner, slot.item))
					.find({ n: owned.n })
			})
	},
	"a kept member, the equality read from the slot": {
		item: "an existence test",
		build: () =>
			query(Agree).rule((r) => {
				const item = v(Item, "item")
				const slot = v(Slot, "slot")
				const ownedSource = Owned.bind({ owner: item.owner })
				const owned = v(ownedSource, "owned")
				return r
					.match(Item, { owner: item.owner })
					.match(ownedSource, { n: owned.n })
					.match(Slot, { item: slot.item })
					.where(r.eq(slot.item, item.owner))
					.find({ n: owned.n })
			})
	},
	"no kept member, the equality read from the item": {
		item: "a join operand",
		build: () =>
			query(Agree).rule((r) => {
				const item = v(Item, "item")
				const ownedSource = Owned.bind({ owner: item.id })
				const owned = v(ownedSource, "owned")
				return r
					.match(Item, { id: item.id })
					.match(ownedSource, { id: owned.id })
					.where(r.eq(item.id, owned.id))
					.find({ h0: item.id })
			})
	},
	"no kept member, the equality read from the bound row": {
		item: "a join operand",
		build: () =>
			query(Agree).rule((r) => {
				const item = v(Item, "item")
				const ownedSource = Owned.bind({ owner: item.id })
				const owned = v(ownedSource, "owned")
				return r
					.match(Item, { id: item.id })
					.match(ownedSource, { id: owned.id })
					.where(r.eq(owned.id, item.id))
					.find({ h0: owned.id })
			})
	}
} as const satisfies Readonly<
	Record<
		string,
		{ readonly item: "an existence test" | "a join operand"; readonly build: () => unknown }
	>
>

/** Each shape of an item beside a correlated source. */
export type CorrelatedReader = keyof typeof correlatedReaders
