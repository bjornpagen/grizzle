import {
	Array as Arr,
	Effect,
	type FileSystem,
	Option,
	Order,
	Path,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { transactionControl } from "#adapter/migrate/input.ts"
import { chainWhole, committedChain, committedSnapshot } from "#cli/committed.ts"
import {
	type CompiledSchema,
	type ConfiguredSchema,
	compileSchema,
	type ResolvedConfig
} from "#cli/config.ts"
import type { CliError } from "#cli/errors.ts"
import { readSchemaTree, type SchemaTree } from "#cli/files.ts"
import { draftSchema } from "#cli/generate.ts"
import { refusalText } from "#cli/refusals.ts"
import { namedText, noDeclarations } from "#cli/renames.ts"
import { compileReasonText, looksLikeLiteralPack } from "#compiler/plan/common.ts"
import {
	accessDrift,
	accessDriftText,
	type DeploySnapshot,
	findMarkers,
	type Installation,
	literalPackFault,
	lossDecisions,
	lossText,
	noTransactionMarker,
	orderFolderFiles,
	type PackFault,
	snapshotFileName,
	splitStatements
} from "#compiler/plan/migration.ts"

/** One finding: which refusal it is, where, what, and the fix. */
interface CheckFinding {
	readonly kind: keyof typeof refusalText
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
 *   finding naming the login's program (program/workload/compile.ts accessDrift), as DbLayer.make refuses at startup;
 * - a roster reordered: a roster declares a handle before one that holds a lower code in snapshot.json, which no
 *   draft can keep every stored code's meaning across (cli/errors.ts RosterReordered), so nothing else of the schema
 *   is compared;
 * - an ungenerated change: the schemas and their logins compile to another snapshot than snapshot.json, so `grizzle
 *   generate` has something to draft; and among them a name the snapshot holds that the schema drops, which the draft
 *   refuses until `--drop` or `--rename` declares it (UndeclaredDrop);
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
	readonly snapshot: Option.Option<DeploySnapshot>
	readonly folders: number
	readonly packs: ReadonlyArray<PackStatement>
}

/** A finding of `kind` about `schema` at `where`, with its fix. */
const finding = (
	schema: ConfiguredSchema,
	kind: keyof typeof refusalText,
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
	const at = (kind: keyof typeof refusalText, where: string, problem: string) =>
		findings.push(finding(schema, kind, where, problem))
	const paths = yield* Path.Path
	const path = (...parts: ReadonlyArray<string>) =>
		paths.relative(cwd, Arr.join([schema.directory, ...parts], "/"))
	const read = yield* Effect.result(readSchemaTree(schema.declared, schema.directory))
	if (Result.isFailure(read)) {
		at("strayEntry", path(), read.failure.reason.message)
		return { findings, snapshot: Option.none(), folders: 0, packs: [] }
	}
	const tree: SchemaTree = read.success
	const committed = yield* Effect.result(committedSnapshot(schema, tree))
	if (Result.isFailure(committed)) {
		at("unreadableSnapshot", path(snapshotFileName), refusalText.unreadableSnapshot.problem)
	}
	const snapshot = Result.getSuccess(committed)

	/** The chain, folder by folder, from the empty snapshot (committed.ts, the walk generate continues). */
	const chain = committedChain(schema, tree)
	const packs: Array<PackStatement> = []
	for (const folder of chain.folders) {
		if (folder.place === "misnamed") {
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
			for (const [i, statement] of splitStatements(file.text).entries()) {
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
			const lines = Str.split(file.text, "\n")
			for (const [i, line] of lines.entries()) {
				if (i > 0 && Str.trim(line) === noTransactionMarker) {
					at(
						"misplacedNoTransaction",
						`${where}:${i + 1}`,
						refusalText.misplacedNoTransaction.problem
					)
				}
			}
			for (const marker of findMarkers(file.text)) {
				at(marker.kind, `${where}:${marker.line}`, refusalText[marker.kind].problem)
			}
		}
	}
	if (
		Option.isSome(snapshot) &&
		chainWhole(chain) &&
		chain.reached !== snapshot.value.fingerprint
	) {
		at("chainEnd", path(snapshotFileName), refusalText.chainEnd.problem)
	}
	return { findings, snapshot, folders: tree.folders.length, packs }
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
					finding(
						schema,
						"literalPack",
						pack.where,
						`statement ${pack.ordinal}: ${packFaultText(fault)}: ${refusalText.literalPack.problem}`
					)
				]
	})

/**
 * One compiled schema's findings: its committed files' (checkCommitted), then the draft of its change from the committed
 * snapshot, which compiles every program of every login's workloads for every role as DbLayer.make does (generate.ts
 * draftSchema): each literal pack held to the drafted installation, a roster reordered, a program the compiler refuses,
 * each workload program whose access moved, and an ungenerated change, against the committed snapshot.
 */
const checkSchema = Effect.fn("checkSchema")(function* (
	compiled: CompiledSchema,
	cwd: string
): Effect.fn.Return<SchemaCheck, never, FileSystem.FileSystem | Path.Path> {
	const schema = compiled.configured
	const committed = yield* checkCommitted(schema, cwd)
	const snapshot = committed.snapshot
	const draft = Option.isSome(snapshot)
		? yield* Effect.result(draftSchema(compiled, snapshot.value, [], noDeclarations))
		: undefined
	const installation =
		draft !== undefined && Result.isSuccess(draft) ? draft.success.installation : undefined
	const findings: Array<CheckFinding> = [
		...committed.findings,
		...packFindings(schema, committed.packs, installation)
	]
	const at = (kind: keyof typeof refusalText, where: string, problem: string) =>
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
					`${namedText(reason.error.reason.dropped)}: ${refusalText.undeclaredDrop.problem}`
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
		}
	}
	return {
		schema: schema.declared,
		findings,
		folders: committed.folders,
		snapshot
	}
})

/** What a literal's layout fault is, in words: a character no hex digit, a count of digits, or a padding bit set. */
const layoutFaultText = (
	fn: string,
	fault: Extract<PackFault, { readonly kind: "layout" }>["fault"]
): string => {
	switch (fault.kind) {
		case "digit":
			return `the literal of ${fn} holds a character that is no hex digit at ${fault.at}`
		case "length":
			return `the literal of ${fn} holds ${fault.digits} hex digits where the cells and width its comment states take ${fault.expected}`
		case "padding":
			return `the literal of ${fn} sets bit ${fault.at}, which pads it past its last cell`
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
 * schema or login that does not compile is the configuration's refusal.
 */
export const check = (
	config: ResolvedConfig,
	cwd: string
): Effect.Effect<ReadonlyArray<SchemaCheck>, CliError, FileSystem.FileSystem | Path.Path> =>
	Effect.forEach(config.schemas, (schema) =>
		Effect.flatMap(Effect.fromResult(compileSchema(schema)), (compiled) =>
			checkSchema(compiled, cwd)
		)
	)

/**
 * Every configured schema's committed files checked, in configured order, compiling nothing (checkCommitted, each
 * literal pack held to the digest and the rows it states): the checks `grizzle migrate` runs before it connects, since
 * it applies the committed files as they are.
 */
export const checkFiles = (
	config: ResolvedConfig,
	cwd: string
): Effect.Effect<ReadonlyArray<SchemaCheck>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.forEach(config.schemas, (schema) =>
		Effect.map(checkCommitted(schema, cwd), (committed): SchemaCheck => ({
			schema: schema.declared,
			findings: [...committed.findings, ...packFindings(schema, committed.packs, undefined)],
			snapshot: committed.snapshot,
			folders: committed.folders
		}))
	)
