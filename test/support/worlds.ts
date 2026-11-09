import { Array as Arr, Effect, type Layer, Record as Rec, type Scope } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import { TokenError } from "#adapter/errors/failures.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import type { DbLayerOf } from "#adapter/types/layer.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { jsonText, trusted, trustedJson } from "#compiler/core/trusted.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import {
	type AnyClosed,
	type AnyDerived,
	type AnyRelation,
	type AnyRoster,
	type AnySchema,
	login,
	type Role,
	role
} from "#compiler/public/schema.ts"
import type { AnyLogin, EntryContexts, RoleRelations } from "#compiler/types/schema/world.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { soleWorldOf } from "#test/support/kernel/naming.ts"
import { clusterConnection, clusterPool, type SqlError } from "#test/support/pg.ts"
import { snapshotValue } from "#test/support/snapshot-json.ts"
import type { SubstrateWorld } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A schema whose relations are reality's own: what a full role holds whole. */
type Reality = AnySchema & {
	readonly relations: Readonly<Record<string, AnyRelation | AnyClosed | AnyDerived>>
}

/** A relation of a schema PostgreSQL holds no rows of: a closed relation's are its constants, a live derived one's its
 * definition's. */
type Unheld =
	| { readonly kind: "closedRelation" }
	| { readonly kind: "derived"; readonly storage: "live" }

/**
 * The relations of `base` a role can hold: every one but its closed relations, which have no extent in the database,
 * only their constants, and its live derived relations, which a role reads through the relations their definitions
 * read.
 */
export const heldRelations = <B extends Reality>(base: B): HeldOf<B> =>
	trusted<HeldOf<B>>(
		Rec.filter(
			base.relations,
			(r) => r.kind !== "closedRelation" && !(r.kind === "derived" && r.storage === "live")
		)
	)

/**
 * The relations of B a role can hold, by their own names and values: B's relation map but its closed relations and live
 * derived relations, so a map of any relations holds any relation, roster or materialized derived relation.
 */
export type HeldOf<B extends Reality> = {
	readonly [K in keyof B["relations"] as B["relations"][K] extends Unheld ? never : K]: Exclude<
		B["relations"][K],
		Unheld
	>
}

/**
 * What a test opens a world through: a schema's full world, the DbLayer of an installation's login, and the token a
 * test's identity provider issues.
 *
 * A schema's full world is the role `app` holding every relation of the schema whole but its closed and live derived
 * relations, and writing every ordinary relation, in the login `server`: reality itself, so every program over the
 * schema runs on it. A closed relation has no extent in the database, only its constants, so no role holds it; a roster
 * does, as its code column; a live derived relation's rows are its definition's over the relations the role holds. It is typed by no
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
export const fullWorld = <B extends Reality>(base: B) => {
	/** Built over any relations, which the role builder checks; the role is then typed by B's own relations (HeldOf). */
	const reality: Reality = base
	const relations = trusted<Readonly<Record<string, AnyRelation | AnyRoster | AnyDerived>>>(
		heldRelations(reality)
	)
	const names = Rec.keys(relations)
	const app = trusted<
		Role<B, "app", RoleRelations<HeldOf<B>>, string, never, EntryContexts<HeldOf<B>>>
	>(
		role(reality, "app", relations, {
			write: Arr.filter(names, (name) => relations[name]?.kind === "relation")
		})
	)
	return { app, server: login(base, "server", [app]) }
}
/** The full world of a schema of B's relations, as fullWorld types it. */
export type FullWorld<B extends Reality = Reality> = ReturnType<typeof fullWorld<B>>

/** The token of `payload`: its JSON text. */
export const tokenOf = (payload: Json): string => jsonText(payload)

/** Every test layer's verify: the payload a token's JSON text holds, or a TokenError for text that holds none. */
export const testVerify = (token: string): Effect.Effect<unknown, TokenError> =>
	Effect.try({
		try: () => trustedJson<unknown>(token),
		catch: (cause) => new TokenError({ cause })
	})

/**
 * The DbLayer of `login` over `installed`, in `database`: the snapshot its migrations reached, the cluster's connection
 * with the login's password (test/support/pg.ts clusterConnection), the test pool, and testVerify.
 */
export const loginLayerIn = <L extends AnyLogin>(
	database: string,
	installed: Installed,
	account: L
): Layer.Layer<DbLayerOf<L>, OpenError> =>
	DbLayer.make({
		...clusterConnection(installed.cluster, database, installed.as(account).password),
		pool: clusterPool,
		login: account,
		snapshot: snapshotValue(installed.snapshot, installed.installation),
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
