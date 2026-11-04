import { inspect } from "node:util"
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, constant, element, type Gen, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	pipe,
	Result,
	String as Str
} from "effect"
import { parseTarget, transactionControl } from "#adapter/migrate/input.ts"
import { planApply, runFiles } from "#adapter/migrate/plan.ts"
import { indices } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { MigrationFolder } from "#compiler/deploy/render/folder.ts"
import { emptyFingerprint, emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { assert, defined, failed, nonEmpty, succeeded } from "#test/support/assert.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftChain, fromEmpty, unowned } from "#test/support/migrate/kit.ts"
import { draftFiles } from "#test/support/migrate/review.ts"
import { shopV1, shopV2, shopV3 } from "#test/unit/deploy/schemas.ts"

/**
 * The apply runner's pure parts: the input check before any connection, transaction-control refusal, and the plan with
 * its resume and refusals. The drift check after an apply is test/pg/admission's.
 *
 * A folder's files as the reviewer leaves them: unedited, or each file's text through `edit`.
 */
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
			Arr.filter(
				Str.split(text, "\n"),
				(l) =>
					!Str.startsWith("-- grizzle: placeholder")(l) &&
					!Str.startsWith("-- grizzle: rename candidate")(l)
			),
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
						caseHang: Duration.minutes(2)
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

describe("the input check before any connection", () => {
	const [g1, g2] = draftChain(
		[
			{ desc: shopV1, options: { schema: shopSchema, owner: unowned, extensions: [] } },
			{ desc: shopV2, options: { schema: shopSchema, owner: unowned, extensions: [] } }
		],
		fromEmpty
	)
	assert.ok(g1 !== undefined && g2 !== undefined)

	it("orders the folders by name and the files by ordinal, with each file's digest and mode", () => {
		const parsed = succeeded(
			parseTarget({
				snapshot: g2.snapshot,
				folders: [source(g2.folder, review), source(g1.folder, unedited)]
			})
		)
		assert.deepEqual(
			Arr.map(parsed.folders, (f) => f.name),
			[g1.folder.name, g2.folder.name]
		)
		/**
		 * A file runs outside a transaction exactly when the drafter wrote it so (the renderer marks it from the drafted
		 * file's mode), and the second version's index file is one.
		 */
		const drafted = new Map(
			Arr.flatMap([g1, g2], (g) =>
				Arr.map(draftFiles(g), (d) => [`${g.folder.name}/${d.name}`, d.transaction] as const)
			)
		)
		for (const folder of parsed.folders) {
			for (const f of folder.files) {
				assert.equal(
					f.noTransaction,
					!defined(
						drafted.get(`${folder.name}/${f.name}`),
						`the drafted file ${folder.name}/${f.name}`
					),
					f.name
				)
			}
		}
		const second = defined(parsed.folders[1], "the second version's folder")
		assert.ok(
			Arr.some(second.files, (f) => f.noTransaction),
			"the second version drafts a file outside a transaction"
		)
		assert.deepEqual(
			Arr.map(second.files, (f) => f.ordinal),
			Arr.range(1, g2.folder.files.length)
		)
	})

	it("accepts the empty snapshot, whose fingerprint is the schema identifier's", () => {
		const empty = emptySnapshot({ schemaName: "Shop", schema: shop })
		assert.equal(empty.fingerprint, emptyFingerprint(shop))
		assert.deepEqual(succeeded(parseTarget({ snapshot: empty, folders: [] })).folders, [])
	})

	/** A target the input check refuses: a folder name that is no folder name, a folder twice, meta.json of another
	 * schema, a stray file, and a file that controls its transaction. */
	type Malformed =
		| "a malformed folder name"
		| "a folder twice"
		| "meta.json of another schema"
		| "a stray file"
		| "transaction control"
	const malformedTarget = (malformed: Malformed) => {
		switch (malformed) {
			case "a malformed folder name":
				return parseTarget({
					snapshot: g1.snapshot,
					folders: [{ ...source(g1.folder, unedited), name: "init" }]
				})
			case "a folder twice":
				return parseTarget({
					snapshot: g1.snapshot,
					folders: [source(g1.folder, unedited), source(g1.folder, unedited)]
				})
			case "meta.json of another schema":
				return parseTarget({
					snapshot: g1.snapshot,
					folders: [
						{
							...source(g1.folder, unedited),
							metaText: Str.replace(`"schema": "${shop}"`, '"schema": "other"')(g1.folder.metaText)
						}
					]
				})
			case "a stray file":
				return parseTarget({
					snapshot: g1.snapshot,
					folders: [{ ...source(g1.folder, unedited), files: [{ name: "notes.txt", text: "" }] }]
				})
			case "transaction control":
				return parseTarget({
					snapshot: g1.snapshot,
					folders: [
						source(g1.folder, (f) => (f.name === "01-setup.sql" ? `${f.text}\nCOMMIT;\n` : f.text))
					]
				})
		}
	}
	const malformations: Arr.NonEmptyReadonlyArray<Malformed> = [
		"a malformed folder name",
		"a folder twice",
		"meta.json of another schema",
		"a stray file",
		"transaction control"
	]

	it.effect(
		"refuses a malformed folder, meta.json of another schema, a stray file and transaction control",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/adapter/input-refusals",
						generator: element(malformations),
						literal: Formatter.format,
						limit: malformations.length,
						coverage: requiredInSpace<Malformed>(malformations),
						caseHang: Duration.minutes(2)
					},
					(malformed, c) =>
						Effect.sync(() => {
							c.note(malformed)
							assert.equal(failed(malformedTarget(malformed)).stage, "input")
						})
				)
			)
	)
})

