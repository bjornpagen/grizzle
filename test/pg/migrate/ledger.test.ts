import { layer } from "@effect/vitest"
import {
	accepting,
	type Machine,
	type Program,
	program,
	type Real,
	runProgram,
	took
} from "@grizzle/testing/commands"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { fullSwarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str, Struct } from "effect"
import { type SchemaApplyReport, applyLockKey } from "#adapter/migrate/apply.ts"
import type {
	AppliedEdit,
	MigrateError,
	UnresolvedLoss,
	UnresolvedMarker
} from "#adapter/migrate/errors.ts"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { indices } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import {
	completedFiles,
	type LedgerColumn,
	ledgerColumns,
	type LedgerRow,
	type LedgerState
} from "#compiler/deploy/ledger/ledger.ts"
import { folderName, metaFileName } from "#compiler/deploy/render/folder.ts"
import { customMigration, type GenerateResult } from "#compiler/deploy/render/generate.ts"
import {
	findMarkers,
	isNoTransaction,
	noTransactionMarker,
	splitStatements
} from "#compiler/deploy/render/markers.ts"
import { emptyFingerprint } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import { printCatalogExpr, quoteIdent } from "#compiler/sql/print.ts"
import {
	apply,
	folderSource,
	id,
	kept,
	noFurther,
	openMigrator,
	refusal,
	reviewedSource
} from "#test/pg/migrate/support.ts"
import { assert, defined, nonEmpty, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	draftChain,
	draftedAt,
	fromEmpty,
	ownedBy,
	parsedMigrationName
} from "#test/support/migrate/kit.ts"
import { readLedger } from "#test/support/migrate/ledger.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { books1, shopV1, shopV2, shopV3 } from "#test/unit/deploy/schemas.ts"

import { regex } from "arkregex"

/** The model: the folders the ledger recorded complete, and, when it holds the next one unfinished, how many of its
 * files it recorded (none when a no-transaction file of it failed before any file was recorded).
 *
 * The apply runner's ledger as a state machine, on PostgreSQL 19.
 *
 * The model is the documented contract: a migrations
 * directory of three drafted folders (Shop v1 to v3: a placeholder, a law with its Validate files, a concurrent index
 * in a no-transaction file, an enum label, a serial field, removed objects dropped in Publish), and a database whose
 * ledger has recorded some folders, maybe one of them in part. Its state is two numbers: the folders recorded complete,
 * and the files recorded of the next one. Each command is an action a user or a deployment takes, and the model says
 * what it must do:
 *
 * - apply the directory as of folder k: the folders after the recorded ones run, the partial one resumed at its first
 *   unrecorded file; a directory missing an applied or partial folder is refused at `edited`, naming each;
 * - apply folders with a gap, folders that end before the snapshot, or a new folder sorted before an applied one:
 *   refused at `order`;
 * - apply the next folder unreviewed: refused at `marker`, naming exactly the markers its files hold, or, with no marker,
 *   at `decision`, naming exactly the losses of stored data meta.json records, each still commented;
 * - apply with a failing statement before a file, after a no-transaction file, or after a statement inside one:
 *   refused at `statement` at that file, the earlier files recorded, a rerun resuming there;
 * - apply with an applied file edited, deleted, renamed or added, its meta.json edited, or its folder gone: refused at
 *   `edited`, naming each edit;
 * - apply while another apply holds the schema's lock (`busy`), as a role that does not own the schema (`identity`),
 *   with a file that controls its own transaction, or with one schema's folders against another schema's snapshot
 *   (`input`);
 * - a data step a deferred law refuses at COMMIT (`commit`), and a folder that would record before the ledger exists
 *   (`record`).
 *
 * After every command the real database is read back and must be in the state the model claims: the ledger's latest
 * target, its partial folder and the files it recorded, its rows read strictly from the table as the runner reads them;
 * and after every refusal the model says ran nothing, the ledger and the whole catalog are unchanged. Each step draws a
 * command the model's state allows, and its parameters in that state, so every drawn program is a sequence of real
 * actions, and a shrunk one is still one. */
interface Model {
	readonly recorded: number
	readonly partial: Option.Option<number>
}

/** The empty database: no folder recorded. */
const initial: Model = { recorded: 0, partial: Option.none() }

type MigrationSession = Parameters<typeof apply>[0]

/** The real system: one schema, the migration identity's session, the drafted chain and its reviewed folders, and the
 * sessions the commands that need another actor use. */
interface System {
	readonly schema: string
	readonly m: MigrationSession
	readonly gs: ReadonlyArray<GenerateResult>
	readonly reviewed: ReadonlyArray<FolderSource>
	/** Another schema's drafted first folder, never applied. */
	readonly foreign: GenerateResult
	readonly holder: RawSession
	readonly intruder: MigrationSession
}

