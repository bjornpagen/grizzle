import {
	Array as Arr,
	Cause,
	DateTime,
	Effect,
	Exit,
	type FileSystem,
	Option,
	Path,
	Result,
	Schema,
	String as Str
} from "effect"
import type { SchemaApplyReport } from "#adapter/migrate/apply.ts"
import {
	MigrateError,
	type MigrationPlace,
	type Outcome,
	stageOutcome
} from "#adapter/migrate/errors.ts"
import { parseArgs, usageText } from "#cli/args.ts"
import { check, findingText, type SchemaCheck } from "#cli/check.ts"
import { type ConfigFile, resolveConfig } from "#cli/config.ts"
import type { CliError } from "#cli/errors.ts"
import { generate, type SchemaGenerateReport } from "#cli/generate.ts"
import { drift, migrate } from "#cli/migrate.ts"
import { names } from "#cli/names.ts"
import { cliStageFix, migrateStageFix, refusalText } from "#cli/refusals.ts"
import { installSkill } from "#cli/skill.ts"

/**
 * The exit statuses a command line's report carries: 0 when the command succeeded, 1 when it was refused or failed, 2
 * for a usage error. An interrupt (SIGINT) produces no report: the runtime exits 130.
 */
const exitCodes = { ok: 0, failed: 1, usage: 2 } as const

/** What one command line came to, as the bin writes it: its exit status, and its lines for stdout and stderr. */
export interface CliReport {
	readonly code: (typeof exitCodes)[keyof typeof exitCodes]
	readonly stdout: ReadonlyArray<string>
	readonly stderr: ReadonlyArray<string>
}

/** The line `grizzle generate` prints when no schema changed. */
const noChanges = "no changes"

const short = (fingerprint: string): string => Str.slice(0, 16)(fingerprint)

/**
 * Each written file, relative to `cwd`; then each marker to resolve and each loss to decide, with what to do; then the
 * next step.
 */
const renderGenerate = (
	reports: ReadonlyArray<SchemaGenerateReport>,
	relative: (path: string) => string
): ReadonlyArray<string> => {
	const written = Arr.flatMap(reports, (r) => (r.kind === "unchanged" ? [] : [r]))
	if (written.length === 0) {
		return [noChanges]
	}
	const folderOf = (r: (typeof written)[number]) => relative(r.path)
	const files = Arr.flatMap(written, (r) => [
		...Arr.map([...r.files, "meta.json"], (f) => `${folderOf(r)}/${f}`),
		...(r.kind === "drafted" ? [relative(r.snapshotPath)] : [])
	])
	const markers = Arr.flatMap(written, (r) =>
		Arr.map(r.markers, (m) =>
			m.kind === "placeholder"
				? `${folderOf(r)}/${m.file}:${m.line}: placeholder: ${refusalText.placeholder.fix}`
				: `${folderOf(r)}/${m.file}:${m.line}: rename candidate: ${refusalText.renameCandidate.fix}`
		)
	)
	const losses = Arr.flatMap(written, (r) =>
		Arr.map(
			r.losses,
			(l) => `${folderOf(r)}/${l.file}: data loss: ${l.loses}: ${refusalText.unresolvedLoss.fix}`
		)
	)
	const custom = Arr.some(written, (r) => r.kind === "custom")
	return [
		...files,
		...markers,
		...losses,
		markers.length + losses.length > 0
			? "next: resolve the markers, then run grizzle check"
			: custom
				? "next: write the SQL files, then run grizzle check"
				: "next: review the SQL, then run grizzle check"
	]
}

const renderApply = (reports: ReadonlyArray<SchemaApplyReport>): ReadonlyArray<string> =>
	Arr.flatMap(reports, (r) => [
		r.applied.length === 0
			? `${r.schemaName}: up to date at ${short(r.after)}`
			: `${r.schemaName}: applied ${r.applied.length} migration${r.applied.length === 1 ? "" : "s"}, now at ${short(r.after)}`,
		...Arr.map(
			r.applied,
			(a) =>
				`  ${a.folder}${a.resumed ? " (resumed)" : ""}: ${a.files.length === 0 ? "recorded" : Arr.join(a.files, ", ")}`
		)
	])

const renderCliError = (e: CliError): ReadonlyArray<string> => [
	`grizzle: ${e.message}`,
	`fix: ${cliStageFix[e.stage]}`
]

/** Every finding, one per line with its fix; a clean schema says so. */
const renderCheck = (checks: ReadonlyArray<SchemaCheck>): ReadonlyArray<string> =>
	Arr.flatMap(checks, (c) =>
		c.findings.length > 0
			? Arr.map(c.findings, findingText)
			: [
					`${c.schema}: ok (${c.folders} migration${c.folders === 1 ? "" : "s"}${Option.isNone(c.snapshot) ? "" : `, snapshot ${short(c.snapshot.value.fingerprint)}`})`
				]
	)

const findingsOf = (checks: ReadonlyArray<SchemaCheck>): number =>
	Arr.reduce(checks, 0, (n, c) => n + c.findings.length)

