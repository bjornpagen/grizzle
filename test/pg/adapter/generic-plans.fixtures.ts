/** What generic-plans.test.ts reads: its session kinds and each case's run over one session of its kind. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Data, Effect, Formatter } from "effect"
import { connectListener, connectSession, type Session } from "#adapter/wire/session.ts"
import { servedSession } from "#compiler/plan/common.ts"
import { clusterConnection, parsedConnection } from "#test/support/pg.ts"
import {
	defaultPool,
	poolFor,
	roleDefaults,
	rowsOn,
	substrateLogin
} from "#test/support/pg/adapter/support.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/** Whose session a case opens: a login's, leased from a Db's pool; an owner's; or an owner's listening one. */
export type GenericPlansFeature =
	| "a login's pool session"
	| "an owner's session"
	| "an owner's listener"

export const genericPlansFeatures: ReadonlyArray<GenericPlansFeature> = [
	"a login's pool session",
	"an owner's session",
	"an owner's listener"
]

export const sessionKinds: Gen<GenericPlansFeature> = (source) =>
	source.draw(
		element<GenericPlansFeature>([
			"a login's pool session",
			"an owner's session",
			"an owner's listener"
		])
	)

class NotGeneric extends Data.TaggedError("NotGeneric")<{ readonly message: string }> {}

/** A session of `kind` as a login of a fresh schema (see the test's header), closed with the scope. */
const sessionOf = (kind: GenericPlansFeature) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema(freshSchema)
		if (kind === "a login's pool session") {
			const login = yield* substrateLogin(schema, "pooled", roleDefaults)
			const pool = yield* poolFor(login, defaultPool)
			return yield* pool.lease
		}
		const owner = yield* substrateLogin(schema, "owner", [])
		const connection = {
			...parsedConnection(clusterConnection(s.cluster, s.database, owner.password), owner.role),
			controls: servedSession
		}
		const session: Session =
			kind === "an owner's session"
				? yield* connectSession(connection)
				: yield* connectListener(connection, { notified: () => undefined, ended: () => undefined })
		return session
	})

/**
 * Opens a session of `kind` and reads its plan_cache_mode and that setting's source on it: force_generic_plan, set by
 * the client's own startup options.
 */
export const runGenericPlans = (kind: GenericPlansFeature, c: Case<GenericPlansFeature>) =>
	Effect.gen(function* () {
		const session = yield* sessionOf(kind)
		const rows = yield* rowsOn(
			session,
			"SELECT pg_catalog.current_setting('plan_cache_mode'), source FROM pg_catalog.pg_settings WHERE name = 'plan_cache_mode'",
			[]
		)
		c.note(kind)
		const [mode, source] = rows[0] ?? []
		if (mode !== "force_generic_plan" || source !== "client") {
			return yield* new NotGeneric({
				message: `${kind} starts with plan_cache_mode ${Formatter.format(mode)} from ${Formatter.format(source)}`
			})
		}
	})
