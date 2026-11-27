import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { catchRefusal, Refusal, unwrap } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import { TemporaryCensus } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { recordedSources } from "#compiler/deploy/admission/manifest.ts"
import { asidesOf, setAside } from "#compiler/deploy/diff/aside.ts"
import { applyDeclarations } from "#compiler/deploy/diff/declared.ts"
import { diff } from "#compiler/deploy/diff/diff.ts"
import {
	type AbandonedSchema,
	type Declarations,
	draftedStatements,
	type MigrationPlan,
	type Swap
} from "#compiler/deploy/diff/plan.ts"
import { fileLockSets, migrationCatalog, StandingIndexes } from "#compiler/deploy/locks/demand.ts"
import { planFiles } from "#compiler/deploy/phases/files.ts"
import {
	type AdvisedFile,
	advisedFiles,
	indexesBeforeReaders
} from "#compiler/deploy/render/advise.ts"
import {
	type CustomMeta,
	type DecisionRecord,
	type DraftedFolder,
	type DraftedMeta,
	decisionRecord,
	type FolderLaws,
	type FolderNaming,
	folderName,
	type MigrationFolder,
	type MigrationName,
	provedRecord,
	writeMeta
} from "#compiler/deploy/render/folder.ts"
import { derivedMigrationName } from "#compiler/deploy/render/naming.ts"
import { assertSourcesAsRecorded } from "#compiler/deploy/render/sources.ts"
import { recordFile, renderFile, spellFile } from "#compiler/deploy/render/sql.ts"
import {
	derivedOf,
	discontinuedRoster,
	type DraftWorkload,
	finishSnapshot,
	rosterFates,
	targetState,
	withAttnums,
	withInstalledViews
} from "#compiler/deploy/snapshot/build.ts"
import type {
	DeploySnapshot,
	SnapshotContent,
	SnapshotDerived
} from "#compiler/deploy/snapshot/types.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { hashedNames } from "#compiler/physical/install/comments.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { assertFolderCreatesHeld } from "#compiler/physical/obligations/created.ts"
import { tableMaxColumns } from "#compiler/write/carriers/carriers.ts"

/** What a schema's draft is drafted from: `grizzle check`'s, and `grizzle generate`'s before it names the folder. */
export interface DraftInput {
	/** The previous committed snapshot: the empty snapshot (`emptySnapshot`) before the schema's first
	 * migration. */
	readonly previous: DeploySnapshot
	/** The current schema's installation, compiled with every extension it needs (derived relations, the workload's
	 * access paths and statistics), as a fresh install would be. */
	readonly installation: Installation
	/** The current workloads: each login's programs' access and the access requests, none for a schema without one. */
	readonly workload: DraftWorkload
	/** The renames and drops this migration declares (`--rename`, `--drop`). */
	readonly declared: Declarations
	/** The schemas the migrations directory holds that the configuration no longer lists, which the CLI names for a
	 * schema's first migration (none for any other): the draft starts the schema under the loss of their rows. */
	readonly abandoned: ReadonlyArray<AbandonedSchema>
}

/** A draft and how `grizzle generate` names its folder: by `--name` or after its change, and the CLI's timestamp. */
interface GenerateInput extends DraftInput {
	readonly naming: FolderNaming
	/** YYYYMMDDHHMMSS, the second after the committed chain's last folder's (the CLI's cli/timestamp.ts). */
	readonly timestamp: string
}

/** What a draft changes: nothing, so the folder holds no file and the snapshot is the previous one; or the schema or
 * workload. */
type DraftChange = "none" | "schema"

/** A draft whose folder is `F`: what it changes, its folder, the folder's decision record, the new snapshot, the
 * installation's derived runtime facts snapshot.json records beside it, and the plan the folder's files render. The
 * snapshot's files are written from the snapshot and its facts where they are written (deploy/snapshot/build.ts
 * writeSnapshot), and snapshot.json alone where it is read (writeRuntimeSnapshot). */
interface DraftOf<F> {
	readonly change: DraftChange
	readonly folder: F
	/** The folder's meta.json files, read as `grizzle check` reads them (decisionRecord), once proved (provedRecord). */
	readonly record: DecisionRecord
	readonly snapshot: DeploySnapshot
	readonly derived: SnapshotDerived
	readonly plan: MigrationPlan
	/** The plan's files, each as it writes its drafts and with the advice its transaction runs under, which meta.json
	 * records (render/advise.ts AdvisedFile): the plans the advice is printed of, every data step's bound. */
	readonly files: ReadonlyArray<AdvisedFile>
}

/** A draft before its folder is named: the folder's meta.json and files, as `grizzle check` drafts it. */
export type MigrationDraft = DraftOf<Omit<DraftedFolder, "name">>

