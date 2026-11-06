import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
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

/**
 * A change to the login's stored search default: none, its removal, or each other value hnsw.iterative_scan takes.
 * Every value the parameter takes and its absence: the box the exhaustion covers.
 */
type DefaultChange =
	| { readonly kind: "intact" }
	| { readonly kind: "removed" }
	| { readonly kind: "changed"; readonly value: "off" | "relaxed_order" }

const changes: Arr.NonEmptyReadonlyArray<DefaultChange> = [
	{ kind: "intact" },
	{ kind: "removed" },
	{ kind: "changed", value: "off" },
	{ kind: "changed", value: "relaxed_order" }
]

type PolicyFeature =
	| "the stored policy fills the read"
	| "a lost default refused"
	| "a changed default refused"

/**
 * Stores `change` as the login's default of the policy's parameter, as the migration identity, whose session must have
 * loaded the vector library to name an `hnsw.*` parameter; the release puts the policy's value back.
 */
const changedDefault = (fx: Fixture, change: DefaultChange) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const role = quoteIdent(loginRole(fx))
		const [setting] = searchPolicySettings
		yield* s.admin.query(`SELECT vector_ext.vector_dims('[1]'::vector_ext.vector)`, [])
		switch (change.kind) {
			case "intact":
				return
			case "removed":
				yield* s.admin.query(`ALTER ROLE ${role} RESET ${setting.parameter}`, [])
				break
			case "changed":
				yield* s.admin.query(`ALTER ROLE ${role} SET ${setting.parameter} = '${change.value}'`, [])
				break
		}
		yield* Effect.addFinalizer(() =>
			Effect.orDie(
				Effect.andThen(
					s.admin.query(`SELECT vector_ext.vector_dims('[1]'::vector_ext.vector)`, []),
					s.admin.query(`ALTER ROLE ${role} SET ${setting.parameter} = '${setting.value}'`, [])
				)
			)
		)
	})

layer(Substrate.layer)("the HNSW search policy as login defaults", (it) => {
	it.effect(
		"admits a login exactly under the stored policy, whose session and typed approximateNearest read run under it",
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
					const [setting] = searchPolicySettings
					return yield* exhaust(
						{
							suite: "pg/vector/policy",
							generator: element(changes),
							literal: Formatter.format,
							limit: changes.length,
							box: "the login's default of hnsw.iterative_scan at each value the parameter takes, and removed",
							oracle: {
								kind: "specification",
								name: "admission holds the login's stored defaults to the policy's: one removed or changed is refused at settings"
							},
							coverage: requiredInSpace<PolicyFeature>([
								"the stored policy fills the read",
								"a lost default refused",
								"a changed default refused"
							]),
							caseHang
						},
						(change, k) =>
							Effect.scoped(
								Effect.gen(function* () {
									yield* changedDefault(fx, change)
									const open = Db.open(fx.opened.server.roles.app, {})
									if (change.kind !== "intact") {
										const error = yield* Effect.flip(
											open.pipe(Effect.scoped, withLayer(fx.opened.layer))
										)
										assert.ok(error instanceof OpenError)
										assert.equal(error.stage, "settings")
										assert.ok(error.reason instanceof AdmissionRefused)
										assert.deepEqual(
											Arr.map(error.reason.mismatches, (m) => [
												m.stage,
												m.check,
												m.expected,
												m.observed
											]),
											[
												[
													"settings",
													`role ${role} default ${setting.parameter}`,
													setting.value,
													change.kind === "removed" ? "<not set>" : change.value
												]
											]
										)
										k.note(
											change.kind === "removed"
												? "a lost default refused"
												: "a changed default refused"
										)
										return
									}
									yield* Effect.gen(function* () {
										const db = yield* open
										assert.deepEqual(
											admittedPolicy(fx.opened.installed.snapshot, role),
											policySettings
										)
										const rows = yield* (yield* db.execute(candidates, paramsOf(fx))).collect
										const why =
											rows.length === 20 ? "the policy fills the request" : yield* underfill(db, fx)
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