/** The folder, file and statement a place names, outermost first. */
const placeParts = (place: MigrationPlace): ReadonlyArray<string> => {
	switch (place.kind) {
		case "directory":
			return []
		case "folder":
			return [place.folder]
		case "file":
			return [place.folder, place.file]
		case "statement":
			return [place.folder, place.file, `statement ${place.statement}`]
	}
}

/** A migrate or a drift the database refused, with the command that ran, which its report names. */
class CommandRefused extends Schema.TaggedError<
	CommandRefused,
	{ readonly brand: unique symbol }
>()("CommandRefused", {
	command: Schema.Literals(["migrate", "drift"]),
	error: MigrateError
}) {}

/** A command's failure: a CLI refusal as it is, a migrate or drift refusal with its command. */
const refusedBy =
	(command: "migrate" | "drift") =>
	(e: CliError | MigrateError): CliError | CommandRefused =>
		e._tag === "CliError" ? e : CommandRefused.make({ command, error: e })

/**
 * The lines a refusal lists under its first, each a fact of its own: each unresolved marker and data loss, and each
 * fact the drift check found missing or unexpected.
 */
const reasonLines = (e: MigrateError): ReadonlyArray<string> => {
	const reason = e.reason
	switch (reason._tag) {
		case "MarkersUnresolved":
			return Arr.map(
				reason.markers,
				(m) =>
					`  ${m.folder}/${m.file}:${m.line}: unresolved ${m.kind === "placeholder" ? "placeholder" : "candidate rename"}`
			)
		case "LossesUndecided":
			return Arr.map(
				reason.losses,
				(l) => `  ${l.folder}/${l.file}: unresolved data loss: ${l.loses}`
			)
		case "Drifted":
			return Arr.map(reason.mismatches, (m) => `  ${m.kind} ${m.fact}`)
		case "ConnectRefused":
		case "SurveyFailed":
		case "RoleUnread":
		case "OwnerUnread":
		case "OwnedByAnother":
		case "InputRefused":
		case "LockUnread":
		case "ApplyBusy":
		case "LedgerUncompiled":
		case "LedgerUnread":
		case "LedgerDamaged":
		case "AppliedEdited":
		case "FolderRefused":
		case "SnapshotUnreached":
		case "StatementFailed":
		case "TransactionFailed":
		case "LedgerUnlocked":
		case "RecordFailed":
		case "FileCommitRefused":
		case "FileCommitLost":
		case "DriftUnchecked":
			return []
	}
}

/** What the database holds after a refused migrate or drift, as its report's outcome line says it. */
const outcomeLine = (command: "migrate" | "drift", outcome: Outcome): string => {
	switch (outcome) {
		case "nothingRan":
			return "No statement of any folder ran; the ledger and the catalog are unchanged."
		case "resumes":
			return "The files before it stay applied and recorded; a rerun resumes at the failed file."
		case "drifted":
			return command === "drift"
				? "Nothing was applied; the catalog differs from the snapshot."
				: "Every folder applied, but the catalog differs from the snapshot."
		case "noVerdict":
			return command === "drift"
				? "Nothing was applied; the drift check reached no verdict."
				: "Every folder applied; the drift check reached no verdict."
	}
}

/**
 * The report of a refused migrate or drift: one line naming the stage, where it stopped (the schema, folder, file and statement,
 * and the server's SQLSTATE and constraint) and the reason's message, which carries the server's message; then each
 * unresolved marker and data loss, each fact the drift check found missing or unexpected, and the server's DETAIL and
 * HINT, each a line of its own, the last two as psql prints them; then what the database holds, and the fix.
 */
const renderMigrateError = (
	command: "migrate" | "drift",
	e: MigrateError
): ReadonlyArray<string> => {
	const server = e.server.by === "server" ? [e.server.error] : []
	const schema = e.schema
	const where = [
		...(schema === undefined ? [] : [`schema ${schema}`]),
		...placeParts(e.place),
		...Arr.flatMap(server, (s) => [
			`SQLSTATE ${s.sqlstate}`,
			...(s.constraint === undefined ? [] : [`constraint ${s.constraint}`])
		])
	]
	const said = Arr.flatMap(server, (s) => [
		...(s.detail === undefined ? [] : [`  DETAIL: ${s.detail}`]),
		...(s.hint === undefined ? [] : [`  HINT: ${s.hint}`])
	])
	return [
		`grizzle ${command}: refused at stage ${e.stage}${where.length === 0 ? "" : ` (${Arr.join(where, ", ")})`}: ${e.reason.message}`,
		...reasonLines(e),
		...said,
		outcomeLine(command, stageOutcome[e.stage]),
		`fix: ${migrateStageFix[e.stage]}`
	]
}

/**
 * A command that ran to its end: its exit status, 0 when it succeeded and 1 when it reported findings, and its report.
 */
interface Ran {
	readonly kind: "ran"
	readonly code: typeof exitCodes.ok | typeof exitCodes.failed
	readonly out: ReadonlyArray<string>
	readonly err: ReadonlyArray<string>
}

