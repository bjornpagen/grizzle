/**
 * The apply runner's pure parts (adapter/migrate): the input check before any connection, transaction-control refusal,
 * and the plan with its resume and refusals. The drift check after an apply is test/pg/admission's.
 *
 * - **Transaction control:** a statement is refused exactly when PostgreSQL's grammar reads it as controlling a
 *   transaction, past comments of both kinds, its keywords in any case.
 * - **The input check:** a target of a prefix of the shop's chain parses into its folders in name order, each file at
 *   its ordinal with its transaction mode; one fault planted at a drawn folder is refused at stage input with exactly
 *   that fault, at that folder.
 * - **The plan:** against a ledger of applied folders, the plan resumes the partial folder at its first file without a
 *   row, applies the rest, and refuses an applied file edited, renamed or deleted, or a file added to a completed
 *   folder, naming every such file. A partial folder redrafted since it started resumes under the redraft, its ledger
 *   rows to take the redraft's meta.json digest and target, when it keeps its source and file count, its meta.json
 *   records every completed file as it ran, and the file it resumes at runs in a transaction; otherwise it is refused.
 *
 * A folder's files as the reviewer leaves them: unedited, or each file's text through `edit`.
 *
 * Oracles: PostgreSQL's grammar of transaction control, per statement form; the documented input faults and the plan's
 * documented resume and refusals, restated over the drawn target and ledger.
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): migrate-rollback-work-to.patch (ROLLBACK WORK TO read as a
 * transaction's rollback), migrate-applied-edit-unseen.patch (an applied file edited afterwards goes unnoticed).
 * Plants (~/.cache/grizzle-release/LEDGERRESUME/plants): redraft-source-unchecked.patch (a redraft of another source
 * resumes), redraft-record-unchecked.patch (a redraft that does not record a completed file as it ran resumes),
 * partial-digest-unchecked.patch (the partial folder's completed files are not compared with the texts that ran),
 * redraft-no-transaction-admitted.patch (a redraft resumes at a no-transaction file).
 *
 * Features: each statement form and comment placement; each input fault; each plan's resume and refusal.
 */
import { inspect } from "node:util"
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, pipe, String as Str } from "effect"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import { type ParsedTarget, parseTarget, transactionControl } from "#adapter/migrate/input.ts"
import { planApply, runFiles } from "#adapter/migrate/plan.ts"
import { indices } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import type { LedgerState, RecordedFolder } from "#compiler/deploy/ledger/ledger.ts"
import { type MigrationFolder, writeMeta } from "#compiler/deploy/render/folder.ts"
import { type GenerateResult, generateMigration } from "#compiler/deploy/render/generate.ts"
import { confirmMarker, placeholderMarker } from "#compiler/deploy/render/markers.ts"
import type { InstallationNames } from "#compiler/deploy/render/variables.ts"
import { emptyFingerprint, emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { placeholderToken } from "#compiler/sql/print.ts"
import { assert, defined, failed, succeeded } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	compile,
	draftChain,
	draftedAt,
	fromEmpty,
	noDeclarations,
	parsedMigrationName,
	unowned
} from "#test/support/migrate/kit.ts"
import { draftFiles } from "#test/support/migrate/review.ts"
import { upTo } from "#test/support/up-to.ts"
import { shopV1, shopV2, shopV3, shopV3Declared } from "#test/unit/deploy/schemas.ts"

/** The installation every parse here fills its statements under: the stems role space, as without a role prefix. */
const stemsInstallation: InstallationNames = { database: "unparsed", roles: { kind: "stems" } }

/** The schema every version of the shop is installed under, and its PostgreSQL schema. */
const shopSchema = atName("shop")
const shop = identifierOf(identity.schema(parsedSchemaName("shop")))

/** A file of a folder: its name and its text. */
interface FileText {
	readonly name: string
	readonly text: string
}

const unedited = (file: FileText): string => file.text
const source = (folder: MigrationFolder, edit: (file: FileText) => string) => ({
	name: folder.name,
	metaText: folder.metaText,
	files: Arr.map(folder.files, (f) => ({ name: f.name, text: edit(f) }))
})

/**
 * A reviewer who resolves every marker and leaves each loss of stored data undecided, its statement commented below
 * its two lines; and one who also writes each loss's statement in.
 */
const leavingLosses = ({ text }: FileText): string =>
	pipe(
		Arr.join(
			Arr.filter(Str.split(text, "\n"), (l) => !Str.startsWith("-- grizzle: placeholder")(l)),
			"\n"
		),
		Str.replaceAll("__GRIZZLE_PLACEHOLDER__", "'0'")
	)

const review = (file: FileText): string => {
	const lines = Str.split(leavingLosses(file), "\n")
	return Arr.join(
		Arr.map(lines, (l, i) =>
			Option.exists(Arr.get(lines, i - 2), Str.startsWith("-- grizzle: data loss"))
				? Str.slice("-- ".length)(l)
				: l
		),
		"\n"
	)
}

/** Three versions of the shop, drafted as a chain from the empty snapshot: a folder each, the second and third with
 * placeholders, the second with a file that runs outside a transaction. */
const shopChain = draftChain(
	[
		{
			desc: shopV1,
			options: { schema: shopSchema, owner: unowned, extensions: [], codes: firstCodes },
			declared: noDeclarations
		},
		{
			desc: shopV2,
			options: { schema: shopSchema, owner: unowned, extensions: [], codes: firstCodes },
			declared: noDeclarations
		},
		{
			desc: shopV3,
			options: { schema: shopSchema, owner: unowned, extensions: [], codes: firstCodes },
			declared: shopV3Declared
		}
	],
	fromEmpty
)

/**
 * A schema's first migration started beside an abandoned one: every drop is declared, so starting it empty beside the
 * schemas its directory still holds is the one loss a draft leaves undecided.
 */
