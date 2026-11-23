import type { PgMember } from "@bjornpagen/testing/pg"
import { ModuleClosure, type NeedFailed } from "@bjornpagen/testing/property"
import { type DatabaseTemplate, Template } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, Option, Redacted, String as Str } from "effect"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"
import { pin } from "#pg/pin.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import { configureDatabase, devSession, testDatabaseSettings } from "#test/support/pg.ts"
import { memberBudget, sqlNeedFailed } from "#test/support/runner.ts"

/**
 * The database every grizzle case starts from: grizzle_template as pg.config.ts states it (public empty, the
 * vector extension in vector_ext, plpgsql), with the test database settings (pg.ts testDatabaseSettings) as its
 * database defaults, which the toolchain replays on every clone (a clone copies no pg_db_role_setting row). Its content
 * is what makes it: the PostgreSQL release the pin builds, by its tarball's SHA-256, pgvector's version and the
 * settings; its build sets them from the owner's own database, so no session is left in it. It states no privilege of
 * PUBLIC's or the owner's: their grants stood only so a clone held across cases, its roles' grants released, read back
 * as its template under the toolchain's fingerprint (Substrate.seat, Substrate.installing), and no case holds a clone
 * across cases any more but in its own rolled-back transaction.
 */
export const baseTemplate: DatabaseTemplate = Template.database({
	declaredIn: import.meta,
	name: "grizzle base",
	content: {
		postgres: { version: pin.PG_PIN_VERSION, tarball: pin.PG_PIN_SHA256 },
		vector: pin.PGVECTOR_PIN_VERSION,
		settings: Arr.map(testDatabaseSettings, ([name, value]) => [name, value])
	},
	from: Template.cluster,
	budget: templateNeedBudget,
	build: (target) =>
		Effect.scoped(
			Effect.gen(function* () {
				const cluster = yield* memberBudget(target.member)
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
 * An origin's part of a template's identity (identityText): the cluster's base, a fresh database's locale, as the
 * toolchain's originKey writes it (`fresh <locale>`), or the identity of the template it is built from.
 */
const originText = (
	origin: DatabaseTemplate["from"]
): Effect.Effect<string, NeedFailed, ModuleClosure> => {
	switch (origin.kind) {
		case "cluster":
			return Effect.succeed("cluster")
		case "fresh":
			return Effect.succeed(`fresh ${origin.locale}`)
		case "database-template":
			return identityText(origin)
	}
}

/**
 * What a template's identity holds, as the toolchain's (resources/template.ts identify) holds it: its name, its
 * content's canonical text, its declaring module's import-closure hash and its origin's (originText), each part its
 * length and itself, so two identities share a text only when they share every part.
 */
const identityText = (
	template: DatabaseTemplate
): Effect.Effect<string, NeedFailed, ModuleClosure> =>
	Effect.gen(function* () {
		const closures = yield* ModuleClosure
		const closure = yield* closures.hashOf(template.declaredIn)
		const origin = yield* originText(template.from)
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
		Str.padStart(16, "0")(String(BigInt(`0x${Str.slice(0, 13)(sha256Hex(wellFormed(text)))}`)))
	)

/**
 * The password of a role a template's build makes a login (substrate.ts templateAllocations): the SHA-256, as hex, of
 * the member's owner password (its length, then itself) and the role's name, so only who holds the owner's password
 * derives it, and every worker that clones the template logs in as the role without the template keeping a credential.
 */
export const templatePassword = (cluster: PgMember, role: string): string => {
	const secret = Redacted.value(cluster.password)
	return sha256Hex(wellFormed(`${secret.length}:${secret}${role}`))
}
