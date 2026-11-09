import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { DbContext } from "#adapter/db/context.ts"
import { openDbContext } from "#adapter/db/open.ts"
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
import { paramTexts, scalarsOnly } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
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

/** The parameters of the typed read: account B, probed with the fixture's vector numbered 21. */
const paramsOf = (fx: Fixture) => ({ account: accountB, vector: vectorParam(fx.probe(21)) })

/**
 * Why a read through `db` underfilled: the iterative scan setting and the candidates statement's plan, both
 * read in the Db's own pooled session, which tell a setting missing there from an early stop of the strict scan.
 */
const underfill = (ctx: DbContext, fx: Fixture) =>
	Effect.gen(function* () {
		const spec = defined(
			compile(candidates, fx.installed, "query").specs[0],
			"the candidates statement"
		)
		const [scan, explained] = yield* Effect.scoped(
			Effect.flatMap(ctx.pool.lease, (session) =>
				Effect.all([
					rowsOn(session, "SHOW hnsw.iterative_scan", []),
					rowsOn(
						session,
						`EXPLAIN (ANALYZE, BUFFERS) ${spec.sql}`,
						paramTexts(spec, paramsOf(fx), scalarsOnly)
					)
				])
			)
		)
		return `underfilled: hnsw.iterative_scan ${Formatter.format(scan)} in the Db's session, plan:\n${Arr.join(
			Arr.map(explained, (r) => String(r[0])),
			"\n"
		)}`
	})

/** One of the policy's settings, by its place in it. */
type PolicySetting = (typeof searchPolicySettings)[number]

/**
 * A change to the login's stored default of one of the policy's settings: its removal, or a value the parameter takes,
 * the policy's own among them.
 */
interface DefaultChange {
	readonly setting: PolicySetting
	readonly value: Option.Option<string>
}

/** Loads the vector library in the admin session, so its `hnsw.*` parameters are known there. */
const loadVectorLibrary = Effect.flatMap(Substrate, (s) =>
	s.admin.query(`SELECT vector_ext.vector_dims('[1]'::vector_ext.vector)`, [])
)

/**
 * Stores `change` as the login's default of its setting's parameter, as the migration identity, whose session must have
 * loaded the vector library to name an `hnsw.*` parameter; the release puts the policy's value back.
 */
const changedDefault = (fx: Fixture, change: DefaultChange) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const role = quoteIdent(loginRole(fx))
		const { parameter, value } = change.setting
		yield* loadVectorLibrary
		if (Option.isSome(change.value)) {
			yield* s.admin.query(`ALTER ROLE ${role} SET ${parameter} = '${change.value.value}'`, [])
		} else {
			yield* s.admin.query(`ALTER ROLE ${role} RESET ${parameter}`, [])
		}
		yield* Effect.addFinalizer(() =>
			Effect.orDie(
				Effect.andThen(
					loadVectorLibrary,
					s.admin.query(`ALTER ROLE ${role} SET ${parameter} = '${value}'`, [])
				)
			)
		)
	})

layer(Substrate.layer)("the HNSW search policy as login defaults", (it) => {
	it.effect(
		"stores the policy as the login's defaults, whose session and typed approximateNearest read run under it",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fx = yield* installFixture({ candidates })
					const settings = yield* storedSettings(fx)
					const stored = Arr.map(settings, (row) => String(row[0]))
					for (const setting of policySettings) {
						assert.ok(stored.includes(setting), `${setting} in ${Arr.join(stored, ", ")}`)
					}
					/** The login's session, as its role, shows each setting, before any vector function runs and after. */
					const session = yield* searcher(fx, "searcher")
					for (const p of searchPolicySettings) {
						const rows = yield* session.values(`SHOW ${p.parameter}`, [])
						assert.deepEqual(rows, [[p.value]], p.parameter)
					}
					yield* session.values(`SELECT vector_ext.vector_dims('[1]'::vector_ext.vector)`, [])
					for (const p of searchPolicySettings) {
						const rows = yield* session.values(`SHOW ${p.parameter}`, [])
						assert.deepEqual(rows, [[p.value]], p.parameter)
					}
					const role = loginRole(fx)
					return yield* exhaust(
						{
							suite: "pg/vector/policy",
							generator: (source): DefaultChange => {
								const setting = source.draw(element(searchPolicySettings))
								return { setting, value: Option.some(setting.value) }
							},
							literal: Formatter.format,
							limit: searchPolicySettings.length,
							box: "the login's default of each policy setting at the policy's value",
							oracle: {
								kind: "specification",
								name: "the login's stored defaults are the policy's, and a Db's typed approximateNearest read fills its request under them"
							},
							coverage: requiredInSpace<"the stored policy fills the read">([
								"the stored policy fills the read"
							]),
							caseHang
						},
						(change, k) =>
							Effect.scoped(
								Effect.gen(function* () {
									yield* changedDefault(fx, change)
									const open = openDbContext(fx.opened.server.roles.app, {})
									yield* Effect.gen(function* () {
										const { db, ctx: dbCtx } = yield* open
										assert.deepEqual(
											admittedPolicy(fx.opened.installed.snapshot, role),
											policySettings
										)
										const rows = yield* (yield* db.execute(candidates, paramsOf(fx))).collect
										const why =
											rows.length === 20
												? "the policy fills the request"
												: yield* underfill(dbCtx, fx)
										assert.equal(rows.length, 20, why)
										for (const row of rows) {
											assert.equal(typeof row.distance, "number")
										}
									}).pipe(Effect.scoped, withLayer(fx.opened.layer))
									k.note("the stored policy fills the read")
								})
							)
					)
				})
			)
	)
})