const ran = (code: Ran["code"], out: ReadonlyArray<string>, err: ReadonlyArray<string>): Ran => ({
	kind: "ran",
	code,
	out,
	err
})

const program = Effect.fn("program")(function* (
	argv: ReadonlyArray<string>,
	cwd: string,
	configFile: Effect.Effect<ConfigFile, CliError, FileSystem.FileSystem | Path.Path>
): Effect.fn.Return<Ran, CliError | CommandRefused, FileSystem.FileSystem | Path.Path> {
	const parsed = parseArgs(argv)
	if (Result.isFailure(parsed)) {
		return yield* parsed.failure
	}
	const command = parsed.success
	if (command.kind === "help") {
		return ran(exitCodes.ok, [Str.trimEnd(usageText)], [])
	}
	if (command.kind === "skill") {
		return ran(exitCodes.ok, yield* installSkill(cwd), [])
	}
	const { value, file } = yield* configFile
	const config = yield* resolveConfig(value, file)
	if (command.kind === "names") {
		return ran(exitCodes.ok, yield* names(config), [])
	}
	if (command.kind === "check") {
		const checks = yield* check(config, cwd)
		const clean = Arr.filter(checks, (c) => c.findings.length === 0)
		const dirty = Arr.filter(checks, (c) => c.findings.length > 0)
		return ran(
			dirty.length === 0 ? exitCodes.ok : exitCodes.failed,
			renderCheck(clean),
			renderCheck(dirty)
		)
	}
	if (command.kind === "migrate") {
		/** Every check grizzle check runs comes first, before connecting. */
		const checks = yield* check(config, cwd)
		if (findingsOf(checks) > 0) {
			return ran(
				exitCodes.failed,
				[],
				[
					...Arr.flatMap(checks, (c) => Arr.map(c.findings, findingText)),
					"grizzle migrate: refused before connecting; nothing ran."
				]
			)
		}
		const applied = yield* Effect.mapError(migrate(config, cwd), refusedBy("migrate"))
		return ran(exitCodes.ok, renderApply(applied), [])
	}
	if (command.kind === "drift") {
		const matched = yield* Effect.mapError(drift(config, cwd), refusedBy("drift"))
		return ran(
			exitCodes.ok,
			Arr.map(matched, (m) => `grizzle drift: ${m.schema} matches snapshot ${m.fingerprint}`),
			[]
		)
	}
	const now = yield* DateTime.now
	const reports = yield* generate(config, { mode: command.mode, schema: command.schema, now })
	const path = yield* Path.Path
	return ran(
		exitCodes.ok,
		renderGenerate(reports, (p) => path.relative(cwd, p)),
		[]
	)
})

/** The report of a command line the runtime refused: a usage error, any other CLI refusal, or a migrate or drift. */
const refusedReport = (e: CliError | CommandRefused): CliReport => {
	if (e._tag === "CliError") {
		return {
			code: e.stage === "usage" ? exitCodes.usage : exitCodes.failed,
			stdout: [],
			stderr: renderCliError(e)
		}
	}
	return { code: exitCodes.failed, stdout: [], stderr: renderMigrateError(e.command, e.error) }
}

/**
 * The `grizzle` command line as an Effect: argv, the directory it runs in, and the import of its grizzle.config.ts,
 * which only a command that reads the configuration runs, in; its report out, which main.ts writes for the bin and a
 * test reads. The command ran, with its report; it was refused,
 * with its error and the stage that refused it, rendered; or it died, reported as an internal error. An interruption
 * stays the fiber's interruption, so an interrupted migrate closes its connection, which rolls an open file transaction
 * back, and the ledger tells where a rerun resumes (packages/grizzle/src/adapter/migrate/apply.ts).
 *
 * Output is stable plain text. The clock a new folder's timestamp reads is Effect's Clock; the environment migrate
 * reads DATABASE_URL, PGPASSWORD and PGSSLROOTCERT from is the ConfigProvider's.
 *
 * @internal
 */
export const runCli = Effect.fn("runCli")(function* (
	argv: ReadonlyArray<string>,
	cwd: string,
	configFile: Effect.Effect<ConfigFile, CliError, FileSystem.FileSystem | Path.Path>
): Effect.fn.Return<CliReport, never, FileSystem.FileSystem | Path.Path> {
	const exit = yield* Effect.exit(program(argv, cwd, configFile))
	if (Exit.isSuccess(exit)) {
		const done: CliReport = {
			code: exit.value.code,
			stdout: exit.value.out,
			stderr: exit.value.err
		}
		return done
	}
	const failure = Cause.findError(exit.cause)
	if (Result.isSuccess(failure)) {
		return refusedReport(failure.success)
	}
	if (Cause.hasInterruptsOnly(exit.cause)) {
		return yield* Effect.interrupt
	}
	const died: CliReport = {
		code: exitCodes.failed,
		stdout: [],
		stderr: ["grizzle: internal error", Cause.pretty(exit.cause)]
	}
	return died
})
