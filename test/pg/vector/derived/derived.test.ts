/**
 * A derived relation over vectors on PostgreSQL 19: the viewer of a view of embeddings reaches the vector type only
 * through the view, runs under the search policy, reads its vectors exactly, and is refused a search over it.
 *
 * - Privileges: the viewer holds the view and not the tables or the type behind it.
 * - Policy: the viewer's session shows the search policy before and after the vector library loads, and the snapshot
 *   names it as the login's defaults.
 * - Exact reads: for each account and a drawn probe, the viewer's typed scoring of the view delivers exactly the
 *   owner's complete scan of it, scored with pgvector's own operator.
 * - Refusal: an approximateNearest over the view is refused by the checker, and by a served workload's compile at the
 *   program.
 *
 * Oracle: a second implementation, the owner's complete scan of the view scored with pgvector's <=>.
 *
 * Plants: vector-cosine-as-l2 (Compute.cosineDistance lowers to l2_distance).
 *
 * Features: each account scored, and a search over the view refused.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, pipe, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { checkQuery } from "#compiler/check/index.ts"
import * as Result from "#compiler/core/result.ts"
import { searchPolicySettings } from "#compiler/physical/ddl/roles.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { workload as servedPrograms } from "#compiler/program/workload/value.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { refresh, workload } from "#compiler/public/workload.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	admittedPolicy,
	dimensions,
	runProbes,
	textRows,
	vectorParam,
	vectorText
} from "#test/pg/vector/ann/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, refused } from "#test/support/assert.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { roleNamesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { type ServedFixture, servedFixture, servedJson } from "#test/support/served-db.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * The fixture under the declared name `name`: its login's workload holds the viewer's exact scoring of an account's
 * documents, `scored`, and the refresher's refresh of the view, `embeddings`.
 */
const build = (name: string) => {
	const Document = relation("Document", { id: uuid, account: uuid }, ["id"])
	const DocumentEmbedding = relation(
		"DocumentEmbedding",
		{ document: uuid, value: pg.vector(dimensions) },
		["document"]
	)
	const Core = schema(name, { Document, DocumentEmbedding }, [
		contained(on(DocumentEmbedding, "document"), on(Document, "id"))
	])
	/** Each embedded document with its account: keyed by document, inherited from the embedding's key. */
	const Embeddings = derived.materialized(
		"Embeddings",
		query(Core).rule((r) => {
			const { document, value } = v(DocumentEmbedding, "documentEmbedding")
			const { account } = v(Document, "document")
			return r
				.match(DocumentEmbedding, { document, value })
				.match(Document, { id: document, account })
				.find({ document, account, value })
		})
	)
	const Reports = schema.extend(Core, `${name}_1`, { Embeddings }, [])
	const viewer = role(Reports, "viewer", { Embeddings })
	const refresher = role(Reports, "refresher", { Embeddings }, { refresh: ["Embeddings"] })
	/** The exact scoring of an account's documents through the view, the viewer's one relation. */
	const scored = query(viewer).rule((r) => {
		const { document, value } = v(Embeddings, "embeddings")
		return r.match(Embeddings, { document, account: r.param("account", uuid), value }).find({
			document,
			distance: Compute.cosineDistance(value, r.param("vector", DocumentEmbedding.fields.value))
		})
	})
	const server = login(Reports, "server", [viewer, refresher], {
		workload: [
			workload(viewer, { scored }),
			workload(refresher, { embeddings: refresh([Embeddings]) })
		]
	})
	return {
		Embeddings,
		Reports,
		viewer,
		refresher,
		server,
		scored
	}
}