const commandKinds = [
	"apply in order",
	"apply up to date",
	"apply missing an applied folder",
	"apply with a gap",
	"apply short of the snapshot",
	"a pending folder sorted before an applied one",
	"apply unreviewed",
	"apply unreviewed without markers",
	"apply unreviewed with a loss undecided",
	"fail before a file",
	"fail after a no-transaction file",
	"fail inside a no-transaction file",
	"resume a partial folder",
	"edit an applied file",
	"busy",
	"owner",
	"transaction control",
	"another schema's folders",
	"commit refused",
	"record before the ledger"
] as const
type Feature = (typeof commandKinds)[number]

const statements = (schema: string) => succeeded(statementsFor(schema))

/** The ledger the model claims: its latest target, and its partial folder with the files recorded. */
const expectLedger = (r: System, model: Model, actual: LedgerState) => {
	const latest =
		model.recorded === 0
			? emptyFingerprint(r.schema)
			: defined(r.gs[model.recorded - 1]).snapshot.fingerprint
	assert.equal(actual.latest, latest, "the ledger's latest target")
	assert.deepEqual(
		actual.partial === undefined
			? undefined
			: { folder: actual.partial.folder, done: [...completedFiles(actual.partial)] },
		Option.getOrUndefined(
			Option.map(model.partial, (files) => ({
				folder: defined(r.gs[model.recorded]).folder.name,
				done: Arr.map(indices(files), (k) => k + 1)
			}))
		),
		"the ledger's partial folder"
	)
	assert.deepEqual(
		Arr.map(actual.complete, (f) => f.folder),
		Arr.map(r.gs.slice(0, model.recorded), (g) => g.folder.name),
		"the folders the ledger records complete"
	)
}

/** The ledger key's columns. */
const folderColumn: LedgerColumn = "folder"
const ordinalColumn: LedgerColumn = "ordinal"

/** Every ledger row a state records: each folder's recorded files with the folder's source, target, file count and
 * additions. */
const ledgerRows = (state: LedgerState): ReadonlyArray<LedgerRow> =>
	Arr.flatMap([...state.complete, ...(state.partial === undefined ? [] : [state.partial])], (f) =>
		Arr.map(f.recorded, (x): LedgerRow => ({
			folder: f.folder,
			ordinal: x.ordinal,
			file: x.file,
			source: f.source,
			target: f.target,
			files: f.files,
			digest: x.digest
		}))
	)

/** A ledger integer cell read strictly: PostgreSQL's output of an integer at least zero. */
const nonNegativeInteger = regex("^(?:0|[1-9][0-9]*)$")

/**
 * The ledger's rows read strictly, straight from its table, none while it does not exist: every cell a nonempty text,
 * ordinal and files PostgreSQL's output of an integer at least zero. The apply runner converts its rows and trusts them
 * (adapter/migrate/ledger.ts), so what it writes is checked here.
 */
const strictLedgerRows = (r: System) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const present = yield* substrate.admin.queryValues(
			"SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = $1::text AND tablename = $2::text",
			[r.schema, ledgerTableName]
		)
		if (present.length === 0) {
			return []
		}
		const rows = yield* substrate.admin.queryValues(
			`SELECT ${Arr.join(
				Arr.map(ledgerColumns, (c) => `${quoteIdent(c)}::text`),
				", "
			)} FROM ${quoteIdent(r.schema)}.${quoteIdent(ledgerTableName)} ORDER BY ${quoteIdent(folderColumn)}, ${quoteIdent(ordinalColumn)}`,
			[]
		)
		return Arr.map(rows, (row, i): LedgerRow => {
			const text = (column: LedgerColumn): string => {
				const cell = row[ledgerColumns.indexOf(column)]
				if (typeof cell !== "string" || cell === "") {
					return assert.fail(`ledger row ${i}'s ${column} is no nonempty text`)
				}
				return cell
			}
			const integer = (column: LedgerColumn): number => {
				const cell = text(column)
				assert.ok(
					nonNegativeInteger.test(cell),
					`ledger row ${i}'s ${column} is no integer at least zero: ${cell}`
				)
				return Number(cell)
			}
			return {
				folder: text("folder"),
				ordinal: integer("ordinal"),
				file: text("file"),
				source: SchemaFingerprint(text("source")),
				target: SchemaFingerprint(text("target")),
				files: integer("files"),
				digest: text("digest")
			}
		})
	})

/** The ledger and the catalog of the schema, read back, the ledger's rows read strictly as the runner reads them. */
const observe = (r: System) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const ledger = yield* readLedger(r.m, r.schema, statements(r.schema))
		const rows = yield* strictLedgerRows(r)
		assert.deepEqual(
			ledgerRows(ledger),
			rows,
			"the ledger's rows read strictly as the runner reads them"
		)
		return { ledger, catalog: yield* readCatalog(substrate.admin, r.schema) }
	})

/** Runs an apply the model says is refused before any statement runs: refused at `stage`, the ledger and the catalog
 * unchanged, and the ledger still the model's. */