/** A draft whose folder is named `<timestamp>_<name>`, as `grizzle generate` writes it. */
export type GenerateResult = DraftOf<DraftedFolder>

/** One table's constraint names to their laws, each also under every name `swaps` builds it under on `table`. */
const builtUnder = (
	table: string,
	named: Readonly<Record<string, NonEmptyReadonlyArray<LawId>>>,
	swaps: ReadonlyArray<Swap>
): Readonly<Record<string, NonEmptyReadonlyArray<LawId>>> =>
	Object.fromEntries(
		Object.entries(named).flatMap(
			([name, laws]): ReadonlyArray<readonly [string, NonEmptyReadonlyArray<LawId>]> => [
				[name, laws],
				...swaps
					.filter((s) => s.table === table && s.of === name)
					.map((s) => [s.name, laws] as const)
			]
		)
	)

/**
 * The laws a refusal of a folder that installs `snapshot` over `previous` names (FolderLaws): every constraint that
 * stands while the folder runs, the target's, each table's also under every name the folder's `swaps` build it under,
 * and the previous installation's on every owner the target holds none of, which a statement of the folder can break
 * before the folder drops it, a stored table its form's change renames among them; and the level schemas of both.
 */
const folderLaws = (
	snapshot: DeploySnapshot,
	previous: DeploySnapshot,
	swaps: ReadonlyArray<Swap>
): FolderLaws => {
	const target = snapshot.constraintToLaw
	const before = previous.constraintToLaw
	return {
		schemas: [...new Set([...snapshot.levels, ...previous.levels].map((l) => l.schema))],
		constraintToLaw: {
			tables: Object.fromEntries(
				[
					...Object.entries(target.tables).map(
						([table, named]) => [table, builtUnder(table, named, swaps)] as const
					),
					...Object.entries(before.tables).filter(([table]) => !Object.hasOwn(target.tables, table))
				].toSorted(([a], [b]) => compareStrings(a, b))
			),
			domains: Object.fromEntries(
				[
					...Object.entries(target.domains),
					...Object.entries(before.domains).filter(
						([domain]) => !Object.hasOwn(target.domains, domain)
					)
				].toSorted(([a], [b]) => compareStrings(a, b))
			)
		}
	}
}

/** `grizzle check`'s draft as a pure function: the plan (planMigration), then its folder rendered, unnamed
 * (renderFolder).
 *
 * draftMigration drafts the next folder of a declared schema from its previous committed snapshot (the empty snapshot
 * before the first migration), the current schema's compiled installation and its logins' workloads: it builds the
 * target snapshot state with the ledger's objects, diffs the two, groups the plan into files and renders them, with
 * meta.json's decision record. It returns the folder's contents and the new snapshot. It reads no file and no clock. The
 * installation is compiled under the codes drafted from `previous`'s (ir/codes.ts draftCodebook over snapshot/build.ts
 * codebookOf): codes that give a code `previous` recorded another meaning are a defect of the caller, never drafted.
 *
 * A schema whose target equals its previous snapshot drafts nothing: the change is none, the snapshot is the previous
 * one and the folder holds no file, so the CLI can report that there is nothing to generate. */
export const draftMigration = (input: DraftInput): Result.Result<MigrationDraft, CompileError> =>
	Result.flatMap(planMigration(input), draftOf)

/**
 * The plan of the next folder of a declared schema from its previous committed snapshot (PlannedDraft): the target
 * snapshot state built with the ledger's objects, the two diffed, and the new snapshot, before the folder is rendered.
 */
