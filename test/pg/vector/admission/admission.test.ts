import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Result, Schema } from "effect"
import {
	admissionExpectation,
	databaseQuery,
	extensionsQuery,
	serverMismatches,
	serverRows
} from "#adapter/admission/expectation.ts"
import { dbContext } from "#adapter/db/context.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import {
	type AdmissionMismatch,
	AdmissionRefused,
	type AdmissionStage
} from "#adapter/errors/failures.ts"
import { Db } from "#adapter/public/db.ts"
import { emptyFingerprint } from "#compiler/deploy/snapshot/build.ts"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import { bareDatabase, installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { installMigratedIn as installIn } from "#test/support/install-migrate.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { loginLayerIn } from "#test/support/worlds.ts"

const builtinCUtf8 =
	"ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C.UTF-8'"

const refusal = (
	error: unknown
): { readonly stage: string; readonly refused: AdmissionRefused } => {
	assert.ok(Schema.is(OpenError)(error))
	assert.ok(Schema.is(AdmissionRefused)(error.reason))
	return { stage: error.stage, refused: error.reason }
}

/** The stage admission refuses mismatches at, the first in its order; none for no mismatch. */
const refusalStage = (mismatches: ReadonlyArray<AdmissionMismatch>): AdmissionStage | undefined =>
	Arr.isReadonlyArrayNonEmpty(mismatches) ? AdmissionRefused.make({ mismatches }).stage : undefined

/** Every cell as the wire delivers it: text. */
const texts = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.map(rows, (row) =>
		Arr.map(row, (cell) => {
			if (typeof cell !== "string") {
				throw new Error(`a cell delivered as ${typeof cell}, not as text`)
			}
			return cell
		})
	)

layer(Substrate.layer)("pgvector admission", (it) => {
	it.effect(
		"admits vector 0.8.7 in vector_ext, read from the real catalog, and refuses any other version or schema",
		() =>
			Effect.gen(function* () {
				const opened = yield* installed(search.Search, {}, { label: "real", extensions: [] })

				/**
				 * Db.open admits the vector schema here: its admission found the pinned version in the vector schema.
				 */
				const expected = yield* Effect.gen(function* () {
					const db = yield* Db.open(opened.server.roles.app, {})
					const ctx = dbContext(db)
					if (ctx === undefined) {
						throw new Error("an opened Db has a context")
					}
					assert.equal(ctx.installedExtensions.get("vector"), ctx.artifacts.names.vectorSchema)
					return admissionExpectation(ctx.artifacts)
				}).pipe(Effect.scoped, withLayer(opened.layer))

				/**
				 * The rows admission reads, read here by a session of the login that has taken on the full role, each
				 * statement alone, as admission runs its statements apart.
				 */
				const s = yield* Substrate
				const searcher = yield* s.session({
					...worldSession(opened.installed.world(opened.app)),
					label: "searcher"
				})
				const rows = Result.getOrThrow(
					serverRows({
						database: texts(yield* searcher.values(databaseQuery.sql, [])),
						extensions: texts(yield* searcher.values(extensionsQuery.sql, []))
					})
				)
				assert.deepEqual(serverMismatches(rows, expected), [])

				/**
				 * Another pinned version or another schema is refused at the capability stage, against the same rows.
				 */
				const [vector] = expected.extensions
				if (vector === undefined) {
					throw new Error("a vector schema expects the extension")
				}
				const older = serverMismatches(rows, {
					...expected,
					extensions: [{ ...vector, version: "0.8.6" }]
				})
				assert.equal(refusalStage(older), "capability")
				const elsewhere = serverMismatches(rows, {
					...expected,
					extensions: [{ ...vector, schema: "public" }]
				})
				assert.equal(refusalStage(elsewhere), "capability")
			}).pipe(Effect.scoped)
	)

	it.effect(
		"a database without pgvector refuses a vector schema and admits a schema without vectors",
		() =>
			Effect.gen(function* () {
				const vectors = yield* installed(search.Search, {}, { label: "real", extensions: [] })
				const plain = yield* installed(W.Work, workFacts, { label: "real", extensions: [] })
				const database = yield* bareDatabase("novec", builtinCUtf8)

				const refused = refusal(
					yield* Effect.flip(
						Db.open(vectors.server.roles.app, {}).pipe(
							withLayer(loginLayerIn(database, vectors.installed, vectors.server))
						)
					)
				)
				assert.equal(refused.stage, "capability")
				const schema = vectors.installed.schema
				assert.deepEqual(
					Arr.map(refused.refused.mismatches, (m) => [m.stage, m.check, m.expected, m.observed]),
					[
						[
							"capability",
							"extension vector",
							"version 0.8.7 installed in schema vector_ext",
							"<not installed>"
						],
						[
							"ledger",
							`ledger ${schema}.${ledgerTableName} latest complete target`,
							vectors.installed.snapshot.fingerprint,
							emptyFingerprint(schema)
						]
					]
				)

				yield* installIn(database, plain.installed)
				const expectation = yield* Effect.gen(function* () {
					const db = yield* Db.open(plain.server.roles.app, {})
					const ctx = dbContext(db)
					assert.equal(ctx?.installedExtensions.has("vector"), false)
					return ctx === undefined ? undefined : admissionExpectation(ctx.artifacts)
				}).pipe(Effect.scoped, withLayer(loginLayerIn(database, plain.installed, plain.server)))
				assert.deepEqual(expectation?.extensions, [])
			}).pipe(Effect.scoped)
	)
})
