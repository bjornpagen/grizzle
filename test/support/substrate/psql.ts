import {
	Array as Arr,
	type Cause,
	Clock,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	Formatter,
	Option,
	pipe,
	Queue,
	Record as Rec,
	Redacted,
	Ref,
	type Scope,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { pgPin } from "#test/support/env.ts"
import { messageOf } from "#test/support/message.ts"
import { reportedConstraintOf } from "#test/support/pg.ts"
import {
	type PgErrorFields,
	PsqlProcessError,
	PsqlStatementError,
	TransactionRolledBack
} from "#test/support/substrate/errors.ts"

import {
	type BelowSerializable,
	beginBelowStatement,
	beginSerializable,
	type Credentials
} from "#test/support/substrate/session.ts"

import { regex } from "arkregex"
const fieldSeparator = "\x1f"
const recordSeparator = "\x1e"
const nullDisplay = "\x1a"
const markerLead = "\x1d"

export interface PsqlResult {
	/** Text values; a SQL NULL is `null`. */
	readonly rows: ReadonlyArray<ReadonlyArray<string | null>>
	readonly rowCount: number
	/** Each NOTICE, WARNING or INFO message the server sent while the statement ran, in order. */
	readonly notices: ReadonlyArray<string>
}

export interface PsqlWriter {
	readonly label: string
	readonly role: string
	readonly database: string
	/**
	 * The server backend running the writer's statements, as pg_backend_pid() reports it, read once when the writer
	 * starts; not counted, and available while a statement is in flight.
	 */
	readonly pid: Effect.Effect<number, PsqlStatementError | PsqlProcessError>
	/**
	 * Runs one SQL statement. A trailing semicolon is optional. psql meta-commands are a defect, and psql still
	 * interpolates its own variables (`:name` outside literals) as it does at a terminal.
	 */
	readonly run: (sql: string) => Effect.Effect<PsqlResult, PsqlStatementError | PsqlProcessError>
	/** BEGIN ISOLATION LEVEL SERIALIZABLE. */
	readonly begin: Effect.Effect<void, PsqlStatementError | PsqlProcessError>
	/** A planted below-SERIALIZABLE BEGIN, for a writer whose writes grizzle must refuse. */
	readonly beginBelow: (
		level: BelowSerializable
	) => Effect.Effect<void, PsqlStatementError | PsqlProcessError>
	/** COMMIT, failing with TransactionRolledBack when PostgreSQL answers it with ROLLBACK (an aborted transaction). */
	readonly commit: Effect.Effect<
		void,
		PsqlStatementError | PsqlProcessError | TransactionRolledBack
	>
	readonly rollback: Effect.Effect<void, PsqlStatementError | PsqlProcessError>
	/** Every statement sent through this writer, whether or not it succeeded. The startup pid query is not counted. */
	readonly statements: Effect.Effect<number>
	readonly log: Effect.Effect<ReadonlyArray<string>>
	readonly resetStatements: Effect.Effect<void>
}

export interface PsqlOptions {
	readonly database: string
	readonly credentials: Credentials
	readonly label: string
	readonly caFile: string
	/** The name libpq connects to and verifies the server certificate against (sslmode=verify-full). */
	readonly host: string
	/** The address to connect to, without a name lookup, or none; the certificate must still name `host`. */
	readonly hostaddr: Option.Option<string>
	/**
	 * Cancels backend `pid`'s query from another connection (pg_cancel_backend), only while pg_stat_activity shows it
	 * running one (state `active`). A statement interrupted once the writer has started is canceled this way, and the
	 * psql session survives. The startup query runs before the backend pid is known: interrupted, the child gets SIGINT,
	 * and a non-interactive psql cancels the query and then exits.
	 */
	readonly cancelBackend: (pid: number) => Effect.Effect<void>
}

/**
 * The writer's deadlines: the wall-clock time each wait may take before psql is killed. They run on the live clock,
 * never on a test's TestClock, which moves only when the test adjusts it, so a hung psql is killed after its real
 * deadline whichever clock the test runs on.
 */
const deadlines = {
	/**
	 * From an interrupted statement's first cancel to its end. Reaching it means a backend ignored its cancels, which is
	 * a defect.
	 */
	cancel: Duration.seconds(10),
	/** From end-of-file on an idle psql's stdin to its exit. */
	exit: Duration.seconds(5)
} as const

/** The live clock: wall time, even in a test whose current clock is its TestClock. */
const wallClock: Clock.Clock = Clock.Clock.defaultValue()

/**
 * `wait`'s result, or none when `deadline` passes first. The deadline's timer alone runs on the wall clock; `wait` keeps
 * the clock it was given. Past the deadline the wait is interrupted, and this returns once it has stopped.
 */
const within = <A, E>(
	deadline: Duration.Duration,
	wait: Effect.Effect<A, E>
): Effect.Effect<Option.Option<A>, E> =>
	Clock.clockWith((current) =>
		wait.pipe(
			Effect.provideService(Clock.Clock, current),
			Effect.timeoutOption(deadline),
			Effect.provideService(Clock.Clock, wallClock)
		)
	)

/** psql killed at once: SIGKILL. */
const killNow: ChildProcess.KillOptions = { killSignal: "SIGKILL" }

/**
 * psql interrupted: SIGINT, on which a non-interactive psql cancels its query and exits, and SIGKILL once the cancel
 * deadline has passed. The spawner times the escalation on wall time itself (NodeChildProcessSpawner).
 */
const interruptThenKill: ChildProcess.KillOptions = {
	killSignal: "SIGINT",
	forceKillAfter: deadlines.cancel
}

/** What psql printed for a statement up to its stdout marker, and its :SQLSTATE and :ROW_COUNT from the marker. */
interface Printed {
	readonly sqlstate: string
	readonly rowCount: number
	/** The rows, or, for a statement sent with its tag, the command tag. */
	readonly output: string
}

/** A statement's whole answer: what it printed, and what psql wrote to stderr before its stderr marker. */
interface Completed extends Printed {
	readonly stderr: string
}

/** What psql prints for a statement before its markers: its rows, or its command tag (QUIET off for it alone). */
type Answer = "rows" | "tag"

/** How a statement ends: its answer, or the error that ended psql first. */
type Outcome = Deferred.Deferred<Completed, PsqlProcessError>

/** A statement given to psql's driver, and its outcome. */
interface Statement {
	readonly id: number
	/** The script text for psql: the statement and its two markers. */
	readonly script: string
	readonly outcome: Outcome
}

/** Which of a statement's two markers psql has still to print. Once it has printed both, the statement has completed. */
type Awaiting =
	| { readonly _tag: "Both" }
	| { readonly _tag: "Stdout"; readonly stderr: string }
	| { readonly _tag: "Stderr"; readonly printed: Printed }

const awaitingBoth: Awaiting = { _tag: "Both" }

/** The statement psql is running, and the markers it has still to print. */
interface Flight {
	readonly statement: Statement
	readonly awaiting: Awaiting
}

/**
 * What psql is doing. It runs at most one statement: the next is written to its stdin only once the running one has
 * completed. So a statement still queued when its fiber is interrupted is dropped without reaching psql, and the server
 * backend only ever runs the statement psql is running, so a cancel aimed at it cannot reach another.
 */
type Line =
	| { readonly _tag: "Idle" }
	| { readonly _tag: "Running"; readonly flight: Flight }
	| { readonly _tag: "Canceling"; readonly flight: Flight }
	| { readonly _tag: "Draining" }

const idle: Line = { _tag: "Idle" }
const draining: Line = { _tag: "Draining" }

/** The statements a line has given psql: the running one, or none. */
const inPsql = (line: Line): ReadonlyArray<Statement> => {
	switch (line._tag) {
		case "Idle":
		case "Draining":
			return []
		case "Running":
		case "Canceling":
			return [line.flight.statement]
	}
}

/**
 * The writer: live, with what psql is doing and the statements queued behind it, or dead, with the error that ended
 * psql, which every statement still waiting and every later one fails with.
 */
type Life =
	| { readonly _tag: "Live"; readonly line: Line; readonly queued: ReadonlyArray<Statement> }
	| { readonly _tag: "Dead"; readonly error: PsqlProcessError }

/** What an interrupted statement turned out to be: dropped unsent (or already ended), or running in psql. */
type Abandoned = "dropped" | "running"

/**
 * How psql ends when the writer's scope closes: it has ended already; end-of-file on its stdin, as it is idle; or a
 * kill, as a statement is still running or queued (it may be blocked on a lock that will never be released).
 */
type Stop = "gone" | "eof" | "kill"

/**
 * What psql's driver is told, in the order it happens. The readers tell it what psql writes and when psql has ended;
 * the writer's callers tell it their statements, their interruptions and the scope's close.
 */
type Event =
	| { readonly _tag: "Stdout"; readonly text: string }
	| { readonly _tag: "Stderr"; readonly text: string }
	| { readonly _tag: "Ended"; readonly reason: string }
	| {
			readonly _tag: "Send"
			readonly sql: string
			readonly answer: Answer
			readonly outcome: Outcome
	  }
	| {
			readonly _tag: "Abandon"
			readonly outcome: Outcome
			readonly reply: Deferred.Deferred<Abandoned>
	  }
	| { readonly _tag: "Canceled" }
	| { readonly _tag: "Close"; readonly reply: Deferred.Deferred<Stop> }

/** How an interrupted statement psql is running is canceled. */
type Canceler = { readonly _tag: "Signal" } | { readonly _tag: "Backend"; readonly pid: number }

const terminate = (sql: string): string => {
	let text = Str.trimEnd(sql)
	while (Str.endsWith(";")(text)) {
		text = Str.trimEnd(Str.slice(0, -1)(text))
	}
	return text
}

/**
 * The psql invocation: no psqlrc, quiet, unaligned tuples with control-character separators, verbose errors. Its
 * connection has no connect deadline, as no test helper's has (test/support/pg.ts session): a connect is judged by what
 * the server answers.
 */
const psqlArguments = (options: PsqlOptions): ReadonlyArray<string> => {
	const conninfo = Arr.join(
		[
			`host=${options.host}`,
			...Option.match(options.hostaddr, {
				onNone: () => [],
				onSome: (address) => [`hostaddr=${address}`]
			}),
			`port=${pgPin.port}`,
			`dbname=${options.database}`,
			`user=${options.credentials.role}`,
			"sslmode=verify-full",
			`sslrootcert=${options.caFile}`,
			`application_name='grizzle-substrate psql ${options.label}'`
		],
		" "
	)
	return [
		"-X",
		"-q",
		"-A",
		"-t",
		"-F",
		fieldSeparator,
		"-R",
		recordSeparator,
		"-P",
		`null=${nullDisplay}`,
		"-v",
		"ON_ERROR_STOP=0",
		"-v",
		"VERBOSITY=verbose",
		conninfo
	]
}

/** The child's environment: no inherited libpq variables, the password through PGPASSWORD. */
const childEnvironment = (credentials: Credentials): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = {}
	for (const [key, value] of Rec.toEntries(process.env)) {
		if (!Str.startsWith("PG")(key)) {
			env[key] = value
		}
	}
	env["PGPASSWORD"] = Redacted.value(credentials.password)
	env["PGCLIENTENCODING"] = "UTF8"
	env["LC_ALL"] = "C"
	return env
}

