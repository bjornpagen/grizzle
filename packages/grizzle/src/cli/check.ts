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
import type { ConfiguredSchema, ResolvedConfig } from "#cli/config.ts"
import { readSchemaTree, type SchemaTree } from "#cli/files.ts"
import { draftSchema } from "#cli/generate.ts"
import { refusalText } from "#cli/refusals.ts"
import { compileReasonText } from "#compiler/core/errors.ts"
import { lossDecisions, lossText, splitRenames } from "#compiler/deploy/render/chosen.ts"
import { orderFolderFiles } from "#compiler/deploy/render/folder.ts"
import {
	findMarkers,
	noTransactionMarker,
	splitStatements
} from "#compiler/deploy/render/markers.ts"
import { type DeploySnapshot, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { accessDrift, accessDriftText } from "#compiler/program/workload/compile.ts"

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
 * The gate an AI runs before committing and CI runs on every push, and the first half of every `grizzle migrate`. For
 * each configured schema it reads the migrations directory as `migrate` would (files.ts) and reports every finding, one
 * per line with its fix, rather than stopping at the first:
 *
 * - an illegal entry or file: a stray entry in the schema's directory, a folder not named `<YYYYMMDDHHMMSS>_<name>`, a
 *   file not named `NN-<words>.sql` or two files of one ordinal, a statement that controls the transaction, or a
 *   `-- grizzle: no-transaction` marker below a file's first line, where it means nothing;
 * - an unreadable snapshot.json or meta.json: a snapshot that does not decode, or of another schema, and a meta.json
 *   that does not read or names another schema;
 * - a broken chain: a folder whose source is not the previous folder's target (the empty snapshot's for the first), or
 *   a newest target that is not snapshot.json's;
 * - an unresolved marker, a placeholder or a candidate rename, in any folder: `migrate` refused it before the folder
 *   ran and refuses an applied file edited afterwards, so an applied folder holds none either;
 * - a candidate rename decided one way at one statement it marks and another way at another, a statement it decides
 *   that is neither kept as drafted nor replaced as its marker says, two chosen candidates that rename one name, or a
 *   loss decided both ways, in any folder whose meta.json records its decisions (render/chosen.ts splitRenames, which
 *   compares statements as PostgreSQL's scanner reads them);
 * - an unresolved loss: a statement that loses stored data, a relation with its rows or a field with its values, that
 *   is neither written in nor carried by a chosen candidate rename (render/chosen.ts lossDecisions), each named with
 *   what it loses;
 * - a workload program whose access moved: each login's workloads' programs read through other access paths or
 *   statistics than snapshot.json records, or a program it does not record, or it records one no workload holds, each
 *   finding naming the login's program (program/workload/compile.ts accessDrift), as DbLayer.make refuses at startup;
 * - an ungenerated change: the schemas and their logins compile to another snapshot than snapshot.json, so `grizzle
 *   generate` has something to draft.
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

/**
 * One schema's findings.
 *
 * The folder's chain faults first: its name, then its meta.json or its link.
 *
 * A custom migration drafts nothing, so it records no decisions.
 *
 * The ungenerated change, against the committed snapshot.
 */
const checkSchema = Effect.fn("checkSchema")(function* (
	schema: ConfiguredSchema,
	cwd: string
): Effect.fn.Return<SchemaCheck, never, FileSystem.FileSystem | Path.Path> {
	const findings: Array<CheckFinding> = []
	const at = (kind: keyof typeof refusalText, where: string, problem: string) =>
		findings.push({ schema: schema.declared, kind, where, problem, fix: refusalText[kind].fix })
	const paths = yield* Path.Path
	const path = (...parts: ReadonlyArray<string>) =>
		paths.relative(cwd, Arr.join([schema.directory, ...parts], "/"))
	const read = yield* Effect.result(readSchemaTree(schema.declared, schema.directory))
	if (Result.isFailure(read)) {
		at("strayEntry", path(), read.failure.reason.message)
		return { schema: schema.declared, findings, snapshot: Option.none(), folders: 0 }
	}
	const tree: SchemaTree = read.success
	const committed = yield* Effect.result(committedSnapshot(schema, tree))
	if (Result.isFailure(committed)) {
		at("unreadableSnapshot", path(snapshotFileName), refusalText.unreadableSnapshot.problem)
	}
	const snapshot = Result.getSuccess(committed)

	/** The chain, folder by folder, from the empty snapshot (committed.ts, the walk generate continues). */
	const chain = committedChain(schema, tree)
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
			for (const r of splitRenames(m.meta.decisions, folder.files)) {
				at(
					"splitRename",
					path(folder.name, r.file),
					`${r.detail}: ${refusalText.splitRename.problem}`
				)
			}
			for (const d of lossDecisions(m.meta.decisions, folder.files)) {
				if (d.kind === "unresolved") {
					at(
						"unresolvedLoss",
						path(folder.name, d.loss.file),
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
				const kind = marker.kind === "placeholder" ? "placeholder" : "renameCandidate"
				at(kind, `${where}:${marker.line}`, refusalText[kind].problem)
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

	if (Option.isSome(snapshot)) {
		const committedWorkload = snapshot.value.workload
		const draft = yield* Effect.result(
			draftSchema(schema, snapshot.value, { kind: "named", name: "check" }, "00000000000000", [])
		)
		if (Result.isFailure(draft)) {
			at(
				"compile",
				schema.declared,
				`${refusalText.compile.problem}: ${draft.failure.reason.message}`
			)
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
		folders: tree.folders.length,
		snapshot
	}
})

/**
 * Every configured schema's findings, in configured order.
 *
 * @internal
 */
export const check = (
	config: ResolvedConfig,
	cwd: string
): Effect.Effect<ReadonlyArray<SchemaCheck>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.forEach(config.schemas, (schema) => checkSchema(schema, cwd))
