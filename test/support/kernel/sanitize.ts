import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Option, Predicate } from "effect"
import { testExitWait } from "#test/support/limits.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"

/** A backend of a login, as pg_stat_activity shows it. */
interface Backend {
	readonly pid: number
	readonly role: string
	/** pg_stat_activity.state: active, idle, idle in transaction, ... */
	readonly state: string
	readonly query: string
}

const decodeBackends = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<Backend> =>
	Arr.map(rows, ([pid, role, state, query]) => ({
		pid: Number(pid),
		role: String(role),
		state: String(state),
		query: String(query)
	}))

/** The client backends of `role`. */
const backendsOf = (
	admin: PgConnection,
	role: string
): Effect.Effect<ReadonlyArray<Backend>, SqlError> =>
	Effect.map(
		admin.queryValues(
			`SELECT a.pid, a.usename::text, coalesce(a.state, 'unknown')::text, left(coalesce(a.query, ''), 200) FROM pg_catalog.pg_stat_activity AS a WHERE a.usename = $1::name AND a.backend_type = 'client backend' ORDER BY a.pid`,
			[role]
		),
		decodeBackends
	)

const describeBackend = (b: Backend): string =>
	`backend ${b.pid} of ${b.role}: ${b.state}, last query ${Formatter.format(b.query)}`

/**
 * How many back-to-back polls find a role's backends before the check prints what it waits for: enough that a closed
 * session's exit, a few round trips, never prints.
 */
export const quietPolls = 1_000

/** What a release that has not ended waits for: the role's backends still listed. */
const waitingReport = (role: string, backends: ReadonlyArray<Backend>): string =>
	Arr.join(
		[
			`waiting for role ${role}'s sessions to end; a session the test never closed keeps this release, and its test, from finishing:`,
			...Arr.map(backends, (b) => `  ${describeBackend(b)}`)
		],
		"\n"
	)

/**
 * Returns once `role` has no backend left (see the header).
 *
 * The connection-leak check: a test leaves no session of its roles behind.
 *
 * Every login a test allocates is released when the test's scope closes (test/support/substrate), and its
 * backends must be gone by then. The check waits on PostgreSQL's own fact, the role's backends listed in
 * pg_stat_activity, until none is left, and judges nothing by time:
 * - a session the test closed is gone already, or certainly goes: a closed client's backend reads end-of-file or its
 *   Terminate and exits, so the wait ends;
 * - a session the test never closed keeps its backend, and the wait does not end. The release then never finishes,
 *   and the test's timeout (vitest.config.ts) or its case's hang guard reports the test as hung. While it
 *   waits, the check prints the backends it waits for on stderr (`waitingReport`), once, after `quietPolls` polls have
 *   found them, so a hang names the leaked session. The print is a diagnostic, never a verdict.
 */
export const awaitRoleQuiet = (admin: PgConnection, role: string): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		for (let polls = 1; ; polls++) {
			const left = yield* backendsOf(admin, role)
			if (left.length === 0) {
				return
			}
			if (polls === quietPolls) {
				yield* Effect.sync(() => process.stderr.write(`${waitingReport(role, left)}\n`))
			}
			yield* Effect.yieldNow
		}
	})

/**
 * A client backend, told from any later backend PostgreSQL gives the same pid by when it started (pg_stat_activity's
 * backend_start, as text).
 */
export interface ClientBackend {
	readonly pid: number
	readonly started: string
}

/**
 * The statement a session reads its own backend's identity by, once, as it opens: its own row of pg_stat_activity. A
 * backend's own entry is there from its start, before it serves any statement, with its start, which its own user
 * reads, so the session reads a state it proves exists, and no other session's listing of it.
 */
export const ownBackendQuery =
	"SELECT a.pid::text, a.backend_start::text FROM pg_catalog.pg_stat_activity AS a WHERE a.pid = pg_catalog.pg_backend_pid()"

/** A pid's text: a positive decimal integer. */
const pidText = regex("^[1-9][0-9]*$")

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
