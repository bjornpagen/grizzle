import { regex } from "arkregex"
import { Array as Arr, Data, Effect, Formatter, Option, Predicate } from "effect"
import { quoteString } from "#compiler/sql/print.ts"
import { testExitWait } from "#test/support/limits.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import type { HeldConnection } from "#test/support/substrate/budget.ts"

/**
 * How many back-to-back polls find a database's backends before a wait for them prints what it waits for: enough that a
 * closed session's exit, a few round trips, never prints.
 */
export const quietPolls = 1_000

/** A backend of a role whose session its test still held open when the role was released. */
export interface HeldBackend {
	readonly pid: number
	/** pg_stat_activity.state: active, idle, idle in transaction, ... */
	readonly state: string
	/** Its last statement, its first 200 characters. */
	readonly query: string
}

/**
 * The client backends of `role`, every column as text: each one's pid, state, last statement (its first 200
 * characters) and the port its client connects from, none for a client over a local socket. What a role's release
 * reads (heldBackends).
 */
export const roleBackendsQuery = (role: string): string =>
	`SELECT a.pid::text, coalesce(a.state, 'unknown')::text, left(coalesce(a.query, ''), 200), a.client_port::text FROM pg_catalog.pg_stat_activity AS a WHERE a.usename = ${quoteString(role)}::name AND a.backend_type = 'client backend'::text ORDER BY a.pid`

/** A cell of roleBackendsQuery's rows as its text, none for SQL NULL. */
const textCell = (cell: unknown): Option.Option<string> =>
	Predicate.isString(cell) ? Option.some(cell) : Option.none()

/**
 * The backends among `rows` (roleBackendsQuery's) whose session the test still holds open (`held`,
 * substrate/budget.ts HeldConnection): one whose client is a socket this process still holds open to the server on
 * `serverPort`, from the port pg_stat_activity names, or one a session it holds read its own pid of. Every other backend
 * listed has had its session ended, and is on its way out.
 *
 * The connection-leak check of a role's release (substrate.ts releaseRole): every session a test opens as a role is
 * closed when the scope that opened it closes, before the role is released, so a backend whose session the test still
 * holds is a session it never closed. The release ends every backend of the role, held or on its way out, so it waits
 * on no session, and a held one fails it (SessionsLeaked), naming each.
 */
export const heldBackends = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>,
	held: ReadonlyArray<HeldConnection>,
	serverPort: number
): ReadonlyArray<HeldBackend> =>
	Arr.flatMap(rows, ([pid, state, query, port]) => {
		const backend = Number(pid)
		const clientPort = Option.map(textCell(port), Number)
		const holds = Arr.some(held, (h) =>
			h.kind === "backend"
				? h.pid === backend
				: h.remote === serverPort && Option.contains(clientPort, h.local)
		)
		return holds
			? [
					{
						pid: backend,
						state: Option.getOrElse(textCell(state), () => "unknown"),
						query: Option.getOrElse(textCell(query), () => "")
					}
				]
			: []
	})

/**
 * The release of `role` found sessions its test never closed (heldBackends): each one's backend, its pid, state and
 * last statement. The release has ended them and dropped the role.
 */
export class SessionsLeaked extends Data.TaggedError("SessionsLeaked")<{
	readonly role: string
	readonly backends: Arr.NonEmptyReadonlyArray<HeldBackend>
}> {
	override get message(): string {
		return Arr.join(
			[
				`the release of role ${this.role} found sessions the test never closed, and ended them:`,
				...Arr.map(
					this.backends,
					(b) => `  backend ${b.pid}: ${b.state}, last query ${Formatter.format(b.query)}`
				)
			],
			"\n"
		)
	}
}

/**
 * A client backend, told from any later backend PostgreSQL gives the same pid by when it started (pg_stat_activity's
 * backend_start, as text).
 */
export interface ClientBackend {
	readonly pid: number
	readonly started: string
}

/**
 * The statement a psql writer reads its own backend's identity by, once, as it opens: its own row of pg_stat_activity.
 * A backend's own entry is there from its start, before it serves any statement (PostgreSQL 19 postinit.c,
 * pgstat_bestart_initial and pgstat_bestart_final), and its start shows to a current user with the privileges of the
 * backend's login (pgstatfuncs.c HAS_PGSTAT_PERMISSIONS). A psql writer reads it as its login, before any SET ROLE, so
 * it reads a state it proves exists, and no other session's listing of it; a login whose sessions start under a role
 * without the login's privileges sees no start, and the writer's open fails with what it read.
 */
export const ownBackendQuery =
	"SELECT a.pid::text, a.backend_start::text FROM pg_catalog.pg_stat_activity AS a WHERE a.pid = pg_catalog.pg_backend_pid()"

/** A pid's text: a positive decimal integer. */
const pidText = regex("^[1-9][0-9]*$")

/**
 * The statement a raw session reads its own backend's pid by, once, as it opens: pg_backend_pid(), which any current
 * user may call, whatever role its login starts its sessions under.
 */
export const ownPidQuery = "SELECT pg_catalog.pg_backend_pid()::text"

/** A session's answer to ownPidQuery, its backend's pid: exactly one row of a pid's text, or none. */
export const ownPidOf = (rows: ReadonlyArray<ReadonlyArray<unknown>>): Option.Option<number> => {
	const [only, ...more] = rows
	if (only === undefined || more.length > 0 || only.length !== 1) {
		return Option.none()
	}
	const [pid] = only
	return Predicate.isString(pid) && pidText.test(pid) ? Option.some(Number(pid)) : Option.none()
}

/**
 * A session's answer to ownBackendQuery, its backend: exactly one row of a pid's text and a start, or none, which the
 * session's open reports with the answer.
 */
export const ownBackendOf = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>
): Option.Option<ClientBackend> => {
	const [only, ...more] = rows
	if (only === undefined || more.length > 0 || only.length !== 2) {
		return Option.none()
	}
	const [pid, started] = only
	return Predicate.isString(pid) && pidText.test(pid) && Predicate.isString(started)
		? Option.some({ pid: Number(pid), started })
		: Option.none()
}

/** The backend's row of pg_stat_activity, while it is listed. */
const backendRow =
	"FROM pg_catalog.pg_stat_activity AS a WHERE a.pid = $1::int4 AND a.backend_start = $2::timestamptz"

/**
 * Ends `backend`, whose client has exited, and returns once it has exited too. A backend waiting for its next command
 * reads its client's end-of-file and exits, but one still running a statement reads nothing until the statement ends,
 * and a statement waiting on a lock ends only when the lock's holder ends its transaction: another session, perhaps one
 * released after this one, so a wait for the backend to exit on its own could wait on that release forever. So a
 * backend still listed is terminated, the server waiting up to testExitWait for it to exit, and the release waits on nothing
 * but this backend. One that outlives its termination is a defect of the cluster, as in dropRole. The call stays in the
 * select list, so it runs only for the backend the WHERE clause finds.
 */
export const endBackend = (
	admin: PgConnection,
	backend: ClientBackend
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		const identity = [backend.pid, backend.started]
		const terminated = yield* admin.queryValues(
			`SELECT pg_catalog.pg_terminate_backend(a.pid, ${testExitWait.value}) ${backendRow}`,
			identity
		)
		if (Arr.every(terminated, ([exited]) => exited === true)) {
			return
		}
		/** False also answers a backend that exited on its own between the listing and the call. */
		const left = yield* admin.queryValues(`SELECT 1 ${backendRow}`, identity)
		if (left.length > 0) {
			return yield* Effect.die(new Error(`backend ${backend.pid} did not exit once terminated`))
		}
	})
