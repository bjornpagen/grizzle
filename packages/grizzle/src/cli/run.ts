import {
	Array as Arr,
	Cause,
	Data,
	Effect,
	Exit,
	type FileSystem,
	Option,
	Path,
	Result
} from "effect"
import { mismatchLine } from "#adapter/admission/drift.ts"
import type { SchemaApplyReport } from "#adapter/migrate/apply.ts"
import {
	type MigrateError,
	type MigrateOutcome,
	type MigrationPlace,
	stageOutcome
} from "#adapter/migrate/errors.ts"
import type { UninstallReport } from "#adapter/migrate/uninstall.ts"
import { type CommandLine, parseArgs } from "#cli/args.ts"
import { check, checkFiles, findingText, type SchemaCheck } from "#cli/check.ts"
import { type ConfigFile, readsNothingGenerated, resolveConfig } from "#cli/config.ts"
import { migrationConnection } from "#cli/connection.ts"
import { draftKey, grizzleCheckout } from "#cli/draft-inputs.ts"
import type { CliError } from "#cli/errors.ts"
import { generateMigrations, type SchemaGenerateReport } from "#cli/generate.ts"
import { drift, migrate, roles, uninstallAll } from "#cli/migrate.ts"
import { names } from "#cli/names.ts"
import { type PhaseMeter, phasedEffect, phaseRun } from "#cli/phases.ts"
import { cliStageFix, isolationFix, migrateStageFix, refusalText } from "#cli/refusals.ts"
import { helpText } from "#cli/usage.ts"
import type { Phases } from "#compiler/plan/common.ts"
import {
	type IsolationCondition,
	type IsolationReason,
	metaFileName,
	type ReasonAt,
	reasonsOf,
	type Serializable
} from "#compiler/plan/migration.ts"

/**
 * The exit statuses a command line's report carries: 0 when the command succeeded, 1 when it was refused or failed, 2
 * for a usage error. An interrupt (SIGINT) produces no report: the runtime exits 130.
 */
const exitCodes = { ok: 0, failed: 1, usage: 2 } as const

/** A report's lines for stdout and stderr, as the bin writes them. */
interface ReportLines {
	readonly stdout: ReadonlyArray<string>
	readonly stderr: ReadonlyArray<string>
}

/** The command ran to its end: status 0 when it succeeded, 1 when it reported findings. */
interface RanReport extends ReportLines {
	readonly outcome: "ran"
	readonly code: typeof exitCodes.ok | typeof exitCodes.failed
}

/** The command was refused, by `refusal`: status 2 for a usage error, 1 for any other refusal. */
interface RefusedReport extends ReportLines {
	readonly outcome: "refused"
	readonly code: typeof exitCodes.failed | typeof exitCodes.usage
	readonly refusal: CliError | CommandRefused
}

/** The command died, reported as an internal error: status 1. */
interface DiedReport extends ReportLines {
	readonly outcome: "died"
	readonly code: typeof exitCodes.failed
}

/** What one command line came to, as the bin writes it, by how it ended: its exit status and its lines. */
export type CliReport = RanReport | RefusedReport | DiedReport

/** The line `grizzle generate` prints when no schema changed. */
const noChanges = "no changes"

/**
 * A marker a drafted folder leaves to resolve, as generate prints it: its file and line, its kind, and that kind's fix,
 * so a confirm is never told to fill a placeholder.
 */
export const markerLine = (
	folder: string,
	marker: SchemaGenerateReport["markers"][number]
): string =>
	`${folder}/${marker.file}:${marker.line}: ${marker.kind}: ${refusalText[marker.kind].fix}`

/** The next step after a generate that wrote no folder: commit what it wrote, snapshot.json, the served files or both. */
const commitStep = (rederived: boolean, served: boolean): string =>
	`next: commit ${rederived && served ? "snapshot.json, manifest.json and the served files" : rederived ? "snapshot.json and manifest.json" : "the served files"}, then run grizzle check`