const refusedBeforeRunning = (
	r: System,
	model: Model,
	stage: MigrateError["stage"],
	attempt: Effect.Effect<SchemaApplyReport, MigrateError>
) =>
	Effect.gen(function* () {
		const before = yield* observe(r)
		const e = yield* refusal(attempt)
		assert.equal(e.stage, stage, e.message)
		const after = yield* observe(r)
		assert.deepEqual(after.ledger, before.ledger, "nothing ran: the ledger")
		assert.deepEqual(after.catalog, before.catalog, "nothing ran: the catalog")
		expectLedger(r, model, after.ledger)
		return e
	})

/** The folders as reviewed, none changed. */
const asReviewed = (f: FolderSource): FolderSource | undefined => f

/** The directory as of folder k, the folders reviewed, each folder of `edit` changed. */
const directory = (
	r: System,
	k: number,
	edit: (f: FolderSource, i: number) => FolderSource | undefined
) => ({
	snapshot: defined(r.gs[k - 1]).snapshot,
	folders: Arr.flatMap(r.reviewed.slice(0, k), (f, i) => {
		const edited = edit(f, i)
		return edited === undefined ? [] : [edited]
	})
})

/** The files the ledger recorded of its partial folder, none when it holds no partial folder. */
const partialFiles = (model: Model): number => Option.getOrElse(model.partial, () => 0)

/** The folders a directory as of folder k lacks that the ledger recorded, in full or in part. */
const missingOf = (model: Model, k: number): ReadonlyArray<number> => {
	const recorded = Arr.filter(indices(model.recorded), (i) => i >= k)
	return Option.isSome(model.partial) && model.recorded >= k
		? [...recorded, model.recorded]
		: recorded
}

/** A statement that fails when it runs (22012), without its terminator. */
const failingStatement = "SELECT 1 / 0"

/** Where a failing statement goes in a reviewed file: before it, after a no-transaction file, or after its k-th
 * statement. */
type Point =
	| { readonly at: "before" | "after"; readonly ordinal: number }
	| { readonly at: "within"; readonly ordinal: number; readonly statement: number }

/** Each file's points; a no-transaction file's statements are the runner's own split (splitStatements). */
const pointsOf = (folder: FolderSource): ReadonlyArray<Point> =>
	Arr.flatMap(folder.files, (f, i): ReadonlyArray<Point> => {
		const ordinal = i + 1
		if (!isNoTransaction(f.text)) {
			return [{ at: "before", ordinal }]
		}
		const within = Arr.map(indices(splitStatements(f.text).length - 1), (k): Point => ({
			at: "within",
			ordinal,
			statement: k + 1
		}))
		return [{ at: "before", ordinal }, ...within, { at: "after", ordinal }]
	})

const inject = (text: string, point: Point): string => {
	switch (point.at) {
		case "after":
			return `${text}\n${failingStatement};\n`
		case "before":
			return isNoTransaction(text)
				? Arr.join(
						[noTransactionMarker, `${failingStatement};`, ...Str.split(text, "\n").slice(1)],
						"\n"
					)
				: `${failingStatement};\n${text}`
		case "within": {
			const split = splitStatements(text)
			return Arr.join(
				Arr.map(
					[...split.slice(0, point.statement), failingStatement, ...split.slice(point.statement)],
					(s) => `${s};\n`
				),
				""
			)
		}
	}
}

/** The markers a drafted folder's files hold, and the losses of stored data its meta.json records, each drafted
 * commented, so unreviewed every one is unresolved. */
const unreviewedOf = (g: GenerateResult) => ({
	markers: Arr.flatMap(g.folder.files, (f) =>
		Arr.map(findMarkers(f.text), (mk) => ({
			folder: g.folder.name,
			file: f.name,
			kind: mk.kind,
			line: mk.line
		}))
	),
	losses: Arr.flatMap(g.folder.meta.files, (f) =>
		Arr.flatMap(f.steps, (s) =>
			s.kind === "loss" ? [{ folder: g.folder.name, file: f.name }] : []
		)
	)
})

/** What the model knows of one drafted folder: whether unreviewed it holds markers or undecided losses, its points,
 * its files, and which of them run outside a transaction. */
interface FolderShape {
	readonly markers: boolean
	readonly losses: boolean
	readonly points: Arr.NonEmptyReadonlyArray<Point>
	readonly files: number
	readonly noTransaction: ReadonlyArray<boolean>
}

type ChainShape = ReadonlyArray<FolderShape>

/** The chain's shape, read off its drafted and reviewed folders. Drafting depends on the schema's name only in the
 * names it writes, so a chain drafted under any name has the shape of every case's. */
const shapeOf = (
	gs: ReadonlyArray<GenerateResult>,
	reviewed: ReadonlyArray<FolderSource>
): ChainShape =>
	Arr.map(gs, (g, i): FolderShape => {
		const folder = defined(reviewed[i])
		const unreviewed = unreviewedOf(g)
		return {
			markers: unreviewed.markers.length > 0,
			losses: unreviewed.losses.length > 0,
			points: nonEmpty(pointsOf(folder), `the points of ${folder.name}`),
			files: folder.files.length,
			noTransaction: Arr.map(folder.files, (f) => isNoTransaction(f.text))
		}
	})

