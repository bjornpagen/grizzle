/** What the properties of derived.test.ts read: its spaces, models and helpers. */

import { Array as Arr, Effect, pipe, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { searchPolicySettings } from "#compiler/physical/ddl/roles.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { refresh, workload } from "#compiler/public/workload.ts"
import { dimensions, probeOf, vectorText } from "#test/pg/vector/ann/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { Id, type IdValue } from "#test/support/ids.ts"
import { type Generated, generatedTemplate, type Installed } from "#test/support/install-migrate.ts"
import { type ServedFixture, servedGenerated } from "#test/support/served-db.ts"
import { Substrate, type SubstrateCase } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * The fixture under the declared name `name`: its login's workload holds the viewer's exact scoring of an account's
 * documents, `scored`, and the refresher's refresh of the view, `embeddings`.
 */
const build = (name: string) => {
	const Document = relation("Document", { id: Id, account: Id }, ["id"])
	const DocumentEmbedding = relation(
		"DocumentEmbedding",
		{ document: Id, value: pg.vector(dimensions) },
		["document"]
	)
	const Core = schema(
		name,
		[Document, DocumentEmbedding],
		[contained(on(DocumentEmbedding, "document"), on(Document, "id"))]
	)
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
	const Reports = schema.extend(Core, `${name}_1`, [Embeddings], [])
	const viewer = role(Reports, "viewer", { Embeddings })
	const refresher = role(Reports, "refresher", { Embeddings }, { refresh: ["Embeddings"] })
	/** The exact scoring of an account's documents through the view, the viewer's one relation. */
	const scored = query(viewer).rule((r) => {
		const { document, value } = v(Embeddings, "embeddings")
		return r.match(Embeddings, { document, account: r.param("account", Id), value }).find({
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

const id = (prefix: number, n: number): IdValue =>
	Id(
		`${pipe(prefix.toString(16), Str.padStart(8, "0"))}-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`
	)

export const derivedAccountA = id(0xa, 1)

export const derivedAccountB = id(0xb, 1)

/** The query vector a test numbers `n`, drawn anew in every run. */
type Probe = (n: number) => ReadonlyArray<number>

/** Sixteen documents of A and eight of B, every one embedded but the last of each account. */
const documentsOf = (probe: Probe) =>
	Arr.makeBy(24, (i) => ({
		id: id(0xd, i + 1),
		account: i < 16 ? derivedAccountA : derivedAccountB,
		value: i === 15 || i === 23 ? undefined : probe(100 + i)
	}))

export const policySettings = Object.freeze(
	Arr.map(searchPolicySettings, (s) => `${s.parameter}=${s.value}`)
)

interface Opened {
	readonly installed: Installed
	readonly fixture: ReturnType<typeof build>
	/** The fixture's login served from the file generate wrote for it. */
	readonly served: ServedFixture<ReturnType<typeof build>["server"]>
	/** A relation's qualified, quoted name in the installation. */
	readonly table: (relation: string) => string
	readonly probe: Probe
}

/**
 * The fixture drafted and served as `grizzle generate` drafts it with its login (install-migrate.ts generatedTemplate),
 * once per member under the template's name, where the search installed it once before its cases.
 */
export const reportsTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "vecview",
	content: { fixture: "vecview" },
	build: (name) => {
		const at = build(name)
		return { schema: at.Reports, logins: [at.server] }
	},
	ambient: ordinarySession
})

/**
 * A case's fixture over its own clone of the template (reportsTemplate): loads the documents of the probes of the
 * case's own draw of vectors (`vectors`), which each case draws anew and so no template holds, rebuilds the fixture under the installed name, so Db.open takes on
 * the installed roles (test/pg/reads/support.ts), serves its login from the file generate wrote, and refreshes the view
 * through the refresher's workload member, a refresh the clone's own, which it drops after the case.
 */
export const openedIn = (taken: SubstrateCase<Generated>, vectors: number) =>
	Effect.provideService(
		Effect.gen(function* () {
			const s = yield* Substrate
			const probe = probeOf(vectors)
			const documents = documentsOf(probe)
			const generated = taken.value
			const installed = generated.installed
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
			const served = servedGenerated(generated, fixture.server)
			yield* Effect.gen(function* () {
				const db = yield* Db.open(served.login.roles.refresher, {})
				yield* db.workload.embeddings.once({ params: {}, facts: {} })
			}).pipe(Effect.scoped, withLayer(served.layer))
			return { installed, fixture, served, table, probe } satisfies Opened
		}),
		Substrate,
		taken.substrate
	)

/** A case: the account the viewer scores, the probe it scores by, and the take of a search over the view. */
export interface ViewCase {
	readonly account: "A" | "B"
	readonly probe: number
	readonly take: number
	/** The draw of the documents' and the probes' vectors (ann/support.ts probeOf). */
	readonly vectors: number
}

export type ViewFeature = "account A scored" | "account B scored" | "a search over the view refused"
