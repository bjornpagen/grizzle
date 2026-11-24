import { ChunkView, type TextChunks } from "@bjornpagen/grizzle-text/chunks"
import {
	Array as Arr,
	Effect,
	type FileSystem,
	Option,
	Order,
	Path,
	type PlatformError,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { matchesFile, readText } from "#adapter/boundary/files.ts"
import { folderSource, type MigrationTarget, transactionControl } from "#adapter/migrate/input.ts"
import type { ServedEntry } from "#adapter/served/compile.ts"
import { chainWhole, type Committed, committedChain, committedSnapshot } from "#cli/committed.ts"
import {
	type CompiledSchema,
	type ConfiguredSchema,
	compileSchema,
	type ResolvedConfig
} from "#cli/config.ts"
import { type CliError, cliError, TreeUnread } from "#cli/errors.ts"
import {
	type LoginFileKind,
	loginFileKinds,
	loginFiles,
	type LoginPaths,
	noLoginPaths,
	readSchemaTree,
	type SchemaTree
} from "#cli/files.ts"
import { keptSchemaDraft, loginText, servedFiles } from "#cli/generate.ts"
import { phasedEffect } from "#cli/phases.ts"
import { refusalText } from "#cli/refusals.ts"
import {
	compileReasonText,
	looksLikeLiteralPack,
	type Phases,
	phased,
	type RecordedFormat,
	recordedFormatText
} from "#compiler/plan/common.ts"
import {
	accessDrift,
	accessDriftText,
	findMarkers,
	type Installation,
	literalPackFault,
	lossDecisions,
	lossText,
	namedSpelling,
	noDeclarations,
	noTransactionMarker,
	orderFolderFiles,
	type PackFault,
	servedDifference,
	servedPartingText,
	textLines
} from "#compiler/plan/migration.ts"
import {
	type DeploySnapshot,
	derivedHolds,
	recordHolds,
	snapshotFileName
} from "#compiler/plan/serve.ts"

/**
 * A refusal a finding is of: any of the refusal table's but an edited literal pack's and a snapshot of another format's,
 * which carry their own facts.
 */
type PlainKind = Exclude<keyof typeof refusalText, "literalPack" | "snapshotFormat">

/**
 * What a finding is: a refusal of the table; an edited literal pack, with the statement of its file that states it,
 * counted from 1, and its fault (physical/ddl/literal.ts PackFault); or a snapshot.json of another format than this
 * grizzle's, with what it records and the format this grizzle reads (errors.ts SnapshotFormat).
 */
type FindingOf =
	| { readonly kind: PlainKind }
	| { readonly kind: "literalPack"; readonly statement: number; readonly fault: PackFault }
	| {
			readonly kind: "snapshotFormat"
			readonly recorded: RecordedFormat
			readonly expected: string
	  }

/**
 * One finding: what it is, where, and its fix; `problem` is its text, rendered from what it is, which check prints and
 * nothing reads back.
 */
export type CheckFinding = FindingOf & {
	/** The declared schema. */
	readonly schema: string
	/** A path, `<path>:<line>` or the declared schema's name. */
	readonly where: string
	readonly problem: string
	readonly fix: string
}

/**
 * `grizzle check`: generated, resolved and untampered, without a database.
 *
 * The gate an AI runs before committing and CI runs on every push. For each configured schema it reads the migrations
 * directory as `migrate` would (files.ts), compiles the schema and every program of its logins' workloads as generate
 * and DbLayer.make do, and reports every finding, one per line with its fix, rather than stopping at the first.
 * `grizzle migrate` runs the findings about the committed files alone, which compile nothing (checkFiles), before it
 * connects:
 *
 * - an illegal entry or file: a stray entry in the schema's directory, a folder not named `<YYYYMMDDHHMMSS>_<name>`, a
 *   file not named `NN-<words>.sql` or two files of one ordinal, a statement that controls the transaction, or a
 *   `-- grizzle: no-transaction` marker below a file's first line, where it means nothing;
 * - an unreadable snapshot.json or meta.json: a snapshot that does not decode, or of another schema, and a meta.json
 *   that does not read or names another schema;
 * - a broken chain: a folder whose source is not the previous folder's target (the empty snapshot's for the first), or
 *   a newest target that is not snapshot.json's;
 * - an unresolved placeholder, in any folder: `migrate` refused it before the folder ran and refuses an applied file
 *   edited afterwards, so an applied folder holds none either;
 * - an unresolved loss: a schema's first migration beside the schemas the configuration no longer lists, whose loss of
 *   their rows the reviewer has neither written in nor left out (lossDecisions), each named with what it loses;
 * - a workload program whose access moved: each login's workloads' programs read through other access paths or
 *   statistics than snapshot.json records, or a program it does not record, or it records one no workload holds, each
 *   finding naming the login's program (program/workload/compile.ts accessDrift);
 * - a roster reordered: a roster declares a handle before one that holds a lower code in snapshot.json, which no
 *   draft can keep every stored code's meaning across (cli/errors.ts RosterReordered), so nothing else of the schema
 *   is compared;
 * - an ungenerated change: the schemas and their logins compile to another snapshot than snapshot.json, so `grizzle
 *   generate` has something to draft; and among them a name the snapshot holds that the schema drops, which the draft
 *   refuses until `--drop` or `--rename` declares it (UndeclaredDrop);
 * - derived facts out of date: the schemas compile to snapshot.json's own snapshot, but the derived runtime facts it
 *   records beside it, outside its fingerprint, are not the ones the compile derives (build.ts derivedHolds), or it
 *   records none, which `grizzle generate` writes again with no migration; beside an ungenerated change they follow
 *   from it, and the folder generate drafts for it writes them, so they are no finding of their own;
 * - a manifest.json out of date: the schemas compile to snapshot.json's own snapshot, but manifest.json's record of it,
 *   which its seal alone trusts, is not the record the compile reaches (build.ts recordHolds); generate writes it again,
 *   with no migration where nothing else changed;
 * - a served workload out of date: each login of the configuration over the schema compiled under the snapshot the
 *   draft lays out, as generate compiles it (generate.ts servedFiles), whose committed `served/<login>.json` is not
 *   that text byte for byte, each named with the first member where they part (served/compile.ts servedDifference); a
 *   login with no served file; and a served file of a login the configuration does not list;
 * - a literal pack edited: a closed relation's constant, stated as one hex literal, whose literal does not decode to
 *   the content its comment states and its function's name digests, decoded back to its cells and held to them, each
 *   named with the first cell and key where it parts from the rows the schema declares (physical/ddl/literal.ts
 *   literalPackFault).
 *
 * Whether a folder is applied, and whether an applied file was edited, only the database knows; `migrate` checks them.
 * check never reads the configuration's connection.
 */
export interface SchemaCheck {
	readonly schema: string
	readonly findings: ReadonlyArray<CheckFinding>
	/** The committed snapshot, or none when it did not read; and the number of folders. */
	readonly snapshot: Option.Option<DeploySnapshot>
	readonly folders: number
}

export const findingText = (f: CheckFinding): string => `${f.where}: ${f.problem}; ${f.fix}`

/** A statement of a committed file that states a literal pack, where it is: what check holds to its content. */
interface PackStatement {
	readonly where: string
	readonly statement: string
	readonly ordinal: number
}

/**
 * What a schema's committed files come to before anything is compiled: every finding about the files themselves, the
 * committed snapshot, the number of folders, and each literal pack statement, which `packFindings` holds to its content.
 */
interface CommittedCheck {
	readonly findings: ReadonlyArray<CheckFinding>
	readonly committed: Option.Option<Committed>
	/**
	 * What `grizzle migrate` applies of the files, read here once: the committed snapshot with every folder as read, none
	 * where the directory or the snapshot does not read, which a finding names.
	 */
	readonly target: Option.Option<MigrationTarget>
	readonly folders: number
	readonly packs: ReadonlyArray<PackStatement>
	/** The committed served files' and OpenAPI documents' paths, by kind and login (files.ts SchemaTree). */
	readonly logins: LoginPaths
}

/** A finding of `kind` about `schema` at `where`, with its fix. */
const finding = (
	schema: ConfiguredSchema,
	kind: PlainKind,
	where: string,
	problem: string
): CheckFinding => ({ schema: schema.declared, kind, where, problem, fix: refusalText[kind].fix })

/**
 * One schema's committed files checked, compiling nothing: the folder's chain faults first, its name, then its
 * meta.json or its link; each statement that controls the transaction, each misplaced no-transaction marker and each
 * marker left to resolve; each loss left undecided; and a chain that does not end at snapshot.json. A custom migration
 * drafts nothing, so it records no decisions.
 */
const checkCommitted = Effect.fn("checkCommitted")(function* (
	schema: ConfiguredSchema,
	cwd: string
): Effect.fn.Return<CommittedCheck, never, FileSystem.FileSystem | Path.Path> {
	const findings: Array<CheckFinding> = []
	const at = (kind: PlainKind, where: string, problem: string) =>
		findings.push(finding(schema, kind, where, problem))
	const paths = yield* Path.Path
	const path = (...parts: ReadonlyArray<string>) =>
		paths.relative(cwd, Arr.join([schema.directory, ...parts], "/"))
	const read = yield* Effect.result(readSchemaTree(schema.declared, schema.directory))
	if (Result.isFailure(read)) {
		at("strayEntry", path(), read.failure.reason.message)
		return {
			findings,
			committed: Option.none(),
			target: Option.none(),
			folders: 0,
			packs: [],
			logins: noLoginPaths
		}
	}
	const tree: SchemaTree = read.success
	/** Every folder parsed once: what the chain, the statement findings and migrate's target all read. */
	const sources = Arr.map(tree.folders, folderSource)
	const committed = yield* Effect.result(committedSnapshot(schema, tree))
	if (Result.isFailure(committed)) {
		const reason = committed.failure.reason
		if (reason._tag === "SnapshotFormat") {
			findings.push({
				schema: schema.declared,
				kind: "snapshotFormat",
				recorded: reason.recorded,
				expected: reason.expected,
				where: path(snapshotFileName),
				problem: `${refusalText.snapshotFormat.problem}: ${recordedFormatText(reason.recorded, reason.expected)}`,
				fix: refusalText.snapshotFormat.fix
			})
		} else {
			at("unreadableSnapshot", path(snapshotFileName), refusalText.unreadableSnapshot.problem)
		}
	}
	const recorded = Result.getSuccess(committed)

	/** The chain, folder by folder, from the empty snapshot (committed.ts, the walk generate continues). */
	const chain = committedChain(schema, sources)
	const packs: Array<PackStatement> = []
	for (const folder of chain.folders) {
		if (folder.place.kind === "misnamed") {
			at("folderName", path(folder.name), refusalText.folderName.problem)
		}
		const m = folder.meta
		switch (m.kind) {
			case "unreadable":
			case "foreign":
				at("unreadableMeta", path(folder.name, "meta.json"), refusalText.unreadableMeta.problem)
				break
			case "unlinked":
				at("brokenChain", path(folder.name, "meta.json"), refusalText.brokenChain.problem)
				break
			case "sound":
				break
		}
		if (m.kind !== "unreadable" && m.meta.kind === "drafted") {
			for (const d of lossDecisions(m.meta.record, folder.files)) {
				if (d.kind === "unresolved") {
					at(
						"unresolvedLoss",
						path(folder.name, d.file),
						`${lossText(d.loss.loses)}: ${refusalText.unresolvedLoss.problem}`
					)
				}
			}
		}
		const ordered = orderFolderFiles(folder.files)
		if (!ordered.ok) {
			at("fileName", path(folder.name), compileReasonText(ordered.error.reason))
		}
		for (const file of folder.files) {
			const where = path(folder.name, file.name)
			for (const [i, statement] of file.statements.entries()) {
				if (looksLikeLiteralPack(statement)) {
					packs.push({ where, statement, ordinal: i + 1 })
				}
				const control = transactionControl(statement)
				if (control !== undefined) {
					at(
						"transactionControl",
						where,
						`statement ${i + 1} is ${control}: ${refusalText.transactionControl.problem}`
					)
				}
			}
			const text = new ChunkView(file.text)
			let i = -1
			for (const line of textLines(text)) {
				i += 1
				if (i > 0 && Str.trim(line) === noTransactionMarker) {
					at(
						"misplacedNoTransaction",
						`${where}:${i + 1}`,
						refusalText.misplacedNoTransaction.problem
					)
				}
			}
			for (const marker of findMarkers(text)) {
				at(marker.kind, `${where}:${marker.line}`, refusalText[marker.kind].problem)
			}
		}
	}
	if (
		Option.isSome(recorded) &&
		chainWhole(chain) &&
		chain.reached !== recorded.value.snapshot.fingerprint
	) {
		at("chainEnd", path(snapshotFileName), refusalText.chainEnd.problem)
	}
	return {
		findings,
		committed: recorded,
		target: Option.map(recorded, (c) => ({ snapshot: c.snapshot, folders: sources })),
		folders: tree.folders.length,
		packs,
		logins: tree.logins
	}
})

/**
 * Each literal pack held to its content (physical/ddl/literal.ts literalPackFault): against the installation the
 * schema drafts, which names the relation and the cell where an edited literal parts from the declared rows, or against
 * none, which holds the literal to the digest and the row count it states.
 */
const packFindings = (
	schema: ConfiguredSchema,
	packs: ReadonlyArray<PackStatement>,
	installation: Installation | undefined
): ReadonlyArray<CheckFinding> =>
	Arr.flatMap(packs, (pack) => {
		const fault = literalPackFault(installation, pack.statement)
		return fault === undefined
			? []
			: [
					{
						kind: "literalPack",
						statement: pack.ordinal,
						fault,
						schema: schema.declared,
						where: pack.where,
						problem: `statement ${pack.ordinal}: ${packFaultText(fault)}: ${refusalText.literalPack.problem}`,
						fix: refusalText.literalPack.fix
					}
				]
	})

/**
 * The findings of one kind of login file, each by the refusal it names, and how a stale file's problem is told: a
 * served file by where its values first part from the compile's (served/compile.ts servedDifference), the committed
 * file read for it as its chunks (files.ts readText).
 */
const loginRules = {
	served: {
		missing: "servedMissing",
		stale: "servedStale",
		extra: "servedExtra",
		parting: (expected: TextChunks, path: string) =>
			Effect.map(readText(path), (committed) =>
				Option.some(servedPartingText(servedDifference(expected, committed)))
			)
	},
	openapi: {
		missing: "documentMissing",
		stale: "documentStale",
		extra: "documentExtra",
		parting: () => Effect.succeed(Option.none<string>())
	}
} as const satisfies {
	readonly [K in LoginFileKind]: {
		readonly missing: PlainKind
		readonly stale: PlainKind
		readonly extra: PlainKind
		readonly parting: (
			expected: TextChunks,
			path: string
		) => Effect.Effect<Option.Option<string>, PlatformError.PlatformError, FileSystem.FileSystem>
	}
}

/**
 * The findings of a schema's committed login files of `kind`, `committed` their paths by login, against the ones
 * generate writes under the draft's snapshot, `served`, each where it lies relative to `cwd`: a login's file whose bytes
 * part from its text, each read a block at a time and held to the text as it is read (files.ts matchesFile), a login
 * with none, and a file of a login the configuration does not list. A file that cannot be read is a stray entry, as a
 * directory that cannot be read is (checkCommitted).
 */
const loginFindings = (
	schema: ConfiguredSchema,
	kind: LoginFileKind,
	served: ReadonlyArray<ServedEntry>,
	committed: ReadonlyMap<string, string>,
	where: (login: string) => string
): Effect.Effect<ReadonlyArray<CheckFinding>, never, FileSystem.FileSystem> => {
	const rules = loginRules[kind]
	const listed = new Set(Arr.map(served, (f) => f.login))
	const extra = Arr.filter(Arr.fromIterable(committed.keys()), (login) => !listed.has(login))
	const held = Effect.forEach(served, (file) => {
		const path = committed.get(file.login)
		const expected = loginText(file, kind)
		if (path === undefined) {
			return Effect.succeed([
				finding(
					schema,
					rules.missing,
					where(file.login),
					`login ${file.login}: ${refusalText[rules.missing].problem}`
				)
			])
		}
		const stale = Effect.flatMap(matchesFile(path, expected), (parting) =>
			parting.kind === "same"
				? Effect.succeed([])
				: Effect.map(rules.parting(expected, path), (part) => [
						finding(
							schema,
							rules.stale,
							where(file.login),
							`login ${file.login}, ${Option.match(part, {
								onNone: () => "",
								onSome: (text) => `${text}: `
							})}${refusalText[rules.stale].problem}`
						)
					])
		)
		return Effect.catchTag(stale, "PlatformError", (cause) =>
			Effect.succeed([
				finding(
					schema,
					"strayEntry",
					where(file.login),
					cliError(new TreeUnread({ schema: schema.declared, directory: path, cause })).reason
						.message
				)
			])
		)
	})
	return Effect.map(held, (found) => [
		...Arr.flatten(found),
		...Arr.map(Arr.sort(extra, Order.String), (login) =>
			finding(
				schema,
				rules.extra,
				where(login),
				`login ${login}: ${refusalText[rules.extra].problem}`
			)
		)
	])
}

/**
 * One compiled schema's findings: its committed files' (checkCommitted), then the draft of its change from the committed
 * snapshot (generate.ts draftSchema): each literal pack held to the drafted installation, a roster reordered, a schema
 * or access plan the compiler refuses, each workload program whose access moved, and an ungenerated change, against the
 * committed snapshot; then every login's workload compiled under the snapshot the draft lays out, as generate compiles
 * it (generate.ts servedFiles), a login it refuses, and the committed served files held to it (servedFindings).
 */
const checkSchema = Effect.fn("checkSchema")(function* (
	compiled: CompiledSchema,
	cwd: string,
	phases: Phases
): Effect.fn.Return<SchemaCheck, never, FileSystem.FileSystem | Path.Path> {
	const schema = compiled.configured
	const committed = yield* checkCommitted(schema, cwd)
	const snapshot = Option.map(committed.committed, (c) => c.snapshot)
	const draft = Option.isSome(snapshot)
		? yield* Effect.result(keptSchemaDraft(compiled, snapshot.value, [], noDeclarations, phases))
		: undefined
	const installation =
		draft !== undefined && Result.isSuccess(draft) ? draft.success.installation : undefined
	const findings: Array<CheckFinding> = [
		...committed.findings,
		...packFindings(schema, committed.packs, installation)
	]
	const at = (kind: PlainKind, where: string, problem: string) =>
		findings.push(finding(schema, kind, where, problem))

	if (Option.isSome(snapshot) && draft !== undefined) {
		const committedWorkload = snapshot.value.workload
		if (Result.isFailure(draft)) {
			const reason = draft.failure.reason
			if (reason._tag === "RosterReordered") {
				at(
					"rosterReordered",
					schema.declared,
					`${reason.message}: ${refusalText.rosterReordered.problem}`
				)
			} else if (reason._tag === "DraftRefused" && reason.error.reason._tag === "UndeclaredDrop") {
				at(
					"undeclaredDrop",
					schema.declared,
					`${namedSpelling(reason.error.reason.dropped)}: ${refusalText.undeclaredDrop.problem}`
				)
			} else {
				at("compile", schema.declared, `${refusalText.compile.problem}: ${reason.message}`)
			}
		} else {
			const current = draft.success.snapshot.workload
			const logins: ReadonlyArray<string> = Arr.sort(
				Arr.dedupe([...Rec.keys(committedWorkload), ...Rec.keys(current)]),
				Order.String
			)
			const drifts = Arr.flatMap(logins, (login: string) => {
				const programs = Option.getOrElse(Rec.get(current, login), () => ({}))
				return Arr.map(accessDrift(committedWorkload, login, programs), (d) =>
					accessDriftText(login, d)
				)
			})
			for (const drift of drifts) {
				at("workloadAccess", schema.declared, `${drift}: ${refusalText.workloadAccess.problem}`)
			}
			if (drifts.length === 0 && draft.success.change === "schema") {
				at("ungenerated", schema.declared, refusalText.ungenerated.problem)
			}
			const recorded = committed.committed
			if (
				draft.success.change === "none" &&
				Option.isSome(recorded) &&
				recorded.value.kind === "files" &&
				!derivedHolds(recorded.value.derived, draft.success.derived)
			) {
				at("derivedFacts", schema.declared, refusalText.derivedFacts.problem)
			}
			if (
				draft.success.change === "none" &&
				Option.isSome(recorded) &&
				recorded.value.kind === "files" &&
				!recordHolds(recorded.value.snapshot, draft.success.snapshot)
			) {
				at("manifestRecord", schema.declared, refusalText.manifestRecord.problem)
			}
			const served = yield* Effect.result(
				servedFiles(compiled, draft.success, draft.success.served, phases)
			)
			if (Result.isFailure(served)) {
				at(
					"compile",
					schema.declared,
					`${refusalText.compile.problem}: ${served.failure.reason.message}`
				)
			} else {
				const paths = yield* Path.Path
				for (const kind of loginFileKinds) {
					const stale = yield* loginFindings(
						schema,
						kind,
						served.success,
						committed.logins[kind],
						(login) =>
							paths.relative(cwd, Arr.join([schema.directory, loginFiles[kind].path(login)], "/"))
					)
					for (const f of stale) {
						findings.push(f)
					}
				}
			}
		}
	}
	return {
		schema: schema.declared,
		findings,
		folders: committed.folders,
		snapshot
	}
})

/**
 * What a literal's layout fault is, in words: no array of its layout, an element spelled otherwise, indexes out of
 * order, or an index or a payload code past what its comment states.
 */
const layoutFaultText = (
	fn: string,
	fault: Extract<PackFault, { readonly kind: "layout" }>["fault"]
): string => {
	switch (fault.kind) {
		case "array":
			return `the literal of ${fn} is no array of its elements in braces, each after a comma, a cells literal's led by the sentinel -1`
		case "element":
			return `the literal of ${fn} holds an element at entry ${fault.at} that is no decimal numeral of no sign and no leading 0`
		case "order":
			return `the literal of ${fn} holds an index at entry ${fault.at} no greater than the index before it`
		case "cell":
			return `the literal of ${fn} holds the index ${fault.cell} at entry ${fault.at}, past the cells its comment states`
		case "code":
			return `the literal of ${fn} holds the payload code ${fault.code} at entry ${fault.at}, past the payload codes its comment states`
	}
}

/** What a literal pack's fault is, in words: its form, its layout, or its content, with the cell and key it parts at. */
const packFaultText = (fault: PackFault): string => {
	switch (fault.kind) {
		case "form":
			return "a statement that begins as a literal pack's comment departs from its printed form"
		case "layout":
			return layoutFaultText(fault.function, fault.fault)
		case "rows":
			return `the comment of ${fault.function} states ${fault.stated} rows where its literal holds ${fault.held}`
		case "content": {
			const relation = fault.relation === undefined ? "" : ` (closed relation ${fault.relation})`
			const differs =
				fault.differs === undefined
					? ""
					: `, first at cell ${fault.differs.cell}${fault.differs.key === undefined ? "" : `, key (${Arr.join(fault.differs.key, ", ")})`}`
			return `the literal of ${fault.function}${relation} differs from its declared rows${differs}`
		}
	}
}

/**
 * Every configured schema's findings, in configured order, each schema compiled first (config.ts compileSchema): a
 * schema or login that does not compile is the configuration's refusal. Each schema's check is a phase reported to
 * `phases` (`schema`), its compile and its draft phases inside it.
 */
export const check = (
	config: ResolvedConfig,
	cwd: string,
	phases: Phases
): Effect.Effect<ReadonlyArray<SchemaCheck>, CliError, FileSystem.FileSystem | Path.Path> =>
	Effect.forEach(config.schemas, (schema) =>
		phasedEffect(
			phases,
			{ name: "schema", of: [schema.declared] },
			Effect.flatMap(
				Effect.suspend(() =>
					Effect.fromResult(phased(phases, { name: "build", of: [] }, () => compileSchema(schema)))
				),
				(compiled) => checkSchema(compiled, cwd, phases)
			)
		)
	)

/**
 * A schema's committed files as `grizzle migrate` checks them before it connects: what `grizzle check` finds of them,
 * and the target migrate applies, read once with them (CommittedCheck target).
 */
export interface FilesCheck extends SchemaCheck {
	readonly target: Option.Option<MigrationTarget>
}

/**
 * Every configured schema's committed files checked, in configured order, compiling nothing (checkCommitted, each
 * literal pack held to the digest and the rows it states): the checks `grizzle migrate` runs before it connects, since
 * it applies the committed files as they are, and the targets it applies, read with them, so nothing reads a file twice.
 */
export const checkFiles = (
	config: ResolvedConfig,
	cwd: string
): Effect.Effect<ReadonlyArray<FilesCheck>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.forEach(config.schemas, (schema) =>
		Effect.map(checkCommitted(schema, cwd), (committed): FilesCheck => ({
			schema: schema.declared,
			findings: [...committed.findings, ...packFindings(schema, committed.packs, undefined)],
			snapshot: Option.map(committed.committed, (c) => c.snapshot),
			folders: committed.folders,
			target: committed.target
		}))
	)