const abandoning = succeeded(
	generateMigration({
		previous: emptySnapshot({ schemaName: "Shop", schema: shop }),
		installation: compile(shopV1, {
			schema: shopSchema,
			owner: unowned,
			extensions: [],
			codes: firstCodes
		}),
		workload: noWorkload,
		declared: noDeclarations,
		abandoned: [{ schema: "Store", directory: "store" }],
		naming: { kind: "named", name: parsedMigrationName("step_1") },
		timestamp: draftedAt(1)
	})
)

/** The shop's empty snapshot: no folder applied. */
const emptyShop = emptySnapshot({ schemaName: "Shop", schema: shop })

/** Whether a file holds a marker grizzle migrate refuses: a placeholder's or a confirm's line, or a placeholder token. */
const marked = (text: string): boolean =>
	Str.includes(placeholderMarker)(text) ||
	Str.includes(confirmMarker)(text) ||
	Str.includes(placeholderToken)(text)

/**
 * A statement's text as parts. Each form of a statement that names a transaction is drawn as PostgreSQL's grammar
 * spells it (gram.y TransactionStmt and TransactionStmtLegacy), keywords in any case, with what the reader must
 * answer: the controlling command, or none. The other forms: a savepoint set, released or rolled back to, a statement
 * PREPAREd as a server statement under any name (`transaction` among them), a DO block whose body commits, a plain statement, and a keyword
 * continued past its letters, which is another word. Before and between the parts go whitespace and comments of both
 * kinds: a line comment ended by a line feed, a CR LF or a lone carriage return, and a block comment, nested or not,
 * holding a quote, a `--`, a `/*` or a keyword. A transaction's identifier is a string constant holding `--`.
 */
/** A keyword in any case: each letter upper or lower by a decision of its own, shrinking toward lowercase. */
const kw =
	(keyword: string): Gen<string> =>
	(source) =>
		Arr.join(
			Arr.map(Str.split(keyword, ""), (ch) =>
				Str.toUpperCase(ch) !== ch && source.draw(boolean) ? Str.toUpperCase(ch) : ch
			),
			""
		)
const one =
	(...keywords: Arr.NonEmptyReadonlyArray<string>): Gen<string> =>
	(source) =>
		source.draw(kw(source.draw(element(keywords))))

const maybe = (parts: Gen<ReadonlyArray<string>>): Gen<ReadonlyArray<string>> =>
	oneOf([constant([]), parts])

const seq =
	(...parts: ReadonlyArray<Gen<ReadonlyArray<string>>>): Gen<ReadonlyArray<string>> =>
	(source) =>
		Arr.flatMap(parts, (part) => source.draw(part))

const single = (part: Gen<string>): Gen<ReadonlyArray<string>> => map(part, (p) => [p])

const workOrTransaction = maybe(single(one("work", "transaction")))
const andChain = maybe(
	oneOf([
		seq(single(kw("and")), single(kw("chain"))),
		seq(single(kw("and")), single(kw("no")), single(kw("chain")))
	])
)
const gid = single(element(["'gid -- not a comment'", "E'g''id'", "$$gid -- x$$"]))
const savepoint = single(element(["s", "sp1", '"Save -- point"']))

type FormName =
	| "BEGIN"
	| "START TRANSACTION"
	| "COMMIT"
	| "COMMIT PREPARED"
	| "END"
	| "ABORT"
	| "ROLLBACK"
	| "ROLLBACK PREPARED"
	| "PREPARE TRANSACTION"
	| "SAVEPOINT"
	| "RELEASE"
	| "ROLLBACK TO"
	| "PREPARE a statement"
	| "DO a block that commits"
	| "a plain statement"
	| "a keyword continued past its letters"

interface Form {
	readonly name: FormName
	readonly parts: ReadonlyArray<string>
	readonly control: string | undefined
}

const form = (
	name: FormName,
	control: string | undefined,
	parts: Gen<ReadonlyArray<string>>
): Gen<Form> => map(parts, (p) => ({ name, parts: p, control }))

const formGen: Gen<Form> = oneOf([
	form(
		"BEGIN",
		"BEGIN",
		seq(
			single(kw("begin")),
			workOrTransaction,
			maybe(
				oneOf([
					seq(single(kw("isolation")), single(kw("level")), single(kw("serializable"))),
					seq(single(kw("read")), single(kw("only")))
				])
			)
		)
	),
	form(
		"START TRANSACTION",
		"START",
		seq(
			single(kw("start")),
			single(kw("transaction")),
			maybe(seq(single(kw("read")), single(kw("write"))))
		)
	),
	form("COMMIT", "COMMIT", seq(single(kw("commit")), workOrTransaction, andChain)),
	form("COMMIT PREPARED", "COMMIT", seq(single(kw("commit")), single(kw("prepared")), gid)),
	form("END", "END", seq(single(kw("end")), workOrTransaction, andChain)),
	form("ABORT", "ABORT", seq(single(kw("abort")), workOrTransaction, andChain)),
	form("ROLLBACK", "ROLLBACK", seq(single(kw("rollback")), workOrTransaction, andChain)),
	form("ROLLBACK PREPARED", "ROLLBACK", seq(single(kw("rollback")), single(kw("prepared")), gid)),
	form(
		"PREPARE TRANSACTION",
		"PREPARE TRANSACTION",
		seq(single(kw("prepare")), single(kw("transaction")), gid)
	),
	form("SAVEPOINT", undefined, seq(single(kw("savepoint")), savepoint)),
	form("RELEASE", undefined, seq(single(kw("release")), maybe(single(kw("savepoint"))), savepoint)),
	form(
		"ROLLBACK TO",
		undefined,
		seq(
			single(kw("rollback")),
			workOrTransaction,
			single(kw("to")),
			maybe(single(kw("savepoint"))),
			savepoint
		)
	),
	form(
		"PREPARE a statement",
		undefined,
		seq(
			single(kw("prepare")),
			single(one("q", "transaction", "transaction1", "transaction$x", "work")),
			maybe(constant(["(", "int", ")"])),
			single(kw("as")),
			single(kw("select")),
			constant(["1"])
		)
	),
	form(
		"DO a block that commits",
		undefined,
		seq(single(kw("do")), constant(["$$ BEGIN COMMIT; END $$"]))
	),
	form(
		"a plain statement",
		undefined,
		element<ReadonlyArray<string>>([
			["SELECT", "1"],
			["CREATE", "INDEX", "CONCURRENTLY", "i", "ON", "t", "(", "c", ")"]
		])
	),
	form(
		"a keyword continued past its letters",
		undefined,
		seq(
			single(
				(source) =>
					`${source.draw(one("begin", "start", "commit", "end", "abort", "rollback"))}${source.draw(element(["2", "$", "é"]))}`
			),
			maybe(single(kw("transaction")))
		)
	)
])