const folderOf = (shape: ChainShape, index: number): FolderShape => defined(shape[index])

/** The points of the next folder after its recorded files. */
const pointsAfter = (shape: ChainShape, model: Model): ReadonlyArray<Point> =>
	Arr.filter(folderOf(shape, model.recorded).points, (p) => p.ordinal > partialFiles(model))

/**
 * The kinds of `points`, each once, in the order they first come: a failure draws its kind before its point, so a
 * failure after a no-transaction file, one point of the ten in the second folder, is drawn as often as one before a file.
 */
const pointKinds = (points: ReadonlyArray<Point>): ReadonlyArray<Point["at"]> =>
	Arr.dedupe(Arr.map(points, (p) => p.at))

/** Whether the next folder holds a transactional file not yet recorded. */
const transactionalAfter = (shape: ChainShape, model: Model): boolean =>
	Arr.some(
		folderOf(shape, model.recorded).noTransaction,
		(noTransaction, i) => !noTransaction && i + 1 > partialFiles(model)
	)

const editKinds = [
	"edited",
	"missing",
	"renamed",
	"added",
	"meta edited",
	"folder missing"
] as const
type EditKind = (typeof editKinds)[number]

/** Each command's parameters: the folder a directory is as of, the point a failure is injected at, or which applied
 * file is edited, and how. */
type LedgerParameters = Readonly<{
	"apply up to": number
	"apply with a gap": number
	"apply short": number
	"early folder": undefined
	"apply unreviewed": undefined
	"fail at": Point
	"edit applied": Readonly<{ folder: number; file: number; kind: EditKind }>
	busy: undefined
	"non-owner": undefined
	"transaction control": undefined
	crossed: undefined
	"commit refused": undefined
	"record before the ledger": undefined
}>

const none = (): Gen<undefined> => constant(undefined)

const unchanged = (model: Model): Model => model

/**
 * The ledger's state machine over a chain of this shape. A command applies where the model's state lets it act and
 * where it acts at all: a failure needs a point after the recorded files, COMMIT in a file a transactional file not
 * yet recorded.
 */
const machineOf = (shape: ChainShape): Machine<Model, LedgerParameters, never> => ({
	initial,
	commands: {
		"apply up to": {
			applies: () => true,
			parameters: () => int(1, 3),
			weight: 1,
			judge: accepting((model, k) =>
				missingOf(model, k).length > 0
					? model
					: { recorded: Math.max(model.recorded, k), partial: Option.none() }
			)
		},
		"apply with a gap": {
			applies: (model) => Option.isNone(model.partial) && model.recorded + 1 < 3,
			parameters: (model) => element(model.recorded + 1 < 2 ? [2, 3] : [3]),
			weight: 1,
			judge: accepting(unchanged)
		},
		"apply short": {
			applies: (model) => missingOf(model, 1).length === 0 || missingOf(model, 2).length === 0,
			parameters: (model) =>
				element(
					nonEmpty(
						Arr.filter([2, 3], (k) => missingOf(model, k - 1).length === 0),
						"the snapshots a short directory may end before"
					)
				),
			weight: 1,
			judge: accepting(unchanged)
		},
		"early folder": {
			applies: (model) => model.recorded > 0 && model.recorded < 3 && Option.isNone(model.partial),
			parameters: none,
			weight: 1,
			judge: accepting(unchanged)
		},
		"apply unreviewed": {
			applies: (model) => model.recorded < 3 && Option.isNone(model.partial),
			parameters: none,
			weight: 1,
			judge: accepting((model) => {
				const folder = folderOf(shape, model.recorded)
				return folder.markers || folder.losses
					? model
					: { recorded: model.recorded + 1, partial: Option.none() }
			})
		},
		"fail at": {
			applies: (model) => model.recorded < 3 && pointsAfter(shape, model).length > 0,
			parameters: (model) => (source) => {
				const points = pointsAfter(shape, model)
				const at = source.draw(
					element(nonEmpty(pointKinds(points), "the kinds of the points after the recorded files"))
				)
				return source.draw(
					element(
						nonEmpty(
							Arr.filter(points, (p) => p.at === at),
							"the points of the drawn kind"
						)
					)
				)
			},
			weight: 1,
			judge: accepting((model, point) => {
				const unfinished =
					Option.isSome(model.partial) ||
					point.ordinal > 1 ||
					defined(folderOf(shape, model.recorded).noTransaction[point.ordinal - 1])
				return {
					recorded: model.recorded,
					partial: unfinished ? Option.some(point.ordinal - 1) : Option.none()
				}
			})
		},
		"edit applied": {
			applies: (model) => model.recorded > 0,
			parameters: (model) => (source) => {
				const folder = source.draw(int(0, model.recorded - 1))
				return {
					folder,
					file: source.draw(int(0, folderOf(shape, folder).files - 1)),
					kind: source.draw(element(editKinds))
				}
			},
			weight: 1,
			judge: accepting(unchanged)
		},
		busy: { applies: () => true, parameters: none, weight: 1, judge: accepting(unchanged) },
		"non-owner": {
			applies: (model) => model.recorded > 0,
			parameters: none,
			weight: 1,
			judge: accepting(unchanged)
		},
		"transaction control": {
			applies: (model) => model.recorded < 3 && transactionalAfter(shape, model),
			parameters: none,
			weight: 1,
			judge: accepting(unchanged)
		},
		crossed: { applies: () => true, parameters: none, weight: 1, judge: accepting(unchanged) },
		"commit refused": {
			applies: (model) => model.recorded >= 2 && Option.isNone(model.partial),
			parameters: none,
			weight: 1,
			judge: accepting(unchanged)
		},
		"record before the ledger": {
			applies: (model) => model.recorded === 0 && Option.isNone(model.partial),
			parameters: none,
			weight: 1,
			judge: accepting(unchanged)
		}
	}
})

