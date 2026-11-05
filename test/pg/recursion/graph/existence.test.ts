import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect } from "effect"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema as declareSchema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { logicalOf, publicCase } from "#test/pg/recursion/graph/support.ts"
import { assert, lacks, succeeded } from "#test/support/assert.ts"
import { lowerAligned } from "#test/support/compile.ts"
import { ownedSchemaFixture } from "#test/support/evidence.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import type { GenContainment } from "#test/support/oracle/gen/schema.ts"
import {
	conservative,
	defaultRunOptions,
	type LabelledCase,
	type Lowering,
	printOutcome,
	reference,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Endpoint existence during deferred violations.
 *
 * Explicit Person matches require those rows to exist. If a query instead matches only Follows rows, a lowering must
 * not silently remove dangling edges while deferred containments are temporarily violated. Adding or removing
 * endpoint-existence tests requires valid evidence in that execution context.
 *
 * The graph fixture's Network: Person carries a name outside its key and one identity writes both relations, so the
 * endpoint containments install as deferred foreign keys. Inside a transaction they may be
 * violated until commit; the oracle loads the facts in its transaction, with a Follows edge into a person that does
 * not exist, and the queries run there. The transaction-context artifact (as a read-back's is) keeps
 * every explicit Person match, because a deferred containment is no existence evidence inside a transaction, and so
 * agrees with the reference evaluator over the violating state: the friends of friends through the missing person are
 * not friends of friends. The Follows-only match keeps its dangling edges, since no rewrite adds an existence test.
 */

const Person = relation("Person", { id: pg.integer, name: str.regex("^.*$", "su") }, ["id"])
const Follows = relation("Follows", { from: pg.integer, to: pg.integer }, ["from", "to"])
const Network = declareSchema("Network", { Person, Follows }, [
	contained(on(Follows, "from"), on(Person, "id")),
	contained(on(Follows, "to"), on(Person, "id"))
])

const containments: ReadonlyArray<GenContainment> = [
	{ from: { relation: "Follows", fields: ["from"] }, to: { relation: "Person", fields: ["id"] } },
	{ from: { relation: "Follows", fields: ["to"] }, to: { relation: "Person", fields: ["id"] } }
]

/**
 * The network's catalog with its containments installed as deferred foreign keys: existence evidence for a committed
 * snapshot only. Every constraint keeps the name ownership gives it.
 */
const installed = ownedSchemaFixture(Network).catalog
const catalog: EvidenceCatalog = {
	...installed,
	containments: Arr.map(installed.containments, (c) => ({
		...c,
		kind: "deferredForeignKey" as const,
		context: "committedSnapshot" as const
	}))
}

const int = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
const text = (s: string): TypedLiteral => ({ kind: "text", value: s })

/**
 * Persons 1 to 4; 1 follows 2 and the missing 9, 2 follows 3, 9 follows 4: inside the transaction the edges 1 -> 9 and
 * 9 -> 4 dangle.
 */
const facts = {
	/** In the checked heading's column order: id, name. */
	Person: Arr.map([1, 2, 3, 4], (i) => [int(i), text(`p${i}`)]),
	Follows: Arr.map(
		[
			[1, 2],
			[1, 9],
			[2, 3],
			[9, 4]
		] as const,
		([a, b]) => [int(a), int(b)]
	)
}

const caseOf = (label: string, q: unknown): LabelledCase =>
	publicCase({
		schema: Network,
		name: "Network",
		relations: ["Person", "Follows"],
		containments,
		facts,
		label,
		query: q,
		params: { person: int(1) }
	})

/** Friends of friends: exactly two directed steps, every participating person required to exist. */
const FriendsOfFriends = query(Network).rule((r) => {
	const { id: start } = v(Person, "start")
	const { id: middle } = v(Person, "middle")
	const { id: end } = v(Person, "end")
	return r
		.match(Person, { id: start })
		.match(Follows, { from: start, to: middle })
		.match(Person, { id: middle })
		.match(Follows, { from: middle, to: end })
		.match(Person, { id: end })
		.where(r.eq(start, r.param("person", pg.integer)))
		.find({ person: end })
})

/** The same two steps over Follows alone: a dangling edge is a fact like any other. */
const FollowsOnly = query(Network).rule((r) => {
	const { from: start, to: middle } = v(Follows, "first")
	const { to: end } = v(Follows, "second")
	return r
		.match(Follows, { from: start, to: middle })
		.match(Follows, { from: middle, to: end })
		.where(r.eq(start, r.param("person", pg.integer)))
		.find({ person: end })
})

/** Reachability whose step requires each destination to exist. */
const Existing = query(Network).recursive("Existing", {
	row: { person: pg.integer },
	base: [
		(r) => {
			const { id } = v(Person, "person")
			return r
				.match(Person, { id })
				.where(r.eq(id, r.param("person", pg.integer)))
				.find({ person: id })
		}
	],
	rec: [
		(r, self) => {
			const { person } = v(self, "self")
			const { to } = v(Follows, "follows")
			return r
				.match(self, { person })
				.match(Follows, { from: person, to })
				.match(Person, { id: to })
				.find({ person: to })
		}
	]
})

/** A case's optimized lowering in `context`, under `names` and the network's deferred catalog. */
const optimized = (c: QueryCase, names: PhysicalNames, context: TemplateContext) =>
	lowerAligned(logicalOf(c), "query", {
		names,
		context,
		catalog
	})

const optimizedIn = (context: TemplateContext): Lowering => ({
	name: `optimized (${context})`,
	lower: ({ case: c, names }) => optimized(c, names, context)
})

/** The rules a case's optimized lowering certifies in `context`, under its schema's stand-in names. */
const certifiedIn = (c: LabelledCase, context: TemplateContext): ReadonlyArray<CertificateRule> =>
	Arr.map(
		succeeded(
			optimized(c, standInNames(c.schema.name, emptyCodebook), context),
			`${c.label}: its lowering`
		).certificates,
		(x) => x.rule
	)

const cases: Arr.NonEmptyReadonlyArray<LabelledCase> = [
	caseOf("FriendsOfFriends", FriendsOfFriends),
	caseOf("FollowsOnly", FollowsOnly),
	caseOf("Existing", Existing)
]

/** A query whose transaction artifact agreed over the violated law, by its label. */
type AgreedFeature = `agreed: ${string}`

layer(Substrate.layer)("endpoint existence during deferred violations", (it) => {
	it.effect(
		"the transaction artifact of each query agrees with the reference over a violated deferred law",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema({ create: false, label: "deferred" })
					return yield* exhaust(
						{
							suite: "recursion/graph/existence",
							generator: element(cases),
							literal: (c: LabelledCase) => c.label,
							limit: cases.length,
							coverage: requiredInSpace<AgreedFeature>(
								Arr.map(cases, (c): AgreedFeature => `agreed: ${c.label}`)
							),
							caseHang
						},
						(c, k) =>
							Effect.gen(function* () {
								const outcome = yield* runLabelledOracle(c, optimizedIn("transaction"), reference, {
									...defaultRunOptions,
									schema: { kind: "named", name: schema }
								})
								assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
								const agreed = yield* runLabelledOracle(
									c,
									optimizedIn("transaction"),
									conservative,
									{
										...defaultRunOptions,
										schema: { kind: "named", name: schema }
									}
								)
								assert.equal(agreed.comparison.equal, true, printOutcome(agreed))
								lacks(certifiedIn(c, "transaction"), "R03.elimination")
								k.note(`agreed: ${c.label}`)
							})
					)
				})
			)
	)
})