type PieceKind =
	| "space"
	| "line"
	| "line ended by a lone carriage return"
	| "block"
	| "nested block"

interface Piece {
	readonly kind: PieceKind
	readonly text: string
}

const pieceGen: Gen<Piece> = oneOf([
	map(element([" ", "\t", "\n", "\r", "\r\n", "\f", "\v"]), (text): Piece => ({
		kind: "space",
		text
	})),
	(source): Piece => {
		const body = source.draw(
			element([" plain", " don't", " /* no block", " */", " -- again", " COMMIT", ' "q"'])
		)
		const end = source.draw(element(["\n", "\r\n", "\r"]))
		return {
			kind: end === "\r" ? "line ended by a lone carriage return" : "line",
			text: `--${body}${end}`
		}
	},
	map(
		array(
			element([
				" it's ",
				" -- no line comment ",
				"\n",
				" /* nested */ ",
				" /* a /* b */ c */ ",
				" COMMIT "
			]),
			{ min: 0, max: 3 }
		),
		(inner): Piece => {
			const body = Arr.join(inner, "")
			return { kind: Str.includes("/*")(body) ? "nested block" : "block", text: `/*${body}*/` }
		}
	)
])

interface StatementDraw {
	readonly form: Form
	/** Before each part: the first's may be empty, every other's holds a piece at least. */
	readonly before: ReadonlyArray<ReadonlyArray<Piece>>
	readonly end: string
}

const statementGen: Gen<StatementDraw> = (source) => ({
	form: source.draw(formGen),
	before: source.draw(array(array(pieceGen, { min: 0, max: 3 }), { min: 12, max: 12 })),
	end: source.draw(element(["", ";", " ;", "\n"]))
})

/** The pieces before each part, a space where none was drawn between two parts. */
const gaps = (d: StatementDraw): ReadonlyArray<ReadonlyArray<Piece>> =>
	Arr.map(indices(d.form.parts.length), (i) => {
		const pieces = d.before[i] ?? []
		return i > 0 && pieces.length === 0 ? [{ kind: "space", text: " " }] : pieces
	})

const statementText = (d: StatementDraw): string => {
	const before = gaps(d)
	return `${Arr.join(
		Arr.map(
			d.form.parts,
			(part, i) =>
				`${Arr.join(
					Arr.map(before[i] ?? [], (p) => p.text),
					""
				)}${part}`
		),
		""
	)}${d.end}`
}

type ControlFeature =
	| FormName
	| "a line comment ended by a lone carriage return before a part"
	| "a nested block comment before a part"
	| "a comment between two parts"

describe("transaction control in a migration file", () => {
	it.effect(
		"refuses exactly the statements PostgreSQL's grammar reads as controlling a transaction, past comments of both kinds",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "PostgreSQL's grammar of transaction control (gram.y TransactionStmt), per statement form"
						},
						suite: "unit/adapter/transaction-control",
						draw: drawn(statementGen),
						literal: Formatter.format,
						coverage: required<ControlFeature>(
							[
								"BEGIN",
								"START TRANSACTION",
								"COMMIT",
								"COMMIT PREPARED",
								"END",
								"ABORT",
								"ROLLBACK",
								"ROLLBACK PREPARED",
								"PREPARE TRANSACTION",
								"SAVEPOINT",
								"RELEASE",
								"ROLLBACK TO",
								"PREPARE a statement",
								"DO a block that commits",
								"a plain statement",
								"a keyword continued past its letters",
								"a line comment ended by a lone carriage return before a part",
								"a nested block comment before a part",
								"a comment between two parts"
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(d, c) =>
						Effect.sync(() => {
							const text = statementText(d)
							assert.equal(transactionControl(text), d.form.control, inspect(text))
							c.note(d.form.name)
							const pieces = gaps(d).flat()
							if (Arr.some(pieces, (p) => p.kind === "line ended by a lone carriage return")) {
								c.note("a line comment ended by a lone carriage return before a part")
							}
							if (Arr.some(pieces, (p) => p.kind === "nested block")) {
								c.note("a nested block comment before a part")
							}
							if (Arr.some(gaps(d).slice(1), (g) => Arr.some(g, (p) => p.kind !== "space"))) {
								c.note("a comment between two parts")
							}
						})
				)
			)
	)
})

/**
 * The input check before any connection (migrate/input.ts parseTarget): a target of a prefix of the shop's chain, its
 * folders in a drawn order, each reviewed or not, is parsed into its folders in name order, each file at its ordinal
 * with the transaction mode its draft wrote; the empty snapshot with no folder is one target. One fault planted at a
 * drawn folder is refused at stage input with exactly that fault, at that folder: a name that is no folder name, a
 * folder given twice, a meta.json grizzle did not write or of another schema, a file given twice, meta.json among the
 * files, a file that is not `NN-<phase>.sql` or a second of one ordinal, and a statement controlling its transaction.
 */