const parseRows = (output: string): ReadonlyArray<ReadonlyArray<string | null>> => {
	if (output.length === 0) {
		return []
	}
	const body = Str.endsWith("\n")(output) ? Str.slice(0, -1)(output) : output
	return Arr.map(Str.split(body, recordSeparator), (record) =>
		Arr.map(Str.split(record, fieldSeparator), (value) => (value === nullDisplay ? null : value))
	)
}

const noticeLine = regex("^(?:psql:[^\\n]*?: )?(?:NOTICE|WARNING|INFO): {2}(?:[0-9A-Z]{5}: )?(.*)$")

/** The messages of psql's verbose report of the notices a statement raised. */
const parseNotices = (stderr: string): ReadonlyArray<string> =>
	Arr.flatMap(Str.split(stderr, "\n"), (line) => {
		const message = noticeLine.exec(line)?.[1]
		return message === undefined ? [] : [message]
	})

const severityLine = regex(
	"^(?:psql:[^\\n]*?: )?(?:ERROR|FATAL|PANIC): {2}(?:([0-9A-Z]{5}): )?(.*)$"
)
/** The fields psql prints after a failed statement's severity line, each a name, a colon and two spaces. */
const FIELD_NAMES: ReadonlyArray<string> = [
	"DETAIL",
	"HINT",
	"CONTEXT",
	"SCHEMA NAME",
	"TABLE NAME",
	"COLUMN NAME",
	"DATATYPE NAME",
	"CONSTRAINT NAME"
]

