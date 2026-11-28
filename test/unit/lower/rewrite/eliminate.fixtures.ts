/** What the properties of eliminate.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr } from "effect"
import type { EvidenceCatalog, ExistenceConstraint } from "#compiler/ir/evidence.ts"
import { type TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelDag } from "#compiler/ir/rel.ts"
import { eliminatePass } from "#compiler/lower/optimize/eliminate/index.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { keyConstraintName, ownedFixture } from "#test/support/evidence.ts"
import { contained, on, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	Account,
	ledgerSchema,
	Posting,
	Q,
	T,
	uuidOf
} from "#test/support/unit/lower/conservative/fixtures.ts"
import {
	deliversAlikeOn,
	factSubsets,
	type HandFacts,
	passContext,
	queryOf,
	runPasses
} from "#test/support/unit/lower/rewrite/support.ts"

/** A uuid literal of the ledger fixture's n-th id (conservative/fixtures.ts uuidOf). */
const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })

/** A bigint literal. */
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** A text literal. */
const text = (s: string): TypedLiteral => ({ kind: "text", value: s })

/**
 * The ledger with Posting.account contained in Account.id: the foreign key ownership installs, and Account's primary
 * key.
 */
const Referenced: SchemaDesc = {
	...ledgerSchema,
	statements: [contained(on("Posting", ["account"]), on("Account", ["id"]))]
}

/** The ledger with its containment, installed as ownership installs it. */
const referenced = ownedFixture(Referenced)

/** The name of Account's primary key as ownership installs it. */
export const accountKey = keyConstraintName(referenced.catalog, "Account", ["id"])

/** The catalog of the installed ledger, with Account's key and the containment's foreign key. */
export const installed = referenced.catalog

/** The ledger's one installed containment. */
const [installedFk] = installed.containments

/**
 * The installed foreign key, which a case restates in the context it states: Account has a field outside its key, so
 * ownership installs it deferred (laws/model/model.ts foreign key deferral).
 */
export const fk: ExistenceConstraint = defined(installedFk, "the ledger's installed containment")

/**
 * The candidate facts: two postings of account 10 with one amount (duplicate referring facts), one of account 11, one
 * of account 13, which no account holds, and three accounts, two of them of id 10, which only a catalog with no key of
 * Account admits.
 */
const postingFacts: ReadonlyArray<ReadonlyArray<TypedLiteral>> = [
	[u(1), u(10), i8(5)],
	[u(2), u(10), i8(5)],
	[u(3), u(11), i8(7)],
	[u(4), u(13), i8(7)]
]

/** The candidate account facts: accounts 10 and 11, and a second account of id 10. */
const accountFacts: ReadonlyArray<ReadonlyArray<TypedLiteral>> = [
	[u(10), text("a")],
	[u(11), text("b")],
	[u(10), text("c")]
]

/**
 * How the catalog states the containment Posting.account -> Account.id: absent, an immediate foreign key, or a deferred
 * foreign key, which proves existence in a committed snapshot only.
 */
export type Containment = "none" | "immediate" | "deferred"

/** The evidence context a case runs the pass in. */
export type Evidence = "snapshot" | "transaction"

/** What the Account occurrence does beyond the key match: nothing, fix its name, or deliver its name. */
export type Match = "key match" | "fixes a column" | "delivers payload"

/** The catalog's containments as each statement of the containment states them. */
export const containmentsOf: Readonly<Record<Containment, ReadonlyArray<ExistenceConstraint>>> = {
	none: [],
	immediate: [{ ...fk, context: "immediate" }],
	deferred: [{ ...fk, context: "committedSnapshot" }]
}

/** The uuid a fact holds at `column`, if it holds one there. */
const uuidAt = (fact: ReadonlyArray<TypedLiteral>, column: number): ReadonlyArray<string> => {
	const value = fact[column]
	return value?.kind === "uuid" ? [value.value] : []
}

/**
 * Every database of the candidate facts the context may see under the installation: a posting with no account only
 * where no constraint the context relies on forbids it (absent, or deferred inside a transaction), and two accounts of
 * one id only where the catalog holds no key of Account.
 */
export const seenDatabases = (
	containment: Containment,
	evidence: Evidence,
	keyed: boolean
): ReadonlyArray<HandFacts> =>
	Arr.filter(factSubsets({ Posting: postingFacts, Account: accountFacts }), (db) => {
		const accountIds = Arr.flatMap(defined(db["Account"], "the account facts"), (f) => uuidAt(f, 0))
		const ids = new Set(accountIds)
		const dangling = Arr.some(defined(db["Posting"], "the posting facts"), (f) =>
			Arr.some(uuidAt(f, 1), (a) => !ids.has(a))
		)
		return (
			(!keyed || ids.size === accountIds.length) &&
			(!dangling ||
				containment === "none" ||
				(containment === "deferred" && evidence === "transaction"))
		)
	})

/** The installed catalog with no constraint of Account's key: existence then proves no at-most-one. */
export const unkeyed: EvidenceCatalog = {
	...installed,
	keyConstraint: (relation, columns) =>
		relation === "Account" ? undefined : installed.keyConstraint(relation, columns)
}

/**
 * Posting joined with the account it names, delivering only posting columns, unless the match delivers the account's
 * name; the account's name fixed to "a" when the match fixes a column.
 */
export const keyMatch = (match: Match) => {
	const q = new Q()
	const region = q.region([
		{
			source: q.base(Posting, conservativeMeta),
			bind: { id: "id", account: "acct", amount: "amount" },
			constants: {}
		},
		match === "fixes a column"
			? {
					source: q.base(Account, conservativeMeta),
					bind: { id: "acct" },
					constants: { name: q.lit(text("a"), T.text) }
				}
			: {
					source: q.base(Account, conservativeMeta),
					bind: match === "delivers payload" ? { id: "acct", name: "name" } : { id: "acct" },
					constants: {}
				}
	])
	return q.build(
		q.project(
			region,
			[["id", "id"], match === "delivers payload" ? ["name", "name"] : ["amount", "amount"]],
			conservativeMeta
		)
	).dag
}

/** Runs pruning and elimination over the DAG in the catalog and context, holding it to every database's delivery. */
export const eliminated = (
	dag: RelDag,
	catalog: EvidenceCatalog,
	evidence: Evidence,
	databases: ReadonlyArray<HandFacts>
) => {
	const query = queryOf(dag, [])
	const ran = succeeded(
		runPasses(query, [prunePass, eliminatePass], passContext({ catalog, evidence }))
	)
	deliversAlikeOn(databases, [Posting, Account], [], query, ran.query)
	return ran
}

/** What the eliminations reach: the rewrite under each evidence context, and each guard holding it back. */
export type EliminateFeature =
	| `eliminated in ${Evidence}`
	| `eliminated on ${"immediate" | "committedSnapshot"} evidence`
	| "held back: no admitted containment"
	| "held back: no key of the target"
	| "held back: the match does more than match a key"
