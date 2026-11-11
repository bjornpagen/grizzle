/**
 * Logins in one process (README "Logins and roles"): every login is its own PostgreSQL user with its own pool, and a Db
 * opens on the layer of its role's login alone.
 *
 * Two installations of the worked example, each with two logins: `web`, holding the roles `reader` and `auditor`, and
 * `ops`, holding `operator`; every role reads Account whole, and each login's workload holds, for each of its roles,
 * the read of every account over that role. All four logins are served from their own served files and their layers
 * built in one scope, as one process builds them, and each case runs a drawn program of requests, each opening a Db per
 * request for a drawn role of a drawn login of a drawn installation and reading every account through its workload,
 * some at once; or one installation's web login at volume, a Db per request alternating its two roles, many at once on
 * its one pool.
 *
 * The oracle is the README's contract of logins: every request answers its installation's accounts, whichever role
 * and however many run at once; while the layers live, each login's sessions log in as its own PostgreSQL role, a login
 * no request opened holds no backend, and none holds more than its pool's maximum; and once the layers' scope closes,
 * every login's pool is released, no backend left.
 *
 *
 * Features: two installations, two logins of one installation, two roles of one login, requests at once, a login no
 * request opened, and a Db per request at volume.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): logins-eager-session.patch (a login's layer opening a session when it
 * is built).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { ServedLogin } from "#adapter/types/layer.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { roleBackends } from "#test/pg/serverless/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { rowsOf } from "#test/support/calls.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { installMigrated as install, loadMigrated as load } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { clusterPool } from "#test/support/pg.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"

type Login = "web" | "ops"
type RoleName = "reader" | "auditor" | "operator"

interface Request {
	readonly installation: 0 | 1
	readonly role: RoleName
}

type Program =
	| {
			readonly kind: "drawn requests"
			readonly requests: Arr.NonEmptyReadonlyArray<Request>
			readonly concurrency: number
	  }
	| {
			readonly kind: "a Db per request at volume"
			readonly installation: 0 | 1
			readonly count: number
			readonly concurrency: number
	  }

const requestGen: Gen<Request> = (source) => ({
	installation: source.draw(element([0, 1] as const)),
	role: source.draw(element<RoleName>(["reader", "auditor", "operator"]))
})

const programGen: Gen<Program> = weighted<Program>([
	[
		3,
		(source) => ({
			kind: "drawn requests",
			requests: [source.draw(requestGen), ...source.draw(array(requestGen, { min: 0, max: 7 }))],
			concurrency: source.draw(int(1, 4))
		})
	],
	[
		1,
		(source) => ({
			kind: "a Db per request at volume",
			installation: source.draw(element([0, 1] as const)),
			count: source.draw(int(24, 64)),
			concurrency: source.draw(int(8, 16))
		})
	]
])

const loginOf = (r: RoleName): Login => (r === "operator" ? "ops" : "web")

/**
 * The worlds of an installation of Work under its declared name: two logins, three roles, and each role's read of every
 * account's id, a member of its login's workload.
 */
const worldsOver = (Work: W.WorkNamed<string>) => {
	const reader = role(Work, "reader", { Account: W.Account })
	const auditor = role(Work, "auditor", { Account: W.Account, Task: W.Task })
	const operator = role(Work, "operator", { Account: W.Account })
	const readerAccounts = query(reader).rule((r) => {
		const { id, name } = v(reader.relations.Account, "account")
		return r.match(reader.relations.Account, { id, name }).find({ id })
	})
	const auditorAccounts = query(auditor).rule((r) => {
		const { id, name } = v(auditor.relations.Account, "account")
		return r.match(auditor.relations.Account, { id, name }).find({ id })
	})
	const operatorAccounts = query(operator).rule((r) => {
		const { id, name } = v(operator.relations.Account, "account")
		return r.match(operator.relations.Account, { id, name }).find({ id })
	})
	return {
		web: login(Work, "web", [reader, auditor], {
			workload: [workload(reader, { readerAccounts }), workload(auditor, { auditorAccounts })]
		}),
		ops: login(Work, "ops", [operator], { workload: [workload(operator, { operatorAccounts })] })
	}
}

type Worlds = ReturnType<typeof worldsOver>

/**
 * Every account's id, read by each role's workload member through a Db of the role, opened for this read alone on its
 * served login.
 */
const readsOf = (web: ServedLogin<Worlds["web"]>, ops: ServedLogin<Worlds["ops"]>) => ({
	reader: Effect.gen(function* () {
		const db = yield* Db.open(web.roles.reader, {})
		const rows = yield* rowsOf(db.workload.readerAccounts.once({ params: {}, facts: {} }))
		return Arr.map(rows, (row) => row.id)
	}),
	auditor: Effect.gen(function* () {
		const db = yield* Db.open(web.roles.auditor, {})
		const rows = yield* rowsOf(db.workload.auditorAccounts.once({ params: {}, facts: {} }))
		return Arr.map(rows, (row) => row.id)
	}),
	operator: Effect.gen(function* () {
		const db = yield* Db.open(ops.roles.operator, {})
		const rows = yield* rowsOf(db.workload.operatorAccounts.once({ params: {}, facts: {} }))
		return Arr.map(rows, (row) => row.id)
	})
})

type LoginsFeature =
	| "two installations"
	| "two logins of one installation"
	| "two roles of one login"
	| "requests at once"
	| "a login no request opened"
	| "a Db per request at volume"

layer(Substrate.layer)("logins in one process", (it) => {
	it.effect(
		"each login its own pool, a Db per request on its role's login alone, every pool released when the layers' scope closes",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const declared = worldsOver(W.Work)
					const installs = yield* Effect.forEach(["one", "two"] as const, (label) =>
						Effect.gen(function* () {
							const done = yield* install(W.Work, {
								ambient: ordinarySession,
								label,
								extensions: [],
								logins: [declared.web, declared.ops]
							})
							yield* load(done, workFacts)
							const worlds = worldsOver(schema(done.declared, W.Work.relations, W.Work.statements))
							const web = yield* servedFixture(done, worlds.web)
							const ops = yield* servedFixture(done, worlds.ops)
							return { done, worlds, web, ops, read: readsOf(web.login, ops.login) }
						})
					)
					const [first, second] = installs
					const installations = [defined(first), defined(second)] as const
					const accountIds = Arr.sort(
						Arr.map(workFacts.Account, (a) => a.id),
						Order.String
					)
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
					return yield* explore(
						{
							suite: "serverless/logins",
							draw: drawn(programGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the README's contract of logins: one pool per login, a Db per request on its login's layer, released with it"
							},
							coverage: required<LoginsFeature>(
								[
									"two installations",
									"two logins of one installation",
									"two roles of one login",
									"requests at once",
									"a login no request opened",
									"a Db per request at volume"
								],
								{ cases: 24, sense: notesOnly }
							),
							kept: [],
							runs: 8,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(program, k) =>
							Effect.gen(function* () {
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
												Arr.flatMap(requests, (r) =>
													r.installation === i ? [loginOf(r.role)] : []
												)
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
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})

/** Waits until no backend logs in as `role`: its login's pool released every session. */
const untilGone = (role: string) =>
	Effect.gen(function* () {
		for (;;) {
			const backends = yield* roleBackends(role)
			if (backends === 0) {
				return
			}
			yield* Effect.yieldNow
		}
	})
