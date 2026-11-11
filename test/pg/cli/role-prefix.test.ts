/**
 * On PostgreSQL 19: one committed `grizzle generate` output installed into two databases of one cluster, each under its
 * own role space, through the command line.
 *
 * PostgreSQL's roles are the cluster's and an installation is one database's, so an installation is its database and
 * its role prefix (DbConnection.rolePrefix). A case draws the second installation's role space, another prefix or
 * none, beside the first's prefix, and whether a role of the first holds a privilege in another database when it is
 * uninstalled. It generates the shop (test/pg/cli/fixture.ts shopV1: the login `server`, its roles `reader` and
 * `writer`) once, then migrates the one output into two fresh databases (test/support/pg.ts freshDatabase), each
 * configuration's connection naming its database and its prefix. Every prefix is an allocated name
 * (test/support/substrate/names.ts uniqueSchemaName), so a role a dead run leaves is the sweep's.
 *
 * Properties, each against its oracle:
 * - Disjoint: `grizzle roles` of each installation is exactly roleNameOf of the login and its roles under its
 *   connection (oracle: the stem each value carries under core/identity.ts roleInSpace, which is the naming door's
 *   for no prefix), and the two lists share no name.
 * - Its own database only: each installation's writer inserts a customer through its layer, over its database under
 *   its prefix, and its reader reads it back; the other installation reads no such customer; a layer of one
 *   installation's login over the other's database is refused.
 * - Uninstall: while a role of the first holds CONNECT on another database, `grizzle uninstall` is refused at stage
 *   uninstall with PostgreSQL's 2BP01 and drops nothing (its roles listed as before, `grizzle drift` still passing).
 *   Then it drops exactly the installation: its schema and its roles' schemas, and its roles, `grizzle roles` printing
 *   none; the second installation's roles are all there and its reader still reads; and a bystander role under the
 *   first's prefix over another schema, outside its namespace, stays.
 *
 * Features: the second installation under another prefix, and under none; an uninstall refused, then done.
 *
 * Plants (~/.cache/grizzle-release/ROLESPACE/plants): runtime-ignores-prefix.patch (a layer logs in as the stem),
 * prefix-applied-twice.patch (migrate fills a role variable with the prefix twice), uninstall-outside-namespace.patch
 * (uninstall drops every role under the prefix), role-printed-plain.patch (the printer prints a grant's role by its
 * stem, bypassing its variable), database-variable-misfilled.patch (the database variable is filled with a role's
 * name).
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Effect,
	Exit,
	Formatter,
	Layer,
	Option,
	Order,
	String as Str
} from "effect"
import { Db } from "#adapter/public/db.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import { maxIdentifierBytes } from "#compiler/core/identity.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { defineConfig } from "#index.ts"
import { shopV1 } from "#test/pg/cli/fixture.ts"
import {
	type CliRun,
	cliOver,
	configName,
	connectionOf,
	ownerOn,
	servedAt,
	workspace
} from "#test/pg/cli/support.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { clusterConnection, clusterPool, freshDatabase } from "#test/support/pg.ts"
import { uniqueSchemaName } from "#test/support/substrate/names.ts"
import {
	dropRole,
	Substrate,
	underDatabasePrivilegeLock
} from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

/** The second installation's role space: a prefix of its own, or none. */
type Second = "prefixed" | "stems"

interface Spaces {
	readonly second: Second
	readonly heldElsewhere: boolean
}

type SpaceFeature =
	| "the second under another prefix"
	| "the second under no prefix"
	| "an uninstall refused, then done"

const spacesGen: Gen<Spaces> = (source) => ({
	second: source.draw(element<Second>(["prefixed", "stems"])),
	heldElsewhere: source.draw(boolean)
})

const notesOf = (s: Spaces): ReadonlyArray<SpaceFeature> => [
	s.second === "prefixed" ? "the second under another prefix" : "the second under no prefix",
	...(s.heldElsewhere ? (["an uninstall refused, then done"] as const) : [])
]

const at = DateTime.makeUnsafe({
	year: 2026,
	month: 11,
	day: 11,
	hour: 12,
	minute: 0,
	second: 0,
	millisecond: 0
})

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