/** The line terminators a value running to the end of its line cannot hold. */
const LINE_TERMINATORS: ReadonlyArray<string> = ["\n", "\r", "\u2028", "\u2029"]

/** A field line's name and its value, which runs to the end of the line. */
const fieldOf = (line: string): readonly [string, string] | undefined => {
	const name = Arr.findFirst(FIELD_NAMES, (each) => Str.startsWith(`${each}:  `)(line))
	if (Option.isNone(name)) {
		return undefined
	}
	const value = Str.slice(name.value.length + 3)(line)
	return Arr.some(LINE_TERMINATORS, (terminator) => Str.includes(terminator)(value))
		? undefined
		: [name.value, value]
}

const fieldKeys: Readonly<
	Record<
		string,
		"detail" | "hint" | "where" | "schema" | "table" | "column" | "dataType" | "constraint"
	>
> = {
	DETAIL: "detail",
	HINT: "hint",
	CONTEXT: "where",
	"SCHEMA NAME": "schema",
	"TABLE NAME": "table",
	"COLUMN NAME": "column",
	"DATATYPE NAME": "dataType",
	"CONSTRAINT NAME": "constraint"
}

/**
 * Parses psql's VERBOSITY=verbose error report, or finds none when stderr holds no severity line: a failure psql
 * reports itself, a client-side error, carries no PostgreSQL report to parse. The SQLSTATE itself comes from psql's
 * :SQLSTATE variable.
 */
