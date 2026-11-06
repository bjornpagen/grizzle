import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Exit, Layer, Record as Rec, Result } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { artifactsUnder, loginRoles } from "#adapter/pool/registry.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import type { GrizzleConfig } from "#adapter/types/config.ts"
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
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { clusterPool } from "#test/support/pg.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"

/**
 * `grizzle generate` compiles every program of a login's workloads exactly as DbLayer.make does, through the one
 * function the layer runs at startup (adapter/pool/registry.ts loginRoles), so a program generate admits is one the
 * layer opens, and one the layer would refuse refuses the draft first, with the same CompileError.
 *
 * Each case is a login whose workload holds one query: an ordered query over a relation of uuid fields, which
 * compiles; and a query whose head is every field of two joined relations, one entry past PostgreSQL's select list
 * (core/limits.ts selectMaxEntries), which the checker admits and the statements the layer compiles refuse when they
 * are printed (ResourceBound, selectList). The first drafts, and its snapshot opens a DbLayer, which builds without a
 * connection; the second refuses the draft with the CompileError the layer's compilation refuses it with.
 */
const Visit = relation("Visit", Rec.fromEntries(Arr.makeBy(24, (i) => [`u${i}`, uuid] as const)), [
	"u0"
])
const Visits = schema("Visits", { Visit }, [])

/** Every visit. */
const visits = query(Visits).rule((r) => {
	const visit = v(Visit, "visit")
	return r.match(Visit, visit).find(visit)
})

/** Ordered by four uuids. */
const fewKeys = visits.orderBy(["u0", "asc"], ["u1", "asc"], ["u2", "asc"], ["u3", "asc"])

const visitsLogin = login(Visits, "server", [role(Visits, "reader", { Visit })], {
	workload: [workload(Visits, { visits: fewKeys })]
})

/** The fields of each joined relation beside its key: both relations' and the key are one entry past a select list. */
const sideFields = Math.ceil(selectMaxEntries.value / 2)

/**
 * A relation keyed by `id`, with `sideFields` boolean fields named `<prefix><i>` beside it: one byte each, so a row fits
 * one heap tuple, which the select list is the first limit past.
 */
const side = <const Name extends string>(name: Name, prefix: string) => {
	const fields: Readonly<Record<string, typeof uuid | typeof pg.boolean>> = {
		id: uuid,
		...Rec.fromEntries(Arr.makeBy(sideFields, (i) => [`${prefix}${i}`, pg.boolean] as const))
	}
	return relation(name, fields, ["id"])
}
const Left = side("Left", "l")
const Right = side("Right", "r")
const Pairs = schema("Pairs", { Left, Right }, [])

/** Every field of a left and of the right of its id: a head of 2 * sideFields + 1 entries. */
const pairs = query(Pairs).rule((r) => {
	const left = v(Left, "left")
	const right = v(Right, "right")
	return r
		.match(Left, left)
		.match(Right, { ...right, id: left["id"] })
		.find({ ...right, ...left })
})

const pairsLogin = login(Pairs, "server", [role(Pairs, "reader", { Left, Right })], {
	workload: [workload(Pairs, { pairs })]
})

const file = `${repoRoot}app/grizzle.config.ts`

/**
 * The draft of a configuration's one schema and login from an empty migrations directory, as generate drafts it, and
 * the login's programs as the layer compiles them.
 */
const draftAndCompile = (given: Pick<GrizzleConfig, "schemas" | "logins">) =>
	Effect.gen(function* () {
		const config = yield* resolveConfig(
			defineConfig({ ...given, migrations: "migrations", connection: offlineOwner }),
			file
		)
		const configured = defined(config.schemas[0], "the configured schema")
		const schema = yield* Effect.fromResult(compileSchema(configured))
		const login = defined(schema.logins[0], "the login")
		const draft = yield* Effect.result(
			draftSchema(
				schema,
				emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
				[],
				noDeclarations
			)
		)
		/** The login's programs, compiled under a fresh installation's codes, which the first draft holds. */
		const codes = firstCodebook(rostersOf(schema.owned))
		const compiled = yield* Effect.result(
			Effect.flatMap(fromEngine(artifactsUnder(schema.owned, codes)), (artifacts) =>
				loginRoles(login.login, login.owned, artifacts)
			)
		)
		return { compiled, draft }
	})

layer(NodeServices.layer, { excludeTestServices: true })("generate and DbLayer.make", (it) => {
	it.effect("open a DbLayer from what generate drafts for a program both compile", () =>
		Effect.gen(function* () {
			const { compiled, draft } = yield* draftAndCompile({
				schemas: [Visits],
				logins: [visitsLogin]
			})
			assert.ok(Result.isSuccess(compiled), "the layer compiles the program")
			assert.ok(Result.isSuccess(draft), "generate drafts the program")
			if (Result.isFailure(draft)) {
				return
			}
			const opened = yield* Effect.exit(
				Effect.scoped(
					Layer.build(
						DbLayer.make({
							...offlineConnection,
							pool: clusterPool,
							login: visitsLogin,
							snapshot: snapshotJson(draft.success.snapshotText)
						})
					)
				)
			)
			assert.ok(Exit.isSuccess(opened), "the drafted snapshot opens the layer")
		})
	)

	it.effect("refuse the draft of a program the layer refuses, with the layer's own refusal", () =>
		Effect.gen(function* () {
			const { compiled, draft } = yield* draftAndCompile({ schemas: [Pairs], logins: [pairsLogin] })
			assert.ok(Result.isFailure(compiled), "the layer refuses the program")
			assert.ok(Result.isFailure(draft), "generate refuses the program")
			if (Result.isSuccess(compiled) || Result.isSuccess(draft)) {
				return
			}
			const refusal = draft.failure.reason
			assert.equal(refusal._tag, "DraftRefused", draft.failure.message)
			if (refusal._tag === "DraftRefused") {
				assert.equal(refusal.step, "workload")
				assert.equal(refusal.error.message, compiled.failure.message)
				const reason = refusal.error.reason
				assert.ok(
					reason._tag === "ResourceBound" && reason.bound.kind === "selectList",
					`refused past the select list, not: ${refusal.error.message}`
				)
			}
		})
	)
})
