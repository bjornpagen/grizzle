/** What the properties of ledger.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { ChunkView } from "@bjornpagen/grizzle-text/chunks"
import { assert, defined, nonEmpty, unorderedEqual } from "@bjornpagen/testing/assert"
import {
	accepting,
	type Machine,
	type Program,
	type Real,
	runProgram,
	took
} from "@bjornpagen/testing/commands"
import { constant, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Option, Order, Result, String as Str } from "effect"
import { applyLockKey, readLedger, type SchemaApplyReport } from "#adapter/migrate/apply.ts"
import type {
	AppliedEdit,
	MigrateError,
	UnresolvedLoss,
	UnresolvedMarker
} from "#adapter/migrate/errors.ts"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { AbandonedSchema } from "#compiler/deploy/diff/plan.ts"
import {
	completedFiles,
	type LedgerColumn,
	ledgerColumns,
	ledgerDigests,
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
import { codebookOf, emptyFingerprint } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { folderOrdinal, ledgerTableName, snapshotGuardName } from "#compiler/physical/ddl/ledger.ts"
import { catalogExpr } from "#compiler/sql/print.ts"
import {
	apply,
	writtenTexts,
	id,
	kept,
	noFurther,
	openMigrator,
	refusal,
	reviewedSource
} from "#test/pg/migrate/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { type InstalledCatalog, readCatalog } from "#test/support/catalog/read.ts"
import { chunked, joined } from "#test/support/chunked.ts"
import { firstCodes } from "#test/support/compile.ts"
import { atName, parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	draftChain,
	draftedAt,
	fromEmpty,
	fromEmptyBeside,
	noDeclarations,
	parsedMigrationName
} from "#test/support/migrate/kit.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { books1, shopV1, shopV2, shopV3, shopV3Declared } from "#test/unit/deploy/schemas.ts"

/** The model's state: the folders the ledger recorded complete, and, when it holds the next one unfinished, how many of
 * its files it recorded (none when a no-transaction file of it failed before any file was recorded). */
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
	readonly reviewed: ReadonlyArray<FolderTexts>
	/** Another schema's drafted first folder, never applied. */
	readonly foreign: GenerateResult
	readonly holder: RawSession
	readonly intruder: MigrationSession
}

export const commandKinds = [
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

export type Feature = (typeof commandKinds)[number]

const statements = (schema: string) => succeeded(statementsFor(schema))

/** The relations a call of the snapshot guard may read, each by its name in the schema: the ledger, its head and their keys. */
const guardRelations = [
	identity.ledger(),
	identity.ledgerKey(),
	identity.ledgerHead(),
	identity.ledgerHeadKey()
] as const

/**
 * A call of the snapshot guard of the schema at `fingerprint`, as a Db's transaction makes it, by the administrator in a
 * transaction of its own: refused, its SQLSTATE; or admitted, the pages a call of it reads of each of `guardRelations`,
 * in their order, which the transaction's own statistics count (pg_stat_get_xact_blocks_fetched), with the pages the
 * head holds. The pages are a second call's, its statement planned by the first, so what they count is the read alone,
 * never the planner's look at an index's metapage, as every Db's session calls the guard again under its cached plan.
 */
const guardCall = (r: System, fingerprint: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const admin = yield* (yield* Substrate).admin.pin
			const qualified = (name: string) => `${quoteIdent(r.schema)}.${quoteIdent(name)}`
			const fetched = Arr.map(
				guardRelations,
				(_, i) =>
					`pg_catalog.pg_stat_get_xact_blocks_fetched(pg_catalog.to_regclass($${i + 1}::text))`
			)
			const headPages = `pg_catalog.pg_relation_size(pg_catalog.to_regclass($${guardRelations.length + 1}::text)) / pg_catalog.current_setting('block_size')::bigint`
			yield* admin.queryValues("BEGIN", [])
			const called = yield* Effect.result(
				admin.queryValues(`SELECT ${qualified(snapshotGuardName)}($1::text)`, [fingerprint])
			)
			if (Result.isFailure(called)) {
				yield* admin.queryValues("ROLLBACK", [])
				const reason = called.failure.reason
				return {
					kind: "refused" as const,
					sqlstate: reason._tag === "ServerError" ? reason.fields.code : reason.message
				}
			}
			const counted = Effect.map(
				admin.queryValues(`SELECT ${Arr.join([...fetched, headPages], ", ")}`, [
					...Arr.map(guardRelations, (n) => qualified(identifierOf(n))),
					qualified(identifierOf(identity.ledgerHead()))
				]),
				([read]) => Arr.map(defined(read, "the guard's pages"), Number)
			)
			const before = yield* counted
			yield* admin.queryValues(`SELECT ${qualified(snapshotGuardName)}($1::text)`, [fingerprint])
			const after = yield* counted
			yield* admin.queryValues("ROLLBACK", [])
			return {
				kind: "admitted" as const,
				pages: Arr.zipWith(after.slice(0, -1), before.slice(0, -1), (a, b) => a - b),
				headPages: defined(after.at(-1), "the head's pages")
			}
		})
	)