export const parseVerboseError = (sqlstate: string, stderr: string): PgErrorFields | undefined => {
	const lines = Str.split(stderr, "\n")
	/**
	 * The last severity line opens psql's report of the failed statement; its message follows the SQLSTATE. The pattern's
	 * message group always takes part in a match.
	 */
	let report: { readonly start: number; readonly message: string } | undefined
	for (const [index, line] of lines.entries()) {
		const match = severityLine.exec(line)
		if (match === null) {
			continue
		}
		report = { start: index, message: match[2] }
	}
	if (report === undefined) {
		return undefined
	}
	const found: Partial<Record<(typeof fieldKeys)[string], string>> = {}
	for (const line of lines.slice(report.start + 1)) {
		const field = fieldOf(line)
		if (field === undefined) {
			continue
		}
		const [name, value] = field
		const key = fieldKeys[name]
		if (key !== undefined && found[key] === undefined) {
			found[key] = value
		}
	}
	return {
		code: sqlstate,
		message: report.message,
		detail: Option.fromUndefinedOr(found.detail),
		hint: Option.fromUndefinedOr(found.hint),
		where: Option.fromUndefinedOr(found.where),
		schema: Option.fromUndefinedOr(found.schema),
		table: Option.fromUndefinedOr(found.table),
		column: Option.fromUndefinedOr(found.column),
		dataType: Option.fromUndefinedOr(found.dataType),
		constraint: reportedConstraintOf(found.constraint)
	}
}

/**
 * Statement `id`'s stdout marker in `text`, once its whole line has arrived: what psql printed before it, and the text
 * after its line.
 */
const stdoutMarker = (
	id: number,
	text: string
): Option.Option<{ readonly printed: Printed; readonly rest: string }> => {
	const marker = `${markerLead}${id} `
	return Option.flatMap(Str.indexOf(marker)(text), (at) =>
		Option.map(Str.indexOf("\n")(Str.slice(at)(text)), (offset) => {
			const end = at + offset
			const [sqlstate, rowCount = "0"] = Str.split(Str.slice(at + marker.length, end)(text), " ")
			return {
				printed: { sqlstate, rowCount: Number(rowCount), output: Str.slice(0, at)(text) },
				rest: Str.slice(end + 1)(text)
			}
		})
	)
}

/** Statement `id`'s stderr marker in `text`: the stderr before it, and the text after it. */
const stderrMarker = (
	id: number,
	text: string
): Option.Option<{ readonly stderr: string; readonly rest: string }> => {
	const marker = `${markerLead}${id}\n`
	return Option.map(Str.indexOf(marker)(text), (at) => ({
		stderr: Str.slice(0, at)(text),
		rest: Str.slice(at + marker.length)(text)
	}))
}

/**
 * The script psql reads for statement `id`: the statement, then a marker on stdout carrying psql's :SQLSTATE and
 * :ROW_COUNT, and a matching marker on stderr.
 */
const scriptOf = (id: number, sql: string, answer: Answer): string => {
	const statement =
		answer === "tag"
			? `\\set QUIET off\n${terminate(sql)}\n;\n\\set QUIET on\n`
			: `${terminate(sql)}\n;\n`
	return `${statement}\\echo ${markerLead}${id} :SQLSTATE :ROW_COUNT\n\\warn ${markerLead}${id}\n`
}

/** Whether the line runs a statement or has one queued: what the scope's close must kill rather than end. */
const busy = (line: Line, queued: ReadonlyArray<Statement>): boolean =>
	inPsql(line).length > 0 || queued.length > 0

