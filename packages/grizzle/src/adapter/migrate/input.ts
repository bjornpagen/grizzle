import { ChunkView, type TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { Array as Arr, Brand, Result } from "effect"
import { readMeta } from "#adapter/boundary/meta.ts"
import {
	type InputFault,
	InputRefused,
	type MigrateError,
	stopped
} from "#adapter/migrate/errors.ts"
import type { MigrationText } from "#adapter/wire/batch.ts"
import { type CompileError, sha256ChunksHex } from "#compiler/plan/common.ts"
import {
	type InstallationNames,
	isFolderName,
	isNoTransaction,
	leadingTokens,
	orderFolderFiles,
	type ReadMeta,
	resolveVariables,
	splitStatements,
	type StatedAdvice,
	statedAdvice,
	type Token
} from "#compiler/plan/migration.ts"
import type { DeploySnapshot } from "#compiler/plan/serve.ts"

/**
 * What `grizzle migrate` is given, checked before it connects.
 *
 * The command line owns the filesystem: it reads `migrations/<schema>/snapshot.json`
 * and every folder `migrations/<schema>/<timestamp>_<name>/`, its meta.json and its `NN-<phase>.sql` files, and hands
 * them over as text. The runner applies exactly those texts: it never reads a file, and what it records
 * is the SHA-256 of the text it ran.
 *
 * Each declared schema is applied with its own snapshot and folders. Before anything is sent:
 *
 * - each folder is named `<14 digits>_<words>` (render/folder.ts), names are distinct, and its meta.json reads as
 *   this schema's (readMeta); its files are `NN-<words>.sql`, one per ordinal, applied in ordinal
 *   order (orderFolderFiles);
 * - each file's statements are read with the drafted files' own splitter (render/markers.ts splitStatements), and a
 *   statement that controls the transaction (BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK other than ROLLBACK TO,
 *   ABORT, PREPARE TRANSACTION) is refused: a file runs as one transaction, or each of its statements alone, and its
 *   ledger row is inserted inside its own transaction, which a file that commits
 *   or opens a transaction itself would break;
 * - each statement's variables, its installation's roles by their stems and its database (compiler/deploy/render/variables.ts),
 *   are filled with what the installation names them, and a variable none fills is refused: what is sent is the filled
 *   statement, what the ledger records the digest of the file as written, the same in every installation.
 *
 * A folder as the command line read it: its texts.
 */
export interface FolderTexts {
	/** `<timestamp>_<name>`. */
	readonly name: string
	/** meta.json's text, as its chunks (grizzle-text TextChunks), as every text of the folder is held. */
	readonly metaText: TextChunks
	/** Every `NN-<phase>.sql` file of the folder; meta.json is metaText. */
	readonly files: ReadonlyArray<{ readonly name: string; readonly text: TextChunks }>
}

/** A file of a folder as it was read, its statements split once by the drafted files' own splitter, its text read
 * through a view of its chunks (grizzle-text ChunkView). */
export interface SourceFile {
	readonly name: string
	readonly text: TextChunks
	readonly statements: ReadonlyArray<string>
}

/**
 * A folder as `grizzle check` and migrate read it, parsed once where its texts are read (folderSource): its name, its
 * meta.json as readMeta reads it, or the reason it does not, the SHA-256 of that text, which the ledger records, and
 * each file's statements. The check's findings and the apply read these, and neither reads a text again.
 */
export interface FolderSource {
	readonly name: string
	readonly meta: Result.Result<ReadMeta, CompileError>
	readonly metaDigest: string
	readonly files: ReadonlyArray<SourceFile>
}

/** A folder's texts, parsed once (FolderSource). */
export const folderSource = (folder: FolderTexts): FolderSource => ({
	name: folder.name,
	meta: readMeta(folder.metaText),
	metaDigest: sha256ChunksHex(folder.metaText),
	files: Arr.map(folder.files, (f) => ({
		name: f.name,
		text: f.text,
		statements: splitStatements(new ChunkView(f.text))
	}))
})

/** One declared schema to apply: the snapshot the application knows and every folder of its migrations directory. */
export interface MigrationTarget {
	readonly snapshot: DeploySnapshot
	readonly folders: ReadonlyArray<FolderSource>
}

/** A statement of a reviewed migration file: the one door of MigrationText (wire/batch.ts). */
const reviewed = Brand.nominal<MigrationText>()

export interface ParsedFile {
	readonly name: string
	readonly ordinal: number
	readonly text: TextChunks
	/** SHA-256 of the text, which the ledger records. */
	readonly digest: string
	readonly noTransaction: boolean
	/** The file's statements, each as reviewed with its variables filled: the one SQL grizzle sends that its printer did
	 * not print. */
	readonly statements: ReadonlyArray<MigrationText>
	/** The plan advice its transaction runs under, statement by statement, as its folder's meta.json states it
	 * (deploy/render/folder.ts statedAdvice): its data steps' plans joined over each recorded statement, none over a
	 * reviewer's between them; none at all for a file of no data step, one whose recorded statements no longer all
	 * stand, and a custom migration's. */
	readonly advice: StatedAdvice
}

export interface ParsedFolder {
	readonly name: string
	readonly meta: ReadMeta
	readonly metaDigest: string
	/** In ordinal order. */
	readonly files: ReadonlyArray<ParsedFile>
}

export interface ParsedTarget {
	readonly schema: string
	readonly snapshot: DeploySnapshot
	/** In name order, which is creation order. */
	readonly folders: ReadonlyArray<ParsedFolder>
}

/** A token's ASCII upper-cased text when it is a word, or undefined. */
const wordOf = (t: Token | undefined): string | undefined =>
	t?.kind === "word" ? t.upper : undefined

/** What a statement whose first word may control a transaction answers, given the two tokens after that word. */
type Control = (second: Token | undefined, third: Token | undefined) => string | undefined
const always =
	(command: string): Control =>
	() =>
		command

const transactionControls: ReadonlyMap<string, Control> = new Map<string, Control>([
	["BEGIN", always("BEGIN")],
	["START", always("START")],
	["COMMIT", always("COMMIT")],
	["END", always("END")],
	["ABORT", always("ABORT")],
	[
		"ROLLBACK",
		(second, third) => {
			const next = wordOf(second) === "WORK" || wordOf(second) === "TRANSACTION" ? third : second
			return wordOf(next) === "TO" ? undefined : "ROLLBACK"
		}
	],
	[
		"PREPARE",
		(second, third) => {
			const namesStatement =
				wordOf(third) === "AS" || (third?.kind === "punct" && third.text === "(")
			return wordOf(second) === "TRANSACTION" && !namesStatement ? "PREPARE TRANSACTION" : undefined
		}
	]
])

/**
 * The tokens a statement's head holds that decide whether it controls a transaction: its verb and the two after it.
 *
 * @formatConstant gram.y's TransactionStmt read by its first three tokens: the verb, then WORK, TRANSACTION or TO
 */
const transactionHead = 3

/**
 * The transaction-control command a statement is, or undefined. It is read as PostgreSQL's grammar (gram.y
 * TransactionStmt and TransactionStmtLegacy) reads the statement's first tokens, as its scanner reads them
 * (sql/lexer.ts), past whitespace and comments:
 * - BEGIN, START, COMMIT, END and ABORT always control a transaction, COMMIT PREPARED another one's;
 * - ROLLBACK does, unless TO follows it after an optional WORK or TRANSACTION: ROLLBACK [WORK | TRANSACTION] TO
 *   [SAVEPOINT] name rolls back to a savepoint;
 * - PREPARE TRANSACTION does, unless AS or a parenthesis follows: PREPARE name [(types)] AS makes a server statement, whose
 *   name may be `transaction`;
 * - SAVEPOINT and RELEASE [SAVEPOINT] name a savepoint, and no other statement controls a transaction.
 * A word is a whole identifier, so `begin1` is no BEGIN.
 */
export const transactionControl = (statement: string): string | undefined => {
	const [first, second, third] = leadingTokens(statement, transactionHead)
	const verb = wordOf(first)
	return verb === undefined ? undefined : transactionControls.get(verb)?.(second, third)
}

/** Checks one schema's snapshot and folders, without a connection, each statement filled under `installation`. */
export const parseTarget = (
	target: MigrationTarget,
	installation: InstallationNames
): Result.Result<ParsedTarget, MigrateError> => {
	const snapshot = target.snapshot
	const schema = snapshot.schema
	const refuse = (fault: InputFault) => Result.fail(stopped(new InputRefused({ schema, fault })))
	const names = new Set<string>()
	const folders: Array<ParsedFolder> = []
	for (const source of target.folders) {
		const folder = source.name
		if (!isFolderName(folder)) {
			return refuse({ kind: "folderName", folder })
		}
		if (names.has(folder)) {
			return refuse({ kind: "repeatedFolder", folder })
		}
		names.add(folder)
		const meta = source.meta
		if (Result.isFailure(meta)) {
			return refuse({ kind: "malformedMeta", folder, error: meta.failure })
		}
		if (meta.success.schema !== schema || meta.success.schemaName !== snapshot.schemaName) {
			return refuse({
				kind: "foreignMeta",
				folder,
				belongs: { schemaName: meta.success.schemaName, schema: meta.success.schema },
				schemaName: snapshot.schemaName
			})
		}
		const fileNames = new Set(Arr.map(source.files, (f) => f.name))
		if (fileNames.size !== source.files.length) {
			return refuse({ kind: "repeatedFile", folder })
		}
		if (fileNames.has("meta.json")) {
			return refuse({ kind: "metaAmongFiles", folder })
		}
		const ordered = orderFolderFiles(source.files)
		if (!ordered.ok) {
			return refuse({ kind: "fileNames", folder, error: ordered.error })
		}
		const files: Array<ParsedFile> = []
		for (const {
			file: { name, text, statements: split },
			ordinal
		} of ordered.value) {
			const statements: Array<MigrationText> = []
			for (const [i, statement] of split.entries()) {
				const control = transactionControl(statement)
				if (control !== undefined) {
					return refuse({
						kind: "transactionControl",
						folder,
						file: name,
						statement: i + 1,
						control
					})
				}
				const filled = resolveVariables(statement, installation)
				if (!filled.ok) {
					return refuse({
						kind: "variable",
						folder,
						file: name,
						statement: i + 1,
						fault: filled.error
					})
				}
				statements.push(reviewed(filled.value))
			}
			files.push({
				name,
				ordinal,
				text,
				digest: sha256ChunksHex(text),
				noTransaction: isNoTransaction(new ChunkView(text)),
				statements,
				advice: statedAdvice(meta.success, { name, text })
			})
		}
		folders.push({
			name: folder,
			meta: meta.success,
			metaDigest: source.metaDigest,
			files
		})
	}
	folders.sort((a, b) => compareCodePoints(a.name, b.name))
	return Result.succeed({ schema, snapshot, folders })
}
