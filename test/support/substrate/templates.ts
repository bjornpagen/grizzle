import type { PgMember } from "@bjornpagen/testing/pg"
import { ModuleClosure, type NeedFailed } from "@bjornpagen/testing/property"
import { type DatabaseTemplate, Template } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, Option, Redacted, String as Str } from "effect"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { pin } from "#pg/pin.ts"
import { pgCluster } from "#test/support/env.ts"
import { configureDatabase, devSession, session, testDatabaseSettings } from "#test/support/pg.ts"
import { memberLease, sqlNeedFailed } from "#test/support/runner.ts"

/**
 * PUBLIC's default privileges on a database, granted as the grant that states them (its ACL then reads as PostgreSQL's
 * default, acldefault, never NULL): an installation grants TEMPORARY on the database to its roles, which materializes the
 * ACL, so a template whose ACL is NULL is told apart from a clone whose roles' grants were released, and a held clone's
 * fingerprint would never settle back to its template.
 */
const databaseDefaultGrant = "GRANT CONNECT, TEMPORARY ON DATABASE"

/**
 * The owner's default privileges on vector_ext, the schema the cluster's maker creates for pgvector under the owner,
 * granted as the grant that states them (its ACL then reads as PostgreSQL's default for a schema, acldefault, never
 * NULL): an installation whose relations hold a vector grants USAGE on vector_ext to its roles, which materializes the
 * ACL, so a template whose schema ACL is NULL is told apart from a clone whose roles' grants were released, and a held
 * clone's fingerprint would never settle back to its template (GZ-MIGRATE-CLI's fixtures.test.ts#workedExamples and
 * paths.test.ts#renamedPaths on Substrate.installing: the one line their clones differed in, `schema vector_ext`).
 */
const vectorSchemaGrant = "GRANT USAGE, CREATE ON SCHEMA vector_ext TO CURRENT_USER"

/**
 * The database every grizzle case starts from: grizzle_template as pg.config.ts states it (public empty, the
 * vector extension in vector_ext, plpgsql), with the test database settings (pg.ts testDatabaseSettings) as its
 * database defaults, PUBLIC's default privileges on it stated (databaseDefaultGrant), which the toolchain replays on
 * every clone (a clone copies no pg_db_role_setting row, and its ACL is replayed as the template's), and the owner's on
 * vector_ext stated (vectorSchemaGrant), which a clone copies as a catalog row. Its content is what makes it: the
 * PostgreSQL build the pin names and its patches, pgvector's version, the settings and the stated privileges; its build
 * sets the database's from the owner's own database and vector_ext's from a session in it that the build closes, so no
 * session is left in it.
 */
export const baseTemplate: DatabaseTemplate = Template.database({
	declaredIn: import.meta,
	name: "grizzle base",
	content: {
		postgres: { tag: pin.PG_PIN_TAG, commit: pin.PG_PIN_COMMIT, patches: pin.PG_PIN_PATCHES },
		vector: pin.PGVECTOR_PIN_VERSION,
		settings: Arr.map(testDatabaseSettings, ([name, value]) => [name, value]),
		acl: databaseDefaultGrant,
		vectorAcl: vectorSchemaGrant
	},
	from: Template.cluster,
	build: (target) =>
		Effect.scoped(
			Effect.gen(function* () {
				const { cluster } = yield* memberLease(target.member)
				const failed = sqlNeedFailed("grizzle base template", `the settings of ${target.name}`)
				const admin = yield* Effect.mapError(
					devSession(cluster, Option.some("grizzle base template")),
					failed
				)
				yield* Effect.mapError(configureDatabase(admin, target.name), failed)
				yield* Effect.mapError(
					admin.query(`${databaseDefaultGrant} ${quoteIdent(target.name)} TO PUBLIC`, []),
					failed
				)
				yield* Effect.mapError(
					Effect.scoped(
						Effect.flatMap(
							session(cluster, {
								database: target.name,
								username: pgCluster.owner,
								password: cluster.password,
								applicationName: Option.some("grizzle base template")
							}),
							(inTarget) => inTarget.query(vectorSchemaGrant, [])
						)
					),
					failed
				)
			})
		)
})

/**
 * What a template's identity holds, as the toolchain's (resources/template.ts identify) holds it: its name, its
 * content's canonical text, its declaring module's import-closure hash and its origin's, the cluster's base for none,
 * each part its length and itself, so two identities share a text only when they share every part.
 */
const identityText = (
	template: DatabaseTemplate
): Effect.Effect<string, NeedFailed, ModuleClosure> =>
	Effect.gen(function* () {
		const closures = yield* ModuleClosure
		const closure = yield* closures.hashOf(template.declaredIn)
		const origin = template.from.kind === "cluster" ? "cluster" : yield* identityText(template.from)
		return Arr.join(
			Arr.map(
				[template.name, template.content, closure, origin],
				(part) => `${part.length}:${part}`
			),
			""
		)
	})

/**
 * A template's digest as its allocations carry it (names.ts templateSchemaName): the first 52 bits of the SHA-256 of
 * its identity (identityText), in decimal, zero-padded to 16 digits. Two templates share it exactly when they share an
 * identity, and so a database on the cluster, but by a collision of 52 bits; each worker computes it, and the build.
 */
export const templateDigest = (
	template: DatabaseTemplate
): Effect.Effect<string, NeedFailed, ModuleClosure> =>
	Effect.map(identityText(template), (text) =>
		Str.padStart(16, "0")(String(BigInt(`0x${Str.slice(0, 13)(sha256Hex(text))}`)))
	)

/**
 * The password of a role a template's build makes a login (substrate.ts templateAllocations): the SHA-256, as hex, of
 * the member's owner password (its length, then itself) and the role's name, so only who holds the owner's password
 * derives it, and every worker that clones the template logs in as the role without the template keeping a credential.
 */
export const templatePassword = (cluster: PgMember, role: string): string => {
	const secret = Redacted.value(cluster.password)
	return sha256Hex(`${secret.length}:${secret}${role}`)
}