const id = (prefix: number, n: number): Uuid =>
	`${pipe(prefix.toString(16), Str.padStart(8, "0"))}-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const accountA = id(0xa, 1)
const accountB = id(0xb, 1)

/** The query vector a test numbers `n`, drawn anew in every run. */
type Probe = (n: number) => ReadonlyArray<number>

/** Sixteen documents of A and eight of B, every one embedded but the last of each account. */
const documentsOf = (probe: Probe) =>
	Arr.makeBy(24, (i) => ({
		id: id(0xd, i + 1),
		account: i < 16 ? accountA : accountB,
		value: i === 15 || i === 23 ? undefined : probe(100 + i)
	}))

const policySettings = Arr.map(searchPolicySettings, (s) => `${s.parameter}=${s.value}`)

interface Opened {
	readonly installed: Installed
	readonly fixture: ReturnType<typeof build>
	/** The fixture's login served as an application serves it. */
	readonly served: ServedFixture<ReturnType<typeof build>["server"]>
	/** A relation's qualified, quoted name in the installation. */
	readonly table: (relation: string) => string
	readonly probe: Probe
}

/**
 * Installs the fixture under a fresh schema, loads the documents, rebuilds the fixture under the installed name, so
 * Db.open takes on the installed roles (test/pg/reads/support.ts), serves its login, and refreshes the view through the
 * refresher's workload member.
 */
const opened = Effect.gen(function* () {
	const s = yield* Substrate
	const probe = yield* runProbes
	const documents = documentsOf(probe)
	const declared = build("VectorView")
	const installed = yield* install(declared.Reports, {
		ambient: ordinarySession,
		label: "vecview",
		logins: [declared.server],
		extensions: []
	})
	const table = (relation: string): string => {
		const name = installed.names.relation(relation)
		return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
	}
	yield* s.admin.query(
		`INSERT INTO ${table("Document")} ("id", "account") VALUES ${Arr.join(
			Arr.map(documents, (d) => `('${d.id}'::uuid, '${d.account}'::uuid)`),
			", "
		)}`,
		[]
	)
	yield* s.admin.query(
		`INSERT INTO ${table("DocumentEmbedding")} ("document", "value") VALUES ${Arr.join(
			Arr.flatMap(documents, (d) =>
				d.value === undefined
					? []
					: [`('${d.id}'::uuid, '${vectorText(d.value)}'::vector_ext.vector)`]
			),
			", "
		)}`,
		[]
	)
	const fixture = build(installed.declared)
	const served = yield* servedFixture(installed, fixture.server)
	yield* Effect.gen(function* () {
		const db = yield* Db.open(served.login.roles.refresher, {})
		yield* db.workload.embeddings.refresh
	}).pipe(Effect.scoped, withLayer(served.layer))
	return { installed, fixture, served, table, probe } satisfies Opened
})

/** A case: the account the viewer scores, the probe it scores by, and the take of a search over the view. */
interface ViewCase {
	readonly account: "A" | "B"
	readonly probe: number
	readonly take: number
}

type ViewFeature = "account A scored" | "account B scored" | "a search over the view refused"

layer(Substrate.layer)("approximateNearest over a derived relation", (it) => {
	it.effect(
		"the viewer reaches the vector type only through the view, runs under the search policy, reads its vectors exactly, and is refused a search over it",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* opened
					const s = yield* Substrate
					const viewer = o.installed.role(o.fixture.viewer)
					const session = yield* s.session({
						...worldSession(o.installed.world(o.fixture.viewer)),
						label: "viewer"
					})
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(o.served.login.roles.viewer, {})
						return yield* explore(
							{
								suite: "pg/vector/derived",
								draw: drawn((source): ViewCase => ({
									account: source.draw(element(["A", "B"] as const)),
									probe: source.draw(int(0, 99)),
									take: source.draw(int(1, 20))
								})),
								literal: Formatter.format,
								oracle: {
									kind: "second-implementation",
									name: "the owner's complete scan of the view, scored with pgvector's own operator"
								},
								coverage: required<ViewFeature>(
									["account A scored", "account B scored", "a search over the view refused"],
									{ cases: 12, sense: notesOnly }
								),
								kept: [],
								runs: 8,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 4,
								caseHang
							},
							(c, k) =>
								Effect.gen(function* () {
									/** The viewer's own view is its one path to the vector type. */
									const privileges = yield* s.admin.queryValues(
										`SELECT pg_catalog.has_table_privilege($1::text, $2::text, 'SELECT')::text, pg_catalog.has_table_privilege($1::text, $3::text, 'SELECT')::text, pg_catalog.has_table_privilege($1::text, $4::text, 'SELECT')::text, pg_catalog.has_table_privilege($1::text, $5::text, 'SELECT')::text, pg_catalog.has_schema_privilege($1::text, 'vector_ext', 'USAGE')::text`,
										[
											viewer,
											roleNamesOf(o.installed, o.fixture.viewer).view("Embeddings"),
											o.table("Embeddings"),
											o.table("Document"),
											o.table("DocumentEmbedding")
										]
									)
									assert.deepEqual(textRows(privileges), [
										["true", "false", "false", "false", "true"]
									])
									for (const p of searchPolicySettings) {
										const rows = yield* session.values(`SHOW ${p.parameter}`, [])
										assert.deepEqual(rows, [[p.value]], p.parameter)
									}
									yield* session.values(
										`SELECT vector_ext.vector_dims('[1]'::vector_ext.vector)`,
										[]
									)
									for (const p of searchPolicySettings) {
										const rows = yield* session.values(`SHOW ${p.parameter}`, [])
										assert.deepEqual(rows, [[p.value]], p.parameter)
									}
									assert.deepEqual(
										admittedPolicy(o.installed.snapshot, o.installed.as(o.fixture.server).role),
										policySettings
									)
									const account = c.account === "A" ? accountA : accountB
									const vector = o.probe(c.probe)
									/**
									 * A complete scan of the view, as the owner sees it: every embedded document of the
									 * account with the native distance, the same C function `cosine_distance` calls.
									 */
									const oracle = yield* Effect.map(
										s.admin.queryValues(
											`SELECT "document"::text, ("value" OPERATOR(vector_ext.<=>) $1::vector_ext.vector)::text FROM ${o.table("Embeddings")} WHERE "account" = $2::uuid ORDER BY 1`,
											[vectorText(vector), account]
										),
										textRows
									)
									assert.notDeepEqual(oracle, [], "the view holds the account's embedded documents")
									const rows = yield* (yield* db.workload.scored.execute({
										account,
										vector: vectorParam(vector)
									})).collect
									const pairs: ReadonlyArray<ReadonlyArray<string | number>> = Arr.map(
										rows,
										(r) => [r.document, r.distance]
									)
									assert.deepEqual(
										Arr.sortWith(pairs, (row) => String(row[0]), Order.String),
										Arr.map(oracle, ([document, distance]) => [
											defined(document, "a document"),
											Number(distance)
										])
									)
									k.note(c.account === "A" ? "account A scored" : "account B scored")
									/**
									 * A ranked vector must be a stored relation's field: a search over the view is refused by the
									 * checker, and by the compile of a served workload that holds it, at the program.
									 */
									const nearest = o.fixture.scored.approximateNearest({
										by: "distance",
										take: c.take
									})
									refused(
										Result.flatMap(queryInput(nearest), (input) =>
											checkQuery(checking(o.fixture.viewer), input.desc, checkOptions("query"))
										),
										"UnsupportedOperation",
										"the checker refuses the search"
									)
									const refusal = yield* Effect.flip(
										Effect.asVoid(
											servedJson(o.installed, o.fixture.server, [
												servedPrograms(o.fixture.viewer, { nearest })
											])
										)
									)
									assert.deepEqual(refusal.place, {
										kind: "program",
										role: "viewer",
										program: "nearest"
									})
									k.note("a search over the view refused")
								})
						)
					}).pipe(Effect.scoped, withLayer(o.served.layer))
				})
			)
	)
})
