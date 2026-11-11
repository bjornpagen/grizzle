import { Array as Arr, Brand, Result } from "effect"
import { readMeta } from "#adapter/boundary/meta.ts"
import {
	type InputFault,
	InputRefused,
	type MigrateError,
	stopped
} from "#adapter/migrate/errors.ts"
import type { MigrationText } from "#adapter/wire/batch.ts"
import { compareCodePoints, sha256Hex } from "#compiler/plan/common.ts"
import {
	type InstallationNames,
	isFolderName,
	isNoTransaction,
	lex,
	orderFolderFiles,
	type ReadMeta,
	resolveVariables,
	splitStatements,
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
 * - each statement's variables, its installation's roles by their stems and its database (compiler/sql/variables.ts),
 *   are filled with what the installation names them, and a variable none fills is refused: what is sent is the filled
 *   statement, what the ledger records the digest of the file as written, the same in every installation.
 *
 * A folder as the command line read it.
 */
export interface FolderSource {
	/** `<timestamp>_<name>`. */
	readonly name: string
	readonly metaText: string
	/** Every `NN-<phase>.sql` file of the folder; meta.json is metaText. */
	readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>
}

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
	readonly text: string
	/** SHA-256 of the text, which the ledger records. */
	readonly digest: string
	readonly noTransaction: boolean
	/** The file's statements, each as reviewed with its variables filled: the one SQL grizzle sends that its printer did
	 * not print. */
	readonly statements: ReadonlyArray<MigrationText>
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
	const [first, second, third] = lex(statement).tokens
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
		const meta = readMeta(source.metaText)
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
			file: { name, text },
			ordinal
		} of ordered.value) {
			const statements: Array<MigrationText> = []
			for (const [i, statement] of splitStatements(text).entries()) {
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
				digest: sha256Hex(text),
				noTransaction: isNoTransaction(text),
				statements
			})
		}
		folders.push({
			name: folder,
			meta: meta.success,
			metaDigest: sha256Hex(source.metaText),
			files
		})
	}
	folders.sort((a, b) => compareCodePoints(a.name, b.name))
	return Result.succeed({ schema, snapshot, folders })
}