/**
 * The snapshot guard the model claims, after every command: none before the first folder records a file; refused
 * (55Z02) at every snapshot while a folder is unfinished; else admitted at the latest target and refused (55Z01) at
 * another. Admitted, it reads no page of the ledger and of the head's key, and of the head no more pages than it holds,
 * one where its one row's versions are pruned, whatever the ledger holds: one keyed read of a derived fact, where the
 * ledger's rule read every folder row and counted each one's files in every Db transaction.
 */
const expectGuard = (r: System, model: Model) =>
	Effect.gen(function* () {
		if (model.recorded === 0 && Option.isNone(model.partial)) {
			return
		}
		const latest = defined(r.gs[Math.max(model.recorded, 1) - 1]).snapshot.fingerprint
		const another = r.foreign.snapshot.fingerprint
		const atLatest = yield* guardCall(r, latest)
		const atAnother = yield* guardCall(r, another)
		if (Option.isSome(model.partial)) {
			assert.deepEqual(
				atLatest,
				{ kind: "refused", sqlstate: sqlstates.grizzleMigrating },
				"the guard refuses a Db while a folder is unfinished"
			)
			assert.deepEqual(
				atAnother,
				{ kind: "refused", sqlstate: sqlstates.grizzleMigrating },
				"the guard refuses every Db while a folder is unfinished"
			)
			return
		}
		assert.deepEqual(
			atAnother,
			{ kind: "refused", sqlstate: sqlstates.grizzleMigrated },
			"the guard refuses a Db at another snapshot"
		)
		if (atLatest.kind !== "admitted") {
			return assert.fail(`the guard admits a Db at the latest target, not ${atLatest.sqlstate}`)
		}
		const [ledger, ledgerKey, head, headKey] = atLatest.pages
		assert.deepEqual(
			[ledger, ledgerKey, headKey],
			[0, 0, 0],
			`the guard reads no page of the ledger, its key or the head's key: a call read ${Arr.join(Arr.map(atLatest.pages, String), ", ")} of the ledger, its key, the head and the head's key`
		)
		assert.ok(
			head !== undefined && head >= 1 && head <= atLatest.headPages,
			`the guard reads the head's ${atLatest.headPages} page(s) at most, ${head} read`
		)
	})

/** The ledger the model claims: its latest target, and its partial folder with the files recorded; and its guard's verdicts (`expectGuard`). */
const expectLedger = (r: System, model: Model, actual: LedgerState) =>
	Effect.gen(function* () {
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
		yield* expectGuard(r, model)
	})

/** The ledger key's columns. */
const folderColumn: LedgerColumn = "folder"

const ordinalColumn: LedgerColumn = "ordinal"

/** Every ledger row a state records: each folder's recorded files with the folder's source, target, file count and
 * additions. */
