import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Schema } from "effect"
import { dbContext } from "#adapter/db/context.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { AdmissionRefused } from "#adapter/errors/failures.ts"
import { Db } from "#adapter/public/db.ts"
import { searchPolicySettings } from "#compiler/physical/ddl/roles.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { rowsOn } from "#test/pg/adapter/support.ts"
import {
	accountB,
	admittedPolicy,
	candidates,
	compile,
	type Fixture,
	installFixture,
	vectorParam
} from "#test/pg/vector/ann/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { paramTexts } from "#test/support/compile.ts"
import { jsonText } from "#test/support/json.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

const policySettings = Arr.map(searchPolicySettings, (s) => `${s.parameter}=${s.value}`)

/** The fixture's login role, which holds the search defaults. */
const loginRole = (fx: Fixture): string => fx.installed.as(fx.opened.server).role

/** The login's own settings for every database, as ALTER ROLE ... SET stored them. */
const storedSettings = (fx: Fixture) =>
	Effect.flatMap(Substrate, (s) =>
		s.admin.queryValues(
			"SELECT pg_catalog.unnest(s.setconfig)::text FROM pg_catalog.pg_db_role_setting AS s JOIN pg_catalog.pg_roles AS r ON r.oid = s.setrole WHERE r.rolname = $1::text AND s.setdatabase = 0::oid ORDER BY 1",
			[loginRole(fx)]
		)
	)

const searcher = (fx: Fixture, label: string) =>
	Effect.flatMap(Substrate, (s) =>
		s.session({ ...worldSession(fx.installed.world(fx.opened.app)), label })
	)

/**
 * Removes one of the login's search defaults as the migration identity, whose session must have loaded the vector
 * library to name an `hnsw.*` parameter.
 */
const loseDefault = (fx: Fixture, parameter: string) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		yield* s.admin.query(`SELECT vector_ext.vector_dims('[1]'::vector_ext.vector)`, [])
		yield* s.admin.query(`ALTER ROLE ${quoteIdent(loginRole(fx))} RESET ${parameter}`, [])
	})

/** The parameters of the typed read: account B, probed with the fixture's vector numbered 21. */
const paramsOf = (fx: Fixture) => ({ account: accountB, vector: vectorParam(fx.probe(21)) })

/**
 * Why a read through `db` underfilled: the iterative scan setting and the candidates statement's plan, both
 * read in the Db's own pooled session, which tell a setting missing there from an early stop of the strict scan.
 */
const underfill = (db: object, fx: Fixture) =>
	Effect.gen(function* () {
		const ctx = defined(dbContext(db), "the Db's context")
		const spec = defined(
			compile(candidates, fx.installed, "query").specs[0],
			"the candidates statement"
		)
		const [scan, explained] = yield* Effect.scoped(
			Effect.flatMap(ctx.pool.lease, (session) =>
				Effect.all([
					rowsOn(session, "SHOW hnsw.iterative_scan", []),
					rowsOn(session, `EXPLAIN (ANALYZE, BUFFERS) ${spec.sql}`, paramTexts(spec, paramsOf(fx)))
				])
			)
		)
		return `underfilled: hnsw.iterative_scan ${jsonText(scan)} in the Db's session, plan:\n${Arr.join(
			Arr.map(explained, (r) => String(r[0])),
			"\n"
		)}`
	})

layer(Substrate.layer)("the HNSW search policy as login defaults", (it) => {
	it.effect(
		"the first migration stores the policy for the login, and a typed approximateNearest read runs under it",
		() =>
			Effect.gen(function* () {
				const fx = yield* installFixture({ candidates })
				const stored = Arr.map(yield* storedSettings(fx), (row) => String(row[0]))
				for (const setting of policySettings) {
					assert.ok(stored.includes(setting), `${setting} in ${Arr.join(stored, ", ")}`)
				}
				/** The login's session, as its role, shows each setting, before any vector function runs and after. */
				const session = yield* searcher(fx, "searcher")
				for (const s of searchPolicySettings) {
					assert.deepEqual(
						yield* session.values(`SHOW ${s.parameter}`, []),
						[[s.value]],
						s.parameter
					)
				}
				yield* session.values(`SELECT vector_ext.vector_dims('[1]'::vector_ext.vector)`, [])
				for (const s of searchPolicySettings) {
					assert.deepEqual(
						yield* session.values(`SHOW ${s.parameter}`, []),
						[[s.value]],
						s.parameter
					)
				}

				yield* Effect.gen(function* () {
					const db = yield* Db.open(fx.opened.server.roles.app, {})
					assert.deepEqual(
						admittedPolicy(fx.opened.installed.snapshot, loginRole(fx)),
						policySettings
					)
					const rows = yield* (yield* db.execute(candidates, paramsOf(fx))).collect
					const why = rows.length === 20 ? "the policy fills the request" : yield* underfill(db, fx)
					assert.equal(rows.length, 20, why)
					for (const row of rows) {
						assert.equal(typeof row.distance, "number")
					}
				}).pipe(Effect.scoped, withLayer(fx.opened.layer))
			}),
		300_000
	)

	it.effect(
		"admission refuses a login that lost a search default",
		() =>
			Effect.gen(function* () {
				const fx = yield* installFixture({ candidates })
				yield* loseDefault(fx, "hnsw.iterative_scan")
				const error = yield* Effect.flip(
					Db.open(fx.opened.server.roles.app, {}).pipe(Effect.scoped, withLayer(fx.opened.layer))
				)
				assert.ok(Schema.is(OpenError)(error))
				assert.equal(error.stage, "settings")
				assert.ok(Schema.is(AdmissionRefused)(error.reason))
				const role = loginRole(fx)
				assert.deepEqual(
					Arr.map(error.reason.mismatches, (m) => [m.stage, m.check, m.expected, m.observed]),
					[["settings", `role ${role} default hnsw.iterative_scan`, "strict_order", "<not set>"]]
				)
			}),
		300_000
	)
})
