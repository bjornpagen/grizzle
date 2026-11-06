import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
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
import { assert, defined } from "#test/support/assert.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { installMigratedIn as installIn } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { loginLayerIn } from "#test/support/worlds.ts"

const builtinCUtf8 =
	"ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C.UTF-8'"

const refusal = (
	error: unknown
): { readonly stage: string; readonly refused: AdmissionRefused } => {
	assert.ok(error instanceof OpenError)
	assert.ok(error.reason instanceof AdmissionRefused)
	return { stage: error.stage, refused: error.reason }
}

/** The stage admission refuses mismatches at, the first in its order; none for no mismatch. */
const refusalStage = (mismatches: ReadonlyArray<AdmissionMismatch>): AdmissionStage | undefined =>
	Arr.isReadonlyArrayNonEmpty(mismatches) ? new AdmissionRefused({ mismatches }).stage : undefined

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

/** The schemas a case opens: one storing vectors, and the worked example, which stores none. */
type SchemaKind = "vectors" | "plain"

/** The databases a case opens in: the test database, which has pgvector, and a bare one without it. */
type DatabaseKind = "with pgvector" | "without pgvector"

/**
 * A case: an open of a schema in a database, and a requirement of the vector extension at a version and in a schema,
 * each the pinned one or another, judged against the rows admission reads from the real catalog.
 */
interface AdmissionCase {
	readonly schema: SchemaKind
	readonly database: DatabaseKind
	readonly version: string
	readonly in: string
}

/** What a case reached: each open's verdict, and each requirement met or refused for its version or its schema. */
type AdmissionFeature =
	| `${SchemaKind} ${"admitted" | "refused"} ${DatabaseKind}`
	| "a requirement met"
	| "another version refused"
	| "another schema refused"

layer(Substrate.layer)("pgvector admission", (it) => {
	it.effect(
		"admits a schema exactly when the database holds each extension it needs at the pinned version in the pinned schema",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const vectors = yield* installed(search.Search, {}, { label: "real", extensions: [] })
					const plain = yield* installed(W.Work, workFacts, { label: "real", extensions: [] })
					const database = yield* bareDatabase("novec", builtinCUtf8)
					yield* installIn(database, plain.installed)

					/** The admission a Db.open of the vector schema made: the vector extension it requires. */
					const expected = yield* Effect.gen(function* () {
						const db = yield* Db.open(vectors.server.roles.app, {})
						const opened = defined(dbContext(db), "an opened Db has a context")
						assert.equal(
							opened.installedExtensions.get("vector"),
							opened.artifacts.names.vectorSchema
						)
						return admissionExpectation(opened.artifacts)
					}).pipe(Effect.scoped, withLayer(vectors.layer))
					const [vector] = expected.extensions
					if (vector === undefined) {
						throw new Error("a vector schema expects the extension")
					}
					/**
					 * The rows admission reads, read here by a session of the login that has taken on the full role, each
					 * statement alone, as admission runs its statements apart.
					 */
					const s = yield* Substrate
					const searcher = yield* s.session({
						...worldSession(vectors.installed.world(vectors.app)),
						label: "searcher"
					})
					const databaseRows = yield* searcher.values(databaseQuery.sql, [])
					const extensionRows = yield* searcher.values(extensionsQuery.sql, [])
					const rows = Result.getOrThrow(
						serverRows({
							database: texts(databaseRows),
							extensions: texts(extensionRows)
						})
					)
					/** The open of a case's schema in its database: the opened Db's context, or its OpenError. */
					const openIn = (c: AdmissionCase) => {
						switch (c.schema) {
							case "vectors":
								return Effect.scoped(
									Db.open(vectors.server.roles.app, {}).pipe(
										withLayer(
											c.database === "with pgvector"
												? vectors.layer
												: loginLayerIn(database, vectors.installed, vectors.server)
										),
										Effect.map(dbContext)
									)
								)
							case "plain":
								return Effect.scoped(
									Db.open(plain.server.roles.app, {}).pipe(
										withLayer(
											c.database === "with pgvector"
												? plain.layer
												: loginLayerIn(database, plain.installed, plain.server)
										),
										Effect.map(dbContext)
									)
								)
						}
					}
					return yield* explore(
						{
							suite: "pg/vector/admission",
							draw: drawn((source): AdmissionCase => ({
								schema: source.draw(element<SchemaKind>(["vectors", "plain"])),
								database: source.draw(element<DatabaseKind>(["with pgvector", "without pgvector"])),
								version: source.draw(element([vector.version, "0.8.6", "0.8.8", "0.9.0"])),
								in: source.draw(element([vector.schema, "public", "vector"]))
							})),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "an extension a schema needs is admitted exactly at its pinned version in its pinned schema, and a schema without vectors needs none"
							},
							coverage: required<AdmissionFeature>(
								[
									"vectors admitted with pgvector",
									"vectors refused without pgvector",
									"plain admitted with pgvector",
									"plain admitted without pgvector",
									"a requirement met",
									"another version refused",
									"another schema refused"
								],
								{ cases: 24, sense: notesOnly }
							),
							kept: [],
							runs: 16,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(c, k) =>
							Effect.gen(function* () {
								/** The requirement against the real catalog's rows: met exactly at both pinned values. */
								const mismatches = serverMismatches(rows, {
									...expected,
									extensions: [{ ...vector, version: c.version, schema: c.in }]
								})
								if (c.version === vector.version && c.in === vector.schema) {
									assert.deepEqual(mismatches, [])
									k.note("a requirement met")
								} else {
									assert.deepEqual(mismatches, [
										{
											stage: "capability",
											check: "extension vector",
											expected: `version ${c.version} installed in schema ${c.in}`,
											observed: `version ${vector.version} installed in schema ${vector.schema}`
										}
									])
									assert.equal(refusalStage(mismatches), "capability")
									k.note(
										c.version === vector.version
											? "another schema refused"
											: "another version refused"
									)
								}
								const open = yield* Effect.result(openIn(c))
								if (c.schema === "vectors" && c.database === "without pgvector") {
									if (Result.isSuccess(open)) {
										return assert.fail("a vector schema opened on a database without pgvector")
									}
									const refused = refusal(open.failure)
									assert.equal(refused.stage, "capability")
									const schema = vectors.installed.schema
									assert.deepEqual(
										Arr.map(refused.refused.mismatches, (m) => [
											m.stage,
											m.check,
											m.expected,
											m.observed
										]),
										[
											[
												"capability",
												"extension vector",
												`version ${vector.version} installed in schema ${vector.schema}`,
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
									k.note(`${c.schema} refused ${c.database}`)
									return
								}
								if (Result.isFailure(open)) {
									return assert.fail(`${c.schema} refused ${c.database}: ${String(open.failure)}`)
								}
								const context = defined(open.success, "an opened Db has a context")
								assert.equal(
									context.installedExtensions.has("vector"),
									c.database === "with pgvector"
								)
								assert.deepEqual(
									Arr.map(admissionExpectation(context.artifacts).extensions, (e) => e.name),
									c.schema === "vectors" ? ["vector"] : []
								)
								k.note(`${c.schema} admitted ${c.database}`)
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
