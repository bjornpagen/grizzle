import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
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
 * agrees with the reference evaluator over the violating state: the friends of friends through a missing person are
 * not friends of friends. The Follows-only match keeps its dangling edges, since no rewrite adds an existence test.
 *
 * A case draws one of the three queries, the persons 1 to 6 that exist, every ordered pair of 1 to 6 a Follows edge
 * or not, so an edge dangles wherever an endpoint is missing, and the person the query starts from.
 *
 * Plants (main's test phase): recursion-existence-deferred-evidence.patch.
 */

const Person = relation("Person", { id: pg.integer, name: str.regex("^.*$", "su") }, ["id"])
const Follows = relation("Follows", { from: pg.integer, to: pg.integer }, ["from", "to"])
const Network = declareSchema(
	"Network",
	[Person, Follows],
	[contained(on(Follows, "from"), on(Person, "id")), contained(on(Follows, "to"), on(Person, "id"))]
)

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

const intLit = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
const text = (s: string): TypedLiteral => ({ kind: "text", value: s })

/** A state, perhaps violating the deferred containments: the persons that exist, and every Follows edge. */
interface State {
	readonly persons: ReadonlyArray<number>
	readonly follows: ReadonlyArray<readonly [number, number]>
}

/** The persons and edges over 1 … 6, each person present or not and each ordered pair an edge or not. */
const stateGen: Gen<State> = (source) => {
	const everyone = Arr.range(1, 6)
	return {
		persons: source.draw(subarray(everyone)),
		follows: source.draw(
			subarray(Arr.flatMap(everyone, (a) => Arr.map(everyone, (b) => [a, b] as const)))
		)
	}
}

/** A network's facts, Person's in its checked heading's column order: id, name. */
const factsOf = (network: State) => ({
	Person: Arr.map(network.persons, (i) => [intLit(i), text(`p${i}`)]),
	Follows: Arr.map(network.follows, ([a, b]) => [intLit(a), intLit(b)])
})

const caseOf = (label: string, q: unknown, network: State, person: number): LabelledCase =>
	publicCase({
		schema: Network,
		name: "Network",
		relations: ["Person", "Follows"],
		containments,
		facts: factsOf(network),
		label,
		query: q,
		params: { person: intLit(person) }
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

/** The queries a case draws among. */
const queryNames = ["FriendsOfFriends", "FollowsOnly", "Existing"] as const
type QueryName = (typeof queryNames)[number]
const queries: Readonly<Record<QueryName, unknown>> = { FriendsOfFriends, FollowsOnly, Existing }

/** A drawn case: a query, a network and the person it starts from. */
interface Sketch {
	readonly query: QueryName
	readonly network: State
	readonly person: number
}

const sketchGen: Gen<Sketch> = (source) => ({
	query: source.draw(element(queryNames)),
	network: source.draw(stateGen),
	person: source.draw(int(1, 6))
})

/** Whether some Follows edge dangles: an endpoint no Person row holds. */
const dangles = (network: State): boolean =>
	Arr.some(
		network.follows,
		([a, b]) => !network.persons.includes(a) || !network.persons.includes(b)
	)

/** A query whose transaction artifact agreed, over a violated deferred law or none. */
type AgreedFeature = `${QueryName} agreed over ${"a dangling edge" | "a lawful state"}`

layer(Substrate.layer)("endpoint existence during deferred violations", (it) => {
	it.effect(
		"the transaction artifact of each query agrees with the reference over a violated deferred law",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema({ create: false, label: "deferred" })
					return yield* explore(
						{
							suite: "recursion/graph/existence",
							draw: drawn(sketchGen),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "the reference evaluator and the conservative lowering over the same state, its deferred laws perhaps violated"
							},
							coverage: required<AgreedFeature>(
								Arr.map(queryNames, (q): AgreedFeature => `${q} agreed over a dangling edge`),
								{ cases: 32, sense: notesOnly }
							),
							kept: [],
							runs: 16,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(k, c) =>
							Effect.gen(function* () {
								const labelled = caseOf(k.query, queries[k.query], k.network, k.person)
								const outcome = yield* runLabelledOracle(
									labelled,
									optimizedIn("transaction"),
									reference,
									{
										...defaultRunOptions,
										schema: { kind: "named", name: schema }
									}
								)
								assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
								const agreed = yield* runLabelledOracle(
									labelled,
									optimizedIn("transaction"),
									conservative,
									{
										...defaultRunOptions,
										schema: { kind: "named", name: schema }
									}
								)
								assert.equal(agreed.comparison.equal, true, printOutcome(agreed))
								lacks(certifiedIn(labelled, "transaction"), "R03.elimination")
								c.note(
									`${k.query} agreed over ${dangles(k.network) ? "a dangling edge" : "a lawful state"}`
								)
							})
					)
				})
			)
	)
})