type InputFaultKind =
	| "folderName"
	| "repeatedFolder"
	| "malformedMeta"
	| "foreignMeta"
	| "repeatedFile"
	| "metaAmongFiles"
	| "fileNames"
	| "transactionControl"

type InputFault =
	| { readonly kind: "none" }
	| { readonly kind: "folderName"; readonly at: number; readonly name: string }
	| { readonly kind: "repeatedFolder"; readonly at: number }
	| { readonly kind: "malformedMeta"; readonly at: number; readonly text: string }
	| { readonly kind: "foreignMeta"; readonly at: number }
	| { readonly kind: "repeatedFile"; readonly at: number; readonly file: number }
	| { readonly kind: "metaAmongFiles"; readonly at: number }
	| {
			readonly kind: "fileNames"
			readonly at: number
			readonly name: "notes.txt" | "a second of one ordinal"
	  }
	| {
			readonly kind: "transactionControl"
			readonly at: number
			readonly file: number
			readonly control: string
	  }

interface InputCase {
	readonly versions: number
	readonly order: ReadonlyArray<number>
	readonly reviewed: ReadonlyArray<boolean>
	readonly fault: InputFault
}

const faultGen: Gen<InputFault> = (source) => {
	const at = source.draw(int(0, 0xffff))
	return source.draw(
		oneOf<InputFault>([
			map(element(["init", "2026_x", "20261024000000", "", "20261024000000_Step"]), (name) => ({
				kind: "folderName",
				at,
				name
			})),
			constant({ kind: "repeatedFolder", at }),
			map(element(["", "{", "{}", "[]", "null"]), (text) => ({ kind: "malformedMeta", at, text })),
			constant({ kind: "foreignMeta", at }),
			map(int(0, 0xffff), (file) => ({ kind: "repeatedFile", at, file })),
			constant({ kind: "metaAmongFiles", at }),
			map(element(["notes.txt", "a second of one ordinal"] as const), (name) => ({
				kind: "fileNames",
				at,
				name
			})),
			(inner) => ({
				kind: "transactionControl",
				at,
				file: inner.draw(int(0, 0xffff)),
				control: inner.draw(element(["COMMIT", "BEGIN", "ROLLBACK", "END", "START TRANSACTION"]))
			})
		])
	)
}

const inputCaseGen: Gen<InputCase> = (source) => {
	const versions = source.draw(int(0, shopChain.length))
	return {
		versions,
		order: source.draw(shuffled(indices(versions), { min: versions, max: versions })),
		reviewed: source.draw(array(boolean, { min: versions, max: versions })),
		fault:
			versions === 0
				? { kind: "none" }
				: source.draw(
						weighted([
							[1, constant<InputFault>({ kind: "none" })],
							[4, faultGen]
						])
					)
	}
}

/** A folder as the command line hands it over. */
type FolderSource = ReturnType<typeof source>

/** The folders of a case as handed over, the fault planted, and the refusal the fault is, at its folder. */
const plantedFolders = (
	folders: ReadonlyArray<FolderSource>,
	fault: InputFault
): {
	readonly folders: ReadonlyArray<FolderSource>
	readonly refusal: { readonly kind: InputFaultKind; readonly folder: string } | undefined
} => {
	if (fault.kind === "none") {
		return { folders, refusal: undefined }
	}
	const at = fault.at % folders.length
	const folder = defined(folders[at], "the faulted folder")
	const replaced = (replacement: ReadonlyArray<FolderSource>): ReadonlyArray<FolderSource> => [
		...Arr.take(folders, at),
		...replacement,
		...Arr.drop(folders, at + 1)
	]
	const fileAt = (pick: number) => pick % folder.files.length
	const refused = (kind: InputFaultKind, name: string) => ({ kind, folder: name })
	switch (fault.kind) {
		case "folderName":
			return {
				folders: replaced([{ ...folder, name: fault.name }]),
				refusal: refused("folderName", fault.name)
			}
		case "repeatedFolder":
			return {
				folders: replaced([folder, folder]),
				refusal: refused("repeatedFolder", folder.name)
			}
		case "malformedMeta":
			return {
				folders: replaced([{ ...folder, metaText: fault.text }]),
				refusal: refused("malformedMeta", folder.name)
			}
		case "foreignMeta": {
			const meta = succeeded(
				writeMeta({
					...defined(
						Arr.findFirst(shopChain, (g) => g.folder.name === folder.name).pipe(
							Option.getOrUndefined
						),
						"the folder's draft"
					).folder.meta,
					schema: "other"
				}),
				"meta.json of another schema, sealed"
			)
			return {
				folders: replaced([{ ...folder, metaText: meta }]),
				refusal: refused("foreignMeta", folder.name)
			}
		}
		case "repeatedFile": {
			const file = defined(folder.files[fileAt(fault.file)], "a file")
			return {
				folders: replaced([{ ...folder, files: [...folder.files, file] }]),
				refusal: refused("repeatedFile", folder.name)
			}
		}
		case "metaAmongFiles":
			return {
				folders: replaced([
					{ ...folder, files: [...folder.files, { name: "meta.json", text: folder.metaText }] }
				]),
				refusal: refused("metaAmongFiles", folder.name)
			}
		case "fileNames": {
			const first = defined(folder.files[0], "a folder's first file")
			const stray =
				fault.name === "notes.txt"
					? { name: "notes.txt", text: "" }
					: { name: `${Str.slice(0, 2)(first.name)}-again.sql`, text: "SELECT 1;\n" }
			return {
				folders: replaced([{ ...folder, files: [...folder.files, stray] }]),
				refusal: refused("fileNames", folder.name)
			}
		}
		case "transactionControl": {
			const target = fileAt(fault.file)
			return {
				folders: replaced([
					{
						...folder,
						files: Arr.map(folder.files, (f, i) =>
							i === target ? { ...f, text: `${f.text}\n${fault.control};\n` } : f
						)
					}
				]),
				refusal: refused("transactionControl", folder.name)
			}
		}
	}
}

