import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { catchRefusal, Refusal, unwrap } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import { TemporaryCensus } from "#compiler/core/identity.ts"
import type { LawId, SchemaFingerprint } from "#compiler/core/ids.ts"
import { asidesOf, setAside } from "#compiler/deploy/diff/aside.ts"
import { applyDeclarations } from "#compiler/deploy/diff/declared.ts"
import type { Departure } from "#compiler/deploy/diff/departed.ts"
import { diff } from "#compiler/deploy/diff/diff.ts"
import {
	type AbandonedSchema,
	type Declarations,
	type MigrationPlan,
	noDeclarations,
	type Swap
} from "#compiler/deploy/diff/plan.ts"
import { fileLockSets, migrationCatalog } from "#compiler/deploy/locks/demand.ts"
import { planFiles } from "#compiler/deploy/phases/files.ts"
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
	upgradeMigrationName,
	writeMeta
} from "#compiler/deploy/render/folder.ts"
import { derivedMigrationName } from "#compiler/deploy/render/naming.ts"
import { recordFile, renderFile, type SpelledFile, spellFile } from "#compiler/deploy/render/sql.ts"
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
import { recordedManifest } from "#compiler/deploy/snapshot/recorded.ts"
import type {
	DeploySnapshot,
	SnapshotContent,
	SnapshotDerived,
	SnapshotRelation
} from "#compiler/deploy/snapshot/types.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { hashedNames } from "#compiler/physical/install/comments.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
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
	/** YYYYMMDDHHMMSS, from the CLI's clock. */
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

/** The laws a refusal of a folder that installs `snapshot` names (FolderLaws): the snapshot's level schemas, and its
 * constraint-to-law map with each table's constraint also under every name the folder's `swaps` build it under. */
const folderLaws = (snapshot: DeploySnapshot, swaps: ReadonlyArray<Swap>): FolderLaws => ({
	schemas: snapshot.levels.map((l) => l.schema),
	constraintToLaw: {
		tables: Object.fromEntries(
			Object.entries(snapshot.constraintToLaw.tables).map(
				([table, named]) => [table, builtUnder(table, named, swaps)] as const
			)
		),
		domains: snapshot.constraintToLaw.domains
	}
})

/** `grizzle check`'s draft, and `grizzle generate`'s before it names the folder, as a pure function.
 *
 * draftMigration drafts the next folder of a declared schema from its previous committed snapshot (the empty snapshot
 * before the first migration), the current schema's compiled installation and its logins' workloads: it builds the
 * target snapshot state with the ledger's objects, diffs the two, groups the plan into files and renders them, with
 * meta.json's decision record of every file built through the record's one constructor (provedRecord), which proves it
 * over every drafted statement's text before it records each statement that is no decision's and holds no placeholder
 * by its digest, and the meta sealed over it, so `grizzle check` and `grizzle migrate` read it (decisionRecord) without
 * proving it again. It returns the folder's contents and the new snapshot. It reads no file and no clock. The
 * installation is compiled under the codes drafted from `previous`'s (ir/codes.ts draftCodebook over snapshot/build.ts
 * codebookOf): codes that give a code `previous` recorded another meaning are a defect of the caller, never drafted.
 *
 * A schema whose target equals its previous snapshot drafts nothing: the change is none, the snapshot is the previous
 * one and the folder holds no file, so the CLI can report that there is nothing to generate. */
export const draftMigration = (input: DraftInput): Result.Result<MigrationDraft, CompileError> =>
	draftOver(input, () => ({ previous: input.previous, stale: noStale, departures: [] }))

/** What a draft diffs the target against: the previous installation, and the objects the database holds of it beyond
 * its record, none for a committed snapshot's draft (deploy/diff/diff.ts DiffInput stale, departures). */
interface DraftedFrom {
	readonly previous: DeploySnapshot
	readonly stale: ReadonlySet<string>
	readonly departures: ReadonlyArray<Departure>
}

/** No object the database holds otherwise: a committed snapshot is what the database holds. */
const noStale: ReadonlySet<string> = new Set()

/**
 * The draft of the target `input` compiles, from the previous installation `from` reads off the target's content, its
 * state before the diff: a committed snapshot's draft reads none of it, and an upgrade's previous installation is that
 * content as the live catalog holds it (livePrevious).
 */
