import { ModuleClosure, type NeedFailed } from "@bjornpagen/testing/property"
import { type DatabaseTemplate, Template } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, Option, Redacted, String as Str } from "effect"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { pin } from "#pg/pin.ts"
import type { InitializedClusterShape } from "#test/support/cluster.ts"
import { configureDatabase, devSession, testDatabaseSettings } from "#test/support/pg.ts"
import { sqlNeedFailed } from "#test/support/runner.ts"

/**
 * The database every grizzle case starts from: grizzle_template as scripts/pg/init.sh makes it (public empty, the
 * vector extension in vector_ext, plpgsql), with the test database settings (pg.ts testDatabaseSettings) as its
 * database defaults, which the toolchain replays on every clone (a clone copies no pg_db_role_setting row). Its content
 * is what makes it: the PostgreSQL build the pin names and its patches, pgvector's version, and the settings; its build
 * only sets them, from the owner's own database, so no session is left in it.
 */
export const baseTemplate: DatabaseTemplate = Template.database({
	declaredIn: import.meta,
	name: "grizzle base",
	content: {
		postgres: { tag: pin.PG_PIN_TAG, commit: pin.PG_PIN_COMMIT, patches: pin.PG_PIN_PATCHES },
		vector: pin.PGVECTOR_PIN_VERSION,
		settings: Arr.map(testDatabaseSettings, ([name, value]) => [name, value])
	},
	from: Template.cluster,
	build: (target) =>
		Effect.scoped(
			Effect.gen(function* () {
				const { cluster } = yield* target.member.leased
				const failed = sqlNeedFailed("grizzle base template", `the settings of ${target.name}`)
				const admin = yield* Effect.mapError(
					devSession(cluster, Option.some("grizzle base template")),
					failed
				)
				yield* Effect.mapError(configureDatabase(admin, target.name), failed)
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
export const templatePassword = (cluster: InitializedClusterShape, role: string): string => {
	const secret = Redacted.value(cluster.devPassword)
	return sha256Hex(`${secret.length}:${secret}${role}`)
}
