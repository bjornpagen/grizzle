/** What the property of deadlines.test.ts reads: its space, its login and the settings it compares. */

import type { Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import type { Source } from "@bjornpagen/testing/source"
import { Array as Arr, Clock } from "effect"
import type { Transaction } from "#adapter/wire/batch.ts"
import { loginTemplate } from "#test/pg/adapter/support.ts"

/** Every way a transaction grizzle opens begins: a read, immediate or deferrable, and a write. */
const openings = ["read", "deferrable read", "write"] as const

type Opening = (typeof openings)[number]

/** The transaction each opening begins, committed. */
export const transactions: { readonly [O in Opening]: Transaction } = {
	read: { access: "readOnly", deferrable: false, end: "COMMIT" },
	"deferrable read": { access: "readOnly", deferrable: true, end: "COMMIT" },
	write: { access: "readWrite", isolation: "serializable", end: "COMMIT" }
}

const deadlineSettings = [
	"idle_in_transaction_session_timeout",
	"lock_timeout",
	"statement_timeout",
	"transaction_timeout"
] as const

/** The deadline settings as one text[] parameter. */
export const deadlineList = `{${Arr.join(deadlineSettings, ",")}}`

export const settingsQuery = `SELECT name::text, setting::text, source::text FROM pg_catalog.pg_settings
WHERE name = ANY ($1::text[]) ORDER BY name`

/** How many of a role's stored defaults set a deadline: none, for the login's role. */
export const roleDeadlinesQuery = `SELECT count(*)::int4 FROM pg_catalog.pg_db_role_setting AS d
CROSS JOIN LATERAL pg_catalog.unnest(d.setconfig) AS c(setting)
WHERE d.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1::text)
AND pg_catalog.split_part(c.setting, '=', 1) = ANY ($2::text[])`

/**
 * The wall clock's time in milliseconds, whatever the test's clock: a Vercel deadline is wall-clock time. It only
 * builds the deadline the request context carries; no verdict reads it.
 */
export const wallMillis = Clock.Clock.defaultValue().currentTimeMillis

/** A session's surroundings: a plain process, or a Vercel function whose request carries a deadline. */
const contexts = ["plain", "vercel deadline"] as const

type Context = (typeof contexts)[number]

export type DeadlineFeature = `${Opening} ${Context}`

/** Every opening with every surrounding, the opening outermost. */
export const modes = (source: Source): readonly [Opening, Context] =>
	[source.draw(element(openings)), source.draw(element(contexts))] as const

/** Each opening in each surrounding, every one of the box. */
export const deadlineSituations: ReadonlyArray<Reached<DeadlineFeature>> = Arr.flatMap(
	openings,
	(i) => Arr.map(contexts, (c): DeadlineFeature => `${i} ${c}`)
)

/** Every session of the pool at once, so each one is asked, not only the floor. */
export const leasedAtOnce = 3

/**
 * The login whose sessions the property asks, as a template (adapter/support.ts loginTemplate), made once per member
 * where the search made it before its cases; no case changes the login.
 */
export const deadlinesLogin = loginTemplate(import.meta, "deadlines server")