const spaceCase = (s: Spaces, c: Case<SpaceFeature>) =>
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
			const worlds = [shop.server, shop.reader, shop.writer] as const
			const expected = (i: Installation): ReadonlyArray<string> =>
				Arr.sort(
					Arr.map(worlds, (w) => roleNameOf(w, named(i))),
					Order.String
				)
			for (const role of [...expected(first), ...expected(second)]) {
				assert.ok(
					utf8Length(role) <= maxIdentifierBytes.value,
					`${role} fits PostgreSQL's identifier: the allocations are short enough`
				)
			}
			const dir = yield* workspace("rolespace")
			const configFor = (i: Installation) =>
				defineConfig({
					schemas: [shop.schema],
					logins: [shop.server],
					migrations: "migrations",
					connection: () => ({
						...connectionOf(substrate.cluster, ownerOn(i.database)),
						...named(i)
					})
				})
			const run = (i: Installation, command: string) =>
				cliOver(dir, configFor(i), [command, configName], at)
			for (const command of ["generate", "check"]) {
				const ran = yield* run(first, command)
				assert.equal(ran.code, 0, `grizzle ${command}: ${ran.stderr}`)
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
			const served = yield* servedAt(`${dir}/migrations/${schema}`, shop.server)
			const layerOver = (i: Installation, over: string) =>
				Effect.map(substrate.login(roleNameOf(served, named(i))), (credentials) =>
					DbLayer.make({
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
			const idOf = (n: number): `${string}-${string}-${string}-${string}-${string}` =>
				`00000000-0000-4000-8000-00000000000${n}`
			const write = (i: Installation, n: number) =>
				Effect.flatMap(layerOver(i, i.database), (l) =>
					Effect.scoped(
						Effect.flatMap(Db.open(served.roles.writer, {}), (db) =>
							db.workload.addCustomer.apply(
								{ insert: { Customer: [{ id: idOf(n), name: "ada" }] } },
								{}
							)
						)
					).pipe(withLayer(l))
				)
			const read = (i: Installation, over: string, n: number) =>
				Effect.flatMap(layerOver(i, over), (l) =>
					Effect.scoped(
						Effect.flatMap(Db.open(served.roles.reader, {}), (db) =>
							db.workload.customer.get({ id: idOf(n) })
						)
					).pipe(withLayer(l))
				)
			const wroteFirst = yield* write(first, 1)
			assert.equal(wroteFirst.kind, "accepted", "the first's writer writes")
			const wroteSecond = yield* write(second, 2)
			assert.equal(wroteSecond.kind, "accepted", "the second's writer writes")
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
			yield* Effect.addFinalizer(() => Effect.orDie(dropRole(substrate.admin, bystander)))
			const readerRole = roleNameOf(shop.reader, named(first))
			if (s.heldElsewhere) {
				yield* substrate.admin.query(
					underDatabasePrivilegeLock(
						`GRANT CONNECT ON DATABASE "${substrate.database}" TO "${readerRole}"`
					),
					[]
				)
				const refused = yield* run(first, "uninstall")
				const report = refused.report
				assert.ok(
					report.outcome === "refused" &&
						report.refusal._tag === "CommandRefused" &&
						report.refusal.error.reason._tag === "UninstallRefused" &&
						report.refusal.error.server.by === "server" &&
						report.refusal.error.server.error.sqlstate === "2BP01",
					`grizzle uninstall is refused with 2BP01 while ${readerRole} holds CONNECT elsewhere: ${refused.stderr}`
				)
				const kept = yield* run(first, "roles")
				assert.deepEqual(lines(kept), expected(first), "nothing was dropped")
				const drift = yield* run(first, "drift")
				assert.equal(drift.code, 0, `the installation stands whole: ${drift.stderr}`)
				yield* substrate.admin.query(
					underDatabasePrivilegeLock(
						`REVOKE CONNECT ON DATABASE "${substrate.database}" FROM "${readerRole}"`
					),
					[]
				)
			}
			const uninstalled = yield* run(first, "uninstall")
			assert.equal(uninstalled.code, 0, `grizzle uninstall: ${uninstalled.stderr}`)
			assert.deepEqual(
				lines(uninstalled),
				Arr.sort(
					[
						...Arr.map(
							[schema, `${schema}__reader`, `${schema}__writer`],
							(n) => `dropped schema ${n}`
						),
						...Arr.map(expected(first), (r) => `dropped role ${r}`)
					],
					Order.String
				),
				"uninstall drops exactly the installation's schemas and roles"
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

layer(Layer.merge(Substrate.layer, NodeServices.layer))(
	"two installations of one generated output on one cluster, each under its own role space",
	(it) => {
		it.effect(
			"install one output into two databases under disjoint role spaces, each working against its own database only, and uninstall exactly one of them, refused whole while a role is held elsewhere",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/cli/role-prefix",
							draw: drawn(spacesGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "roleNameOf under each installation's role space, and PostgreSQL's own roles and grants"
							},
							coverage: required<SpaceFeature>(
								[
									"the second under another prefix",
									"the second under no prefix",
									"an uninstall refused, then done"
								],
								{ cases: 8, sense: notesOnly }
							),
							kept: [],
							runs: 4,
							shrink: { kind: "bounded", candidates: 8 },
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						spaceCase
					)
				)
		)
	}
)
