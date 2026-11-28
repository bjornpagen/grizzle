import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Exit, Layer, Result } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { served } from "#adapter/public/layer.ts"
import { artifactsOver, loginRoles, workloadReach } from "#adapter/served/login.ts"
import { noLevelAbove } from "#adapter/witness/keylaw.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, eachServedFile } from "#cli/generate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { installBasis } from "#compiler/physical/install/plan.ts"
import type { IndexResolver } from "#compiler/plan/migration.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { selectMaxEntries } from "#compiler/sql/print.ts"
import { defineConfig } from "#index.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { offlineDecoders, servedSourcedLayer } from "#test/support/live-layer.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { clusterPool } from "#test/support/pg.ts"
import { offlineConnection, offlineOwner } from "#test/support/pg/cli/support.ts"
import {
	boxParams,
	compileCaseDeadline,
	file,
	type Head,
	headGen,
	pairsOf,
	type Width,
	widthsOf
} from "#test/unit/cli/generate-opens.fixtures.ts"

/**
 * The resolver of no installation: the layer's roles compile over artifacts no installation stands behind, and its
 * workload's one read is advised only where it is served (adapter/served/project.ts), which the draft's own snapshot
 * resolves; a read resolved here is the compile's internal compiler error.
 */
const noInstallation: IndexResolver = (request) =>
	defect(`the read of ${request.relation}, resolved where no installation stands`)

/** Generate and DbLayer.make compile a login's programs alike at the select list's bound and beside it: what generate drafts opens the layer, and what the layer refuses refuses the draft with the layer's own refusal. */
export const generateAndDbLayerMakeCompileALoginsProgramsAlikeAtTheSelectListsBoundAndBesideItWhatGenerateDraftsOpensTheLayerAndWhatTheLayerRefusesRefusesTheDraftWithTheLayersOwnRefusal =
	property.exhaust(finite(headGen), {
		needs: {},
		situations: [
			"within the bound",
			"at the bound",
			"past the bound",
			"one past the bound"
		] satisfies ReadonlyArray<Reached<Width>>,
		check: (_, c: Case<Width>) => (head: Head) =>
			Effect.gen(function* () {
				c.noteAll(widthsOf(head))
				const within = head.entries <= selectMaxEntries
				const pairs = pairsOf(head)
				const config = yield* resolveConfig(
					defineConfig({
						contracts: [],
						schemas: [pairs.schema],
						logins: [pairs.login],
						migrations: "migrations",
						rolePrefixBytes: 0,
						connection: () => offlineOwner
					}),
					file
				)
				const configured = defined(config.schemas[0], "the configured schema")
				const compiledSchema = yield* Effect.fromResult(compileSchema(configured))
				const compiledLogin = defined(compiledSchema.logins[0], "the login")
				const generated = yield* Effect.result(
					Effect.flatMap(
						draftSchema(
							compiledSchema,
							emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
							[],
							noDeclarations,
							silentPhases
						),
						(draft) =>
							eachServedFile(compiledSchema, draft, draft.served, silentPhases, Effect.succeed)
					)
				)
				const codes = firstCodebook(rostersOf(compiledSchema.owned))
				const compiled = yield* Effect.result(
					Effect.flatMap(
						Effect.flatMap(
							Effect.mapError(
								workloadReach(compiledLogin.login, compiledLogin.owned),
								(refused) => refused.error
							),
							(reach) =>
								fromEngine(
									Engine.flatMap(
										installBasis(compiledLogin.owned.base, codes, reach.served),
										(basis) => artifactsOver(basis, boxParams)
									)
								)
						),
						(artifacts) =>
							Effect.mapError(
								loginRoles(
									compiledLogin.login,
									compiledLogin.owned,
									artifacts,
									noLevelAbove,
									noInstallation
								),
								(refused) => refused.error
							)
					)
				)
				assert.equal(
					Result.isSuccess(compiled),
					within,
					"the layer compiles exactly the programs the select list holds"
				)
				if (Result.isSuccess(generated)) {
					assert.ok(
						Result.isSuccess(compiled),
						"generate drafts and serves only what the layer compiles"
					)
					const entry = defined(generated.success[0], "the login's served file")
					const opened = yield* Effect.exit(
						Effect.scoped(
							Layer.build(
								servedSourcedLayer(offlineDecoders, {
									...offlineConnection,
									pool: clusterPool,
									login: served<typeof pairs.login>(jsonOf(entry.text), "server")
								})
							)
						)
					)
					assert.ok(Exit.isSuccess(opened), "the drafted served file opens the layer")
					return
				}
				assert.ok(Result.isFailure(compiled), "generate refuses only what the layer refuses")
				if (Result.isSuccess(compiled)) {
					return
				}
				const refusal = generated.failure.reason
				assert.ok(
					(refusal._tag === "DraftRefused" && refusal.step === "workload") ||
						refusal._tag === "ServedRefused",
					`generate refuses the workload: ${refusal.message}`
				)
				if (refusal._tag === "ServedRefused") {
					assert.deepEqual(
						refusal.place,
						{ kind: "program", role: "reader", program: "pairs" },
						"the served file's compile names the program"
					)
				}
				const error = refusal.error
				assert.ok(error._tag === "CompileError", `refused by a CompileError: ${refusal.message}`)
				assert.deepEqual(error.reason, compiled.failure.reason)
				const reason = error.reason
				assert.ok(
					reason._tag === "ResourceBound" && reason.bound.kind === "selectList",
					"refused past the select list"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "DbLayer.make's own compilation of the login's programs (served/login.ts loginRoles), and the select list's bound"
		},
		box: "a program's head on PostgreSQL's select list's bound and one entry past it",
		caseDeadline: compileCaseDeadline,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: "\tif (targets.length > selectMaxEntries) {",
				replacement: "\tif (targets.length >= selectMaxEntries) {",
				why: "A select list at the bound is refused."
			}
		]
	})
