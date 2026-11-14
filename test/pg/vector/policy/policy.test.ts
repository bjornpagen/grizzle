/**
 * The HNSW search policy as login defaults, on PostgreSQL 19 over the approximate-retrieval fixture (test/pg/vector/ann):
 * the installer stores the fixed search policy (physical/ddl/roles.ts searchPolicySettings) as the defaults of the login
 * whose role names a vector, and every session of that login, and a Db's read, runs under it.
 *
 * - Stored: the login's settings for every database hold each of the policy's settings, the snapshot's role defaults
 *   name exactly the policy, and the login's session shows each setting before and after the vector library loads.
 * - Served: for every account and drawn query vector, a Db's approximateNearest read, served by its once
 *   (test/support/served-db.ts withServedDb), fills its request up to the account's eligible facts, each candidate an
 *   eligible fact, at a number distance.
 *
 * Oracle: the specification of the policy (its settings, stored and shown as stated) and of a filtered search under a
 * strict-order iterative scan, which fills its request whenever the eligible facts allow.
 *
 * Plants, each red at the floor stream (~/.cache/grizzle-release/REDSWEEP/plants): vector-policy-dropped.patch (the
 * policy's iterative scan is "off", HNSW's default, which underfills a filtered request), and
 * vector-policy-int8-read-as-number.patch (an int8 cell read as a number, so a candidate's revision is no eligible
 * fact's).
 *
 * Features: each account the read is served for.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { TupleSet } from "#compiler/core/tuple-map.ts"
import { searchPolicySettings } from "#compiler/physical/ddl/roles.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import {
	accountA,
	accountB,
	accountC,
	admittedPolicy,
	candidates,
	installFixture,
	sizes,
	vectorParam
} from "#test/pg/vector/ann/support.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { readOnce } from "#test/support/calls.ts"
import { caseHang } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"

const policySettings = Object.freeze(
	Arr.map(searchPolicySettings, (s) => `${s.parameter}=${s.value}`)
)

/** The candidates the read requests (ann/support.ts candidates). */
const candidatesTake = 20

/** An account of the fixture, by the letter its size is listed under. */
type AccountLabel = keyof typeof sizes

const accountOf: { readonly [L in AccountLabel]: Uuid } = {
	A: accountA,
	B: accountB,
	C: accountC
}

const labels = nonEmpty(Rec.keys(sizes), "the fixture's accounts")

layer(Substrate.layer)("the HNSW search policy as login defaults", (it) => {
	it.effect(
		"stores the policy as the login's defaults, whose session and approximateNearest read run under it",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const fx = yield* installFixture({ candidates })
					const role = fx.installed.as(fx.opened.server).role
					const settings = yield* s.admin.queryValues(
						"SELECT pg_catalog.unnest(s.setconfig)::text FROM pg_catalog.pg_db_role_setting AS s JOIN pg_catalog.pg_roles AS r ON r.oid = s.setrole WHERE r.rolname = $1::text AND s.setdatabase = 0::oid",
						[role]
					)
					const stored = Arr.map(settings, (row) => String(row[0]))
					for (const setting of policySettings) {
						assert.ok(stored.includes(setting), `${setting} in ${Arr.join(stored, ", ")}`)
					}
					assert.deepEqual(admittedPolicy(fx.opened.installed.snapshot, role), policySettings)
					const session = yield* s.session({
						...worldSession(fx.installed.world(fx.app)),
						label: "searcher"
					})
					for (const p of searchPolicySettings) {
						const shown = yield* session.values(`SHOW ${p.parameter}`, [])
						assert.deepEqual(shown, [[p.value]], p.parameter)
					}
					yield* session.values(`SELECT vector_ext.vector_dims('[1]'::vector_ext.vector)`, [])
					for (const p of searchPolicySettings) {
						const shown = yield* session.values(`SHOW ${p.parameter}`, [])
						assert.deepEqual(shown, [[p.value]], p.parameter)
					}
					/** The documents whose current revision has an embedding: each an eligible fact, keyed (document, revision). */
					const eligibleFacts = Arr.filter(fx.facts, (d) =>
						Arr.some(d.embeddings, (e) => e.revision === d.current)
					)
					const eligible = (account: string): number =>
						Arr.filter(eligibleFacts, (d) => d.account === account).length
					/** The eligible facts' keys as values, which a row's (document, revision) is one of when its values are. */
					const current = new TupleSet<ReadonlyArray<unknown>>()
					for (const d of eligibleFacts) {
						current.add([d.id, d.current])
					}
					return yield* withServedDb(fx.installed, fx.opened.server.roles.app, {}, ({ serve }) =>
						Effect.gen(function* () {
							const served = yield* serve(fx.opened.programs)
							const read = readOnce(member(served, "candidates"))
							return yield* explore(
								{
									suite: "pg/vector/policy",
									draw: drawn(
										(source) =>
											[source.draw(element(labels)), source.draw(int(0, 2 ** 31 - 1))] as const
									),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "a strict-order iterative scan fills a filtered request up to the eligible facts"
									},
									coverage: required<`account ${AccountLabel}`>(
										Arr.map(labels, (label) => `account ${label}` as const),
										{ cases: 12, sense: notesOnly }
									),
									kept: [],
									runs: 12,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 4,
									caseHang
								},
								([label, n], c) =>
									Effect.gen(function* () {
										const account = accountOf[label]
										const rows = yield* read({
											params: { account, vector: vectorParam(fx.probe(n)) },
											facts: {}
										})
										assert.equal(
											rows.length,
											Math.min(candidatesTake, eligible(account)),
											`account ${label}: the request filled up to the eligible facts`
										)
										for (const row of rows) {
											const fact = [row["document"], row["revision"]]
											assert.ok(current.has(fact), `${Formatter.format(fact)} is an eligible fact`)
											assert.equal(typeof row["distance"], "number")
										}
										c.note(`account ${label}`)
									})
							)
						})
					).pipe(Effect.scoped)
				})
			)
	)
})