const ledgerRows = (state: LedgerState): ReadonlyArray<LedgerRow> =>
	Arr.flatMap([...state.complete, ...(state.partial === undefined ? [] : [state.partial])], (f) =>
		Arr.map(
			[{ ordinal: folderOrdinal, file: metaFileName, digest: f.meta }, ...f.completed],
			(x): LedgerRow => ({
				folder: f.folder,
				ordinal: x.ordinal,
				file: x.file,
				source: f.source,
				target: f.target,
				files: f.files,
				digest: x.digest
			})
		)
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
				Arr.map(ledgerColumns, (c) =>
					Arr.contains(ledgerDigests, c)
						? `pg_catalog.encode(${quoteIdent(c)}, 'hex')`
						: `${quoteIdent(c)}::text`
				),
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
		const catalog = yield* readCatalog(substrate.admin, [r.schema])
		return { ledger, catalog: declared(catalog) }
	})

/**
 * The catalog as a file of a migration leaves it, each column's statistics its declared target alone: what an ANALYZE
 * samples (pg_stats' distinct values and its sampled statistics) is autovacuum's to write at any moment, of a table
 * changed past its threshold, the ledger's head first, which every file's transaction updates, so no comparison of two
 * reads around a refused file reads it.
 */
const declared = (read: InstalledCatalog): InstalledCatalog =>
	read.kind === "absent"
		? read
		: {
				kind: "present",
				catalog: {
					...read.catalog,
					tables: Arr.map(read.catalog.tables, (t) => ({
						...t,
						columns: Arr.map(t.columns, (c) => ({
							...c,
							statistics: Option.map(c.statistics, (st) =>
								Arr.join(Arr.take(Str.split(" ")(st), 2), " ")
							)
						}))
					}))
				}
			}

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
		yield* expectLedger(r, model, after.ledger)
		return e
	})

/** The folders as reviewed, none changed. */
const asReviewed = (f: FolderTexts): FolderTexts | undefined => f

