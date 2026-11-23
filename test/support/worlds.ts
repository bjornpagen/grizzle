import { utf8Text } from "@bjornpagen/grizzle-text/utf8"
import { Array as Arr, Effect, Record as Rec, Redacted, type Scope } from "effect"
import { TokenRefused } from "#adapter/errors/failures.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { jsonText, trusted, trustedJson } from "#compiler/core/trusted.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import {
	type AnyClosed,
	type AnyDerived,
	type AnyRelation,
	type AnyRoster,
	type AnySchema,
	type Role,
	role
} from "#compiler/public/schema.ts"
import { loginBuilder as login } from "#compiler/schema/world.ts"
import type { RoleRelations } from "#compiler/types/schema/world.ts"
import { soleWorldOf } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { SubstrateWorld } from "#test/support/substrate/session.ts"
import { Substrate, type TemplateBinding } from "#test/support/substrate/substrate.ts"
import { templatePassword } from "#test/support/substrate/templates.ts"

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
 * derived relations, so a map of any relations holds any relation, roster or stored derived relation.
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
 * relations, writing every ordinary relation and declaring no context, in the login `server`, whose workload is the test's programs over the
 * role, each a member a Db of the role runs by its name (`db.workload.<name>`): reality itself, so every program over the
 * schema runs on it. A closed relation has no extent in the database, only its constants, so no role holds it; a roster
 * does, as its code column; a live derived relation's rows are its definition's over the relations the role holds. It is typed by no
 * particular schema (its relations are any relations), so a program over the schema is a program over one of its levels
 * whatever the schema's name. A fixture that needs more than one role states its own.
 *
 * A test token is the JSON text of the payload it stands for, in base64url (tokenText, a token68 as every door reads
 * one), and testVerify, every test layer's verify, decodes it: any other token is a TokenRefused, as a verifier's refusal
 * is. So a test states the claims it opens a Db with by value,
 * and what grizzle decodes from them is grizzle's own, through the role's contexts.
 *
 * The full world of `base` whose login's workload holds `programs` over its role (see the header): `{}` for a world a
 * test only installs, or opens on a path that runs no workload member. The programs may be written over the fixture a
 * test declared rather than over `base`, the fixture rebuilt under its installed name: a level is its content, not its
 * name (program/schema.ts levelSchema), so the workload and the login are the builders workload(...) and login(...)
 * run, beneath the public types' checks, which read a program's schema by name and the programs' names off a type P
 * fullWorld holds as a parameter. The one workload of the login, over its one role, is what login(...) admits.
 */
export const fullWorld = <B extends Reality, const P extends Readonly<Record<string, unknown>>>(
	base: B,
	programs: P
) => {
	/** Built over any relations, which the role builder checks; the role is then typed by B's own relations (HeldOf). */
	const reality: Reality = base
	const relations = trusted<Readonly<Record<string, AnyRelation | AnyRoster | AnyDerived>>>(
		heldRelations(reality)
	)
	const names = Rec.keys(relations)
	const app = trusted<Role<B, "app", RoleRelations<HeldOf<B>>, string, never>>(
		role(reality, "app", relations, {
			write: Arr.filter(names, (name) => relations[name]?.kind === "relation")
		})
	)
	return { app, server: login(base, "server", [app], [{ workload: [workload(app, programs)] }]) }
}
/** The full world of a schema of B's relations whose login's workload holds P, as fullWorld types it. */
export type FullWorld<
	B extends Reality = Reality,
	P extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>
> = ReturnType<typeof fullWorld<B, P>>

/**
 * The token of a payload's `text`, as every door reads a token (adapter/db/token.ts parseToken, a token68): the text's
 * UTF-8 bytes in base64url (RFC 4648 section 5), as a JWT's segments are, so Db.open and an HTTP call accept it alike.
 */
export const tokenText = (text: string): string =>
	Buffer.from(utf8.encode(text)).toString("base64url")

/**
 * The bytes a base64url text spells (RFC 4648 section 5, unpadded), or none for a text that is no canonical base64url:
 * the platform's decoding, which skips what it cannot read, held to the text its bytes encode back to.
 */
const base64urlBytes = (text: string): Uint8Array | undefined => {
	const bytes = Buffer.from(text, "base64url")
	return bytes.toString("base64url") === text ? bytes : undefined
}

/** The token of `payload`: its JSON text, as a token (tokenText). */
export const tokenOf = (payload: Json): string => tokenText(jsonText(payload))

const utf8 = new TextEncoder()

/**
 * Every test layer's verify: the payload the JSON text a token spells holds (tokenText), or a TokenRefused for a token
 * that spells no UTF-8 text or a text that holds no JSON as written. Its bytes are read as the UTF-8 they are
 * (grizzle-text utf8.ts), so a byte order mark before the JSON, which JSON.parse refuses, is no JSON.
 */
export const testVerify = (token: string): Effect.Effect<unknown, TokenRefused> => {
	const bytes = base64urlBytes(token)
	if (bytes === undefined) {
		return Effect.fail(new TokenRefused({ cause: "the token spells no base64url text" }))
	}
	const text = utf8Text(bytes)
	return text === undefined
		? Effect.fail(new TokenRefused({ cause: "the token spells no UTF-8 text" }))
		: Effect.try({
				try: () => trustedJson<unknown>(text),
				catch: (cause) => new TokenRefused({ cause })
			})
}

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

/**
 * oracleWorld of an installation a template's build ran (script-template.ts scriptTemplate), as a case over a clone of
 * it takes it on: the login's password the one the build's allocations derived for it (substrate/templates.ts
 * templatePassword), which every worker derives from the member's owner password.
 */
export const templateOracleWorld = (
	installation: Installation,
	binding: TemplateBinding
): SubstrateWorld => {
	const sole = soleWorldOf(installation)
	return {
		login: {
			role: sole.login,
			password: Redacted.make(templatePassword(binding.cluster, sole.login))
		},
		role: sole.role
	}
}