/** The count of each condition among `reasons`, each in the order it first stands there: "laws 3, absence 1". */
const countsText = (reasons: ReadonlyArray<IsolationReason>): string => {
	const counts = new Map<IsolationCondition, number>()
	for (const reason of reasons) {
		counts.set(reason.condition, (counts.get(reason.condition) ?? 0) + 1)
	}
	return Arr.join(
		Arr.map([...counts], ([condition, count]) => `${condition} ${count}`),
		", "
	)
}

/** Where a reason places its failure, as generate prints it: the role, a relation, a member's write or a statement. */
const placeText = (at: ReasonAt): string => {
	switch (at.kind) {
		case "role":
			return "the role"
		case "relation":
			return `relation ${at.relation}`
		case "member":
			return `member ${at.member}, relation ${at.relation}`
		case "statement":
			return `member ${at.member}, statement ${at.statement}, relation ${at.relation}`
	}
}

/**
 * The lines under a SERIALIZABLE role, why it runs SERIALIZABLE: each reason of its own, its condition, where, its
 * detail and the condition's fix (isolationFix); or, for the reasons roles that run SERIALIZABLE give it, one line per
 * giver, to fix that role first, with the count of each condition it gives. Each count of the role's line is the count
 * of its condition's lines, or the sum of its givers' counts of it.
 */
const whyLines = (why: Serializable): ReadonlyArray<string> =>
	why.kind === "own"
		? Arr.map(
				why.reasons,
				(r) => `  ${r.condition}, ${placeText(r.at)}: ${r.detail}; ${isolationFix[r.condition]}`
			)
		: Arr.map(
				why.by,
				(g) => `  fix login ${g.login}, role ${g.role} first (${countsText(g.reasons)})`
			)

/**
 * A role's level as generate prints it: read committed; or serializable with the count of each condition it failed,
 * then a line per reason it fails by itself, or per role that gives it one (whyLines).
 */
export const levelLines = (
	role: SchemaGenerateReport["certification"][number]
): ReadonlyArray<string> => {
	const head = `login ${role.login}, role ${role.role}`
	return role.certificate.level === "readCommitted"
		? [`${head}: read committed`]
		: [
				`${head}: serializable (${countsText(reasonsOf(role.certificate.why))})`,
				...whyLines(role.certificate.why)
			]
}

/**
 * A fence as generate prints it: the login, the relation its writes of it lock IN EXCLUSIVE MODE before their snapshot,
 * and why, each role certified read committed whose foreign key checks of it rely on the lock.
 */
const fenceLine = (fence: SchemaGenerateReport["fences"][number]): string =>
	`login ${fence.login} fences ${fence.relation}: its writes of it lock it in exclusive mode before their snapshot, for the read committed foreign key checks of ${Arr.join(
		Arr.map(fence.for, (r) => `login ${r.login}, role ${r.role}`),
		"; "
	)}`

/**
 * The level of every role of every schema's logins, with why each SERIALIZABLE one is (levelLines), each fence its
 * login takes for them (fenceLine), then what generate wrote (renderWrites).
 */
const renderGenerate = (
	reports: ReadonlyArray<SchemaGenerateReport>,
	relative: (path: string) => string
): ReadonlyArray<string> => [
	...Arr.flatMap(reports, (r) => Arr.flatMap(r.certification, levelLines)),
	...Arr.flatMap(reports, (r) => Arr.map(r.fences, fenceLine)),
	...renderWrites(reports, relative)
]

/**
 * Each written file, relative to `cwd`, each served file written and each removed; then each marker to resolve and each
 * loss to decide, with what to do; then the next step.
 */
