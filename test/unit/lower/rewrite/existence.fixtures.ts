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
import { succeeded } from "#test/support/assert.ts"
import { keyConstraintName } from "#test/support/evidence.ts"
import {
	Account as AccountRelation,
	type OccurrenceSpec,
	plainRegion,
	Posting,
	Q,
	T,
	uuidOf
} from "#test/unit/lower/conservative/fixtures.ts"
import { correlatedSources } from "#test/unit/lower/rewrite/guarded.ts"
import {
	deliversAlikeOn,
	factSubsets,
	ledgerCatalog,
	lowersConservatively,
	passContext,
	queryOf,
	type Ran,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

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

/** Runs `passes` over the DAG in a snapshot, holding the result to every database's delivery and to the conservative lowering. */
export const rewritten = (
	dag: RelDag,
	passes: ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>
): Ran => {
	const query = queryOf(dag, [])
	const ran = succeeded(
		runPasses(query, passes, passContext({ catalog: ledgerCatalog, evidence: "snapshot" }))
	)
	deliversAlikeOn(databases, [Posting, AccountRelation], [], query, ran.query)
	lowersConservatively(ran.query, emptyCodebook)
	return ran
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