/** A row of a stored relation of the snapshot as an INSERT: a value for every field it declares but a serial one, which
 * its sequence fills, each table and column named as the snapshot records it. */
const insertOf = (
	snapshot: DeploySnapshot,
	schema: string,
	relation: string,
	values: Readonly<Record<string, string>>
): string => {
	const stored = snapshot.theory.relations[relation]
	assert.ok(stored?.kind === "relation", `${relation} is a stored relation of the snapshot`)
	const fields = Arr.filter(stored.fields, (x) => !x.serial)
	const literals = Arr.map(fields, (x) => {
		const literal = values[x.name]
		assert.ok(literal !== undefined, `a value for ${relation}.${x.name}`)
		return literal
	})
	return `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(stored.ident)} (${Arr.join(
		Arr.map(fields, (x) => quoteIdent(x.column)),
		", "
	)}) VALUES (${Arr.join(literals, ", ")});\n`
}

/**
 * Each command run on PostgreSQL and held to the state the model predicts after it, noting in the case what it reached.
 *
 * A failing statement leaves the files before it recorded. The ledger holds the folder unfinished once it recorded a
 * file of it, or once a no-transaction file of it began, whose folder row is recorded before its first statement so
 * that no Db runs while its statements run alone (the stale-Db fence, TODO 0b; adapter/migrate/apply.ts
 * recordFolderRow); the row outlives the failure. A folder whose first file is transactional and fails has no row.
 *
 * A data step that inserts a task without its arm is refused at COMMIT by the alternatives law Shop v2 adds; an empty
 * custom folder of the empty snapshot, sorted before the first, finds no ledger to record in.
 */
