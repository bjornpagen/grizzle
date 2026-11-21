/**
 * A connection that fails is classified, and every class states its own reason, the same through `grizzle migrate` and
 * through a Db's call, never with a password (packages/grizzle/src/adapter/errors/failures.ts ConnectRefusal).
 *
 * The property, exhausted over every class of connection failure, each set up for real, each opened by the migration identity's session (MigrateError whose
 * reason, ConnectRefused, carries the refusal) and by a pool's lease as a Db's call takes one (ReadFailure at stage
 * acquire, its reason; Db.open leases nothing): a refused socket (nothing listening), the server's
 * SQLSTATE (a role over its connection limit, 53300; a wrong password, 28P01; no such database, 3D000), TLS (a CA that
 * is not the server's; a server that answers the SSLRequest with N, or with neither S nor N), a server that closes the
 * connection at once, a failing password Effect, and no password for a role SCRAM authenticates. Each attempt's
 * connection is parsed as grizzle parses one (test/support/pg.ts parsedConnection), so an empty CA bundle never reaches
 * a connection: the parse refuses it at stage config (test/unit/adapter/layer.test.ts). The oracle is the class each failure is: its tag and the fact that tells it apart. Both
 * paths carry the same class; the migrate reason names the role, host and port and states the class's message; no
 * password, given or wrong, appears in a message or anywhere in either error; and the messages of the failures are all
 * distinct.
 *
 * A Db's call reads its class as the CallError README "Errors and outcomes" names (adapter/live/call-error.ts
 * readCallError): a wrong password `credentialRefused`, `passwordRefused`; nothing listening `unavailable`,
 * `connectionRefused`; a CA that is not the server's `credentialRefused`, `tlsUnverified`; and each other failure its own
 * kind and reason, `retry` `never` for `credentialRefused` and `safe` for `unavailable`. The wrong password is a real
 * login's, on the local cluster, in the substrate's own database: the login role it makes for this run.
 *
 * Features: every failure through each path, a wrong password, nothing listening and a CA that is not the server's among
 * them.
 */
import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, String as Str } from "effect"
import {
	attemptOf,
	classOf,
	type ConnectClassFeature,
	expectedClass,
	failureGen,
	failurePairs,
	failureSituations,
	throughCall,
	throughMigrate
} from "#test/pg/adapter/connect-classes.fixtures.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Every class of connection failure yields its own class alike through migrate and a Db's call, never with a password:
 * a failure's one attempt through both paths, each its class, and the reason each states alike.
 *
 * Its pre-conversion budget: the box, every failure through each path, 22 cases (test/pg/adapter/connect-classes.test.ts at edabdcc5f).
 */
export const everyClassOfConnectionFailureIsItsClassAlikeThroughMigrateAndADbsCall =
	property.exhaust(finite(failureGen), {
		needs: { substrate: Substrate.installing },
		situations: failureSituations,
		check:
			({ substrate }, c: Case<ConnectClassFeature>) =>
			(condition) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const s = yield* Substrate
							const schema = yield* s.schema(freshSchema)
							const attempt = yield* attemptOf(s, schema, condition)
							const migrate = yield* throughMigrate(s, attempt)
							const called = yield* throughCall(s, attempt, condition)
							for (const [path, reported] of [
								["grizzle migrate", migrate],
								["a Db's call", called]
							] as const) {
								assert.equal(
									classOf(reported.refusal),
									expectedClass[condition].fact,
									`${condition} through ${path}: its class`
								)
								for (const secret of attempt.secrets) {
									assert.ok(
										!Str.includes(secret)(reported.text),
										`${condition} through ${path} holds a password`
									)
								}
								c.note(`${condition} through ${path}`)
							}
							assert.equal(
								called.stated,
								migrate.stated,
								`${condition}: its reason, alike through both paths`
							)
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "ConnectRefusal: the class each failure is, told by its tag and its distinguishing fact"
		},
		box: "every class of connection failure, its one attempt through migrate and through a Db's call",
		kept: [],
		kills: []
	})

/**
 * Every class states its own reason: two failures' attempts, one after the other under one login name in one schema,
 * state distinct reasons through migrate, where the search compared every failure's after its box.
 *
 * Its pre-conversion budget: the box, every two failures, 55 cases (test/pg/adapter/connect-classes.test.ts at edabdcc5f).
 */
export const everyClassOfConnectionFailureStatesItsOwnReason = property.exhaust(
	finite(failurePairs),
	{
		needs: { substrate: Substrate.installing },
		situations: [],
		check:
			({ substrate }) =>
			([first, second]) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const s = yield* Substrate
							const schema = yield* s.schema(freshSchema)
							const stated = (condition: typeof first) =>
								Effect.scoped(
									Effect.flatMap(attemptOf(s, schema, condition), (attempt) =>
										Effect.map(throughMigrate(s, attempt), (reported) => reported.stated)
									)
								)
							const one = yield* stated(first)
							const other = yield* stated(second)
							assert.notEqual(one, other, `${first} and ${second} state distinct reasons: ${one}`)
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "ConnectRefusal: each class's message its own"
		},
		box: "every two classes of connection failure, each through migrate",
		kept: [],
		kills: []
	}
)
