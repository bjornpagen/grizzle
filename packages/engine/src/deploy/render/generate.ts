import { canonicalTextOf, catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact, unsupported } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type * as Result from "#compiler/core/result.ts"
import { asidesOf, setAside } from "#compiler/deploy/diff/aside.ts"
import { diff } from "#compiler/deploy/diff/diff.ts"
import type { AbandonedSchema, MigrationPlan } from "#compiler/deploy/diff/plan.ts"
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
	type RecordFault,
	recordFaultText,
	writeMeta
} from "#compiler/deploy/render/folder.ts"
import { derivedMigrationName } from "#compiler/deploy/render/naming.ts"
import { recordFile, renderFile } from "#compiler/deploy/render/sql.ts"
import {
	type DraftWorkload,
	finishSnapshot,
	targetState,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"

interface GenerateInput {
	/** The previous committed snapshot: the empty snapshot (`emptySnapshot`) before the schema's first
	 * migration. */
	readonly previous: DeploySnapshot
	/** The current schema's installation, compiled with every extension it needs (residual laws, derived relations, the
	 * workload's access paths and statistics), as a fresh install would be. */
	readonly installation: Installation
	/** The current workloads: each login's programs' access and the access requests, none for a schema without one. */
	readonly workload: DraftWorkload
	readonly naming: FolderNaming
	/** YYYYMMDDHHMMSS, from the CLI's clock. */
	readonly timestamp: string
	/** The schemas the migrations directory holds that the configuration no longer lists, which the CLI names for a
	 * schema's first migration (none for any other): the draft starts the schema under the loss of their rows. */
	readonly abandoned: ReadonlyArray<AbandonedSchema>
}

/** What a draft changes: nothing, so the folder holds no file and the snapshot is the previous one; or the schema or
 * workload. */
export type DraftChange = "none" | "schema"

export interface GenerateResult {
	readonly change: DraftChange
	readonly folder: DraftedFolder
	/** The folder's meta.json files, read as `grizzle check` reads them (decisionRecord). */
	readonly record: DecisionRecord
	readonly snapshot: DeploySnapshot
	readonly snapshotText: string
	readonly plan: MigrationPlan
}

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
 * tell apart, or a path that names no rename offer or two. */
const recordRefusal = (fault: RecordFault): CompileError => {
	switch (fault.kind) {
		case "indistinct":
			return unsupported(
				SourceLoc("grizzle generate", []),
				`a draft whose decisions read apart: ${recordFaultText(fault)}; make the changes in two migrations`
			)
		case "unnamed":
			return malformedArtifact("meta", ["files"], recordFaultText(fault))
	}
}

/** The name's shape is checked before anything is compiled.
 *
 * `grizzle generate` and `grizzle generate --custom` as pure functions.
 *
 * generateMigration drafts the next folder of a declared schema from its previous committed snapshot (the empty
 * snapshot before the first migration), the current schema's compiled installation and its logins' workloads: it builds
 * the target snapshot state with the ledger's objects, diffs the two, groups the plan into files and renders them, with
 * meta.json's decision record of every file built through the record's one constructor (decisionRecord), the one
 * `grizzle check` reads it through. It returns the folder and the new snapshot; the CLI writes both. It reads no file
 * and no clock: the caller supplies the timestamp.
 *
 * A schema whose target equals its previous snapshot drafts nothing: the change is none, the snapshot is the previous
 * one and the folder holds no file, so the CLI can report that there is nothing to generate. */
export const generateMigration = (
	input: GenerateInput
): Result.Result<GenerateResult, CompileError> =>
	catchRefusal(() => {
		const { installation, previous } = input
		if (input.naming.kind === "named") {
			unwrap(folderName(input.timestamp, input.naming.name))
		}
		if (previous.schema !== installation.names.schema) {
			throw new Refusal(
				malformedArtifact(
					"snapshot",
					["schema"],
					`a previous snapshot of the installed schema ${installation.names.schema}; it is of ${previous.schema}`
				)
			)
		}
		const deferred = [
			...installation.deferred.residualLaws,
			...installation.deferred.derivedRelations
		]
		if (deferred.length > 0) {
			throw new Refusal(
				unsupported(
					SourceLoc(`grizzle generate of schema ${installation.owned.name}`, []),
					`an installation that installs every residual law and derived relation; ${deferred.join(", ")} is left to an extension the caller did not supply`
				)
			)
		}
		const state = unwrap(targetState({ installation, workload: input.workload }))
		/** The holders whose names the target gives objects of another kind are set aside first. */
		const asides = asidesOf(previous, state.manifest.objects)
		const plan = unwrap(
			diff({
				previous: setAside(previous, asides),
				target: state,
				installation,
				asides,
				abandoned: input.abandoned
			})
		)
		const finished = unwrap(finishSnapshot(state))
		const changed = plan.steps.length > 0 || comparable(finished) !== comparable(previous)
		const snapshot = changed ? finished : previous
		const name = unwrap(
			folderName(
				input.timestamp,
				input.naming.kind === "named" ? input.naming.name : derivedMigrationName(previous, snapshot)
			)
		)
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
			files: recorded
		}
		const change: DraftChange = changed ? "schema" : "none"
		return {
			change,
			folder: { name, meta, metaText: unwrap(writeMeta(meta)), files },
			record: record.value,
			snapshot,
			snapshotText: unwrap(writeSnapshot(snapshot)),
			plan
		}
	})

/** An empty migration for hand-written data steps, whose source and target are both the current snapshot. */
export const customMigration = (input: {
	readonly snapshot: DeploySnapshot
	readonly name: string
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
