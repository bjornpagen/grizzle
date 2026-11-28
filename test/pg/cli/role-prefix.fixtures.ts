/** What the properties of role-prefix.test.ts read: its spaces, models and helpers. */

import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Option, Order, Record as Rec, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import { identifierOf, identity, maxIdentifierBytes } from "#compiler/core/identity.ts"
import { defineConfig } from "#index.ts"
import { writeAnswerOf, oneOf } from "#test/support/calls.ts"
import { type IdValue, toId } from "#test/support/ids.ts"
import { decodersIn, servedSourcedLayer } from "#test/support/live-layer.ts"
import { clusterConnection, clusterPool, freshDatabase } from "#test/support/pg.ts"
import { shopV1 } from "#test/support/pg/cli/fixture.ts"
import {
	cliOver,
	type CliRun,
	configName,
	connectionOf,
	ownerOn,
	servedAt,
	workspace
} from "#test/support/pg/cli/support.ts"
import { uniqueSchemaName } from "#test/support/substrate/names.ts"
import { connect, ownerCredentials } from "#test/support/substrate/session.ts"
import { dropRole, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

/** The second installation's role space: a prefix of its own, or none. */
type Second = "prefixed" | "stems"

interface Spaces {
	readonly second: Second
	readonly heldElsewhere: boolean
}

export type SpaceFeature =
	| "the second under another prefix"
	| "the second under no prefix"
	| "an uninstall refused, then done"

export const spacesGen: Gen<Spaces> = (source) => ({
	second: source.draw(element<Second>(["prefixed", "stems"])),
	heldElsewhere: source.draw(boolean)
})

const notesOf = (s: Spaces): ReadonlyArray<SpaceFeature> => [
	s.second === "prefixed" ? "the second under another prefix" : "the second under no prefix",
	...(s.heldElsewhere ? (["an uninstall refused, then done"] as const) : [])
]

/** An installation: its database and its role prefix, none for the stems'. */
interface Installation {
	readonly database: string
	readonly rolePrefix: Option.Option<string>
}

/** The installation as roleNameOf and a connection name it: its database, and its prefix when it has one. */
const named = (i: Installation) =>
	Option.match(i.rolePrefix, {
		onNone: () => ({ database: i.database }),
		onSome: (rolePrefix) => ({ database: i.database, rolePrefix })
	})

/** The lines a command printed on stdout, sorted. */
const lines = (ran: CliRun): ReadonlyArray<string> =>
	Arr.sort(
		Arr.filter(Str.split("\n")(ran.stdout), (line) => line.length > 0),
		Order.String
	)

export const spaceCase = (s: Spaces, c: Case<SpaceFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			c.noteAll(notesOf(s))
			const substrate = yield* Substrate
			const schema = yield* substrate.schema({ create: false, label: "rs" })
			const shop = shopV1(schema, "none")
			const firstPrefix = uniqueSchemaName("ra", 0)
			const firstDatabase = yield* freshDatabase(substrate.cluster)
			const secondDatabase = yield* freshDatabase(substrate.cluster)
			const first: Installation = { database: firstDatabase, rolePrefix: Option.some(firstPrefix) }
			const second: Installation = {
				database: secondDatabase,
				rolePrefix: s.second === "prefixed" ? Option.some(uniqueSchemaName("rb", 0)) : Option.none()
			}
			const dir = yield* workspace("rolespace")
			/** The longest prefix either installation is under: the harness's own fact, which its configuration states. */
			const rolePrefixBytes = Arr.reduce(
				Arr.flatMap([first, second], (i) => Option.toArray(i.rolePrefix)),
				0,
				(most, prefix) => Math.max(most, utf8Length(prefix))
			)
			const configFor = (i: Installation) =>
				defineConfig({
					schemas: [shop.schema],
					logins: [shop.server],
					migrations: "migrations",
					rolePrefixBytes,
					connection: () => ({
						...connectionOf(substrate.cluster, ownerOn(substrate.cluster, i.database)),
						...named(i)
					})
				})
			const run = (i: Installation, command: string) =>
				cliOver(dir, configFor(i), [command, configName])
			for (const command of ["generate", "check"]) {
				const ran = yield* run(first, command)
				assert.equal(ran.code, 0, `grizzle ${command}: ${ran.stderr}`)
			}
			const served = yield* servedAt(`${dir}/migrations/${schema}`, shop.server)
			const expected = (i: Installation): ReadonlyArray<string> =>
				Arr.sort(
					[
						roleNameOf(served, named(i)),
						...Arr.map(Rec.values(shop.server.roles), (r) => roleNameOf(r.role, named(i))),
						roleNameOf(served.decoder, named(i))
					],
					Order.String
				)
			for (const role of [...expected(first), ...expected(second)]) {
				assert.ok(
					utf8Length(role) <= maxIdentifierBytes,
					`${role} fits PostgreSQL's identifier: the allocations are short enough`
				)
			}
			for (const i of [first, second]) {
				const migrated = yield* run(i, "migrate")
				assert.equal(migrated.code, 0, `grizzle migrate into ${i.database}: ${migrated.stderr}`)
			}
			const rolesOfFirst = yield* run(first, "roles")
			const rolesOfSecond = yield* run(second, "roles")
			const listedFirst = lines(rolesOfFirst)
			const listedSecond = lines(rolesOfSecond)
			assert.deepEqual(
				listedFirst,
				expected(first),
				"grizzle roles lists exactly the first's roles"
			)
			assert.deepEqual(
				listedSecond,
				expected(second),
				"grizzle roles lists exactly the second's roles"
			)
			assert.deepEqual(
				Arr.intersection(listedFirst, listedSecond),
				[],
				"the two installations share no role"
			)
			const scope = yield* Effect.scope
			const decoderOf = yield* decodersIn(substrate, scope)
			const layerOver = (i: Installation, over: string) =>
				Effect.map(substrate.login(roleNameOf(served, named(i))), (credentials) =>
					servedSourcedLayer(decoderOf, {
						...clusterConnection(substrate.cluster, over, credentials.password),
						...Option.match(i.rolePrefix, {
							onNone: () => ({}),
							onSome: (rolePrefix) => ({ rolePrefix })
						}),
						pool: clusterPool,
						login: served,
						verify: testVerify
					})
				)
			const idOf = (n: number): IdValue => toId(`00000000-0000-4000-8000-00000000000${n}`)
			const write = (i: Installation, n: number) =>
				Effect.flatMap(layerOver(i, i.database), (l) =>
					Effect.scoped(
						Effect.flatMap(Db.open(served.roles.writer, {}), (db) =>
							writeAnswerOf(
								db.workload.addCustomer.once({
									params: {},
									facts: { insert: { Customer: [{ id: idOf(n), name: "ada" }] } }
								})
							)
						)
					).pipe(withLayer(l))
				)
			const read = (i: Installation, over: string, n: number) =>
				Effect.flatMap(layerOver(i, over), (l) =>
					Effect.scoped(
						Effect.flatMap(Db.open(served.roles.reader, {}), (db) =>
							oneOf(db.workload.customer.once({ params: { id: idOf(n) }, facts: {} }))
						)
					).pipe(withLayer(l))
				)
			const wroteFirst = yield* write(first, 1)
			assert.equal(wroteFirst._tag, "accepted", "the first's writer writes")
			const wroteSecond = yield* write(second, 2)
			assert.equal(wroteSecond._tag, "accepted", "the second's writer writes")
			const ownFirst = yield* read(first, first.database, 1)
			const ownSecond = yield* read(second, second.database, 2)
			const othersOfFirst = yield* read(second, second.database, 1)
			assert.ok(Option.isSome(ownFirst), "the first reads its own")
			assert.ok(Option.isSome(ownSecond), "the second reads its own")
			assert.ok(Option.isNone(othersOfFirst), "the second reads none of the first's")
			const crossed = yield* Effect.exit(read(first, second.database, 2))
			assert.ok(Exit.isFailure(crossed), "the first's login is refused over the second's database")
			const bystander = `${firstPrefix}__${uniqueSchemaName("rx", 0)}__x`
			yield* substrate.admin.query(`CREATE ROLE "${bystander}" NOLOGIN`, [])
			yield* Effect.addFinalizer(() =>
				Effect.orDie(dropRole(substrate.cluster, substrate.admin, bystander))
			)
			const readerRole = roleNameOf(shop.reader, named(first))
			if (s.heldElsewhere) {
				const held = yield* substrate.schema({ create: true, label: "held" })
				yield* substrate.admin.query(`GRANT USAGE ON SCHEMA "${held}" TO "${readerRole}"`, [])
				const refused = yield* run(first, "uninstall")
				const report = refused.report
				assert.ok(
					report.outcome === "refused" &&
						report.refusal._tag === "CommandRefused" &&
						report.refusal.error.reason._tag === "UninstallRefused" &&
						report.refusal.error.server.by === "server" &&
						report.refusal.error.server.error.sqlstate === "2BP01",
					`grizzle uninstall is refused with 2BP01 while ${readerRole} holds USAGE on ${held} elsewhere: ${refused.stderr}`
				)
				const kept = yield* run(first, "roles")
				assert.deepEqual(lines(kept), expected(first), "nothing was dropped")
				const drift = yield* run(first, "drift")
				assert.equal(drift.code, 0, `the installation stands whole: ${drift.stderr}`)
				yield* substrate.admin.query(`REVOKE USAGE ON SCHEMA "${held}" FROM "${readerRole}"`, [])
			}
			const installedFirst = Arr.sort(expected(first), Order.String)
			const uninstalled = yield* run(first, "uninstall")
			assert.equal(uninstalled.code, 0, `grizzle uninstall: ${uninstalled.stderr}`)
			assert.deepEqual(
				lines(uninstalled),
				Arr.sort(
					[
						...Arr.map(
							[schema, identifierOf(identity.wholeSchema(schema))],
							(n) => `dropped schema ${n}`
						),
						...Arr.map(installedFirst, (r) => `dropped role ${r}`)
					],
					Order.String
				),
				"uninstall drops exactly the installation's schemas and roles, its decoder login as the cluster names it"
			)
			const leftUnder = yield* substrate.admin.queryValues(
				"SELECT rolname::text FROM pg_catalog.pg_roles WHERE starts_with(rolname::text, $1::text) ORDER BY 1",
				[`${firstPrefix}__`]
			)
			assert.deepEqual(
				Arr.map(leftUnder, ([role]) => String(role)),
				[bystander],
				"no role of the installation is left under its prefix"
			)
			const ownerAfter = yield* connect(substrate.cluster, {
				database: first.database,
				credentials: ownerCredentials(substrate.cluster),
				label: "after uninstall"
			})
			const slotsLeft = yield* ownerAfter.queryValues(
				"SELECT slot_name::text FROM pg_catalog.pg_replication_slots WHERE database = current_database()",
				[]
			)
			const publicationsLeft = yield* ownerAfter.queryValues(
				"SELECT pubname::text FROM pg_catalog.pg_publication",
				[]
			)
			assert.deepEqual(
				[slotsLeft, publicationsLeft],
				[[], []],
				"no slot or publication of the installation is left in its database"
			)
			const left = yield* run(first, "roles")
			const secondLeft = yield* run(second, "roles")
			const stillRead = yield* read(second, second.database, 2)
			const bystanding = yield* substrate.roleExists(bystander)
			assert.deepEqual(lines(left), [], "none of its roles is left")
			assert.deepEqual(lines(secondLeft), expected(second), "the second's roles are all there")
			assert.ok(Option.isSome(stillRead), "the second still reads")
			assert.ok(bystanding, "the bystander outside its namespace stays")
			const last = yield* run(second, "uninstall")
			assert.equal(last.code, 0, `grizzle uninstall of the second: ${last.stderr}`)
		})
	)