type InputFeature =
	| "the empty snapshot with no folders"
	| "folders handed over out of order"
	| "a file outside a transaction"
	| `refused ${InputFaultKind}`

describe("the input check before any connection", () => {
	it.effect(
		"orders the folders by name and the files by ordinal with each one's mode, and refuses each fault planted in them at stage input, naming it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/migrate-input",
						draw: drawn(inputCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the chain's drafts in name order, each fault's refusal planted at its folder"
						},
						coverage: required<InputFeature>(
							[
								"the empty snapshot with no folders",
								"folders handed over out of order",
								"a file outside a transaction",
								"refused folderName",
								"refused repeatedFolder",
								"refused malformedMeta",
								"refused foreignMeta",
								"refused repeatedFile",
								"refused metaAmongFiles",
								"refused fileNames",
								"refused transactionControl"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 150,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const drafts = Arr.take(shopChain, c.versions)
							const handed = Arr.map(c.order, (i) => {
								const g = defined(drafts[i], "a version's draft")
								return source(g.folder, c.reviewed[i] === true ? review : unedited)
							})
							const snapshot = Option.match(Arr.last(drafts), {
								onNone: () => emptyShop,
								onSome: (g) => g.snapshot
							})
							const planted = plantedFolders(handed, c.fault)
							const parsed = parseTarget({ snapshot, folders: planted.folders }, stemsInstallation)
							if (planted.refusal !== undefined) {
								const reason = failed(parsed).reason
								assert.deepEqual(
									{
										stage: failed(parsed).stage,
										fault: reason._tag === "InputRefused" ? reason.fault.kind : reason._tag,
										folder:
											reason._tag === "InputRefused" && reason.fault.kind !== "repeatedSchema"
												? reason.fault.folder
												: undefined
									},
									{ stage: "input", fault: planted.refusal.kind, folder: planted.refusal.folder }
								)
								k.note(`refused ${planted.refusal.kind}`)
								return
							}
							const target = succeeded(parsed)
							assert.deepEqual(
								Arr.map(target.folders, (f) => ({
									name: f.name,
									files: Arr.map(
										f.files,
										(file) => [file.name, file.ordinal, file.noTransaction] as const
									)
								})),
								Arr.map(drafts, (g) => ({
									name: g.folder.name,
									files: Arr.map(draftFiles(g), (d, i) => [d.name, i + 1, !d.transaction] as const)
								}))
							)
							if (c.versions === 0) {
								k.note("the empty snapshot with no folders")
							}
							if (Arr.some(c.order, (position, i) => position !== i)) {
								k.note("folders handed over out of order")
							}
							if (
								Arr.some(target.folders, (f) => Arr.some(f.files, (file) => file.noTransaction))
							) {
								k.note("a file outside a transaction")
							}
						})
				)
			)
	)
})

/**
 * The plan (migrate/plan.ts planApply): which folders an apply runs, decided before any statement.
 *
 * Over drawn targets and ledgers: the shop's chain of three folders, or a schema's first migration beside an abandoned
 * one; which of the chain's folders the target holds, each reviewed or not (markers left, or losses left undecided);
 * the snapshot it knows, the empty one or a version's; a ledger whose first folders completed and whose next is partial,
 * at any of its files; and a recorded file edited after it ran, or a file added to a folder that completed. The partial
 * folder's ledger rows record the draft that started it or another one (a redraft since), of its source or of another,
 * its target kept or another, its file count the folder's or one more, and one of its completed files may have run
 * with a statement no draft records. The oracle is the planner's documented order, restated over the chain's positions:
 * an applied file edited, missing or added stops it first; then each folder in name order is skipped when complete,
 * resumed past its recorded files when partial, started when it continues the ledger's latest target, and refused
 * otherwise, as is a recorded folder whose ledger rows name another target than its meta.json. A partial folder of
 * another file count is refused; one the ledger records under its own draft resumes; one redrafted since resumes under
 * the redraft, the ledger to take the redraft's meta.json digest and target, exactly when the redraft keeps its source
 * and records every completed file as it ran (none run with a statement no draft records, none holding a loss left
 * commented) and the file it resumes at runs in a transaction, and is refused otherwise. The latest target must then
 * be the known snapshot's; then no file that runs may hold a marker, and no folder that runs a loss left undecided.
 */
type ChainName = "the shop" | "a first migration beside an abandoned schema"

type Edit =
	| { readonly kind: "none" }
	| { readonly kind: "a recorded file edited"; readonly pick: number }
	| { readonly kind: "a file added to a complete folder"; readonly pick: number }
	| { readonly kind: "a recorded folder of another target"; readonly pick: number }

/** The draft the ledger's rows record the partial folder under: the one that started it, or a redraft since, of its
 * source or of another, its target kept or another. */
type PartialDraft =
	| { readonly kind: "its own" }
	| {
			readonly kind: "a redraft"
			readonly source: "kept" | "another"
			readonly target: "kept" | "another"
	  }

interface PlanCase {
	readonly chain: ChainName
	readonly held: ReadonlyArray<boolean>
	readonly reviewed: ReadonlyArray<boolean>
	/** The known snapshot: the empty one, -1, or a version's. */
	readonly known: number
	readonly complete: number
	readonly partial:
		| { readonly kind: "none" }
		| {
				readonly kind: "partial"
				readonly recorded: number
				readonly draft: PartialDraft
				/** The file count its rows record: the folder's, or one more. */
				readonly files: "kept" | "one more"
				/** A completed file that ran with a statement no draft records, picked among them. */
				readonly extra: Option.Option<number>
		  }
	readonly edit: Edit
}

