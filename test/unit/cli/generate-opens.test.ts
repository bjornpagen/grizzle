import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Exit, Formatter, Layer, Record as Rec, Result } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { artifactsUnder, loginRoles } from "#adapter/pool/registry.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema } from "#cli/generate.ts"
import { selectMaxEntries } from "#compiler/core/limits.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { defineConfig } from "#index.ts"
import { offlineConnection, offlineOwner } from "#test/pg/cli/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { clusterPool } from "#test/support/pg.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"

/**
 * `grizzle generate` compiles every program of a login's workloads exactly as DbLayer.make does, through the one
 * function the layer runs at startup (adapter/pool/registry.ts loginRoles), so a program generate admits is one the
 * layer opens, and one the layer would refuse refuses the draft first, with the same CompileError.
 *
 * The box is PostgreSQL's select list at its bound (core/limits.ts selectMaxEntries): a login whose workload holds
 * one query, whose head is every field of two joined relations, as wide as the select list holds, and one entry wider.
 * The checker admits both; the statements the layer compiles refuse the wider when they are printed (ResourceBound,
 * selectList). At the bound, the layer compiles the program, generate drafts it, and its snapshot opens a DbLayer,
 * which builds without a connection; one past it, the layer refuses the program and generate refuses the draft with the
 * CompileError the layer refuses it with.
 */
type Width = "at the select list's bound" | "one entry past it"

const widths = [
	"at the select list's bound",
	"one entry past it"
] as const satisfies ReadonlyArray<Width>

/** The head's entries: the select list's bound, or one more. */
const entriesOf = (width: Width): number =>
	selectMaxEntries.value + (width === "one entry past it" ? 1 : 0)

/**
 * A relation keyed by `id`, with `count` boolean fields named `<prefix><i>` beside it: one byte each, so a row fits one
 * heap tuple, which the select list is the first limit past.
 */
const side = <const Name extends string>(name: Name, prefix: string, count: number) => {
	const fields: Readonly<Record<string, typeof uuid | typeof pg.boolean>> = {
		id: uuid,
		...Rec.fromEntries(Arr.makeBy(count, (i) => [`${prefix}${i}`, pg.boolean] as const))
	}
	return relation(name, fields, ["id"])
}

/** The schema and login of a head of `entries` entries: every field of a left and of the right of its id. */
const pairsOf = (entries: number) => {
	const leftFields = Math.ceil((entries - 1) / 2)
	const Left = side("Left", "l", leftFields)
	const Right = side("Right", "r", entries - 1 - leftFields)
	const Pairs = schema("Pairs", { Left, Right }, [])
	const pairs = query(Pairs).rule((r) => {
		const left = v(Left, "left")
		const right = v(Right, "right")
		return r
			.match(Left, left)
			.match(Right, { ...right, id: left["id"] })
			.find({ ...right, ...left })
	})
	return {
		schema: Pairs,
		login: login(Pairs, "server", [role(Pairs, "reader", { Left, Right })], {
			workload: [workload(Pairs, { pairs })]
		})
	}
}

const file = `${repoRoot}app/grizzle.config.ts`

layer(NodeServices.layer, { excludeTestServices: true })("generate and DbLayer.make", (it) => {
	it.effect(
		"compile a login's programs alike at the select list's bound: what generate drafts opens the layer, and what the layer refuses refuses the draft with the layer's own refusal",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/cli/generate-opens",
						generator: element(widths),
						literal: Formatter.format,
						limit: widths.length,
						coverage: requiredInSpace<Width>(widths),
						caseHang,
						box: "a program's head at PostgreSQL's select list's bound and one entry past it",
						oracle: {
							kind: "second-implementation",
							name: "DbLayer.make's own compilation of the login's programs (registry.ts loginRoles)"
						}
					},
					(width: Width, c: Case<Width>) =>
						Effect.gen(function* () {
							c.note(width)
							const pairs = pairsOf(entriesOf(width))
							const config = yield* resolveConfig(
								defineConfig({
									schemas: [pairs.schema],
									logins: [pairs.login],
									migrations: "migrations",
									connection: offlineOwner
								}),
								file
							)
							const configured = defined(config.schemas[0], "the configured schema")
							const compiledSchema = yield* Effect.fromResult(compileSchema(configured))
							const compiledLogin = defined(compiledSchema.logins[0], "the login")
							const draft = yield* Effect.result(
								draftSchema(
									compiledSchema,
									emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
									[],
									noDeclarations
								)
							)
							const codes = firstCodebook(rostersOf(compiledSchema.owned))
							const compiled = yield* Effect.result(
								Effect.flatMap(
									fromEngine(artifactsUnder(compiledSchema.owned, codes)),
									(artifacts) => loginRoles(compiledLogin.login, compiledLogin.owned, artifacts)
								)
							)
							assert.equal(
								Result.isSuccess(compiled),
								width === "at the select list's bound",
								"the layer compiles exactly the program the select list holds"
							)
							if (Result.isSuccess(draft)) {
								assert.ok(
									Result.isSuccess(compiled),
									"generate drafts only what the layer compiles"
								)
								const opened = yield* Effect.exit(
									Effect.scoped(
										Layer.build(
											DbLayer.make({
												...offlineConnection,
												pool: clusterPool,
												login: pairs.login,
												snapshot: snapshotJson(draft.success.snapshotText)
											})
										)
									)
								)
								assert.ok(Exit.isSuccess(opened), "the drafted snapshot opens the layer")
								return
							}
							assert.ok(Result.isFailure(compiled), "generate refuses only what the layer refuses")
							if (Result.isSuccess(compiled)) {
								return
							}
							const refusal = draft.failure.reason
							assert.equal(refusal._tag, "DraftRefused")
							if (refusal._tag === "DraftRefused") {
								assert.equal(refusal.step, "workload")
								assert.deepEqual(refusal.error.reason, compiled.failure.reason)
								const reason = refusal.error.reason
								assert.ok(
									reason._tag === "ResourceBound" && reason.bound.kind === "selectList",
									"refused past the select list"
								)
							}
						})
				)
			)
	)
})