/**
 * psql's driver: the one owner of the writer's state, which nothing else reads or writes. Readers and callers only tell
 * it events, which it takes one at a time: each step changes the state, writes psql's stdin (`input`) and completes
 * outcomes and replies, and never waits. So a fiber an outcome resumes at once can only tell the driver another event,
 * which waits for the next step.
 */
const driver = (input: Queue.Enqueue<string, Cause.Done>): ((event: Event) => void) => {
	let life: Life = { _tag: "Live", line: idle, queued: [] }
	/** What psql has written that no marker has consumed yet, and all of its stderr, for a process error's report. */
	let stdout = ""
	let stderr = ""
	let allStderr = ""
	let nextId = 0

	/** Writes the first queued statement to psql's stdin when psql is running none. */
	const pump = (): void => {
		const current = life
		if (current._tag === "Dead" || current.line._tag !== "Idle") {
			return
		}
		const [next, ...rest] = current.queued
		if (next === undefined) {
			return
		}
		life = {
			_tag: "Live",
			line: { _tag: "Running", flight: { statement: next, awaiting: awaitingBoth } },
			queued: rest
		}
		Queue.offerUnsafe(input, next.script)
	}

	const takeStdout = (id: number): Option.Option<Printed> => {
		const found = stdoutMarker(id, stdout)
		if (Option.isNone(found)) {
			return Option.none()
		}
		stdout = found.value.rest
		return Option.some(found.value.printed)
	}

	const takeStderr = (id: number): Option.Option<string> => {
		const found = stderrMarker(id, stderr)
		if (Option.isNone(found)) {
			return Option.none()
		}
		stderr = found.value.rest
		return Option.some(found.value.stderr)
	}

	/** Reads the running statement's markers from what psql has written, and completes it once both are read. */
	const readMarkers = (): void => {
		const current = life
		if (current._tag === "Dead") {
			return
		}
		const line = current.line
		if (line._tag === "Idle" || line._tag === "Draining") {
			return
		}
		const { statement, awaiting } = line.flight
		const printed =
			awaiting._tag === "Stderr" ? Option.some(awaiting.printed) : takeStdout(statement.id)
		const report =
			awaiting._tag === "Stdout" ? Option.some(awaiting.stderr) : takeStderr(statement.id)
		if (Option.isSome(printed) && Option.isSome(report)) {
			life = { ...current, line: line._tag === "Running" ? idle : draining }
			pump()
			Deferred.doneUnsafe(
				statement.outcome,
				Exit.succeed({ ...printed.value, stderr: report.value })
			)
			return
		}
		if (Option.isSome(printed)) {
			life = {
				...current,
				line: {
					...line,
					flight: { statement, awaiting: { _tag: "Stderr", printed: printed.value } }
				}
			}
			return
		}
		if (Option.isSome(report)) {
			life = {
				...current,
				line: { ...line, flight: { statement, awaiting: { _tag: "Stdout", stderr: report.value } } }
			}
		}
	}

	/** psql has ended: every statement it was given or had queued fails, as every later one will. */
	const end = (reason: string): void => {
		const current = life
		if (current._tag === "Dead") {
			return
		}
		const error = new PsqlProcessError({ reason, stderr: allStderr })
		life = { _tag: "Dead", error }
		for (const statement of [...inPsql(current.line), ...current.queued]) {
			Deferred.doneUnsafe(statement.outcome, Exit.fail(error))
		}
	}

	/** Queues a statement, or fails it at once when psql has ended. */
	const send = (sql: string, answer: Answer, outcome: Outcome): void => {
		const current = life
		if (current._tag === "Dead") {
			Deferred.doneUnsafe(outcome, Exit.fail(current.error))
			return
		}
		const id = nextId
		nextId += 1
		life = {
			...current,
			queued: [...current.queued, { id, script: scriptOf(id, sql, answer), outcome }]
		}
		pump()
	}

	/**
	 * An interrupted statement: one still queued is dropped unsent; the one psql is running is being canceled, and stays
	 * the running one, so its markers are still consumed in order, until it has ended.
	 */
	const abandon = (outcome: Outcome): Abandoned => {
		const current = life
		if (current._tag === "Dead" || Deferred.isDoneUnsafe(outcome)) {
			return "dropped"
		}
		const line = current.line
		if (line._tag === "Running" && line.flight.statement.outcome === outcome) {
			life = { ...current, line: { _tag: "Canceling", flight: line.flight } }
			return "running"
		}
		life = {
			...current,
			queued: Arr.filter(current.queued, (statement) => statement.outcome !== outcome)
		}
		return "dropped"
	}

	/** The cancel has wound down: psql takes the next statement. */
	const canceled = (): void => {
		const current = life
		if (current._tag === "Live" && current.line._tag === "Draining") {
			life = { ...current, line: idle }
			pump()
		}
	}

	/**
	 * How psql ends as the scope closes. An idle psql gets end-of-file on its stdin here. A busy one is killed, and every
	 * statement it was given or had queued fails here, as psql's exit would fail it: the driver stops with the scope,
	 * perhaps before it is told of that exit, and a statement whose outcome it never completed would keep its fiber
	 * waiting forever.
	 */
	const close = (): Stop => {
		const current = life
		if (current._tag === "Dead") {
			return "gone"
		}
		if (busy(current.line, current.queued)) {
			end("psql was killed: its writer was released with a statement running or queued")
			return "kill"
		}
		Queue.endUnsafe(input)
		return "eof"
	}

	return (event) => {
		switch (event._tag) {
			case "Stdout":
				stdout += event.text
				readMarkers()
				return
			case "Stderr":
				stderr += event.text
				allStderr += event.text
				readMarkers()
				return
			case "Ended":
				end(event.reason)
				return
			case "Send":
				send(event.sql, event.answer, event.outcome)
				return
			case "Abandon":
				Deferred.doneUnsafe(event.reply, Exit.succeed(abandon(event.outcome)))
				return
			case "Canceled":
				canceled()
				return
			case "Close":
				Deferred.doneUnsafe(event.reply, Exit.succeed(close()))
				return
		}
	}
}

