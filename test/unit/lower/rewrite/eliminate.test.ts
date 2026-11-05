import { describe, it } from "@effect/vitest"
import { assertNone } from "@effect/vitest/utils"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { EvidenceCatalog, ExistenceConstraint } from "#compiler/ir/evidence.ts"
import { type TypedLiteral, OpId } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelDag } from "#compiler/ir/rel.ts"
import { eliminatePass } from "#compiler/lower/optimize/eliminate/index.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { assert, defined, lacks, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { keyConstraintName, ownedFixture } from "#test/support/evidence.ts"
import { contained, on, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { wild } from "#test/support/kernel/naming.ts"
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
	rulesOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/**
 * R03: eliminate a relation only with a complete proof. The gate's counterexamples:
 * absent witnesses (no containment, a key outside the matched fields), duplicate referring facts, deferred laws inside a
 * transaction, a match that filters or delivers payload; and the certificate's premises, the installed constraints the
 * elimination rests on.
 */

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
 * of account 13, which no account holds, and two accounts.
 */
const postingFacts: ReadonlyArray<ReadonlyArray<TypedLiteral>> = [
	[u(1), u(10), i8(5)],
	[u(2), u(10), i8(5)],
	[u(3), u(11), i8(7)],
	[u(4), u(13), i8(7)]
]

const accountFacts: ReadonlyArray<ReadonlyArray<TypedLiteral>> = [
	[u(10), text("a")],
	[u(11), text("b")]
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
 * where no constraint the context relies on forbids it (absent, or deferred inside a transaction).
 */
const seenDatabases = (containment: Containment, evidence: Evidence): ReadonlyArray<HandFacts> =>
	Arr.filter(factSubsets({ Posting: postingFacts, Account: accountFacts }), (db) => {
		const ids = new Set(
			Arr.flatMap(defined(db["Account"], "the account facts"), (f) => uuidAt(f, 0))
		)
		const dangling = Arr.some(defined(db["Posting"], "the posting facts"), (f) =>
			Arr.some(uuidAt(f, 1), (a) => !ids.has(a))
		)
		return (
			!dangling ||
			containment === "none" ||
			(containment === "deferred" && evidence === "transaction")
		)
	})

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
	| "held back: the match does more than match a key"

describe("the complete proof", () => {
	it.effect(
		"an Account match goes exactly when an admitted containment and key prove it neither filters nor multiplies",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/eliminate-proof",
						literal: Formatter.format,
						generator: (source) => ({
							containment: source.draw(element<Containment>(["none", "immediate", "deferred"])),
							evidence: source.draw(element<Evidence>(["snapshot", "transaction"])),
							match: source.draw(
								element<Match>(["key match", "fixes a column", "delivers payload"])
							)
						}),
						limit: 18,
						coverage: requiredInSpace<EliminateFeature>([
							"eliminated in snapshot",
							"eliminated in transaction",
							"eliminated on immediate evidence",
							"eliminated on committedSnapshot evidence",
							"held back: no admitted containment",
							"held back: the match does more than match a key"
						]),
						caseHang
					},
					({ containment, evidence, match }, c) =>
						Effect.sync(() => {
							const catalog = { ...installed, containments: containmentsOf[containment] }
							const ran = eliminated(
								keyMatch(match),
								catalog,
								evidence,
								seenDatabases(containment, evidence)
							)
							const containmentAdmitted =
								containment === "immediate" ||
								(containment === "deferred" && evidence === "snapshot")
							const found = Arr.findFirst(ran.certificates, (x) => x.rule === "R03.elimination")
							if (!containmentAdmitted) {
								c.note("held back: no admitted containment")
							} else if (match !== "key match") {
								c.note("held back: the match does more than match a key")
							}
							if (!(containmentAdmitted && match === "key match")) {
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

	it.effect(
		"refuses a containment whose target fields hold no key: existence without at most one",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/eliminate-no-key",
						literal: Formatter.format,
						generator: element<Evidence>(["snapshot", "transaction"]),
						limit: 2,
						coverage: requiredInSpace<Evidence>(["snapshot", "transaction"]),
						caseHang
					},
					(evidence, c) =>
						Effect.sync(() => {
							c.note(evidence)
							const q = new Q()
							const region = q.region([
								{
									source: q.base(Account, conservativeMeta),
									bind: { id: "acct", name: "who" },
									constants: {}
								},
								{ source: q.base(Account, conservativeMeta), bind: { name: "who" }, constants: {} }
							])
							const dag = q.build(q.project(region, [["acct", "acct"]], conservativeMeta)).dag
							const byName: ExistenceConstraint = {
								...fk,
								from: { relation: "Account", fields: ["name"] },
								to: { relation: "Account", fields: ["name"] },
								enforcement: { kind: "constraint", name: wild.constraint("account_fk_name") }
							}
							const ran = eliminated(
								dag,
								{ ...installed, containments: [byName] },
								evidence,
								seenDatabases("immediate", evidence)
							)
							lacks(rulesOf(ran.certificates), "R03.elimination")
						})
				)
			)
	)
})