const chainOf = (name: ChainName) => (name === "the shop" ? shopChain : [abandoning])

const planCaseGen: Gen<PlanCase> = (source) => {
	const chain = source.draw(
		weighted<ChainName>([
			[4, constant("the shop")],
			[1, constant("a first migration beside an abandoned schema")]
		])
	)
	const length = chainOf(chain).length
	const complete = source.draw(int(0, length))
	return {
		chain,
		held: source.draw(
			weighted<ReadonlyArray<boolean>>([
				[3, constant(upTo(length, () => true))],
				[1, array(boolean, { min: length, max: length })]
			])
		),
		reviewed: source.draw(
			weighted<ReadonlyArray<boolean>>([
				[3, constant(upTo(length, () => true))],
				[1, array(boolean, { min: length, max: length })]
			])
		),
		known: source.draw(
			weighted([
				[4, constant(length - 1)],
				[1, int(-1, length - 1)]
			])
		),
		complete,
		partial:
			complete === length
				? { kind: "none" }
				: source.draw(
						oneOf<PlanCase["partial"]>([
							constant({ kind: "none" }),
							(s): PlanCase["partial"] => ({
								kind: "partial",
								recorded: s.draw(int(0, 0xffff)),
								draft: s.draw(
									weighted<PartialDraft>([
										[2, constant({ kind: "its own" })],
										[
											2,
											(d) => ({
												kind: "a redraft",
												source: d.draw(
													weighted<"kept" | "another">([
														[3, constant("kept")],
														[1, constant("another")]
													])
												),
												target: d.draw(element(["kept", "another"]))
											})
										]
									])
								),
								files: s.draw(
									weighted<"kept" | "one more">([
										[5, constant("kept")],
										[1, constant("one more")]
									])
								),
								extra: s.draw(
									weighted<Option.Option<number>>([
										[3, constant(Option.none())],
										[1, map(int(0, 0xffff), Option.some)]
									])
								)
							})
						])
					),
		edit: source.draw(
			weighted<Edit>([
				[4, constant({ kind: "none" })],
				[1, map(int(0, 0xffff), (pick) => ({ kind: "a recorded file edited", pick }))],
				[1, map(int(0, 0xffff), (pick) => ({ kind: "a file added to a complete folder", pick }))],
				[1, map(int(0, 0xffff), (pick) => ({ kind: "a recorded folder of another target", pick }))]
			])
		)
	}
}

/** A folder of the chain as the case's reviewer leaves it. */
const reviewedSource = (c: PlanCase, folder: MigrationFolder, i: number): FolderSource =>
	source(
		folder,
		c.chain === "the shop"
			? c.reviewed[i] === true
				? review
				: unedited
			: c.reviewed[i] === true
				? review
				: leavingLosses
	)

/** The ledger rows of a parsed folder's first `files` files and its folder row. */
const recordedOf = (folder: ParsedTarget["folders"][number], files: number): RecordedFolder => ({
	folder: folder.name,
	source: folder.meta.source,
	target: folder.meta.target,
	files: folder.files.length,
	meta: folder.metaDigest,
	completed: Arr.map(Arr.take(folder.files, files), (f) => ({
		ordinal: f.ordinal,
		file: f.name,
		digest: f.digest
	}))
})

/**
 * A case's partial folder, resolved against its chain: its index, how many of its files completed, the draft its rows
 * record, its recorded file count, and the completed file that ran with a statement no draft records, by index.
 */
interface PartialFolder {
	readonly index: number
	readonly recorded: number
	readonly draft: PartialDraft
	readonly files: "kept" | "one more"
	readonly extra: Option.Option<number>
}

const partialOf = (
	c: PlanCase,
	chain: ReadonlyArray<GenerateResult>
): PartialFolder | undefined => {
	const p = c.partial
	if (p.kind === "none") {
		return undefined
	}
	const recorded = p.recorded % defined(chain[c.complete], "the partial folder").folder.files.length
	return {
		index: c.complete,
		recorded,
		draft: p.draft,
		files: p.files,
		extra: recorded === 0 ? Option.none() : Option.map(p.extra, (pick) => pick % recorded)
	}
}

/** The partial folder's rows as its draft records them, from the rows `rows` of the draft that started it. */
const underDraft = (p: PartialFolder, rows: RecordedFolder): RecordedFolder => {
	const files = p.files === "one more" ? rows.files + 1 : rows.files
	const draft = p.draft
	return draft.kind === "its own"
		? { ...rows, files }
		: {
				...rows,
				files,
				meta: "the digest of another draft's meta.json",
				source: draft.source === "another" ? strangerFingerprint : rows.source,
				target: draft.target === "another" ? strangerFingerprint : rows.target
			}
}

/** A fingerprint no folder of any chain starts from or reaches: a redraft's other source or target. */
const strangerFingerprint = SchemaFingerprint(Str.repeat(64)("f"))

/** The statement a completed file ran with that no draft records. */
const unrecordedStatement = "\nSELECT 1;\n"

/** The files of a drafted folder holding a loss of stored data, as its meta.json records them. */
const lossFiles = (folder: MigrationFolder): ReadonlyArray<string> =>
	folder.meta.kind === "drafted"
		? Arr.flatMap(folder.meta.files, (f) =>
				Arr.some(f.steps, (st) => st.kind === "loss") ? [f.name] : []
			)
		: []

/** A run as the model states it: a redraft's with what its ledger rows take. */
type RunVerdict = {
	readonly folder: string
	readonly ordinals: ReadonlyArray<number>
} & (
	| { readonly kind: "start" | "resume" }
	| {
			readonly kind: "redraft"
			readonly record: { readonly meta: string; readonly target: string }
	  }
)