const realOf = (
	r: System,
	c: Case<Feature>
): Real<Model, LedgerParameters, never, MigrateError | SqlError, Substrate> => ({
	"apply up to": (k, model, after) =>
		Effect.as(
			Effect.gen(function* () {
				const missing = missingOf(model, k)
				if (missing.length > 0) {
					c.note("apply missing an applied folder")
					const e = yield* refusedBeforeRunning(
						r,
						model,
						"edited",
						apply(r.m, directory(r, k, asReviewed), noFurther)
					)
					const reason = e.reason
					assert.ok(reason._tag === "AppliedEdited", e.message)
					const edits: ReadonlyArray<AppliedEdit> = reason.edits
					assert.deepEqual(
						edits,
						Arr.map(missing, (i) => ({
							folder: defined(r.gs[i]).folder.name,
							file: metaFileName,
							kind: "missing"
						})) satisfies ReadonlyArray<AppliedEdit>,
						"the applied folders named missing"
					)
					return
				}
				const expected = Arr.map(r.gs.slice(model.recorded, k), (g, j) => {
					const resumed = j === 0 && Option.isSome(model.partial)
					return {
						folder: g.folder.name,
						files: Arr.map(g.folder.files.slice(resumed ? partialFiles(model) : 0), (f) => f.name),
						resumed
					}
				})
				c.note(
					expected.length === 0
						? "apply up to date"
						: Option.isSome(model.partial)
							? "resume a partial folder"
							: "apply in order"
				)
				const report = yield* apply(r.m, directory(r, k, asReviewed), noFurther)
				assert.deepEqual(report.applied, expected, "the folders the apply runs")
				const observed = yield* observe(r)
				expectLedger(r, after, observed.ledger)
			}),
			took
		),
	"apply with a gap": (k, model) =>
		Effect.as(
			Effect.gen(function* () {
				c.note("apply with a gap")
				const gap = model.recorded
				yield* refusedBeforeRunning(
					r,
					model,
					"order",
					apply(
						r.m,
						directory(r, k, (f, i) => (i === gap ? undefined : f)),
						noFurther
					)
				)
			}),
			took
		),
	"apply short": (k, model) =>
		Effect.as(
			Effect.gen(function* () {
				c.note("apply short of the snapshot")
				yield* refusedBeforeRunning(
					r,
					model,
					"order",
					apply(
						r.m,
						{ snapshot: defined(r.gs[k - 1]).snapshot, folders: r.reviewed.slice(0, k - 1) },
						noFurther
					)
				)
			}),
			took
		),
	"early folder": (_none, model) =>
		Effect.as(
			Effect.gen(function* () {
				c.note("a pending folder sorted before an applied one")
				const next = model.recorded
				const early = (f: FolderSource): FolderSource => ({
					...f,
					name: succeeded(folderName("20000101000000", parsedMigrationName("early")))
				})
				yield* refusedBeforeRunning(
					r,
					model,
					"order",
					apply(
						r.m,
						directory(r, next + 1, (f, i) => (i === next ? early(f) : f)),
						noFurther
					)
				)
			}),
			took
		),
	"apply unreviewed": (_none, model, after) =>
		Effect.as(
			Effect.gen(function* () {
				const g = defined(r.gs[model.recorded])
				const { markers, losses } = unreviewedOf(g)
				const unreviewed = directory(r, model.recorded + 1, (f, i) =>
					i === model.recorded ? folderSource(g.folder) : f
				)
				if (markers.length === 0 && losses.length === 0) {
					c.note("apply unreviewed without markers")
					yield* apply(r.m, unreviewed, noFurther)
					const observed = yield* observe(r)
					expectLedger(r, after, observed.ledger)
					return
				}
				if (markers.length === 0) {
					c.note("apply unreviewed with a loss undecided")
					const e = yield* refusedBeforeRunning(
						r,
						model,
						"decision",
						apply(r.m, unreviewed, noFurther)
					)
					const reason = e.reason
					assert.ok(reason._tag === "LossesUndecided", e.message)
					const named: ReadonlyArray<UnresolvedLoss> = reason.losses
					assert.deepEqual(
						Arr.map(named, (l) => ({ folder: l.folder, file: l.file })),
						losses,
						"the losses named"
					)
					return
				}
				c.note("apply unreviewed")
				const e = yield* refusedBeforeRunning(r, model, "marker", apply(r.m, unreviewed, noFurther))
				const reason = e.reason
				assert.ok(reason._tag === "MarkersUnresolved", e.message)
				const named: ReadonlyArray<UnresolvedMarker> = reason.markers
				assert.deepEqual(named, markers, "the markers named")
			}),
			took
		),
	"fail at": (point, model, after) =>
		Effect.as(
			Effect.gen(function* () {
				c.note(
					point.at === "before"
						? "fail before a file"
						: point.at === "after"
							? "fail after a no-transaction file"
							: "fail inside a no-transaction file"
				)
				const next = defined(r.reviewed[model.recorded])
				const file = defined(next.files[point.ordinal - 1])
				const failing = directory(r, model.recorded + 1, (f, i) =>
					i === model.recorded
						? {
								...f,
								files: Arr.map(f.files, (x) =>
									x.name === file.name ? { ...x, text: inject(x.text, point) } : x
								)
							}
						: f
				)
				const e = yield* refusal(apply(r.m, failing, noFurther))
				assert.ok(e.stage === "statement", e.message)
				const place = e.place
				assert.ok(
					(place.kind === "file" || place.kind === "statement") && place.file === file.name,
					"the failing file"
				)
				assert.ok(
					e.server.by === "server" && e.server.error.sqlstate === "22012",
					"the failing statement's SQLSTATE"
				)
				const observed = yield* observe(r)
				expectLedger(r, after, observed.ledger)
			}),
			took
		),
	"edit applied": ({ folder, file, kind }, model) =>
		Effect.as(
			Effect.gen(function* () {
				c.note("edit an applied file")
				const applied = defined(r.reviewed[folder])
				const target = defined(applied.files[file])
				const renamed = `${Str.slice(0, 3)(target.name)}renamed.sql`
				const name = applied.name
				const edit = (f: FolderSource): FolderSource | undefined => {
					switch (kind) {
						case "edited":
							return {
								...f,
								files: Arr.map(f.files, (x) =>
									x === target ? { ...x, text: `-- tuned\n${x.text}` } : x
								)
							}
						case "missing":
							return { ...f, files: Arr.filter(f.files, (x) => x !== target) }
						case "renamed":
							return {
								...f,
								files: Arr.map(f.files, (x) => (x === target ? { ...x, name: renamed } : x))
							}
						case "added":
							return { ...f, files: [...f.files, { name: "99-later.sql", text: "SELECT 1;\n" }] }
						case "meta edited":
							return { ...f, metaText: `${f.metaText}\n` }
						case "folder missing":
							return undefined
					}
				}
				const expected = (
					{
						edited: [{ folder: name, file: target.name, kind: "edited" }],
						missing: [{ folder: name, file: target.name, kind: "missing" }],
						renamed: [
							{ folder: name, file: target.name, kind: "missing" },
							{ folder: name, file: renamed, kind: "added" }
						],
						added: [{ folder: name, file: "99-later.sql", kind: "added" }],
						"meta edited": [{ folder: name, file: metaFileName, kind: "edited" }],
						"folder missing": [{ folder: name, file: metaFileName, kind: "missing" }]
					} satisfies Readonly<Record<EditKind, ReadonlyArray<AppliedEdit>>>
				)[kind]
				const k = Option.isNone(model.partial) ? model.recorded : model.recorded + 1
				const e = yield* refusedBeforeRunning(
					r,
					model,
					"edited",
					apply(
						r.m,
						directory(r, k, (f, j) => (j === folder ? edit(f) : f)),
						noFurther
					)
				)
				const reason = e.reason
				assert.ok(reason._tag === "AppliedEdited", e.message)
				const edits: ReadonlyArray<AppliedEdit> = reason.edits
				unorderedEqual(edits, expected, "the edits named")
			}),
			took
		),
	busy: (_none, model) =>
		Effect.as(
			Effect.gen(function* () {
				c.note("busy")
				yield* r.holder.values(
					`SELECT pg_catalog.pg_advisory_lock(${printCatalogExpr(applyLockKey(r.schema))})`,
					[]
				)
				yield* Effect.ensuring(
					refusedBeforeRunning(
						r,
						model,
						"busy",
						apply(r.m, directory(r, Math.min(3, model.recorded + 1), asReviewed), noFurther)
					),
					Effect.ignore(
						r.holder.values(
							`SELECT pg_catalog.pg_advisory_unlock(${printCatalogExpr(applyLockKey(r.schema))})`,
							[]
						)
					)
				)
			}),
			took
		),
	"non-owner": (_none, model) =>
		Effect.as(
			Effect.gen(function* () {
				c.note("owner")
				yield* refusedBeforeRunning(
					r,
					model,
					"owner",
					apply(r.intruder, directory(r, Math.min(3, model.recorded + 1), asReviewed), noFurther)
				)
			}),
			took
		),
	"transaction control": (_none, model) =>
		Effect.as(
			Effect.gen(function* () {
				c.note("transaction control")
				const next = defined(r.reviewed[model.recorded])
				const file = defined(
					Option.getOrUndefined(
						Arr.findFirst(
							next.files,
							(f, i) => i + 1 > partialFiles(model) && !isNoTransaction(f.text)
						)
					),
					"a transactional file not yet recorded"
				)
				const e = yield* refusedBeforeRunning(
					r,
					model,
					"input",
					apply(
						r.m,
						directory(r, model.recorded + 1, (f, i) =>
							i === model.recorded
								? {
										...f,
										files: Arr.map(f.files, (x) =>
											x === file ? { ...x, text: `${x.text}\nCOMMIT;\n` } : x
										)
									}
								: f
						),
						noFurther
					)
				)
				assert.ok(e.stage === "input", e.message)
				const place = e.place
				assert.ok(
					place.kind === "statement" && place.file === file.name,
					"the file that controls its transaction"
				)
			}),
			took
		),
	crossed: (_none, model) =>
		Effect.as(
			Effect.gen(function* () {
				c.note("another schema's folders")
				yield* refusedBeforeRunning(
					r,
					model,
					"input",
					apply(r.m, { snapshot: r.foreign.snapshot, folders: r.reviewed.slice(0, 1) }, noFurther)
				)
			}),
			took
		),
	"commit refused": (_none, model) =>
		Effect.as(
			Effect.gen(function* () {
				c.note("commit refused")
				const snapshot = defined(r.gs[model.recorded - 1]).snapshot
				const account = `'${id(1)}'`
				const step = {
					...succeeded(
						customMigration({
							snapshot,
							name: parsedMigrationName("data_step"),
							timestamp: draftedAt(model.recorded + 1)
						})
					),
					files: [
						{
							name: "01-data.sql",
							text:
								insertOf(snapshot, r.schema, "Account", { id: account, name: "'alpha'" }) +
								insertOf(snapshot, r.schema, "Task", {
									id: `'${id(11)}'`,
									account,
									kind: "'Automatic'",
									weight: "1"
								})
						}
					]
				}
				const before = yield* observe(r)
				const e = yield* refusal(
					apply(
						r.m,
						{ snapshot, folders: [...r.reviewed.slice(0, model.recorded), folderSource(step)] },
						noFurther
					)
				)
				assert.ok(e.stage === "commit", e.message)
				const server = e.server
				if (server.by !== "server") {
					return assert.fail("the server refused the COMMIT")
				}
				const { sqlstate, constraint } = server.error
				assert.ok(sqlstate === "23000", "the COMMIT's SQLSTATE")
				assert.ok(
					constraint !== undefined && snapshot.theory.laws[constraint]?.kind === "residual",
					"a residual law refuses at COMMIT"
				)
				const afterward = yield* observe(r)
				assert.deepEqual(afterward.ledger, before.ledger, "the refused file is unrecorded")
				assert.deepEqual(afterward.catalog, before.catalog, "the refused file left nothing")
			}),
			took
		),
	"record before the ledger": (_none, model) =>
		Effect.as(
			Effect.gen(function* () {
				c.note("record before the ledger")
				const first = defined(r.gs[0])
				/** Sorted before every drafted folder: its timestamp precedes the clock's. */
				const early = succeeded(
					customMigration({
						snapshot: { ...first.snapshot, fingerprint: emptyFingerprint(r.schema) },
						name: parsedMigrationName("too_early"),
						timestamp: "20000101000000"
					})
				)
				const substrate = yield* Substrate
				const e = yield* refusal(
					apply(
						r.m,
						{ snapshot: first.snapshot, folders: [folderSource(early), defined(r.reviewed[0])] },
						noFurther
					)
				)
				assert.equal(e.stage, "record", e.message)
				const catalog = yield* readCatalog(substrate.admin, r.schema)
				assert.equal(catalog.kind, "absent", "the schema the first file created rolled back")
				const observed = yield* observe(r)
				expectLedger(r, model, observed.ledger)
			}),
			took
		)
})

