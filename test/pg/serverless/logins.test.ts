/**
 * Logins in one process (README "Logins and roles"): every login is its own PostgreSQL user with its own pool, and a Db
 * opens on the layer of its role's login alone.
 *
 * Two installations of the worked example, each with two logins: `web`, holding the roles `reader` and `auditor`, and
 * `ops`, holding `operator`; every role reads Account whole, and each login's workload holds, for each of its roles,
 * the read of every account over that role. Each installation is drafted and served as `grizzle generate` drafts it
 * with both logins (test/support/install-migrate.ts installGenerated), and all four logins are served from the files
 * generate wrote for them, their layers built in one scope, as one process builds them, and each case runs a drawn program of requests, each opening a Db per
 * request for a drawn role of a drawn login of a drawn installation and reading every account through its workload,
 * some at once; or one installation's web login at volume, a Db per request alternating its two roles, many at once on
 * its one pool.
 *
 * The oracle is the README's contract of logins: every request answers its installation's accounts, whichever role
 * and however many run at once; while the layers live, each login's sessions log in as its own PostgreSQL role, a login
 * no request opened holds no backend, and none holds more than its pool's maximum; and once the layers' scope closes,
 * every login's pool is released, no backend left.
 *
 * Features: two installations, two logins of one installation, two roles of one login, requests at once, a login no
 * request opened, and a Db per request at volume.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Layer, Order } from "effect"
import {
	accountIds,
	type Login,
	loginOf,
	type LoginsFeature,
	programGen,
	readsOf,
	type Request,
	untilGone,
	workAt,
	worldsOver
} from "#test/pg/serverless/logins.fixtures.ts"
import { roleBackends } from "#test/pg/serverless/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { installGenerated, loadMigrated as load } from "#test/support/install-migrate.ts"
import { clusterPool } from "#test/support/pg.ts"
import { servedGenerated } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Logins in one process each login its own pool, a Db per request on its role's login alone, every pool released when the layers' scope closes.
 *
 * Its pre-conversion budget: runs 8, coverage cases 24 (test/pg/serverless/logins.test.ts at d8eed1786).
 */
export const loginsInOneProcessEachLoginItsOwnPoolADbPerRequestOnItsRolesLoginAloneEveryPoolReleasedWhenTheLayersScopeCloses =
	property.explore(programGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"two installations",
			"two logins of one installation",
			"two roles of one login",
			"requests at once",
			"a login no request opened",
			"a Db per request at volume"
		] satisfies ReadonlyArray<Reached<LoginsFeature>>,
		check:
			({ substrate }, k: Case<LoginsFeature>) =>
			(program) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const installs = yield* Effect.forEach(["one", "two"] as const, (label) =>
							Effect.gen(function* () {
								const generated = yield* installGenerated(
									(name) => {
										const at = worldsOver(workAt(name))
										return { schema: workAt(name), logins: [at.web, at.ops] }
									},
									{ label, ambient: ordinarySession }
								)
								const done = generated.installed
								yield* load(done, workFacts)
								const worlds = worldsOver(workAt(done.declared))
								const web = servedGenerated(generated, worlds.web)
								const ops = servedGenerated(generated, worlds.ops)
								return { done, worlds, web, ops, read: readsOf(web.login, ops.login) }
							})
						)
						const [first, second] = installs
						const installations = [defined(first), defined(second)] as const
						/** The PostgreSQL role each login's sessions log in as. */
						const loginRole = (i: 0 | 1, l: Login): string => {
							const { done, worlds } = installations[i]
							return done.as(worlds[l]).role
						}
						const everyLogin = Arr.flatMap([0, 1] as const, (i) =>
							Arr.map(["web", "ops"] as const, (l) => ({
								installation: i,
								login: l,
								role: loginRole(i, l)
							}))
						)

						const requests: ReadonlyArray<Request> =
							program.kind === "drawn requests"
								? program.requests
								: upTo(program.count, (n) => ({
										installation: program.installation,
										role: n % 2 === 0 ? "reader" : "auditor"
									}))
						const concurrency = program.concurrency
						/** One request: a Db of its role, opened for it alone, reading every account. */
						const run = (r: Request) =>
							Effect.gen(function* () {
								const ids = yield* installations[r.installation].read[r.role]
								assert.deepEqual(
									Arr.sort(ids, Order.String),
									accountIds,
									`the accounts, read as ${r.role}`
								)
							})
						const layers = Layer.mergeAll(
							installations[0].web.layer,
							installations[0].ops.layer,
							installations[1].web.layer,
							installations[1].ops.layer
						)
						yield* Effect.scoped(
							Effect.gen(function* () {
								yield* Effect.forEach(requests, run, { concurrency, discard: true })
								for (const l of everyLogin) {
									const backends = yield* roleBackends(l.role)
									const opened = Arr.some(
										requests,
										(r) => r.installation === l.installation && loginOf(r.role) === l.login
									)
									assert.ok(
										backends <= clusterPool.max,
										`${l.role} holds ${backends} backends, past its pool's maximum`
									)
									if (!opened) {
										assert.equal(backends, 0, `${l.role}: no request opened it, so no session`)
										k.note("a login no request opened")
									}
								}
							}).pipe(withLayer(layers))
						)
						for (const l of everyLogin) {
							yield* untilGone(l.role)
						}
						const installationsUsed = new Set(Arr.map(requests, (r) => r.installation))
						if (installationsUsed.size === 2) {
							k.note("two installations")
						}
						if (
							Arr.some(
								[0, 1] as const,
								(i) =>
									new Set(
										Arr.flatMap(requests, (r) => (r.installation === i ? [loginOf(r.role)] : []))
									).size === 2
							)
						) {
							k.note("two logins of one installation")
						}
						if (
							Arr.some(
								[0, 1] as const,
								(i) =>
									Arr.some(requests, (r) => r.installation === i && r.role === "reader") &&
									Arr.some(requests, (r) => r.installation === i && r.role === "auditor")
							)
						) {
							k.note("two roles of one login")
						}
						if (concurrency > 1 && requests.length > 1) {
							k.note("requests at once")
						}
						if (program.kind === "a Db per request at volume") {
							k.note("a Db per request at volume")
						}
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the README's contract of logins: one pool per login, a Db per request on its login's layer, released with it"
		},
		budget: { runs: 8, steered: 24 },
		kept: [],
		kills: []
	})