/**
 * A failed statement is a PsqlStatementError only when psql printed PostgreSQL's report of it. A failure psql reports
 * without one is psql's own, not the server's refusal of the statement, so it is a PsqlProcessError that names the
 * statement and its SQLSTATE, and its stderr is psql's whole report. None for a statement that succeeded.
 */
const refusalOf = (
	label: string,
	sql: string,
	completed: Completed
): PsqlStatementError | PsqlProcessError | undefined => {
	if (completed.sqlstate === "00000") {
		return undefined
	}
	const fields = parseVerboseError(completed.sqlstate, completed.stderr)
	return fields === undefined
		? new PsqlProcessError({
				reason: `psql writer ${label}: a statement failed with SQLSTATE ${Formatter.format(completed.sqlstate)} and no PostgreSQL error report: ${sql}`,
				stderr: completed.stderr
			})
		: new PsqlStatementError({ sql, fields })
}

const backendPidQuery = "SELECT pg_catalog.pg_backend_pid()"

/**
 * psql child processes as direct SQL writers.
 *
 * Laws hold for any non-owner writer, grizzle or psql: a psql session logs in as a login, takes on one of its world
 * roles (SET ROLE) and writes at SERIALIZABLE; below it, every grizzle table refuses the write. The schedules project
 * runs psql child processes as direct SQL writers.
 * A writer is the real psql binary of the pinned build, connecting over TCP with sslmode=verify-full against the
 * local CA and a SCRAM password, as every non-bootstrap connection must (Rules and The cluster).
 *
 * Protocol: psql reads a script from a pipe with ON_ERROR_STOP off, so a failed statement leaves the session usable, as
 * it does for a person at a terminal. After each statement the writer emits a marker on stdout carrying psql's :SQLSTATE
 * and :ROW_COUNT variables, and a matching marker on stderr; the text before the markers is the statement's rows
 * (unaligned, tuples only) and its verbose error report. COMMIT alone runs with QUIET off, so psql prints its command
 * tag before the marker: an aborted transaction answers COMMIT with the tag ROLLBACK and SQLSTATE 00000.
 *
 * Starts a psql writer as `credentials.role`, spawned through Effect's ChildProcess as a resource of the scope. When the
 * scope closes, on success, failure or interruption, psql is ended (end-of-file when idle, a kill when busy, failing
 * every statement still waiting) and reaped.
 *
 * @internal
 */