export const planMigration = (input: DraftInput): Result.Result<PlannedDraft, CompileError> =>
	catchRefusal(() => {
		const { installation, previous } = input
		/** The installation's checks, written once: their digests the snapshot records, their queries the diff drafts. */
		const checks = lawChecks(installation)
		const state = unwrap(targetState({ installation, workload: input.workload, checks }))
		if (previous.schema !== installation.names.schema) {
			throw new Refusal(
				malformedArtifact(
					"snapshot",
					["schema"],
					`a previous snapshot of the installed schema ${installation.names.schema}; it is of ${previous.schema}`
				)
			)
		}
		const rosters = rosterFates(previous, input.declared, [
			...installation.names.codes.rosters.keys()
		])
		const discontinued = discontinuedRoster(rosters, installation.names.codes)
		if (discontinued !== undefined) {
			defect(
				`the installation's codes of roster ${discontinued} continue the previous snapshot's: compile it under the codes drafted from them`
			)
		}
		/** Every hashed name that stands while the migration runs, the previous installation's and the target's, against
		 * which each temporary it mints is censused. */
		const temporaries = new TemporaryCensus([
			...hashedNames(previous.manifest.comments),
			...hashedNames(state.manifest.comments)
		])
		/** The declared renames carried out first, every drop checked declared; then the holders whose names the target
		 * gives objects of another kind set aside. */
		const applied = applyDeclarations(previous, state, installation, input.declared, temporaries)
		const asides = asidesOf(applied.previous, state.manifest.objects, temporaries)
		/** The diff's plan, each index a data step reads through created before it (render/advise.ts
		 * indexesBeforeReaders): the plan every file and the snapshot are drafted from. */
		const plan = indexesBeforeReaders(
			unwrap(
				diff({
					previous: setAside(applied.previous, asides),
					target: state,
					installation,
					checks,
					renames: applied.statements,
					asides,
					temporaries,
					abandoned: input.abandoned,
					rosters
				})
			),
			installation
		)
		/** The target's content, its attribute numbers continuing the previous snapshot's, fingerprinted: the new
		 * snapshot where its fingerprint is another than the previous one's, the previous snapshot itself, as the
		 * schemas compile it, where it is the same, since the fingerprint digests the whole content. */
		const content = unwrap(
			withAttnums(withInstalledViews(state, plan), applied.previous, plan, tableMaxColumns)
		)
		const snapshot = unwrap(finishSnapshot(content))
		const change: DraftChange =
			plan.steps.length > 0 || snapshot.fingerprint !== previous.fingerprint ? "schema" : "none"
		const planned: PlannedDraft = {
			change,
			snapshot,
			derived: derivedOf(installation),
			plan,
			files:
				change === "schema"
					? advisedFiles(
							planFiles(plan),
							installation,
							new StandingIndexes(
								previous,
								state.manifest.objects.flatMap((o) => o.ddl)
							)
						)
					: [],
			rendering: {
				previous,
				schema: installation.names.schema,
				objects: state.manifest.objects,
				declared: input.declared
			}
		}
		return planned
	})

/**
 * What a draft's folder is rendered from beside its plan and its snapshot (renderFolder): the previous installation it is
 * drafted from, the installed schema, every object of the target installation, and the renames and drops it declares.
 */
interface FolderInput {
	readonly previous: DeploySnapshot
	readonly schema: Installation["names"]["schema"]
	readonly objects: SnapshotContent["manifest"]["objects"]
	readonly declared: Declarations
}

/**
 * A draft before its folder is rendered (planMigration): what it changes, the new snapshot, the
 * installation's derived runtime facts snapshot.json records beside it, the plan its folder's files render, and what the
 * rendering reads beside them (FolderInput). It holds no installation. The snapshot is all a login's served file reads
 * of the draft, and of the snapshot's facts the plan decides one alone, its fingerprint, over the content's attribute
 * numbers and installed views (snapshot/build.ts withAttnums, withInstalledViews); the rest is the installation's. So the
 * served files compile between the plan and the folder's rendering (renderMigration), neither the installation nor what
 * the rendering makes held beside what they compile over, and the rendering runs once they are written.
 */
export interface PlannedDraft {
	readonly change: DraftChange
	readonly snapshot: DeploySnapshot
	readonly derived: SnapshotDerived
	readonly plan: MigrationPlan
	/** The plan's files, each as it writes its drafts and with the advice its transaction runs under (render/advise.ts). */
	readonly files: ReadonlyArray<AdvisedFile>
	readonly rendering: FolderInput
}

/** A planned draft's folder, `F` unnamed or named, and the folder's decision record (renderFolder, renderMigration). */
interface RenderedFolder<F> {
	readonly folder: F
	readonly record: DecisionRecord
}

/**
 * The folder a planned draft renders, unnamed, and its decision record: its plan grouped into files and rendered, with
 * meta.json's decision record of every file built through the record's one constructor (provedRecord), which proves it
 * over every drafted statement's text before it records each statement that is no decision's and holds no placeholder
 * by its digest, and the meta sealed over it, so `grizzle check` and `grizzle migrate` read it (decisionRecord) without
 * proving it again; every function the folder creates is held to the snapshot's record of its source by the text the
 * folder writes (render/sources.ts assertSourcesAsRecorded), an internal compiler error where they differ. A draft that
 * changes nothing renders a folder of no file.
 */