describe("the plan: skip, resume, run, or refuse before any statement", () => {
	const [g1, g2, g3] = draftChain(
		[
			{ desc: shopV1, options: { schema: shopSchema, owner: unowned, extensions: [] } },
			{ desc: shopV2, options: { schema: shopSchema, owner: unowned, extensions: [] } },
			{ desc: shopV3, options: { schema: shopSchema, owner: unowned, extensions: [] } }
		],
		fromEmpty
	)
	assert.ok(g1 !== undefined && g2 !== undefined && g3 !== undefined)
	const parsed = succeeded(
		parseTarget({
			snapshot: g3.snapshot,
			folders: [source(g1.folder, unedited), source(g2.folder, review), source(g3.folder, review)]
		})
	)
	const empty = { latest: emptyFingerprint(shop), complete: [], partial: undefined }
	/** The ledger rows of a parsed folder's first `files` files, its folder row first. */
	const recordedOf = (index: number, files: number) => {
		const folder = defined(parsed.folders[index])
		return [
			{ ordinal: 0, file: "meta.json", digest: folder.metaDigest },
			...Arr.map(folder.files.slice(0, files), (f) => ({
				ordinal: f.ordinal,
				file: f.name,
				digest: f.digest
			}))
		]
	}

	it("runs every folder from the empty snapshot, ending at the known snapshot", () => {
		const plan = succeeded(planApply(parsed, empty))
		assert.deepEqual(
			Arr.map(plan.runs, (r) => [r.folder.name, runFiles(r).length, r.kind]),
			[
				[g1.folder.name, g1.folder.files.length, "start"],
				[g2.folder.name, g2.folder.files.length, "start"],
				[g3.folder.name, g3.folder.files.length, "start"]
			]
		)
		assert.equal(plan.after, g3.snapshot.fingerprint)
	})

	it("skips the applied folders and resumes the partial one at its first unrecorded file", () => {
		const state = {
			latest: g1.snapshot.fingerprint,
			complete: [
				{
					folder: g1.folder.name,
					source: g1.folder.meta.source,
					target: g1.folder.meta.target,
					files: g1.folder.files.length,
					recorded: recordedOf(0, g1.folder.files.length)
				}
			],
			partial: {
				folder: g2.folder.name,
				source: g2.folder.meta.source,
				target: g2.folder.meta.target,
				files: g2.folder.files.length,
				recorded: recordedOf(1, 2)
			}
		}
		const plan = succeeded(planApply(parsed, state))
		assert.deepEqual(
			Arr.map(plan.runs, (r) => [r.folder.name, Arr.map(runFiles(r), (f) => f.ordinal), r.kind]),
			[
				[g2.folder.name, Arr.map(indices(g2.folder.files.length - 2), (i) => i + 3), "resume"],
				[g3.folder.name, Arr.map(indices(g3.folder.files.length), (i) => i + 1), "start"]
			]
		)
	})

	it("refuses a gap in the chain, folders that end before the known snapshot, and unresolved markers", () => {
		const gap = succeeded(
			parseTarget({
				snapshot: g3.snapshot,
				folders: [source(g1.folder, unedited), source(g3.folder, review)]
			})
		)
		assert.equal(failed(planApply(gap, empty)).stage, "order")
		const short = succeeded(
			parseTarget({
				snapshot: g3.snapshot,
				folders: [source(g1.folder, unedited), source(g2.folder, review)]
			})
		)
		assert.equal(failed(planApply(short, empty)).stage, "order")
		const marked = succeeded(
			parseTarget({
				snapshot: g2.snapshot,
				folders: [source(g1.folder, unedited), source(g2.folder, unedited)]
			})
		)
		const m = failed(planApply(marked, empty)).reason
		assert.ok(m._tag === "MarkersUnresolved", "unresolved markers refuse the plan")
		assert.ok(
			Arr.every(m.markers, (mk) => mk.folder === g2.folder.name && mk.kind === "placeholder")
		)
	})

	it("refuses an undecided loss of stored data, and plans it once its statement is written in", () => {
		const losses = Arr.map(
			nonEmpty(
				Arr.flatMap(g3.folder.meta.files, (f) =>
					Arr.flatMap(f.steps, (s) => (s.kind === "loss" ? [f.name] : []))
				),
				"removing a field drafts a loss"
			),
			(file) => ({ folder: g3.folder.name, file })
		)
		const undecided = succeeded(
			parseTarget({
				snapshot: g3.snapshot,
				folders: [
					source(g1.folder, unedited),
					source(g2.folder, review),
					source(g3.folder, leavingLosses)
				]
			})
		)
		const refused = failed(planApply(undecided, empty))
		const d = refused.reason
		assert.ok(
			d._tag === "LossesUndecided",
			`an undecided loss refuses the plan, not ${refused.stage}`
		)
		assert.deepEqual(
			Arr.map(d.losses, (l) => ({ folder: l.folder, file: l.file })),
			losses
		)
		const decided = succeeded(
			parseTarget({
				snapshot: g3.snapshot,
				folders: [source(g1.folder, unedited), source(g2.folder, review), source(g3.folder, review)]
			})
		)
		assert.ok(Result.isSuccess(planApply(decided, empty)), "a loss written in plans")
	})
})
