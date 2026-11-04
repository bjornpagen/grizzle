import { Array as Arr, type Option } from "effect"

/** The variables node-postgres reads into a session's startup packet whenever grizzle's configured value is falsy. */
export const startupVariableNames = ["PGOPTIONS", "PGREPLICATION"] as const
export type StartupVariable = (typeof startupVariableNames)[number]

/** The sessions grizzle opens: a login's, every session of a Db's pool; and an owner's, the migration identity's. */
export type SessionKind = "login" | "owner"

/**
 * The variables of the process environment node-postgres would send at the startup of a session, by the sessions they
 * reach. pg reads each as `config[key] || process.env[...]` (pg 8.23 connection-parameters.js `val`), so a configured
 * value that is empty never turns it off:
 * - `PGREPLICATION`, sent as `replication`, which makes the session a replication connection: grizzle sets none, as no
 *   session of its is one, so it would reach every session;
 * - `PGOPTIONS`, sent as `options`: every session of a login's pool sets it itself, to the pinned login defaults
 *   (physical/ddl/roles.ts loginStartupOptions), so it reaches only an owner's sessions, which set none, as they start
 *   under their role's and their database's defaults.
 * Every other variable pg reads that way, grizzle's client configuration sets (wire/session.ts clientConfig), and the
 * password pg is given is a function, so pg reads neither PGPASSWORD nor a password file.
 */
const startupVariables: {
	readonly [K in SessionKind]: Arr.NonEmptyReadonlyArray<StartupVariable>
} = {
	login: ["PGREPLICATION"],
	owner: ["PGOPTIONS", "PGREPLICATION"]
}

/**
 * The first of `kind`'s startup variables, in list order, that `env` sets to a text: what pg would send at the startup
 * of each such session. pg takes the empty text for unset. `env` is the process environment, the very source pg reads,
 * and never a ConfigProvider's view of it, which an application may set apart from it. DbLayer.make refuses a login's
 * (pool/registry.ts), the command line an owner's (cli/connection.ts).
 */
export const setStartupVariable = (
	env: Readonly<Record<string, string | undefined>>,
	kind: SessionKind
): Option.Option<StartupVariable> =>
	Arr.findFirst(startupVariables[kind], (variable) => {
		const value = env[variable]
		return value !== undefined && value !== ""
	})