/** What the planner decides, as the model states it. */
type PlanVerdict =
	| {
			readonly kind: "plan"
			readonly runs: ReadonlyArray<RunVerdict>
			readonly after: string
	  }
	| {
			readonly kind: "refused"
			readonly reason:
				| "AppliedEdited"
				| "FolderRefused"
				| "SnapshotUnreached"
				| "MarkersUnresolved"
				| "LossesUndecided"
	  }

type PlanFeature =
	| "every folder run from the empty snapshot"
	| "the applied folders skipped"
	| "a partial folder resumed"
	| "a partial folder resumed under a redraft of another target"
	| "a partial folder resumed under a redraft of its target"
	| "a redraft of another source refused"
	| "a redraft not recording a completed file refused"
	| "a partial folder of another file count refused"
	| "a redraft resuming at a no-transaction file refused"
	| "a folder started after a resumed one"
	| "nothing to run"
	| `refused ${Extract<PlanVerdict, { readonly kind: "refused" }>["reason"]}`

describe("the plan: skip, resume, run, or refuse before any statement", () => {
	it.effect(
		"runs exactly the folders the ledger has not applied, resuming the partial one, or refuses in the documented order",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/migrate-plan",
						draw: drawn(planCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the planner's documented order, restated over the chain's positions"
						},
						coverage: required<PlanFeature>(
							[
								"every folder run from the empty snapshot",
								"the applied folders skipped",
								"a partial folder resumed",
								"a partial folder resumed under a redraft of another target",
								"a partial folder resumed under a redraft of its target",
								"a redraft of another source refused",
								"a redraft not recording a completed file refused",
								"a partial folder of another file count refused",
								"a redraft resuming at a no-transaction file refused",
								"a folder started after a resumed one",
								"nothing to run",
								"refused AppliedEdited",
								"refused FolderRefused",
								"refused SnapshotUnreached",
								"refused MarkersUnresolved",
								"refused LossesUndecided"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const chain = chainOf(c.chain)
							const partial = partialOf(c, chain)
							/** Every folder as the reviewer left it, the extra statement of the partial folder's file in it. */
							const sources = Arr.map(chain, (g, i) => {
								const reviewed = reviewedSource(c, g.folder, i)
								const extra = partial?.index === i ? partial.extra : Option.none()
								return Option.match(extra, {
									onNone: () => reviewed,
									onSome: (at) => ({
										...reviewed,
										files: Arr.map(reviewed.files, (f, j) =>
											j === at ? { ...f, text: `${f.text}${unrecordedStatement}` } : f
										)
									})
								})
							})
							/** Every folder as it ran, which the ledger's digests record. */
							const ran = succeeded(
								parseTarget(
									{
										snapshot: defined(Arr.last(chain).pipe(Option.getOrUndefined), "a draft")
											.snapshot,
										folders: sources
									},
									stemsInstallation
								)
							).folders
							const recordedFolders = [
								...Arr.map(Arr.take(ran, c.complete), (f) => ({
									folder: f,
									files: f.files.length
								})),
								...(partial === undefined
									? []
									: [{ folder: defined(ran[partial.index]), files: partial.recorded }])
							]
							/** The recorded folder whose ledger rows name the empty snapshot as its target, which none of the
							 * chain's folders targets. */
							const moved =
								c.edit.kind === "a recorded folder of another target" && recordedFolders.length > 0
									? c.edit.pick % recordedFolders.length
									: undefined
							const recordedAt = (
								i: number,
								folder: ParsedTarget["folders"][number],
								files: number
							): RecordedFolder =>
								i === moved
									? { ...recordedOf(folder, files), target: emptyFingerprint(shop) }
									: recordedOf(folder, files)
							const state: LedgerState = {
								latest:
									c.complete === 0
										? emptyFingerprint(shop)
										: defined(ran[c.complete - 1], "the latest complete folder").meta.target,
								complete: Arr.map(Arr.take(ran, c.complete), (f, i) =>
									recordedAt(i, f, f.files.length)
								),
								partial:
									partial === undefined
										? undefined
										: underDraft(
												partial,
												recordedAt(partial.index, defined(ran[partial.index]), partial.recorded)
											)
							}
							/** The edit, resolved: the recorded file it edits, or the complete folder a file is added to. */
							const recordedFiles = Arr.flatMap(recordedFolders, ({ folder, files }) =>
								Arr.map(Arr.take(folder.files, files), (f) => ({
									folder: folder.name,
									file: f.name
								}))
							)
							const edit = c.edit
							const edited =
								edit.kind === "a recorded file edited" && recordedFiles.length > 0
									? defined(recordedFiles[edit.pick % recordedFiles.length])
									: undefined
							const added =
								edit.kind === "a file added to a complete folder" && c.complete > 0
									? defined(ran[edit.pick % c.complete]).name
									: undefined
							const heldSources = Arr.filter(sources, (_, i) => c.held[i] === true)
							const target = Arr.map(heldSources, (folder) => ({
								...folder,
								files: [
									...Arr.map(folder.files, (f) =>
										edited !== undefined && edited.folder === folder.name && edited.file === f.name
											? { ...f, text: `${f.text}\n-- edited after it ran\n` }
											: f
									),
									...(added === folder.name
										? [
												{
													name: `${Str.padStart(2, "0")(String(folder.files.length + 1))}-added.sql`,
													text: "SELECT 1;\n"
												}
											]
										: [])
								]
							}))
							const known: DeploySnapshot =
								c.known < 0 ? emptyShop : defined(chain[c.known], "the known version").snapshot
							/** The model's notes of the partial folder's decision. */
							const notes: Array<PlanFeature> = []
							/** Whether a redraft fails to record a completed file of the partial folder as it ran: one ran with a
							 * statement no draft records, or holds a loss its reviewer left commented. */
							const unrecorded = (p: PartialFolder): boolean => {
								const drafted = defined(chain[p.index], "the partial folder").folder
								const losses = lossFiles(drafted)
								return (
									Option.isSome(p.extra) ||
									(c.chain === "a first migration beside an abandoned schema" &&
										c.reviewed[p.index] !== true &&
										Arr.some(Arr.take(drafted.files, p.recorded), (f) =>
											Arr.contains(losses, f.name)
										))
								)
							}
							const verdict = ((): PlanVerdict => {
								const recordedIndices = [
									...indices(c.complete),
									...(partial === undefined ? [] : [partial.index])
								]
								if (
									Arr.some(recordedIndices, (i) => c.held[i] !== true) ||
									(edited !== undefined &&
										Arr.some(
											recordedIndices,
											(i) => c.held[i] === true && defined(ran[i]).name === edited.folder
										)) ||
									(added !== undefined &&
										Arr.some(
											indices(c.complete),
											(i) => c.held[i] === true && defined(ran[i]).name === added
										))
								) {
									return { kind: "refused", reason: "AppliedEdited" }
								}
								const runs: Array<{ readonly index: number; readonly run: RunVerdict }> = []
								let latest = c.complete - 1
								for (const i of indices(chain.length)) {
									const redrafted = partial?.index === i && partial.draft.kind === "a redraft"
									if (i === moved && c.held[i] === true && !redrafted) {
										return { kind: "refused", reason: "FolderRefused" }
									}
									if (c.held[i] !== true || i < c.complete) {
										continue
									}
									const folder = defined(ran[i])
									const ordinals = Arr.map(folder.files, (f) => f.ordinal)
									if (partial?.index === i) {
										const draft = partial.draft
										const run = Arr.drop(ordinals, partial.recorded)
										if (draft.kind === "a redraft" && draft.source === "another") {
											notes.push("a redraft of another source refused")
											return { kind: "refused", reason: "FolderRefused" }
										}
										if (partial.files === "one more") {
											notes.push("a partial folder of another file count refused")
											return { kind: "refused", reason: "FolderRefused" }
										}
										if (draft.kind === "its own") {
											runs.push({
												index: i,
												run: { folder: folder.name, kind: "resume", ordinals: run }
											})
										} else if (unrecorded(partial)) {
											notes.push("a redraft not recording a completed file refused")
											return { kind: "refused", reason: "FolderRefused" }
										} else if (folder.files[partial.recorded]?.noTransaction === true) {
											notes.push("a redraft resuming at a no-transaction file refused")
											return { kind: "refused", reason: "FolderRefused" }
										} else {
											runs.push({
												index: i,
												run: {
													folder: folder.name,
													kind: "redraft",
													ordinals: run,
													record: { meta: folder.metaDigest, target: folder.meta.target }
												}
											})
										}
									} else if (i === latest + 1) {
										runs.push({ index: i, run: { folder: folder.name, kind: "start", ordinals } })
									} else {
										return { kind: "refused", reason: "FolderRefused" }
									}
									latest = i
								}
								if (latest !== c.known) {
									return { kind: "refused", reason: "SnapshotUnreached" }
								}
								const runText = ({ index, run }: (typeof runs)[number]) =>
									Arr.flatMap(defined(ran[index]).files, (f) =>
										Arr.contains(run.ordinals, f.ordinal) ? [f.text] : []
									)
								if (Arr.some(runs, (run) => Arr.some(runText(run), marked))) {
									return { kind: "refused", reason: "MarkersUnresolved" }
								}
								if (
									c.chain === "a first migration beside an abandoned schema" &&
									Arr.some(runs, (run) => c.reviewed[run.index] !== true)
								) {
									return { kind: "refused", reason: "LossesUndecided" }
								}
								return {
									kind: "plan",
									runs: Arr.map(runs, ({ run }) => run),
									after: known.fingerprint
								}
							})()
							const parsed = succeeded(
								parseTarget({ snapshot: known, folders: target }, stemsInstallation)
							)
							const planned = planApply(parsed, state)
							if (verdict.kind === "refused") {
								const refusal: MigrateError = failed(planned)
								assert.equal(refusal.reason._tag, verdict.reason)
								k.note(`refused ${verdict.reason}`)
								Arr.forEach(notes, (n) => k.note(n))
								return
							}
							const plan = succeeded(planned)
							assert.deepEqual<PlanVerdict>(
								{
									kind: "plan" as const,
									runs: Arr.map(plan.runs, (r): RunVerdict => {
										const ordinals = Arr.map(runFiles(r), (f) => f.ordinal)
										return r.kind === "redraft"
											? { folder: r.folder.name, kind: r.kind, ordinals, record: r.record }
											: { folder: r.folder.name, kind: r.kind, ordinals }
									}),
									after: plan.after
								},
								verdict
							)
							if (plan.runs.length === 0) {
								k.note("nothing to run")
							}
							if (
								c.complete === 0 &&
								partial === undefined &&
								plan.runs.length === chain.length &&
								chain.length > 1
							) {
								k.note("every folder run from the empty snapshot")
							}
							if (c.complete > 0 && plan.runs.length > 0) {
								k.note("the applied folders skipped")
							}
							if (Arr.some(plan.runs, (r) => r.kind === "resume")) {
								k.note("a partial folder resumed")
							}
							for (const r of plan.runs) {
								if (r.kind === "redraft") {
									k.note(
										state.partial?.target === r.record.target
											? "a partial folder resumed under a redraft of its target"
											: "a partial folder resumed under a redraft of another target"
									)
								}
							}
							if (
								Arr.some(plan.runs, (r) => r.kind !== "start") &&
								Arr.some(plan.runs, (r) => r.kind === "start")
							) {
								k.note("a folder started after a resumed one")
							}
						})
				)
			)
	)
})
