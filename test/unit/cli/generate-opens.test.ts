import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Exit, Layer, Record as Rec, Redacted, Result } from "effect"
import { loginRoles } from "#adapter/pool/registry.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import { resolveConfig } from "#cli/config.ts"
import { draftSchema } from "#cli/generate.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { defineConfig } from "#index.ts"
import { assert, defined } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"

/**
 * `grizzle generate` compiles every program of a login's workloads exactly as DbLayer.make does, through the one
 * function the layer runs at startup (adapter/pool/registry.ts loginRoles), so a program generate admits is one the
 * layer opens, and one the layer would refuse refuses the draft first, with the same CompileError.
 *
 * Each case is a login whose workload holds one ordered query over a relation of uuid fields: one ordered by a few of
 * them, which compiles, and one ordered by all of them, whose shortest cursor token is past cursorMaxBytes, which only
 * the page template the layer compiles refuses (adapter/page/template.ts). The checker and the access extraction admit
 * both, which is all generate once ran. The first drafts, and its snapshot opens a DbLayer, which builds without a
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

/** Ordered by four uuids, a token far within cursorMaxBytes. */
const fewKeys = visits.orderBy(["u0", "asc"], ["u1", "asc"], ["u2", "asc"], ["u3", "asc"])
/** Ordered by all 24, a shortest token of 24 uuids, past cursorMaxBytes. */
const everyKey = visits.orderBy(
	["u0", "asc"],
	["u1", "asc"],
	["u2", "asc"],
	["u3", "asc"],
	["u4", "asc"],
	["u5", "asc"],
	["u6", "asc"],
	["u7", "asc"],
	["u8", "asc"],
	["u9", "asc"],
	["u10", "asc"],
	["u11", "asc"],
	["u12", "asc"],
	["u13", "asc"],
	["u14", "asc"],
	["u15", "asc"],
	["u16", "asc"],
	["u17", "asc"],
	["u18", "asc"],
	["u19", "asc"],
	["u20", "asc"],
	["u21", "asc"],
	["u22", "asc"],
	["u23", "asc"]
)

const loginOf = (program: typeof fewKeys) =>
	login(Visits, "server", [role(Visits, "reader", { Visit })], {
		workload: [workload(Visits, { visits: program })]
	})

const file = `${repoRoot}app/grizzle.config.ts`

const pem = "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n"

/** A login's draft from an empty migrations directory, as generate drafts it, and its programs as the layer compiles them. */
const draftAndCompile = (server: ReturnType<typeof loginOf>) =>
	Effect.gen(function* () {
		const config = yield* resolveConfig(defineConfig({ schemas: [Visits], logins: [server] }), file)
		const configured = defined(config.schemas[0], "the configured schema")
		const login = defined(configured.workloads[0], "the login's workloads")
		const compiled = yield* Effect.result(loginRoles(login.roles, login.workloads))
		const draft = yield* Effect.result(
			draftSchema(
				configured,
				emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
				{ kind: "named", name: "visits" },
				"20261104000000",
				[]
			)
		)
		return { compiled, draft }
	})

layer(NodeServices.layer, { excludeTestServices: true })("generate and DbLayer.make", (it) => {
	it.effect("open a DbLayer from what generate drafts for a program both compile", () =>
		Effect.gen(function* () {
			const server = loginOf(fewKeys)
			const { compiled, draft } = yield* draftAndCompile(server)
			assert.ok(Result.isSuccess(compiled), "the layer compiles the program")
			assert.ok(Result.isSuccess(draft), "generate drafts the program")
			if (Result.isFailure(draft)) {
				return
			}
			const opened = yield* Effect.exit(
				Effect.scoped(
					Layer.build(
						DbLayer.make({
							host: "localhost",
							port: 5433,
							database: "visits",
							login: server,
							snapshot: snapshotJson(draft.success.snapshotText),
							password: Redacted.make("unused"),
							tls: { ca: pem }
						})
					)
				)
			)
			assert.ok(Exit.isSuccess(opened), "the drafted snapshot opens the layer")
		})
	)

	it.effect("refuse the draft of a program the layer refuses, with the layer's own refusal", () =>
		Effect.gen(function* () {
			const { compiled, draft } = yield* draftAndCompile(loginOf(everyKey))
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
				assert.equal(refusal.error.reason._tag, "UnsupportedOperation", refusal.error.message)
			}
		})
	)
})
