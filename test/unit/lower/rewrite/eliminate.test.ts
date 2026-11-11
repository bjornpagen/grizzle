/**
 * R03 (lower/optimize/eliminate): a relation is eliminated only with a complete proof. Exhausted over how the catalog
 * states the containment Posting.account -> Account.id (absent, an immediate or a deferred foreign key), the evidence
 * context, whether Account has a key, and what its occurrence does beyond the key match: the Account match goes exactly
 * when an admitted containment and a key of its target prove it neither filters nor multiplies; its certificate names
 * the context its evidence holds in and the installed constraints it rests on, as a set; and the rewritten query
 * delivers what the original does, by the reference evaluator, on every database of the candidate facts the context may
 * see under the installation (two postings of one account, a posting of no account, two accounts of one id).
 *
 * Oracle: the gate's statement as a checker (a specification), and the reference evaluator's delivery (a second
 * implementation).
 *
 * Features: eliminated in each evidence context and on each kind of evidence; held back for each missing premise.
 *
 * Plant, failing the search: a deferred foreign key read as proving existence inside a transaction
 * (eliminate-deferred).
 */
import { describe, it } from "@effect/vitest"
import { assertNone } from "@effect/vitest/utils"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { EvidenceCatalog, ExistenceConstraint } from "#compiler/ir/evidence.ts"
import { type TypedLiteral, OpId } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelDag } from "#compiler/ir/rel.ts"
import { eliminatePass } from "#compiler/lower/optimize/eliminate/index.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { keyConstraintName, ownedFixture } from "#test/support/evidence.ts"
import { contained, on, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	Account,
	ledgerSchema,
	Posting,
	Q,
	T,
	uuidOf
} from "#test/unit/lower/conservative/fixtures.ts"

