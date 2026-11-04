import { Array as Arr, Effect, type Layer, Record as Rec, type Scope } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import { TokenError } from "#adapter/errors/failures.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import type { DbLayerOf } from "#adapter/types/layer.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import {
	type AnyClosed,
	type AnyDerived,
	type AnyRelation,
	type AnySchema,
	login,
	role
} from "#compiler/public/schema.ts"
import type { AnyLogin } from "#compiler/types/schema/world.ts"
import { pgPin } from "#test/support/env.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { soleWorldOf } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { SubstrateWorld } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A schema whose relations are reality's own: what a full role holds whole. */
type Reality = AnySchema & {
	readonly relations: Readonly<Record<string, AnyRelation | AnyClosed | AnyDerived>>
}

/**
 * What a test opens a world through: a schema's full world, the DbLayer of an installation's login, and the token a
 * test's identity provider issues.
 *
 * A schema's full world is the role `app` holding every relation of the schema whole and writing every ordinary
 * relation, in the login `server`: reality itself, so every program over the schema runs on it. It is typed by no
 * particular schema (its relations are any relations), so a program over the schema is a program over one of its levels
 * whatever the schema's name; it refreshes nothing, which a type over any relations cannot name. A fixture that needs
 * more than one role, or a refresh, states its own.
 *
 * A test token is the JSON text of the payload it stands for, and testVerify, every test layer's verify, decodes it:
 * any other text is a TokenError, as a verifier's refusal is. So a test states the claims it opens a Db with by value,
 * and what grizzle decodes from them is grizzle's own, through the role's contexts.
 *
 * The full world of `base` (see the header).
 */
export const fullWorld = (base: Reality) => {
	const relations = base.relations
	const names = Rec.keys(relations)
	const app = role(base, "app", relations, {
		write: Arr.filter(names, (name) => relations[name]?.kind === "relation")
	})
	return { app, server: login(base, "server", [app]) }
}
export type FullWorld = ReturnType<typeof fullWorld>

/** The token of `payload`: its JSON text. */
export const tokenOf = (payload: Json): string => jsonText(payload)

/** Every test layer's verify: the payload a token's JSON text holds, or a TokenError for text that holds none. */
export const testVerify = (token: string): Effect.Effect<unknown, TokenError> =>
	Effect.try({
		try: () => trustedJson<unknown>(token),
		catch: (cause) => new TokenError({ cause })
	})

/**
 * The DbLayer of `login` over `installed`, in `database`: the snapshot its migrations reached, verify-full TLS against
 * the local CA, the login's password, and testVerify.
 */
export const loginLayerIn = <L extends AnyLogin>(
	database: string,
	installed: Installed,
	account: L
): Layer.Layer<DbLayerOf<L>, OpenError> =>
	DbLayer.make({
		login: account,
		snapshot: installed.snapshot,
		host: pgPin.host,
		port: pgPin.port,
		database,
		password: installed.as(account).password,
		tls: { ca: installed.cluster.caPem },
		verify: testVerify
	})

/** The DbLayer of `login` over `installed`, in the database it was migrated in. */
export const loginLayer = <L extends AnyLogin>(
	installed: Installed,
	account: L
): Layer.Layer<DbLayerOf<L>, OpenError> => loginLayerIn(installed.database, installed, account)

/**
 * The one world of an installation compiled with oracleOwnedLogin (oracle/install/real.ts), as a direct SQL writer
 * takes it on: the login's credentials and its full role's theory role.
 */
export const oracleWorld = (
	installation: Installation
): Effect.Effect<SubstrateWorld, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const sole = soleWorldOf(installation)
		const s = yield* Substrate
		return { login: yield* s.login(sole.login), role: sole.role }
	})
