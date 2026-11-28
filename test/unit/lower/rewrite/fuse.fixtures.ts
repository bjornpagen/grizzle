/** What the properties of fuse.test.ts read: its spaces, models and helpers. */

import { element } from "@bjornpagen/testing/gen"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { conservativeMeta, type RelDag } from "#compiler/ir/rel.ts"
import {
	relationalRewrites,
	semanticSimplification
} from "#compiler/lower/optimize/demand/phases.ts"
import { fusePass } from "#compiler/lower/optimize/fuse/index.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { Account, Posting, Q, uuidOf } from "#test/support/unit/lower/conservative/fixtures.ts"
import {
	deliversAlikeOn,
	factSubsets,
	ledgerCatalog,
	lowersConservatively,
	passContext,
	queryOf,
	type Ran,
	runPasses
} from "#test/support/unit/lower/rewrite/support.ts"

/** A uuid literal of the ledger fixture's n-th id (conservative/fixtures.ts uuidOf). */
const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })

/** A bigint literal. */
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** A text literal. */
const text = (s: string): TypedLiteral => ({ kind: "text", value: s })

/**
 * Every database of these posting and account facts: account 10 holds amounts 5, 5 and 7 (two postings agreeing on
 * (account, amount)), account 11 one 5.
 */
const databases = factSubsets({
	Posting: [
		[u(1), u(10), i8(5)],
		[u(2), u(10), i8(5)],
		[u(3), u(10), i8(7)],
		[u(4), u(11), i8(5)]
	],
	Account: [
		[u(10), text("a")],
		[u(11), text("b")]
	]
})

/**
 * Runs fusion and simplification, and the semantic simplification and relational rewrites composed, holding each to
 * every database's delivery and to the conservative lowering; the fusion run's certificates.
 */
export const fused = (dag: RelDag): Ran => {
	const query = queryOf(dag, [])
	const run = (passes: ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>): Ran => {
		const ran = succeeded(
			runPasses(query, passes, passContext({ catalog: ledgerCatalog, evidence: "snapshot" }))
		)
		deliversAlikeOn(databases, [Posting, Account], [], query, ran.query)
		lowersConservatively(ran.query, emptyCodebook)
		return ran
	}
	run([semanticSimplification, relationalRewrites])
	return run([fusePass, simplifyPass])
}

/** A region over every posting, binding its id, account and amount. */
export const postings = (q: Q) =>
	q.region([
		{
			source: q.base(Posting, conservativeMeta),
			bind: { id: "id", account: "account", amount: "amount" },
			constants: {}
		}
	])

/**
 * What an outer occurrence does with each of two columns of an imported stage that carry one inner variable (amount):
 * leave it existential, bind it to a variable of its own, fix it to 5 or to 7, or fix it to another posting's amount,
 * a constant that reads a column of an earlier occurrence's source.
 */
export type Use = "existential" | "bound" | "fixed to 5" | "fixed to 7" | "fixed to a read"

/** Every use of a column the box draws. */
export const uses = element<Use>([
	"existential",
	"bound",
	"fixed to 5",
	"fixed to 7",
	"fixed to a read"
])

/** Whether the imported stage filters the amount its two columns carry, so a predicate reads the inner variable. */
export type Stage = "filtered" | "unfiltered"

/** The bound tuple the imported stage delivers. */
export type Bound = "account, amount" | "id, account, amount"

/** Who reads the imported stage: a fold over it, or the query. */
export type Reader = "a fold" | "the query"