export const openPsql = Effect.fnUntraced(function* (
	options: PsqlOptions
): Effect.fn.Return<
	PsqlWriter,
	PsqlProcessError,
	Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
	const label = options.label
	/**
	 * psql's stdin: each statement's script in order, and its end is end-of-file. A write psql can no longer read fails
	 * only the spawner's stdin fiber; psql's exit then ends every statement.
	 */
	const input = yield* Queue.unbounded<string, Cause.Done>()
	const handle = yield* ChildProcess.make(`${pgPin.prefix}/bin/psql`, psqlArguments(options), {
		env: childEnvironment(options.credentials),
		stdin: Stream.encodeText(Stream.fromQueue(input))
	}).pipe(
		Effect.mapError(
			(cause) =>
				new PsqlProcessError({ reason: `psql could not start: ${messageOf(cause)}`, stderr: "" })
		)
	)

	const events = yield* Queue.unbounded<Event>()
	const tell = (event: Event): Effect.Effect<void> => Effect.asVoid(Queue.offer(events, event))
	/** Tells the driver an event that carries a reply, and waits for the reply. */
	const ask = <A>(event: (reply: Deferred.Deferred<A>) => Event): Effect.Effect<A> =>
		Effect.flatMap(Deferred.make<A>(), (reply) =>
			Effect.andThen(tell(event(reply)), Deferred.await(reply))
		)
	const step = driver(input)
	yield* Stream.fromQueue(events).pipe(
		Stream.runForEach((event) => Effect.sync(() => step(event))),
		Effect.forkScoped
	)

	/**
	 * Both of psql's outputs read to their end, each chunk decoded as UTF-8 across chunk boundaries and told to the
	 * driver as it arrives.
	 */
	const drained = Effect.all(
		[
			handle.stdout.pipe(
				Stream.decodeText,
				Stream.runForEach((text) => tell({ _tag: "Stdout", text }))
			),
			handle.stderr.pipe(
				Stream.decodeText,
				Stream.runForEach((text) => tell({ _tag: "Stderr", text }))
			)
		],
		{ concurrency: "unbounded", discard: true }
	)
	/**
	 * Why psql ended, once all of its output is read, so the driver reads a report psql wrote just before exiting first:
	 * its exit, or the failure that stopped the reading.
	 */
	const ending: Effect.Effect<string> = Effect.matchEffect(drained, {
		onFailure: (cause) => Effect.succeed(`psql's output could not be read: ${messageOf(cause)}`),
		onSuccess: () =>
			Effect.match(handle.exitCode, {
				onFailure: (cause) => `psql exited (${messageOf(cause)})`,
				onSuccess: (code) => `psql exited (code ${code})`
			})
	})
	const monitor = yield* ending.pipe(
		Effect.flatMap((reason) => tell({ _tag: "Ended", reason })),
		Effect.forkScoped
	)

	/** Kills psql `how` while it runs; a kill that fails found psql already gone. */
	const kill = (how: ChildProcess.KillOptions): Effect.Effect<void> =>
		handle.isRunning.pipe(
			Effect.flatMap((alive) => (alive ? handle.kill(how) : Effect.void)),
			Effect.ignore
		)

	const stop = (how: Stop): Effect.Effect<void> => {
		switch (how) {
			case "gone":
				return Effect.void
			case "kill":
				return kill(killNow)
			case "eof":
				return Effect.gen(function* () {
					const exited = yield* within(deadlines.exit, Effect.exit(handle.exitCode))
					if (Option.isNone(exited)) {
						yield* kill(killNow)
					}
				})
		}
	}
	yield* Effect.addFinalizer(() =>
		ask<Stop>((reply) => ({ _tag: "Close", reply })).pipe(
			Effect.flatMap(stop),
			Effect.andThen(Fiber.join(monitor))
		)
	)

	/**
	 * Cancels backend `pid`'s query until the statement has ended. A cancel that arrives before psql has sent the
	 * statement, while the backend is still reading a command, is ignored by PostgreSQL, hence the repeats. Each cancel
	 * runs to its end, so once this stops, at the statement's end or at the deadline, no cancel is in flight.
	 */
	const recancel = (outcome: Outcome, pid: number): Effect.Effect<void> =>
		Effect.gen(function* () {
			for (;;) {
				if (yield* Deferred.isDone(outcome)) {
					return
				}
				yield* Effect.uninterruptible(options.cancelBackend(pid))
				yield* Effect.yieldNow
			}
		})

	/**
	 * Ends an interrupted statement psql is running, and returns only once it has really completed or psql has ended. A
	 * backend that ignores its cancels past the deadline ends psql instead, as does interrupting the startup query, which
	 * has no backend pid to cancel by yet.
	 */
	const cancel = (outcome: Outcome, canceler: Canceler): Effect.Effect<void> => {
		const ended = Effect.ignore(Deferred.await(outcome))
		switch (canceler._tag) {
			case "Signal":
				return Effect.andThen(kill(interruptThenKill), ended)
			case "Backend":
				return Effect.gen(function* () {
					const canceled = yield* within(deadlines.cancel, recancel(outcome, canceler.pid))
					if (Option.isNone(canceled)) {
						yield* kill(killNow)
					}
					yield* ended
				})
		}
	}

	/**
	 * Gives up on an interrupted statement: one already answered needs nothing, and is never asked of the driver, which
	 * stops with the writer's scope, whose release answers every statement it leaves; the driver drops one still queued;
	 * when psql is running it, it is canceled, and the next statement waits until the cancel has wound down.
	 */
	const abandon = (outcome: Outcome, canceler: Canceler): Effect.Effect<void> =>
		Effect.flatMap(Deferred.isDone(outcome), (answered) =>
			answered
				? Effect.void
				: Effect.flatMap(
						ask<Abandoned>((reply) => ({ _tag: "Abandon", outcome, reply })),
						(abandoned) =>
							abandoned === "running"
								? Effect.ensuring(cancel(outcome, canceler), tell({ _tag: "Canceled" }))
								: Effect.void
					)
		)

	/** Queues one statement and waits for its outcome; `canceler` cancels it if its fiber is interrupted. */
	const send = (
		sql: string,
		answer: Answer,
		canceler: Canceler
	): Effect.Effect<Completed, PsqlProcessError> =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const outcome = yield* Deferred.make<Completed, PsqlProcessError>()
				yield* tell({ _tag: "Send", sql, answer, outcome })
				return yield* restore(Deferred.await(outcome)).pipe(
					Effect.onInterrupt(() => abandon(outcome, canceler))
				)
			})
		)

	const complete = (
		sql: string,
		answer: Answer,
		canceler: Canceler
	): Effect.Effect<Completed, PsqlStatementError | PsqlProcessError> =>
		Effect.flatMap(send(sql, answer, canceler), (completed) => {
			const refusal = refusalOf(label, sql, completed)
			return refusal === undefined ? Effect.succeed(completed) : Effect.fail(refusal)
		})
	const execute = (
		sql: string,
		canceler: Canceler
	): Effect.Effect<PsqlResult, PsqlStatementError | PsqlProcessError> =>
		Effect.map(complete(sql, "rows", canceler), (completed) => ({
			rows: parseRows(completed.output),
			rowCount: completed.rowCount,
			notices: parseNotices(completed.stderr)
		}))

	/**
	 * The startup read, before the backend pid is known. It also surfaces a refused connection or login as a process
	 * error, and so a server's report on the query itself.
	 */
	const started = yield* send(backendPidQuery, "rows", { _tag: "Signal" })
	const refused = refusalOf(label, backendPidQuery, started)
	if (refused !== undefined) {
		return yield* refused._tag === "PsqlStatementError"
			? new PsqlProcessError({ reason: refused.fields.message, stderr: started.stderr })
			: refused
	}
	const backendPid = Number(parseRows(started.output)[0]?.[0])
	const backend: Canceler = { _tag: "Backend", pid: backendPid }
	const log = yield* Ref.make<ReadonlyArray<string>>([])

	const record = (sql: string) => Ref.update(log, (entries) => [...entries, sql])

	/** A meta-command line would break the marker protocol: it is a defect in the test, not a statement outcome. */
	const run = (sql: string) =>
		Arr.some(Str.split(sql, "\n"), (line) => pipe(Str.trimStart(line), Str.startsWith("\\")))
			? Effect.die(new Error(`psql writers run SQL statements, not meta-commands: ${sql}`))
			: Effect.andThen(record(sql), execute(sql, backend))

	const commit = Effect.gen(function* () {
		yield* record("COMMIT")
		const completed = yield* complete("COMMIT", "tag", backend)
		const command = Str.trim(completed.output)
		if (command !== "COMMIT") {
			return yield* new TransactionRolledBack({ label, command })
		}
	})

	return {
		label,
		role: options.credentials.role,
		database: options.database,
		pid: Effect.succeed(backendPid),
		run,
		begin: Effect.asVoid(run(beginSerializable)),
		beginBelow: (level) => Effect.asVoid(run(beginBelowStatement(level))),
		commit,
		rollback: Effect.asVoid(run("ROLLBACK")),
		statements: Effect.map(Ref.get(log), (entries) => entries.length),
		log: Ref.get(log),
		resetStatements: Ref.set(log, [])
	}
})
