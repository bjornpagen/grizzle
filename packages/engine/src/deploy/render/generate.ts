import { canonicalTextOf, catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact, unsupported } from "#compiler/core/errors.ts"
import { TemporaryCensus } from "#compiler/core/identity.ts"
import { defect } from "#compiler/core/invariant.ts"
import { tableMaxColumns } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { asidesOf, setAside } from "#compiler/deploy/diff/aside.ts"
import { applyDeclarations } from "#compiler/deploy/diff/declared.ts"
import { diff } from "#compiler/deploy/diff/diff.ts"
import type { AbandonedSchema, Declarations, MigrationPlan } from "#compiler/deploy/diff/plan.ts"
import { planFiles } from "#compiler/deploy/phases/files.ts"
import {
	type CustomMeta,
	type DecisionRecord,
	type DraftedFolder,
	type DraftedMeta,
	decisionRecord,
	type FolderNaming,
	folderName,
	type MigrationFolder,
	type MigrationName,
	type RecordFault,
	recordFaultText,
	writeMeta
} from "#compiler/deploy/render/folder.ts"
import { derivedMigrationName } from "#compiler/deploy/render/naming.ts"
import { recordFile, renderFile } from "#compiler/deploy/render/sql.ts"
import {
	derivedOf,
	discontinuedRoster,
	type DraftWorkload,
	finishSnapshot,
	rosterFates,
	targetState,
	withAttnums,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import type {
	DeploySnapshot,
	SnapshotDerived,
	SnapshotFiles
} from "#compiler/deploy/snapshot/types.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { hashedNames } from "#compiler/physical/install/comments.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"

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
 * installation's derived runtime facts snapshot.json records beside it, the files' texts, and the plan the folder's files
 * render. */
interface DraftOf<F> {
	readonly change: DraftChange
	readonly folder: F
	/** The folder's meta.json files, read as `grizzle check` reads them (decisionRecord). */
	readonly record: DecisionRecord
	readonly snapshot: DeploySnapshot
	readonly derived: SnapshotDerived
	readonly snapshotFiles: SnapshotFiles
	readonly plan: MigrationPlan
}

/** A draft before its folder is named: the folder's meta.json and files, as `grizzle check` drafts it. */
export type MigrationDraft = DraftOf<Omit<DraftedFolder, "name">>

/** A draft whose folder is named `<timestamp>_<name>`, as `grizzle generate` writes it. */
export type GenerateResult = DraftOf<DraftedFolder>

const unwrap = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw new Refusal(r.error)
	}
	return r.value
}

/** Everything of a snapshot but its fingerprint, for the no-change test. */
const comparable = (s: Omit<DeploySnapshot, "fingerprint"> | DeploySnapshot): string => {
	if (!("fingerprint" in s)) {
		return canonicalTextOf(s)
	}
	const { fingerprint, ...content } = s
	return canonicalTextOf(content)
}

/** A decision record that does not read, as the draft's refusal: two decisions spelled alike, which a review cannot
 * tell apart. */
const recordRefusal = (fault: RecordFault): CompileError =>
	unsupported(
		SourceLoc("grizzle generate", []),
		`a draft whose decisions read apart: ${recordFaultText(fault)}; make the changes in two migrations`
	)

/** `grizzle check`'s draft, and `grizzle generate`'s before it names the folder, as a pure function.
 *
 * draftMigration drafts the next folder of a declared schema from its previous committed snapshot (the empty snapshot
 * before the first migration), the current schema's compiled installation and its logins' workloads: it builds the
 * target snapshot state with the ledger's objects, diffs the two, groups the plan into files and renders them, with
 * meta.json's decision record of every file built through the record's one constructor (decisionRecord), the one
 * `grizzle check` reads it through. It returns the folder's contents and the new snapshot. It reads no file and no
 * clock. The installation is compiled under the codes drafted from `previous`'s (ir/codes.ts draftCodebook over
 * snapshot/build.ts codebookOf): codes that give a code `previous` recorded another meaning are a defect of the caller,
 * never drafted.
 *
 * A schema whose target equals its previous snapshot drafts nothing: the change is none, the snapshot is the previous
 * one and the folder holds no file, so the CLI can report that there is nothing to generate. */
export const draftMigration = (input: DraftInput): Result.Result<MigrationDraft, CompileError> =>
	catchRefusal(() => {
		const { installation, previous } = input
		if (previous.schema !== installation.names.schema) {
			throw new Refusal(
				malformedArtifact(
					"snapshot",
					["schema"],
					`a previous snapshot of the installed schema ${installation.names.schema}; it is of ${previous.schema}`
				)
			)
		}
		const deferred = installation.deferred.derivedRelations
		if (deferred.length > 0) {
			throw new Refusal(
				unsupported(
					SourceLoc(`grizzle generate of schema ${installation.owned.name}`, []),
					`an installation that installs every derived relation; ${deferred.join(", ")} is left to an extension the caller did not supply`
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
		/** The installation's checks, written once: their digests the snapshot records, their queries the diff drafts. */
		const checks = lawChecks(installation)
		const state = unwrap(targetState({ installation, workload: input.workload, checks }))
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
				rosters
			})
		)
		const finished = unwrap(
			finishSnapshot(unwrap(withAttnums(state, applied.previous, plan, tableMaxColumns.value)))
		)
		const changed = plan.steps.length > 0 || comparable(finished) !== comparable(previous)
		const snapshot = changed ? finished : previous
		const drafted = changed ? planFiles(plan) : []
		const files = drafted.map((f) => ({ name: f.name, text: unwrap(renderFile(f)) }))
		const recorded = drafted.map((f) => unwrap(recordFile(f)))
		const record = decisionRecord(recorded)
		if (!record.ok) {
			throw new Refusal(recordRefusal(record.error))
		}
		const meta: DraftedMeta = {
			kind: "drafted",
			schemaName: snapshot.schemaName,
			schema: snapshot.schema,
			source: previous.fingerprint,
			target: snapshot.fingerprint,
			declared: input.declared,
			files: recorded
		}
		const change: DraftChange = changed ? "schema" : "none"
		const derived = derivedOf(installation)
		return {
			change,
			folder: { meta, metaText: unwrap(writeMeta(meta)), files },
			record: record.value,
			snapshot,
			derived,
			snapshotFiles: unwrap(writeSnapshot(snapshot, derived)),
			plan
		}
	})

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
			target: input.snapshot.fingerprint
		}
		return { name, meta, metaText: unwrap(writeMeta(meta)), files: [] }
	})