const renderWrites = (
	reports: ReadonlyArray<SchemaGenerateReport>,
	relative: (path: string) => string
): ReadonlyArray<string> => {
	const rederived = Arr.flatMap(reports, (r) => (r.kind === "rederived" ? [r] : []))
	const written = Arr.flatMap(reports, (r) =>
		r.kind === "custom" || r.kind === "drafted" ? [r] : []
	)
	const served = Arr.flatMap(reports, (r) => Arr.map(r.served, relative))
	const unserved = Arr.flatMap(reports, (r) => Arr.map(r.unserved, (p) => `removed ${relative(p)}`))
	if (
		written.length === 0 &&
		rederived.length === 0 &&
		served.length === 0 &&
		unserved.length === 0
	) {
		return [noChanges]
	}
	const folderOf = (r: (typeof written)[number]) => relative(r.path)
	const files = [
		...Arr.flatMap(written, (r) => [
			...Arr.map([...r.files, metaFileName], (f) => `${folderOf(r)}/${f}`),
			...(r.kind === "drafted" ? Arr.map(r.snapshotPaths, relative) : [])
		]),
		...Arr.flatMap(rederived, (r) => Arr.map(r.snapshotPaths, relative)),
		...served,
		...unserved
	]
	const markers = Arr.flatMap(written, (r) => Arr.map(r.markers, (m) => markerLine(folderOf(r), m)))
	const losses = Arr.flatMap(written, (r) =>
		Arr.map(
			r.losses,
			(l) => `${folderOf(r)}/${l.file}: data loss: ${l.loses}: ${refusalText.unresolvedLoss.fix}`
		)
	)
	const locks = Arr.flatMap(written, (r) =>
		Arr.isReadonlyArrayNonEmpty(r.locks) ? [locksLine(folderOf(r), r.locks)] : []
	)
	const custom = Arr.some(written, (r) => r.kind === "custom")
	return [
		...files,
		...locks,
		...markers,
		...losses,
		markers.length + losses.length > 0
			? "next: resolve the markers, then run grizzle check"
			: custom
				? "next: write the SQL files, then run grizzle check"
				: written.length > 0
					? "next: review the SQL, then run grizzle check"
					: commitStep(rederived.length > 0, served.length + unserved.length > 0)
	]
}

/**
 * The locks a drafted folder's files state, as generate prints them: each file's, and the largest, which the server's
 * lock table must hold beside every other session's while it runs (`grizzle migrate` refuses an apply it cannot hold).
 */
const locksLine = (
	folder: string,
	locks: Arr.NonEmptyReadonlyArray<{ readonly file: string; readonly locks: number }>
): string => {
	const largest = Arr.reduce(locks, locks[0], (most, f) => (f.locks > most.locks ? f : most))
	return `${folder}: locks ${Arr.join(
		Arr.map(locks, (f) => `${f.file} ${f.locks}`),
		", "
	)}; the server's lock table must hold ${largest.locks} for ${largest.file}'s transaction`
}

const renderApply = (reports: ReadonlyArray<SchemaApplyReport>): ReadonlyArray<string> =>
	Arr.flatMap(reports, (r) => [
		r.applied.length === 0
			? `${r.schemaName}: up to date at ${r.after}`
			: `${r.schemaName}: applied ${r.applied.length} migration${r.applied.length === 1 ? "" : "s"}, now at ${r.after}`,
		...Arr.map(
			r.applied,
			(a) =>
				`  ${a.folder}${a.resumed ? " (resumed)" : ""}: ${a.files.length === 0 ? "recorded" : Arr.join(a.files, ", ")}`
		)
	])

/** What uninstall dropped, a line each: every schema, then every role; that nothing was, when nothing was there. */
const renderUninstall = (dropped: UninstallReport): ReadonlyArray<string> =>
	dropped.schemas.length + dropped.roles.length === 0
		? ["grizzle uninstall: nothing installed"]
		: [
				...Arr.map(dropped.schemas, (s) => `dropped schema ${s}`),
				...Arr.map(dropped.roles, (r) => `dropped role ${r}`)
			]