/** The directory as of folder k, the folders reviewed, each folder of `edit` changed. */
const directory = (
	r: System,
	k: number,
	edit: (f: FolderTexts, i: number) => FolderTexts | undefined
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
const pointsOf = (folder: FolderTexts): ReadonlyArray<Point> =>
	Arr.flatMap(folder.files, (f, i): ReadonlyArray<Point> => {
		const ordinal = i + 1
		if (!isNoTransaction(new ChunkView(f.text))) {
			return [{ at: "before", ordinal }]
		}
		const within = Arr.map(
			indices(splitStatements(new ChunkView(f.text)).length - 1),
			(k): Point => ({
				at: "within",
				ordinal,
				statement: k + 1
			})
		)
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

/** A loss's place: the folder and the file that record it. */
type Place = Readonly<{ folder: string; file: string }>

/**
 * Losses by their place, a folder and a file, in that order: a file may record several losses, so the losses a refusal
 * names are a multiset of places, compared in this order, whatever order the refusal lists them in.
 */
const inPlaceOrder = (places: ReadonlyArray<Place>): ReadonlyArray<Place> =>
	Arr.sort(places, Order.Struct({ folder: Order.String, file: Order.String }))

/** The markers a drafted folder's files hold, and the losses of stored data its meta.json records, each drafted
 * commented, so unreviewed every one is unresolved. */
const unreviewedOf = (g: GenerateResult) => ({
	markers: Arr.flatMap(g.folder.files, (f) =>
		Arr.map(findMarkers(new ChunkView(f.text)), (mk) => ({
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
	reviewed: ReadonlyArray<FolderTexts>
): ChainShape =>
	Arr.map(gs, (g, i): FolderShape => {
		const folder = defined(reviewed[i])
		const unreviewed = unreviewedOf(g)
		return {
			markers: unreviewed.markers.length > 0,
			losses: unreviewed.losses.length > 0,
			points: nonEmpty(pointsOf(folder), `the points of ${folder.name}`),
			files: folder.files.length,
			noTransaction: Arr.map(folder.files, (f) => isNoTransaction(new ChunkView(f.text)))
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
export const machineOf = (shape: ChainShape): Machine<Model, LedgerParameters, never> => ({
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
	const fields = Arr.filter(stored.fields, (x) => x.writing === "caller")
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
 * A data step that inserts an automatic task without its arm is refused at COMMIT by the reverse containment of Shop
 * v2's Automatic arm's mirrors, a native foreign key deferred on the cycle (fin.md §7); an empty
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
					unorderedEqual(
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
				yield* expectLedger(r, after, observed.ledger)
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
				const early = (f: FolderTexts): FolderTexts => ({
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
					i === model.recorded ? writtenTexts(g.folder) : f
				)
				if (markers.length === 0 && losses.length === 0) {
					c.note("apply unreviewed without markers")
					yield* apply(r.m, unreviewed, noFurther)
					const observed = yield* observe(r)
					yield* expectLedger(r, after, observed.ledger)
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
						inPlaceOrder(Arr.map(named, (l) => ({ folder: l.folder, file: l.file }))),
						inPlaceOrder(losses),
						"the losses named, one per loss, in any order"
					)
					return
				}
				c.note("apply unreviewed")
				const e = yield* refusedBeforeRunning(r, model, "marker", apply(r.m, unreviewed, noFurther))
				const reason = e.reason
				assert.ok(reason._tag === "MarkersUnresolved", e.message)
				const named: ReadonlyArray<UnresolvedMarker> = reason.markers
				unorderedEqual(named, markers, "the markers named")
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
									x.name === file.name ? { ...x, text: chunked(inject(joined(x.text), point)) } : x
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
				yield* expectLedger(r, after, observed.ledger)
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
				const edit = (f: FolderTexts): FolderTexts | undefined => {
					switch (kind) {
						case "edited":
							return {
								...f,
								files: Arr.map(f.files, (x) =>
									x === target ? { ...x, text: chunked(`-- tuned\n${joined(x.text)}`) } : x
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
							return {
								...f,
								files: [...f.files, { name: "99-later.sql", text: chunked("SELECT 1;\n") }]
							}
						case "meta edited":
							return { ...f, metaText: chunked(`${joined(f.metaText)}\n`) }
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
					`SELECT pg_catalog.pg_advisory_lock(${catalogExpr(applyLockKey(r.schema)).text})`,
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
							`SELECT pg_catalog.pg_advisory_unlock(${catalogExpr(applyLockKey(r.schema)).text})`,
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
							(f, i) => i + 1 > partialFiles(model) && !isNoTransaction(new ChunkView(f.text))
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
											x === file ? { ...x, text: chunked(`${joined(x.text)}\nCOMMIT;\n`) } : x
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
				/** A closed id is stored as its handle's code, as the snapshot's codes number the roster. */
				const automatic = codeOf(
					defined(codebookOf(snapshot).rosters.get(parsedName("Kind")), "the codes of Kind"),
					"Automatic"
				)
				const task = snapshot.theory.relations["Task"]
				assert.ok(task?.kind === "relation", "Task is a stored relation of the snapshot")
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
							text: chunked(
								insertOf(snapshot, r.schema, "Account", { id: account, name: "'alpha'" }) +
									insertOf(snapshot, r.schema, "Task", {
										id: `'${id(11)}'`,
										account,
										kind: `${automatic}::smallint`,
										weight: "1"
									})
							)
						}
					]
				}
				const before = yield* observe(r)
				const e = yield* refusal(
					apply(
						r.m,
						{ snapshot, folders: [...r.reviewed.slice(0, model.recorded), writtenTexts(step)] },
						noFurther
					)
				)
				assert.ok(e.stage === "commit", e.message)
				const server = e.server
				if (server.by !== "server") {
					return assert.fail("the server refused the COMMIT")
				}
				const { sqlstate, constraint } = server.error
				assert.ok(sqlstate === "23503", "the COMMIT's SQLSTATE")
				const named =
					constraint === undefined
						? []
						: (lawsOfConstraint(
								snapshot.constraintToLaw,
								{ kind: "table", name: task.ident },
								constraint
							) ?? [])
				/** How the snapshot holds each law the refusal names, held at COMMIT: by a deferred native, or by the judge, a
				 * containment the rule judge holds among them (laws/model/plan.ts containmentDischarge). */
				const held = Arr.map(named, (law) => snapshot.theory.laws[law]?.kind)
				assert.ok(
					Arr.isReadonlyArrayNonEmpty(held) &&
						Arr.every(held, (kind) => kind === "native" || kind === "trigger"),
					`every law on Task the COMMIT's refusal names is held at COMMIT, by a deferred foreign key or the judge, not ${Formatter.format(held)}`
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
						{ snapshot: first.snapshot, folders: [writtenTexts(early), defined(r.reviewed[0])] },
						noFurther
					)
				)
				assert.equal(e.stage, "record", e.message)
				const catalog = yield* readCatalog(substrate.admin, [r.schema])
				assert.equal(catalog.kind, "absent", "the schema the first file created rolled back")
				const observed = yield* observe(r)
				yield* expectLedger(r, model, observed.ledger)
			}),
			took
		)
})

/**
 * The schema the chain's first draft abandons: a directory of the migrations directory, holding its snapshot.json, of a
 * schema the configuration no longer lists, as a schema renamed in code leaves one. Every drop is declared, so starting
 * the schema beside it is the one loss a draft leaves to the reviewer.
 */
const abandoned: AbandonedSchema = { schema: "store", directory: "migrations/store" }

/**
 * The chain Shop v1 to v3 drafted from the empty snapshot beside the abandoned schema, under an allocated schema name
 * and its owner, each step's codes drafted from the snapshot before it, v3 declaring its one drop (`--drop
 * Task.weight`).
 */
const chainOf = (allocated: string): ReadonlyArray<GenerateResult> =>
	draftChain(
		Arr.map(
			[
				[shopV1, noDeclarations],
				[shopV2, noDeclarations],
				[shopV3, shopV3Declared]
			] as const,
			([desc, declared]) => ({
				desc,
				options: {
					schema: atName(allocated),
					extensions: [],
					codes: firstCodes
				},
				declared
			})
		),
		fromEmptyBeside([abandoned])
	)

type LedgerProgram = Program<LedgerParameters>

/** One run of the state machine: a schema of its own, the chain drafted and reviewed against it, which must have the
 * shape the model was built over, and the program run on it from the empty snapshot. */
export const runOn = (shape: ChainShape) => (steps: LedgerProgram, c: Case<Feature>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		/** The allocated name the chain is installed under, and its PostgreSQL schema, the door's identifier of it. */
		const allocated = yield* substrate.schema({ create: false, label: "ledger" })
		const schema = identifierOf(identity.schema(parsedSchemaName(allocated)))
		const gs = chainOf(allocated)
		const reviewed = Arr.map(gs, (g) => reviewedSource(g, kept))
		assert.deepEqual(shapeOf(gs, reviewed), shape, "the case's chain has the model's shape")
		const foreignSchema = yield* substrate.schema({ create: false, label: "ledger_other" })
		const foreign = defined(
			draftChain(
				[
					{
						desc: books1,
						options: {
							schema: atName(foreignSchema),
							extensions: [],
							codes: firstCodes
						},
						declared: noDeclarations
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

/**
 * The shape of the chain every case drafts, read off the chain drafted under names of its own: drafting depends on the
 * schema's and the owner's names only in the names it writes (shapeOf), and each case checks its own chain has it.
 */
const shapeChain = chainOf("ledger_shape")

export const ledgerShape: ChainShape = shapeOf(
	shapeChain,
	Arr.map(shapeChain, (g) => reviewedSource(g, kept))
)