/** The chain Shop v1 to v3 drafted from the empty snapshot under an allocated schema name and its owner. */
const chainOf = (allocated: string, owner: string): ReadonlyArray<GenerateResult> =>
	draftChain(
		Arr.map([shopV1, shopV2, shopV3], (desc) => ({
			desc,
			options: { schema: atName(allocated), owner: ownedBy(owner), extensions: [] }
		})),
		fromEmpty
	)

type LedgerProgram = Program<LedgerParameters>

/** One run of the state machine: a schema of its own, the chain drafted and reviewed against it, which must have the
 * shape the model was built over, and the program run on it from the empty snapshot. */
const runOn = (shape: ChainShape) => (steps: LedgerProgram, c: Case<Feature>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const owner = substrate.owner.role
		/** The allocated name the chain is installed under, and its PostgreSQL schema, the door's identifier of it. */
		const allocated = yield* substrate.schema({ create: false, label: "ledger" })
		const schema = identifierOf(identity.schema(parsedSchemaName(allocated)))
		const gs = chainOf(allocated, owner)
		const reviewed = Arr.map(gs, (g) => reviewedSource(g, kept))
		assert.deepEqual(shapeOf(gs, reviewed), shape, "the case's chain has the model's shape")
		const foreignSchema = yield* substrate.schema({ create: false, label: "ledger_other" })
		const foreign = defined(
			draftChain(
				[
					{
						desc: books1,
						options: { schema: atName(foreignSchema), owner: ownedBy(owner), extensions: [] }
					}
				],
				fromEmpty
			)[0]
		)
		const elsewhere = yield* substrate.schema({ create: false, label: "ledger_elsewhere" })
		const role = yield* substrate.role(elsewhere, "intruder")
		const intruder = yield* openMigrator(substrate, role)
		const system: System = {
			schema,
			m: yield* openMigrator(substrate, substrate.owner),
			gs,
			reviewed,
			foreign,
			holder: yield* substrate.session({ ...ownerSession(), label: "ledger lock holder" }),
			intruder
		}
		yield* runProgram(machineOf(shape), realOf(system, c), steps)
	})

