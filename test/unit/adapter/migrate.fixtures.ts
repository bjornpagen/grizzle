/** What the properties of migrate.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import type { TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	aimed,
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
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, pipe, String as Str } from "effect"
import type { ParsedTarget } from "#adapter/migrate/input.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import type { RecordedFolder } from "#compiler/deploy/ledger/ledger.ts"
import type { DraftFile } from "#compiler/deploy/phases/files.ts"
import { type MigrationFolder, writeMeta } from "#compiler/deploy/render/folder.ts"
import { generateMigration, type GenerateResult } from "#compiler/deploy/render/generate.ts"
import { confirmMarker, placeholderMarker } from "#compiler/deploy/render/markers.ts"
import type { InstallationNames } from "#compiler/deploy/render/variables.ts"
import { emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { databaseLock } from "#compiler/sql/catalog.ts"
import { placeholderToken, printStatement } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { chunked, joined } from "#test/support/chunked.ts"
import { firstCodes } from "#test/support/compile.ts"
import { f, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	compile,
	draftChain,
	draftedAt,
	fromEmpty,
	noDeclarations,
	parsedMigrationName
} from "#test/support/migrate/kit.ts"
import { draftFiles } from "#test/support/migrate/review.ts"
import { shopV1, shopV2, shopV3, shopV3Declared } from "#test/support/unit/deploy/schemas.ts"
import { upTo } from "#test/support/up-to.ts"

/** The installation every parse here fills its statements under: the stems role space, as without a role prefix. */
export const stemsInstallation: InstallationNames = {
	database: "unparsed",
	roles: { kind: "stems" }
}

/** The schema every version of the shop is installed under, and its PostgreSQL schema. */
const shopSchema = atName("shop")

export const shop = identifierOf(identity.schema(parsedSchemaName("shop")))

/** A file of a folder: its name and its text. */
interface FileText {
	readonly name: string
	readonly text: string
}

export const unedited = (file: FileText): string => file.text

