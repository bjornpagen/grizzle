import * as Arr from "effect/Array"
import type * as Option from "effect/Option"

/** The variables node-postgres reads into a session's startup packet whenever grizzle's configured value is falsy. */
export const startupVariableNames = ["PGOPTIONS", "PGREPLICATION"] as const
export type StartupVariable = (typeof startupVariableNames)[number]

/**
 * The variables of the process environment node-postgres would send at the startup of a login's or an owner's session,
 * whatever grizzle configures. pg reads each startup variable as `config[key] || process.env[...]` (pg 8.23
 * connection-parameters.js `val`), so a configured value that is empty never turns it off:
 * - `PGREPLICATION`, sent as `replication`, which makes the session a replication connection: grizzle sets none, as no
 *   such session of its is one, so it would reach every one;
 * - `PGOPTIONS`, sent as `options`, reaches neither: a login's session sets them itself, to its pinned defaults
 *   (physical/ddl/roles.ts loginStartupOptions), and an owner's to generic plans (ownerStartupOptions).
 * Every other variable pg reads that way, grizzle's client configuration sets (wire/session.ts clientConfig), and the
 * password pg is given is a function, so pg reads neither PGPASSWORD nor a password file, except `PGAPPNAME`, sent as
 * `application_name`, which grizzle leaves to the environment: grizzle names no session, and the name is the
 * deployment's own label for its sessions in pg_stat_activity and the server's log, which no setting, admission or
 * statement of grizzle's reads.
 */
const refusedVariables = [
	"PGREPLICATION"
] as const satisfies Arr.NonEmptyReadonlyArray<StartupVariable>
export type RefusedVariable = (typeof refusedVariables)[number]

/**
 * The first refused variable (refusedVariables), in list order, that the process environment sets to a text: what pg
 * would send at the startup of every login's and owner's session. pg takes the empty text for unset. It reads
 * `process.env`, the very source pg reads, never a ConfigProvider's view of it, which an application may set apart
 * from it: this module is grizzle's one reader of the environment (the no-environment gate). DbLayer.make refuses a
 * login's (pool/served.ts), the command line an owner's (cli/connection.ts).
 */
export const startupVariableSet = (): Option.Option<RefusedVariable> => {
	const env = process.env
	return Arr.findFirst(refusedVariables, (variable) => {
		const value = env[variable]
		return value !== undefined && value !== ""
	})
}