/** A refusal of the command line, and its stage's fix beneath it where its stage has one (cliStageFix). */
const renderCliError = (e: CliError): ReadonlyArray<string> => {
	const stage = e.stage
	return stage === "config"
		? [`grizzle: ${e.message}`]
		: [`grizzle: ${e.message}`, `fix: ${cliStageFix[stage]}`]
}

/** Every finding, one per line with its fix; a clean schema says so. */
const renderCheck = (checks: ReadonlyArray<SchemaCheck>): ReadonlyArray<string> =>
	Arr.flatMap(checks, (c) =>
		c.findings.length > 0
			? Arr.map(c.findings, findingText)
			: [
					`${c.schema}: ok (${c.folders} migration${c.folders === 1 ? "" : "s"}${Option.isNone(c.snapshot) ? "" : `, snapshot ${c.snapshot.value.fingerprint}`})`
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

/** A command that connects, whose refusal by the database its report names. */
type ConnectingCommand = "migrate" | "drift" | "roles" | "uninstall"

/** A connecting command the database refused, with the command that ran, which its report names. */
class CommandRefused extends Data.TaggedError("CommandRefused")<{
	readonly command: ConnectingCommand
	readonly error: MigrateError
}> {}

/** A command's failure: a CLI refusal as it is, a connecting command's refusal with its command. */
const refusedBy =
	(command: ConnectingCommand) =>
	(e: CliError | MigrateError): CliError | CommandRefused =>
		e._tag === "CliError" ? e : new CommandRefused({ command, error: e })

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
				(m) => `  ${m.folder}/${m.file}:${m.line}: unresolved placeholder`
			)
		case "LossesUndecided":
			return Arr.map(
				reason.losses,
				(l) => `  ${l.folder}/${l.file}: unresolved data loss: ${l.loses}`
			)
		case "Drifted":
			return Arr.map(reason.mismatches, (m) => `  ${mismatchLine(m)}`)
		case "ConnectRefused":
		case "SurveyFailed":
		case "StackTooShallow":
		case "BlockSizeMismatched":
		case "AdviceUnloaded":
		case "MigratorPreloads":
		case "LockTableShort":
		case "RoleUnread":
		case "OwnerUnread":
		case "OwnedByAnother":
		case "InputRefused":
		case "LockUnread":
		case "ApplyBusy":
		case "WalLevelMinimal":
		case "DecoderUnreplicated":
		case "LedgerUncompiled":
		case "LedgerUnread":
		case "LedgerDamaged":
		case "AppliedEdited":
		case "FolderRefused":
		case "SnapshotUnreached":
		case "StatementFailed":
		case "GuardedTableUnbracketed":
		case "TransactionFailed":
		case "LedgerUnlocked":
		case "AdviceRefused":
		case "RecordFailed":
		case "FileCommitRefused":
		case "FileCommitLost":
		case "DriftUnchecked":
		case "ProofsUnrecorded":
		case "NamespaceUnread":
		case "UninstallRefused":
			return []
	}
}

/** What the database holds after a refused connecting command, as its report's outcome line says it. */
const outcomeLine = (command: ConnectingCommand, outcome: MigrateOutcome): string => {
	switch (outcome) {
		case "nothingRan":
			return command === "roles" || command === "uninstall"
				? "Nothing was dropped; the database and the cluster's roles are unchanged."
				: "No statement of any folder ran; the ledger and the catalog are unchanged."
		case "resumes":
			return "The files before it stay applied and recorded; a rerun resumes at the failed file."
		case "drifted":
			return command === "migrate"
				? "Every folder applied, but the catalog differs from the snapshot."
				: "Nothing was applied; the catalog differs from the snapshot."
		case "noVerdict":
			return command === "migrate"
				? "Every folder applied; the drift check reached no verdict."
				: "Nothing was applied; the drift check reached no verdict."
	}
}