const draftOver = (
	input: Omit<DraftInput, "previous">,
	from: (state: SnapshotContent) => DraftedFrom
): Result.Result<MigrationDraft, CompileError> =>
	catchRefusal(() => {
		const { installation } = input
		/** The installation's checks, written once: their digests the snapshot records, their queries the diff drafts. */
		const checks = lawChecks(installation)
		const state = unwrap(targetState({ installation, workload: input.workload, checks }))
		const { previous, stale, departures } = from(state)
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
			throw defect(
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
		const plan = unwrap(
			diff({
				previous: setAside(applied.previous, asides),
				target: state,
				installation,
				checks,
				renames: applied.statements,
				asides,
				temporaries,
				abandoned: input.abandoned,
				rosters,
				stale,
				departures
			})
		)
		/** The target's content, its attribute numbers continuing the previous snapshot's, fingerprinted: the new
		 * snapshot where its fingerprint is another than the previous one's, the previous snapshot itself, as the
		 * schemas compile it, where it is the same, since the fingerprint digests the whole content. */
		const content = unwrap(
			withAttnums(withInstalledViews(state, plan), applied.previous, plan, tableMaxColumns)
		)
		const snapshot = unwrap(finishSnapshot(content))
		const changed = plan.steps.length > 0 || snapshot.fingerprint !== previous.fingerprint
		const drafted = changed ? planFiles(plan) : []
		/** Each drafted file's statements, each printed and filed once for its text and for meta.json. */
		const spelled = new Map(drafted.map((f) => [f, unwrap(spellFile(f))] as const))
		const spelledOf = (f: (typeof drafted)[number]): SpelledFile =>
			defined(spelled.get(f), "a drafted file is spelled")
		const files = drafted.map((f) => ({ name: f.name, text: unwrap(renderFile(spelledOf(f))) }))
		const draftedRecord = fileLockSets({
			schema: installation.names.schema,
			catalog: migrationCatalog(
				previous,
				state.manifest.objects.flatMap((o) => o.ddl)
			),
			files: drafted
		}).map((f) => unwrap(recordFile(spelledOf(f.file), f.locks.size)))
		const recorded = unwrap(provedRecord(draftedRecord))
		const record = decisionRecord(recorded)
		const meta: DraftedMeta = {
			kind: "drafted",
			schemaName: snapshot.schemaName,
			schema: snapshot.schema,
			source: previous.fingerprint,
			target: snapshot.fingerprint,
			laws: folderLaws(snapshot, plan.swaps),
			declared: input.declared,
			files: recorded
		}
		const change: DraftChange = changed ? "schema" : "none"
		const derived = derivedOf(installation)
		return {
			change,
			folder: { meta, metaText: unwrap(writeMeta(meta)), files },
			record,
			snapshot,
			derived,
			plan
		}
	})

/**
 * What `grizzle upgrade` reads of a live installation beside the target, the compile of the source the installation was
 * deployed from by this grizzle (the shell's cli/upgrade.ts): the snapshot the database holds by its ledger, of
 * whatever format its committed files are, and the target's objects as the drift check of the target against the live
 * catalog found them.
 */
export interface LiveInstallation {
	/** The ledger's latest complete target: the snapshot the database holds, which the upgrade's folder continues. */
	readonly fingerprint: SchemaFingerprint
	/**
	 * Every object of the target the database holds, by identity: each PostgreSQL describes held as the target's or
	 * defined otherwise under the target's names (`stale`), and each it does not describe whose every object it is
	 * created after the database holds. Every other is absent, which the upgrade creates.
	 */
	readonly kept: ReadonlySet<string>
	/** The kept objects the database holds under the target's names but defines otherwise (DiffInput stale). */
	readonly stale: ReadonlySet<string>
	/** The objects the database holds that no object of the target is, in their drop order (DiffInput departures). */
	readonly departures: ReadonlyArray<Departure>
	/**
	 * The attribute numbers each table of the installation has used, by its name, as pg_attribute counts them, its
	 * dropped columns included: each stored relation's history, which no source determines (SnapshotRelation attnums).
	 */
	readonly attnums: ReadonlyMap<string, number>
}

/** What an upgrade's draft is drafted from: the target's compile and workloads (DraftInput), and the live installation. */
export interface UpgradeInput extends Omit<DraftInput, "previous" | "declared" | "abandoned"> {
	readonly live: LiveInstallation
}

/**
 * The previous installation an upgrade drafts from: the target's content as the live installation holds it, under the
 * ledger's fingerprint. Its manifest is the target's objects the database holds (`kept`), each recorded as the target's,
 * the ones it holds otherwise named as the target names them, which the database's are (`stale`), with every edge of
 * the target to one of them, so a kept object reads through its record what the target's reads (a stale roster domain
 * its roster's constants, the one an upgrade creates among them, deploy/diff/diff.ts domainsOf); each stored relation's attribute numbers are the table's; every other member is the target's,
 * the codes and spellings it was compiled under the database's own (the shell's cli/upgrade.ts reads them). So the diff
 * creates each absent object, changes each stale one by its kind's rule, and drops each departed one, with the safety
 * of any migration, and a target the database holds whole drafts nothing but the snapshot.
 */
const livePrevious = (state: SnapshotContent, live: LiveInstallation): DraftedFrom => {
	const relations = Object.fromEntries(
		Object.entries(state.theory.relations).map(([name, r]): readonly [string, SnapshotRelation] => [
			name,
			r.kind === "relation"
				? {
						...r,
						attnums: defined(
							live.attnums.get(r.ident),
							"the live installation holds every table it keeps"
						)
					}
				: r
		])
	)
	const content: SnapshotContent = {
		...state,
		theory: { ...state.theory, relations },
		manifest: {
			...state.manifest,
			objects: state.manifest.objects.filter((o) => live.kept.has(o.ident)),
			edges: state.manifest.edges.filter((e) => live.kept.has(e.to))
		}
	}
	return {
		previous: {
			...content,
			manifest: recordedManifest(content.manifest),
			fingerprint: live.fingerprint
		},
		stale: live.stale,
		departures: live.departures
	}
}

/**
 * `grizzle upgrade`'s draft as a pure function: the target drafted from the live installation it is compiled for
 * (livePrevious), declaring nothing, as generate drafts from a committed snapshot. Its change is none where the database
 * holds the target whole under its fingerprint: only the snapshot's files are written again, in this grizzle's format;
 * else its folder rebases the installation's history onto the target, holding no file where only the fingerprint moved.
 */
export const draftUpgrade = (input: UpgradeInput): Result.Result<MigrationDraft, CompileError> =>
	draftOver({ ...input, declared: noDeclarations, abandoned: [] }, (state) =>
		livePrevious(state, input.live)
	)

/** `grizzle upgrade`'s draft as `grizzle upgrade` writes it: its folder named `<timestamp>_upgrade` (draftUpgrade). */
export const generateUpgrade = (
	input: UpgradeInput & { readonly timestamp: string }
): Result.Result<GenerateResult, CompileError> =>
	Result.flatMap(draftUpgrade(input), (draft) =>
		Result.map(folderName(input.timestamp, upgradeMigrationName), (name): GenerateResult => ({
			...draft,
			folder: { name, ...draft.folder }
		}))
	)

/**
 * The snapshot of the target `input` compiles, as a fresh installation records it: what the drift check of an upgrade
 * judges the live catalog by, before anything of the live installation is known.
 */
export const freshSnapshot = (
	input: Omit<DraftInput, "previous" | "declared" | "abandoned">
): Result.Result<DeploySnapshot, CompileError> =>
	catchRefusal(() =>
		unwrap(
			finishSnapshot(
				unwrap(
					targetState({
						installation: input.installation,
						workload: input.workload,
						checks: lawChecks(input.installation)
					})
				)
			)
		)
	)

/** The name a draft's folder is named by: the name `--name` gives, or the one derived from its change. */
const draftName = (
	naming: FolderNaming,
	previous: DeploySnapshot,
	draft: MigrationDraft
): MigrationName => {
	switch (naming.kind) {
		case "named":
			return naming.name
		case "derived":
			return derivedMigrationName(previous, draft.snapshot)
	}
}

/** `grizzle generate` as a pure function: the draft (draftMigration), its folder named `<timestamp>_<name>`. It returns
 * the folder and the new snapshot; the CLI writes both. The caller supplies the timestamp, since the compiler reads no
 * clock. */
export const generateMigration = (
	input: GenerateInput
): Result.Result<GenerateResult, CompileError> =>
	Result.flatMap(draftMigration(input), (draft) =>
		Result.map(
			folderName(input.timestamp, draftName(input.naming, input.previous, draft)),
			(name): GenerateResult => ({ ...draft, folder: { name, ...draft.folder } })
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
			laws: folderLaws(input.snapshot, [])
		}
		return { name, meta, metaText: unwrap(writeMeta(meta)), files: [] }
	})
