import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { type Gen, int, map } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Exit, Formatter, Layer, Record as Rec, Result } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { compiledDbLayer } from "#adapter/pool/registry.ts"
import { artifactsOver, layerOver, loginRoles, workloadSlice } from "#adapter/served/login.ts"
import { noLevelAbove } from "#adapter/witness/keylaw.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, servedFiles } from "#cli/generate.ts"
import { selectMaxEntries } from "#compiler/core/limits.ts"
import * as Engine from "#compiler/core/result.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { installBasis } from "#compiler/physical/install/plan.ts"
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
import { upTo } from "#test/support/up-to.ts"

/**
 * `grizzle generate` compiles every program of a login's workloads once, into the login's served file, through the
 * one compile of a login (adapter/served/compile.ts compileServed over adapter/served/login.ts loginRoles), so a program
 * generate admits is one the layer's own compilation admits and its drafted snapshot opens the layer, and one that
 * compilation refuses refuses generate, by the program, with the same CompileError.
 *
 * The box is PostgreSQL's select list around its bound (core/limits.ts selectMaxEntries): a login whose workload holds
 * one query, whose head is every field of two joined relations, split between them evenly, on the bound and one
 * entry past it. The checker admits every width; the statements the layer compiles refuse a head past the
 * bound when they are printed (ResourceBound, selectList). Within it, the layer compiles the program, generate drafts
 * it and writes its served file, and its snapshot opens a DbLayer, which builds without a connection; past it, the
 * layer refuses the program and generate refuses with the CompileError the layer refuses it with, the draft's access
 * plan or the served file's compile naming the program. A case compiles a program of some 1,664 columns, so the box is
 * the bound and the entry past it alone.
 */

/** A head around the select list's bound: its entries, and how many of them are the left relation's fields. */
interface Head {
	readonly entries: number
	readonly left: number
}

/** A head on the bound or one entry past it, its fields split evenly between two relations. */
const headGen: Gen<Head> = map(int(0, 1), (offset): Head => {
	const entries = selectMaxEntries.value + offset
	return { entries, left: Math.ceil((entries - 1) / 2) }
})

type Width = "within the bound" | "at the bound" | "past the bound" | "one past the bound"

/** Where a head stands against the bound. */
const widthsOf = (head: Head): ReadonlyArray<Width> => [
	head.entries <= selectMaxEntries.value ? "within the bound" : "past the bound",
	...(head.entries === selectMaxEntries.value ? ["at the bound" as const] : []),
	...(head.entries === selectMaxEntries.value + 1 ? ["one past the bound" as const] : [])
]

/**
 * A relation keyed by `id`, with `count` boolean fields named `<prefix><i>` beside it: one byte each, so a row fits one
 * heap tuple, which the select list is the first limit past.
 */
const side = <const Name extends string>(name: Name, prefix: string, count: number) => {
	const fields: Readonly<Record<string, typeof uuid | typeof pg.boolean>> = {
		id: uuid,
		...Rec.fromEntries(upTo(count, (i) => [`${prefix}${i}`, pg.boolean] as const))
	}
	return relation(name, fields, ["id"])
}

/** The schema and login of a head: every field of a left relation and of the right one of its id. */
const pairsOf = (head: Head) => {
	const Left = side("Left", "l", head.left)
	const Right = side("Right", "r", head.entries - 1 - head.left)
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
		"compile a login's programs alike at the select list's bound and beside it: what generate drafts opens the layer, and what the layer refuses refuses the draft with the layer's own refusal",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/cli/generate-opens",
						generator: headGen,
						literal: Formatter.format,
						limit: 2,
						coverage: requiredInSpace<Width>([
							"within the bound",
							"at the bound",
							"past the bound",
							"one past the bound"
						]),
						caseHang,
						box: "a program's head on PostgreSQL's select list's bound and one entry past it",
						oracle: {
							kind: "second-implementation",
							name: "DbLayer.make's own compilation of the login's programs (served/login.ts loginRoles), and the select list's bound"
						}
					},
					(head: Head, c: Case<Width>) =>
						Effect.gen(function* () {
							c.noteAll(widthsOf(head))
							const within = head.entries <= selectMaxEntries.value
							const pairs = pairsOf(head)
							const config = yield* resolveConfig(
								defineConfig({
									schemas: [pairs.schema],
									logins: [pairs.login],
									migrations: "migrations",
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
										noDeclarations
									),
									(draft) =>
										Effect.as(servedFiles(compiledSchema, draft.snapshotFiles), draft.snapshotFiles)
								)
							)
							const codes = firstCodebook(rostersOf(compiledSchema.owned))
							const compiled = yield* Effect.result(
								Effect.flatMap(
									Effect.mapError(
										workloadSlice(compiledLogin.login, compiledLogin.owned),
										(refused) => refused.error
									),
									(slice) =>
										Effect.flatMap(
											fromEngine(
												layerOver(slice, (sliced) =>
													Engine.flatMap(
														installBasis(compiledLogin.owned.base, codes, sliced),
														artifactsOver
													)
												)
											),
											(layer) =>
												Effect.mapError(
													loginRoles(compiledLogin.login, compiledLogin.owned, layer, noLevelAbove),
													(refused) => refused.error
												)
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
								const opened = yield* Effect.exit(
									Effect.scoped(
										Layer.build(
											compiledDbLayer({
												...offlineConnection,
												pool: clusterPool,
												login: pairs.login,
												snapshot: snapshotJson(generated.success.snapshot)
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
							if (refusal._tag === "DraftRefused" || refusal._tag === "ServedRefused") {
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
