import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Order, pipe, Schema, String as Str } from "effect"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import { checkQuery } from "#compiler/check/index.ts"
import * as Result from "#compiler/core/result.ts"
import { searchPolicySettings } from "#compiler/physical/ddl/roles.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, login, on, relation, role, schema } from "#compiler/public/schema.ts"
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
import { checking, checkOptions } from "#test/support/policy.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { loginLayer } from "#test/support/worlds.ts"

/** The fixture under the declared name `name`. */
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
	const Embeddings = derived(
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
	const Reports = schema.extend(Core, { Embeddings }, [])
	const viewer = role(Reports, "viewer", { Embeddings })
	const refresher = role(Reports, "refresher", { Embeddings }, { refresh: ["Embeddings"] })
	const server = login(Reports, "server", [viewer, refresher])
	/** The exact scoring of an account's documents through the view, the viewer's one relation. */
	const scored = query(viewer).rule((r) => {
		const { document, value } = v(Embeddings, "embeddings")
		return r.match(Embeddings, { document, account: r.param("account", uuid), value }).find({
			document,
			distance: Compute.cosineDistance(value, r.param("vector", DocumentEmbedding.fields.value))
		})
	})
	return {
		Embeddings,
		Reports,
		viewer,
		refresher,
		server,
		scored,
		nearest: scored.approximateNearest({ by: "distance", take: 3 })
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

/** The parameters of every read: account A, probed with the vector numbered 7. */
const paramsOf = (probe: Probe) => ({ account: accountA, vector: vectorParam(probe(7)) })

const policySettings = Arr.map(searchPolicySettings, (s) => `${s.parameter}=${s.value}`)

interface Opened {
	readonly installed: Installed
	readonly fixture: ReturnType<typeof build>
	/** A relation's qualified, quoted name in the installation. */
	readonly table: (relation: string) => string
	readonly probe: Probe
	readonly params: ReturnType<typeof paramsOf>
}

/**
 * Installs the fixture under a fresh schema, loads the documents, refreshes the view as the refresher, and rebuilds
 * the fixture under the installed name, so Db.open takes on the installed roles (test/pg/reads/support.ts).
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
	yield* Effect.gen(function* () {
		const db = yield* Db.open(fixture.server.roles.refresher, {})
		yield* db.refresh(fixture.Embeddings)
	}).pipe(Effect.scoped, withLayer(loginLayer(installed, fixture.server)))
	return { installed, fixture, table, probe, params: paramsOf(probe) } satisfies Opened
})

layer(Substrate.layer)("approximateNearest over a derived relation", (it) => {
	it.effect(
		"the viewer reaches the vector type only through the view, runs under the search policy, and reads its vectors",
		() =>
			Effect.gen(function* () {
				const o = yield* opened
				const s = yield* Substrate
				const viewer = o.installed.role(o.fixture.viewer)
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
				assert.deepEqual(yield* textRows(privileges), [["true", "false", "false", "false", "true"]])

				/**
				 * The first migration stored the policy for the viewer's login, and its session as the viewer shows it
				 * before and after the vector library loads.
				 */
				const session = yield* s.session({
					...worldSession(o.installed.world(o.fixture.viewer)),
					label: "viewer"
				})
				for (const p of searchPolicySettings) {
					assert.deepEqual(
						yield* session.values(`SHOW ${p.parameter}`, []),
						[[p.value]],
						p.parameter
					)
				}
				yield* session.values(`SELECT vector_ext.vector_dims('[1]'::vector_ext.vector)`, [])
				for (const p of searchPolicySettings) {
					assert.deepEqual(
						yield* session.values(`SHOW ${p.parameter}`, []),
						[[p.value]],
						p.parameter
					)
				}

				/**
				 * A complete scan of the view, as the owner sees it: every embedded document of the account with the
				 * native distance, the same C function `cosine_distance` calls.
				 */
				const oracle = yield* textRows(
					yield* s.admin.queryValues(
						`SELECT "document"::text, ("value" OPERATOR(vector_ext.<=>) $1::vector_ext.vector)::text FROM ${o.table("Embeddings")} WHERE "account" = $2::uuid ORDER BY 1`,
						[vectorText(o.probe(7)), accountA]
					)
				)
				assert.notDeepEqual(oracle, [], "the view holds A's embedded documents")

				yield* Effect.gen(function* () {
					const db = yield* Db.open(o.fixture.server.roles.viewer, {})
					assert.deepEqual(
						admittedPolicy(o.installed.snapshot, o.installed.as(o.fixture.server).role),
						policySettings
					)
					const rows = yield* (yield* db.execute(o.fixture.scored, o.params)).collect
					const pairs: ReadonlyArray<ReadonlyArray<string | number>> = Arr.map(rows, (r) => [
						r.document,
						r.distance
					])
					assert.deepEqual(
						Arr.sortWith(pairs, (row) => String(row[0]), Order.String),
						Arr.map(oracle, ([document, distance]) => [
							defined(document, "a document"),
							Number(distance)
						])
					)
				}).pipe(Effect.scoped, withLayer(loginLayer(o.installed, o.fixture.server)))
			}),
		300_000
	)

	it.effect(
		"approximateNearest over the view is refused: a ranked vector must be a stored relation's field",
		() =>
			Effect.gen(function* () {
				const o = yield* opened
				const search = Result.flatMap(queryInput(o.fixture.nearest), (input) =>
					checkQuery(checking(o.fixture.viewer), input.desc, checkOptions("query"))
				)
				refused(search, "UnsupportedOperation", "the checker refuses the search")
				yield* Effect.gen(function* () {
					const db = yield* Db.open(o.fixture.server.roles.viewer, {})
					const read = yield* Effect.flip(
						Effect.flatMap(db.execute(o.fixture.nearest, o.params), (r) => r.collect)
					)
					assert.ok(Schema.is(ReadFailure)(read) && read.stage === "compile")
				}).pipe(Effect.scoped, withLayer(loginLayer(o.installed, o.fixture.server)))
			}),
		300_000
	)
})