/** The rotating stream's programs, as the suite always ran them. */
const runs = 3

/**
 * The steered phase's budget: eighty times the rotating stream's cases, spent only until every command is reached. A
 * refused COMMIT and the failures in the third folder's no-transaction file need two folders recorded first, a state a
 * program of uniformly drawn commands reaches about one time in twenty.
 */
const steeredCases = 80 * runs

/**
 * The ledger's search, every command required of a generated program. The machine is built over the shape of the chain
 * drafted under a name of its own. Shrinking stops after 150 candidates, each a whole program on PostgreSQL; a case
 * still running after 20 minutes is hung (the suite's protective cap).
 */
const ledgerSearch = Effect.gen(function* () {
	const substrate = yield* Substrate
	const gs = chainOf("ledger_shape", substrate.owner.role)
	const shape = shapeOf(
		gs,
		Arr.map(gs, (g) => reviewedSource(g, kept))
	)
	return yield* explore(
		{
			suite: "migrate/ledger",
			draw: drawn(
				program(
					machineOf(shape),
					{ min: 0, max: 12 },
					fullSwarm(Struct.keys(machineOf(shape).commands))
				)
			),
			literal: Formatter.format,
			coverage: required<Feature>(commandKinds, { cases: steeredCases, sense: notesOnly }),
			kept: [],
			runs,
			shrink: { kind: "bounded", candidates: 150 },
			concurrency: 1,
			steerEvery: 16,
			caseHang
		},
		runOn(shape)
	)
})

layer(Substrate.layer)("the apply runner's ledger as a state machine", (it) => {
	it.effect(
		`${runs} programs of the rotating stream, steered until every command is reached: each command leaves the ledger the model claims, and a refusal runs nothing`,
		(ctx) => searched(ctx, ledgerSearch)
	)
})