export const source = (folder: MigrationFolder, edit: (file: FileText) => string) => ({
	name: folder.name,
	metaText: folder.metaText,
	files: Arr.map(folder.files, (f) => ({
		name: f.name,
		text: chunked(edit({ name: f.name, text: joined(f.text) }))
	}))
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

export const reviewedText = (file: FileText): string => {
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

/**
 * A booking of a room for a span of slots, keyed by both: its key a no-overlap constraint over a GiST index whose room
 * column btree_gist serves, so the version that adds it creates the extension in its first file, a database-wide
 * statement (sql/print.ts commandsOf) before the transactional files after it.
 */
const Booking = relation(
	"Booking",
	{ room: f.uuid, during: f.span(f.integer, undefined), id: f.uuid },
	["room", "during"]
)

/** A version of the shop with the room's bookings beside its relations (Booking). */
const booked = (desc: SchemaDesc): SchemaDesc => ({
	...desc,
	relations: [...desc.relations, Booking]
})

/** Three versions of the shop, drafted as a chain from the empty snapshot: a folder each, the second and third with
 * placeholders, the second with a file that runs outside a transaction, and the second adding the room's bookings, so
 * its first file creates btree_gist, a database-wide statement before a transactional file (planCases). */
export const shopChain = draftChain(
	[
		{
			desc: shopV1,
			options: { schema: shopSchema, extensions: [], codes: firstCodes },
			declared: noDeclarations
		},
		{
			desc: booked(shopV2),
			options: { schema: shopSchema, extensions: [], codes: firstCodes },
			declared: noDeclarations
		},
		{
			desc: booked(shopV3),
			options: { schema: shopSchema, extensions: [], codes: firstCodes },
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
export const emptyShop = emptySnapshot({ schemaName: "Shop", schema: shop })

/** Whether a file holds a marker grizzle migrate refuses: a placeholder's or a confirm's line, or a placeholder token. */
export const marked = (text: string): boolean =>
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

export const statementGen: Gen<StatementDraw> = (source) => ({
	form: source.draw(formGen),
	before: source.draw(array(array(pieceGen, { min: 0, max: 3 }), { min: 12, max: 12 })),
	end: source.draw(element(["", ";", " ;", "\n"]))
})

/** The pieces before each part, a space where none was drawn between two parts. */
export const gaps = (d: StatementDraw): ReadonlyArray<ReadonlyArray<Piece>> =>
	Arr.map(indices(d.form.parts.length), (i) => {
		const pieces = d.before[i] ?? []
		return i > 0 && pieces.length === 0 ? [{ kind: "space", text: " " }] : pieces
	})

export const drawnStatementText = (d: StatementDraw): string => {
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

export type ControlFeature =
	| FormName
	| "a line comment ended by a lone carriage return before a part"
	| "a nested block comment before a part"
	| "a comment between two parts"

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

export const inputCaseGen: Gen<InputCase> = (source) => {
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
type FolderTexts = ReturnType<typeof source>

/** The folders of a case as handed over, the fault planted, and the refusal the fault is, at its folder. */
export const plantedFolders = (
	folders: ReadonlyArray<FolderTexts>,
	fault: InputFault
): {
	readonly folders: ReadonlyArray<FolderTexts>
	readonly refusal: { readonly kind: InputFaultKind; readonly folder: string } | undefined
} => {
	if (fault.kind === "none") {
		return { folders, refusal: undefined }
	}
	const at = fault.at % folders.length
	const folder = defined(folders[at], "the faulted folder")
	const replaced = (replacement: ReadonlyArray<FolderTexts>): ReadonlyArray<FolderTexts> => [
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
				folders: replaced([{ ...folder, metaText: chunked(fault.text) }]),
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
					? { name: "notes.txt", text: chunked("") }
					: { name: `${Str.slice(0, 2)(first.name)}-again.sql`, text: chunked("SELECT 1;\n") }
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
							i === target ? { ...f, text: chunked(`${joined(f.text)}\n${fault.control};\n`) } : f
						)
					}
				]),
				refusal: refused("transactionControl", folder.name)
			}
		}
	}
}

export type InputFeature =
	| "the empty snapshot with no folders"
	| "folders handed over out of order"
	| "a file outside a transaction"
	| `refused ${InputFaultKind}`

/**
 * The plan (migrate/plan.ts planApply): which folders an apply runs, decided before any statement.
 *
 * Over drawn targets and ledgers: the shop's chain of three folders, or a schema's first migration beside an abandoned
 * one; which of the chain's folders the target holds, each reviewed or not (markers left, or losses left undecided);
 * the snapshot it knows, the empty one or a version's; a ledger whose first folders completed and whose next is
 * partial, at any of its files or, drawn apart, at one that runs outside a transaction; and a recorded file edited
 * after it ran, or a file added to a folder that completed. The partial folder's ledger rows record the draft that
 * started it or another one (a redraft since), of its source or of another, its target kept or another, its file count
 * the folder's or one more, and one of its completed files may have run with a statement no draft records. The oracle
 * is the planner's documented order, restated over the chain's positions: an applied file edited, missing or added
 * stops it first; then each folder in name order is skipped when complete, resumed past its recorded files when
 * partial, started when it continues the ledger's latest target, and refused otherwise, as is a recorded folder whose
 * ledger rows name another target than its meta.json. A partial folder of another file count is refused; one the ledger
 * records under its own draft resumes; one redrafted since resumes under the redraft, the ledger to take the redraft's
 * meta.json digest and target, exactly when the redraft keeps its source and records every completed file as it ran
 * (none run with a statement no draft records, none holding a loss left commented) and the file it resumes at runs in a
 * transaction, and is refused otherwise. The latest target must then be the known snapshot's; then no file that runs
 * may hold a marker, and no folder that runs a loss left undecided.
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
	/** The folders the ledger records complete, the chain's first. */
	readonly complete: number
	readonly partial:
		| { readonly kind: "none" }
		| {
				readonly kind: "partial"
				/** The files its rows record completed, the folder's first: the index of the file it resumes at. */
				readonly recorded: number
				readonly draft: PartialDraft
				/** The file count its rows record: the folder's, or one more. */
				readonly files: "kept" | "one more"
				/** A completed file that ran with a statement no draft records, picked among them. */
				readonly extra: Option.Option<number>
		  }
	readonly edit: Edit
}

export const chainOf = (name: ChainName) => (name === "the shop" ? shopChain : [abandoning])

/**
 * Where the ledger's rows stop in a chain: after its first `complete` folders and, where a folder follows them, before
 * that folder's file at index `next`, the one a partial folder resumes at.
 */
interface Stop {
	readonly complete: number
	readonly next: Option.Option<number>
}

/**
 * Where the ledger's rows stop, read off the chain's drafts: anywhere, or before one of the files that run outside a
 * transaction (a draft's no-transaction file), the one place a redraft may not resume at. The draw knows where those
 * files are, so a draft that gains or loses a file elsewhere moves nothing it reaches.
 */
const stopGen = (drafts: ReadonlyArray<GenerateResult>): Gen<Stop> => {
	const anywhere: Gen<Stop> = (s) => {
		const complete = s.draw(int(0, drafts.length))
		return {
			complete,
			next: Option.map(Arr.get(drafts, complete), (g) => s.draw(int(0, draftFiles(g).length - 1)))
		}
	}
	const outside = Arr.flatMap(drafts, (g, complete) =>
		Arr.flatMap(draftFiles(g), (d, next): ReadonlyArray<Stop> =>
			d.transaction ? [] : [{ complete, next: Option.some(next) }]
		)
	)
	return Arr.match(outside, {
		onEmpty: () => anywhere,
		onNonEmpty: (files) =>
			weighted<Stop>([
				[3, anywhere],
				[1, element(files)]
			])
	})
}

const planCaseGen: Gen<PlanCase> = (source) => {
	const chain = source.draw(
		weighted<ChainName>([
			[4, constant("the shop")],
			[1, constant("a first migration beside an abandoned schema")]
		])
	)
	const drafts = chainOf(chain)
	const length = drafts.length
	const stop = source.draw(stopGen(drafts))
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
		complete: stop.complete,
		partial: Option.match(stop.next, {
			onNone: (): PlanCase["partial"] => ({ kind: "none" }),
			onSome: (recorded) =>
				source.draw(
					oneOf<PlanCase["partial"]>([
						constant({ kind: "none" }),
						(s): PlanCase["partial"] => ({
							kind: "partial",
							recorded,
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
				)
		}),
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

/**
 * The database lock's text, the first command of every statement that writes a catalog row another installation in the
 * same database writes too (sql/catalog.ts databaseLock): a file holding it holds a statement of two commands.
 */
const databaseLockText = printStatement(databaseLock)

/** Whether one of `files` holds a database-wide statement, a statement of two commands behind the database lock. */
export const holdsDatabaseWide = (files: ReadonlyArray<{ readonly text: TextChunks }>): boolean =>
	Arr.some(files, (f) => Str.includes(databaseLockText)(joined(f.text)))

/** A stop of the shop's chain: the folders the ledger records complete, and the files of the next that completed. */
interface ShopStop {
	readonly complete: number
	readonly recorded: number
}

/** The stops of the shop's chain whose partial folder's completed files, and the file it resumes at, `holds` holds. */
const shopStops = (
	what: string,
	holds: (completed: ReadonlyArray<{ readonly text: TextChunks }>, next: DraftFile) => boolean
): Arr.NonEmptyReadonlyArray<ShopStop> =>
	nonEmpty(
		Arr.flatMap(shopChain, (g, complete) =>
			Arr.flatMap(draftFiles(g), (next, recorded) =>
				holds(Arr.take(g.folder.files, recorded), next) ? [{ complete, recorded }] : []
			)
		),
		what
	)

/**
 * A plan case of the shop's chain, every folder held and reviewed, its partial folder stopped at one of `stops` and
 * redrafted since, of its own source: the redraft's decision then rests on the completed files and the file it resumes
 * at alone.
 */
const redraftAt =
	(stops: Arr.NonEmptyReadonlyArray<ShopStop>): Gen<PlanCase> =>
	(source) => {
		const length = shopChain.length
		const stop = source.draw(element(stops))
		return {
			chain: "the shop",
			held: upTo(length, () => true),
			reviewed: upTo(length, () => true),
			known: length - 1,
			complete: stop.complete,
			partial: {
				kind: "partial",
				recorded: stop.recorded,
				draft: {
					kind: "a redraft",
					source: "kept",
					target: source.draw(element(["kept", "another"] as const))
				},
				files: "kept",
				extra: Option.none()
			},
			edit: { kind: "none" }
		}
	}

/**
 * The plan's cases, aimed at the redrafts a drawn case seldom meets: one resuming past a completed file that holds a
 * database-wide statement, which resumes only where its meta.json records each command of that statement as the file
 * writes it, and one stopped at a file that runs outside a transaction, where no redraft resumes.
 */
export const planCases = aimed<PlanCase, PlanFeature>(planCaseGen, [
	[
		"a partial folder resumed under a redraft past a database-wide statement",
		redraftAt(
			shopStops(
				"a stop past a database-wide statement",
				(completed, next) => next.transaction && holdsDatabaseWide(completed)
			)
		)
	],
	[
		"a redraft resuming at a no-transaction file refused",
		redraftAt(shopStops("a stop at a no-transaction file", (_, next) => !next.transaction))
	]
])

/** A folder of the chain as the case's reviewer leaves it. */
export const reviewedSource = (c: PlanCase, folder: MigrationFolder, i: number): FolderTexts =>
	source(
		folder,
		c.chain === "the shop"
			? c.reviewed[i] === true
				? reviewedText
				: unedited
			: c.reviewed[i] === true
				? reviewedText
				: leavingLosses
	)

/** The ledger rows of a parsed folder's first `files` files and its folder row. */
export const recordedOf = (
	folder: ParsedTarget["folders"][number],
	files: number
): RecordedFolder => ({
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
 * A case's partial folder, resolved: its index, how many of its files completed, the draft its rows record, its
 * recorded file count, and the completed file that ran with a statement no draft records, by index.
 */
export interface PartialFolder {
	readonly index: number
	readonly recorded: number
	readonly draft: PartialDraft
	readonly files: "kept" | "one more"
	readonly extra: Option.Option<number>
}

export const partialOf = (c: PlanCase): PartialFolder | undefined => {
	const p = c.partial
	if (p.kind === "none") {
		return undefined
	}
	return {
		index: c.complete,
		recorded: p.recorded,
		draft: p.draft,
		files: p.files,
		extra: p.recorded === 0 ? Option.none() : Option.map(p.extra, (pick) => pick % p.recorded)
	}
}

/** The partial folder's rows as its draft records them, from the rows `rows` of the draft that started it. */
export const underDraft = (p: PartialFolder, rows: RecordedFolder): RecordedFolder => {
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
export const unrecordedStatement = "\nSELECT 1;\n"

/** The files of a drafted folder holding a loss of stored data, as its meta.json records them. */
export const lossFiles = (folder: MigrationFolder): ReadonlyArray<string> =>
	folder.meta.kind === "drafted"
		? Arr.flatMap(folder.meta.files, (f) =>
				Arr.some(f.steps, (st) => st.kind === "loss") ? [f.name] : []
			)
		: []

/** A run as the model states it: a redraft's with what its ledger rows take. */
export type RunVerdict = {
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
export type PlanVerdict =
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

export type PlanFeature =
	| "every folder run from the empty snapshot"
	| "the applied folders skipped"
	| "a partial folder resumed"
	| "a partial folder resumed under a redraft of another target"
	| "a partial folder resumed under a redraft of its target"
	| "a partial folder resumed under a redraft past a database-wide statement"
	| "a redraft of another source refused"
	| "a redraft not recording a completed file refused"
	| "a partial folder of another file count refused"
	| "a redraft resuming at a no-transaction file refused"
	| "a folder started after a resumed one"
	| "nothing to run"
	| `refused ${Extract<PlanVerdict, { readonly kind: "refused" }>["reason"]}`