import { caseHang } from "#test/support/limits.ts"
import {
	passContext,
	deliversAlikeOn,
	factSubsets,
	type HandFacts,
	nodesOf,
	queryOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
const text = (s: string): TypedLiteral => ({ kind: "text", value: s })

/**
 * The ledger with Posting.account contained in Account.id: the foreign key ownership installs, and Account's primary
 * key.
 */
const Referenced: SchemaDesc = {
	...ledgerSchema,
	statements: [contained(on("Posting", ["account"]), on("Account", ["id"]))]
}
const referenced = ownedFixture(Referenced)
const accountKey = keyConstraintName(referenced.catalog, "Account", ["id"], "primary")
const installed = referenced.catalog
const [installedFk] = installed.containments

/**
 * The installed foreign key, which a case restates in the context it states: Account has a field outside its key, so
 * ownership installs it deferred (laws/model/model.ts foreign key deferral).
 */
const fk: ExistenceConstraint = defined(installedFk, "the ledger's installed containment")

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

const accountFacts: ReadonlyArray<ReadonlyArray<TypedLiteral>> = [
	[u(10), text("a")],
	[u(11), text("b")],
	[u(10), text("c")]
]

/**
 * How the catalog states the containment Posting.account -> Account.id: absent, an immediate foreign key, or a deferred
 * foreign key, which proves existence in a committed snapshot only.
 */
type Containment = "none" | "immediate" | "deferred"
type Evidence = "snapshot" | "transaction"
/** What the Account occurrence does beyond the key match: nothing, fix its name, or deliver its name. */
type Match = "key match" | "fixes a column" | "delivers payload"

const containmentsOf: Readonly<Record<Containment, ReadonlyArray<ExistenceConstraint>>> = {
	none: [],
	immediate: [{ ...fk, kind: "foreignKey", context: "immediate" }],
	deferred: [{ ...fk, kind: "deferredForeignKey", context: "committedSnapshot" }]
}

const uuidAt = (fact: ReadonlyArray<TypedLiteral>, column: number): ReadonlyArray<string> => {
	const value = fact[column]
	return value?.kind === "uuid" ? [value.value] : []
}

/**
 * Every database of the candidate facts the context may see under the installation: a posting with no account only
 * where no constraint the context relies on forbids it (absent, or deferred inside a transaction), and two accounts of
 * one id only where the catalog holds no key of Account.
 */
const seenDatabases = (
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
const unkeyed: EvidenceCatalog = {
	...installed,
	keyConstraint: (relation, columns, role) =>
		relation === "Account" ? undefined : installed.keyConstraint(relation, columns, role)
}

/**
 * Posting joined with the account it names, delivering only posting columns, unless the match delivers the account's
 * name; the account's name fixed to "a" when the match fixes a column.
 */
const keyMatch = (match: Match) => {
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

const eliminated = (
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
type EliminateFeature =
	| `eliminated in ${Evidence}`
	| `eliminated on ${"immediate" | "committedSnapshot"} evidence`
	| "held back: no admitted containment"
	| "held back: no key of the target"
	| "held back: the match does more than match a key"

describe("the complete proof", () => {
	it.effect(
		"an Account match goes exactly when an admitted containment and a key of its target prove it neither filters nor multiplies",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every containment statement, evidence context, key and match of the ledger's Posting and Account",
						oracle: {
							kind: "specification",
							name: "R03's complete proof, an admitted containment and a key of its target; the reference's delivery on every database the context may see"
						},
						suite: "unit/lower/rewrite/eliminate-proof",
						literal: Formatter.format,
						generator: (source) => ({
							containment: source.draw(element<Containment>(["none", "immediate", "deferred"])),
							evidence: source.draw(element<Evidence>(["snapshot", "transaction"])),
							match: source.draw(
								element<Match>(["key match", "fixes a column", "delivers payload"])
							),
							keyed: source.draw(boolean)
						}),
						limit: 36,
						coverage: requiredInSpace<EliminateFeature>([
							"eliminated in snapshot",
							"eliminated in transaction",
							"eliminated on immediate evidence",
							"eliminated on committedSnapshot evidence",
							"held back: no admitted containment",
							"held back: no key of the target",
							"held back: the match does more than match a key"
						]),
						caseHang
					},
					({ containment, evidence, match, keyed }, c) =>
						Effect.sync(() => {
							const catalog = {
								...(keyed ? installed : unkeyed),
								containments: containmentsOf[containment]
							}
							const ran = eliminated(
								keyMatch(match),
								catalog,
								evidence,
								seenDatabases(containment, evidence, keyed)
							)
							const containmentAdmitted =
								containment === "immediate" ||
								(containment === "deferred" && evidence === "snapshot")
							const found = Arr.findFirst(ran.certificates, (x) => x.rule === "R03.elimination")
							if (!containmentAdmitted) {
								c.note("held back: no admitted containment")
							} else if (!keyed) {
								c.note("held back: no key of the target")
							} else if (match !== "key match") {
								c.note("held back: the match does more than match a key")
							}
							if (!(containmentAdmitted && keyed && match === "key match")) {
								assertNone(found)
								return
							}
							const cert = Option.getOrThrowWith(
								found,
								() => new Error("the elimination's certificate")
							)
							const expectedContext = containment === "deferred" ? "committedSnapshot" : "immediate"
							c.note(`eliminated in ${evidence}`)
							c.note(`eliminated on ${expectedContext} evidence`)
							assert.equal(cert.context, expectedContext)
							assert.deepEqual(cert.equality, [OpId("uuid_eq")])
							const enforcement = fk.enforcement
							assert.ok(
								enforcement.kind === "constraint",
								"the installed foreign key is a named constraint"
							)
							unorderedEqual(
								Arr.flatMap(cert.premises, (p) => (p.kind === "constraint" ? [p.constraint] : [])),
								[accountKey, enforcement.name]
							)
							assert.deepEqual(
								Arr.map(nodesOf(ran.query.dag, "MatchRegion"), (r) => r.occurrences.length),
								[1]
							)
						})
				)
			)
	)
})