/**
 * The report of a refused migrate or drift: one line naming the stage, where it stopped (the schema, folder, file and statement,
 * and the server's SQLSTATE and constraint) and the reason's message, which carries the server's message; then each
 * unresolved marker and data loss, each fact the drift check found missing or unexpected, and the server's DETAIL and
 * HINT, each a line of its own, the last two as psql prints them; then what the database holds, and the fix.
 */
const renderMigrateError = (command: ConnectingCommand, e: MigrateError): ReadonlyArray<string> => {
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

/** The import of the configuration file at an absolute path: the bin's (main.ts), or a test's. */
export type ConfigLoader = (
	file: string
) => Effect.Effect<ConfigFile, CliError, FileSystem.FileSystem | Path.Path>

const program = Effect.fn("program")(function* (
	argv: ReadonlyArray<string>,
	cwd: string,
	node: string,
	load: ConfigLoader,
	meter: PhaseMeter
): Effect.fn.Return<Ran, CliError | CommandRefused, FileSystem.FileSystem | Path.Path> {
	const parsed = parseArgs(argv)
	if (Result.isFailure(parsed)) {
		return yield* parsed.failure
	}
	const line = parsed.success
	if (line.kind === "help") {
		return ran(exitCodes.ok, [helpText], [])
	}
	const run = phaseRun(meter, line.phases)
	return yield* Effect.ensuring(
		commandRan(line, cwd, node, load, run.phases),
		Effect.sync(run.done)
	)
})

/** The command a command line runs, over the configuration file it names, its phases reported to `phases`. */
const commandRan = Effect.fn("commandRan")(function* (
	line: Extract<CommandLine, { readonly kind: "run" }>,
	cwd: string,
	node: string,
	load: ConfigLoader,
	phases: Phases
): Effect.fn.Return<Ran, CliError | CommandRefused, FileSystem.FileSystem | Path.Path> {
	const path = yield* Path.Path
	const { loaded, config } = yield* phasedEffect(
		phases,
		{ name: "config", of: [] },
		Effect.flatMap(load(path.resolve(cwd, line.config)), (file) =>
			Effect.flatMap(resolveConfig(file.value, file.file), (resolved) =>
				Effect.map(Effect.fromResult(readsNothingGenerated(file, resolved, path)), (held) => ({
					loaded: file,
					config: held
				}))
			)
		)
	)
	const command = line.command
	if (command.kind === "draftKey") {
		const key = yield* draftKey({
			request: command,
			config: loaded.file,
			closure: loaded.closure,
			migrations: config.migrations,
			grizzle: grizzleCheckout,
			node
		})
		return ran(exitCodes.ok, [key], [])
	}
	if (command.kind === "names") {
		const listed = yield* names(config)
		return ran(exitCodes.ok, listed, [])
	}
	if (command.kind === "check") {
		const checks = yield* check(config, cwd, phases)
		const clean = Arr.filter(checks, (c) => c.findings.length === 0)
		const dirty = Arr.filter(checks, (c) => c.findings.length > 0)
		return ran(
			dirty.length === 0 ? exitCodes.ok : exitCodes.failed,
			renderCheck(clean),
			renderCheck(dirty)
		)
	}
	if (command.kind === "migrate") {
		/**
		 * Where to connect comes first, then every check of the committed files grizzle check runs, before connecting:
		 * migrate applies those files as they are, so it compiles nothing.
		 */
		const connection = yield* migrationConnection(config)
		const checks = yield* checkFiles(config, cwd)
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
		const targets = Arr.flatMap(checks, (c) => Option.toArray(c.target))
		const applied = yield* Effect.mapError(migrate(targets, connection), refusedBy("migrate"))
		return ran(exitCodes.ok, renderApply(applied), [])
	}
	if (command.kind === "roles") {
		const connection = yield* migrationConnection(config)
		const listed = yield* Effect.mapError(roles(config, connection), refusedBy("roles"))
		return ran(exitCodes.ok, listed, [])
	}
	if (command.kind === "uninstall") {
		const connection = yield* migrationConnection(config)
		const dropped = yield* Effect.mapError(uninstallAll(config, connection), refusedBy("uninstall"))
		return ran(exitCodes.ok, renderUninstall(dropped), [])
	}
	if (command.kind === "drift") {
		const connection = yield* migrationConnection(config)
		const matched = yield* Effect.mapError(drift(config, connection), refusedBy("drift"))
		return ran(
			exitCodes.ok,
			Arr.map(matched, (m) => `grizzle drift: ${m.schema} matches snapshot ${m.fingerprint}`),
			[]
		)
	}
	const reports = yield* generateMigrations(config, {
		mode: command.mode,
		schema: command.schema,
		declared: command.declared,
		phases
	})
	return ran(
		exitCodes.ok,
		renderGenerate(reports, (p) => path.relative(cwd, p)),
		[]
	)
})

/** The report of a command line the runtime refused: a usage error, any other CLI refusal, or a migrate or drift. */
const refusedReport = (e: CliError | CommandRefused): RefusedReport => {
	if (e._tag === "CliError") {
		return {
			outcome: "refused",
			code: e.stage === "usage" ? exitCodes.usage : exitCodes.failed,
			stdout: [],
			stderr: renderCliError(e),
			refusal: e
		}
	}
	return {
		outcome: "refused",
		code: exitCodes.failed,
		stdout: [],
		stderr: renderMigrateError(e.command, e.error),
		refusal: e
	}
}

/**
 * The `grizzle` command line as an Effect: argv, the directory it runs in, against which the configuration file it
 * names resolves, the version of the Node that runs it, a draft's input (draft-inputs.ts), and the import of that file,
 * which only a command that reads the configuration runs, in; its report
 * out, which main.ts writes for the bin and a test reads. The command ran, with its report; it was refused, with its
 * error and the stage that refused it, rendered; or it died, reported as an internal error. An interruption stays the
 * fiber's interruption, so an interrupted migrate closes its connection, which rolls an open file transaction back,
 * and the ledger tells where a rerun resumes (packages/grizzle/src/adapter/migrate/apply.ts).
 *
 * Its phases, where the command line asks (`--phases`), are written to `meter` as each starts and ends, apart from the
 * report (phases.ts), which they leave as it is.
 *
 * Output is stable plain text. No command reads a clock for what it writes: a new folder's timestamp is its committed
 * chain's next (timestamp.ts), so a draft is a function of its inputs (draft-inputs.ts). Its spans run untimed: it
 * hands them to no tracer and reports its phases by its own meter, so the times Effect's tracer reads at each span's
 * start and end would be read for nothing, and untimed a draft reads no clock at all. No command reads the
 * environment for where to connect: migrate, drift, roles and uninstall connect with the configuration's connection
 * (connection.ts).
 */
export const runCli = (
	argv: ReadonlyArray<string>,
	cwd: string,
	node: string,
	load: ConfigLoader,
	meter: PhaseMeter
): Effect.Effect<CliReport, never, FileSystem.FileSystem | Path.Path> =>
	Effect.withTracerTiming(cliRun(argv, cwd, node, load, meter), false)

/** The command line as runCli runs it, untimed. */
const cliRun = Effect.fn("runCli")(function* (
	argv: ReadonlyArray<string>,
	cwd: string,
	node: string,
	load: ConfigLoader,
	meter: PhaseMeter
): Effect.fn.Return<CliReport, never, FileSystem.FileSystem | Path.Path> {
	const exit = yield* Effect.exit(program(argv, cwd, node, load, meter))
	if (Exit.isSuccess(exit)) {
		const done: RanReport = {
			outcome: "ran",
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
	const died: DiedReport = {
		outcome: "died",
		code: exitCodes.failed,
		stdout: [],
		stderr: ["grizzle: internal error", Cause.pretty(exit.cause)]
	}
	return died
})