const renderFolder = (
	planned: PlannedDraft
): Result.Result<RenderedFolder<Omit<DraftedFolder, "name">>, CompileError> =>
	catchRefusal(() => {
		const { snapshot, rendering } = planned
		const { previous, objects } = rendering
		const advised = planned.files
		const drafted = advised.map((a) => a.file)
		assertFolderCreatesHeld(
			drafted.flatMap((f) => f.drafts.flatMap(draftedStatements)),
			new Set(objects.map((o) => o.ident))
		)
		/** Each drafted file's statements, each printed and filed once for its text and for meta.json. */
		const spelled = new Map(advised.map((a) => [a.file, [unwrap(spellFile(a)), a.advice] as const]))
		const spelledOf = (f: (typeof drafted)[number]) =>
			defined(spelled.get(f), "a drafted file is spelled")
		const files = drafted.map((f) => ({ name: f.name, text: unwrap(renderFile(spelledOf(f)[0])) }))
		const draftedRecord = fileLockSets({
			schema: rendering.schema,
			catalog: migrationCatalog(
				previous,
				objects.flatMap((o) => o.ddl)
			),
			files: drafted
		}).map((f) => {
			const [file, advice] = spelledOf(f.file)
			return unwrap(recordFile(file, f.locks.size, advice))
		})
		assertSourcesAsRecorded(draftedRecord, recordedSources(snapshot))
		const recorded = unwrap(provedRecord(draftedRecord))
		const meta: DraftedMeta = {
			kind: "drafted",
			schemaName: snapshot.schemaName,
			schema: snapshot.schema,
			source: previous.fingerprint,
			target: snapshot.fingerprint,
			laws: folderLaws(snapshot, previous, planned.plan.swaps),
			declared: rendering.declared,
			files: recorded
		}
		return {
			folder: { meta, metaText: unwrap(writeMeta(meta)), files },
			record: decisionRecord(recorded)
		}
	})

/** A planned draft whole: its folder rendered (renderFolder) beside its plan and its snapshot. */
const draftOf = (planned: PlannedDraft): Result.Result<MigrationDraft, CompileError> =>
	Result.map(renderFolder(planned), (rendered) => ({
		change: planned.change,
		folder: rendered.folder,
		record: rendered.record,
		snapshot: planned.snapshot,
		derived: planned.derived,
		plan: planned.plan,
		files: planned.files
	}))

/** The name a draft's folder is named by: the name `--name` gives, or the one derived from its change. */
const draftName = (
	naming: FolderNaming,
	previous: DeploySnapshot,
	snapshot: DeploySnapshot
): MigrationName => {
	switch (naming.kind) {
		case "named":
			return naming.name
		case "derived":
			return derivedMigrationName(previous, snapshot)
	}
}

/**
 * A planned draft's folder rendered (renderFolder) and named `<timestamp>_<name>` by `naming`, with its decision record:
 * what `grizzle generate` writes once the served files the plan's snapshot compiles are written.
 * The caller supplies the timestamp, the committed chain's next (the CLI's cli/timestamp.ts), so the folder is a
 * function of its input alone.
 */
export const renderMigration = (
	planned: PlannedDraft,
	naming: FolderNaming,
	timestamp: string
): Result.Result<RenderedFolder<DraftedFolder>, CompileError> =>
	Result.flatMap(renderFolder(planned), (rendered) =>
		Result.map(
			folderName(timestamp, draftName(naming, planned.rendering.previous, planned.snapshot)),
			(name) => ({ folder: { name, ...rendered.folder }, record: rendered.record })
		)
	)

/** `grizzle generate` as a pure function: the plan (planMigration), its folder rendered and named `<timestamp>_<name>`
 * (renderMigration). It returns the folder and the new snapshot; the CLI writes both. */
export const generateMigration = (
	input: GenerateInput
): Result.Result<GenerateResult, CompileError> =>
	Result.flatMap(planMigration(input), (planned) =>
		Result.map(
			renderMigration(planned, input.naming, input.timestamp),
			(rendered): GenerateResult => ({
				change: planned.change,
				folder: rendered.folder,
				record: rendered.record,
				snapshot: planned.snapshot,
				derived: planned.derived,
				plan: planned.plan,
				files: planned.files
			})
		)
	)

/** `grizzle generate --custom` as a pure function: an empty migration for hand-written data steps, whose source and
 * target are both the current snapshot. */
export const customMigration = (input: {
	readonly snapshot: DeploySnapshot
	readonly name: MigrationName
	readonly timestamp: string
}): Result.Result<MigrationFolder, CompileError> =>
	catchRefusal(() => {
		const name = unwrap(folderName(input.timestamp, input.name))
		const meta: CustomMeta = {
			kind: "custom",
			schemaName: input.snapshot.schemaName,
			schema: input.snapshot.schema,
			source: input.snapshot.fingerprint,
			target: input.snapshot.fingerprint,
			laws: folderLaws(input.snapshot, input.snapshot, [])
		}
		return { name, meta, metaText: unwrap(writeMeta(meta)), files: [] }
	})
