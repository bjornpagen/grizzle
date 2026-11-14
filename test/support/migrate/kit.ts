import {
	Array as Arr,
	DateTime,
	Formatter,
	Order,
	Result as EffectResult,
	String as Str
} from "effect"
import { formatTimestamp } from "#cli/clock.ts"
import { type LoginFileKind, loginFileKinds, loginFiles } from "#cli/files.ts"
import type { refusalText } from "#cli/refusals.ts"
import { rosterRenames } from "#cli/renames.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { AbandonedSchema, Declarations } from "#compiler/deploy/diff/plan.ts"
import { type MigrationName, parseMigrationName } from "#compiler/deploy/render/folder.ts"
import { type GenerateResult, generateMigration } from "#compiler/deploy/render/generate.ts"
import {
	type DraftWorkload,
	emptySnapshot,
	noWorkload,
	rosterFates
} from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import {
	type Codebook,
	draftCodebook,
	firstCodebook,
	noPreviousRosters,
	type PreviousRoster,
	reorderRefusal
} from "#compiler/ir/codes.ts"
import type { SchemaDesc } from "#compiler/ir/desc.ts"
import type { Roster } from "#compiler/ir/scalar.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { manifestFileName, snapshotFileName } from "#compiler/plan/serve.ts"
import type { AnySchema } from "#compiler/public/schema.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	allocatedLevels,
	type TestCodes,
	firstCodes,
	installedCodes
} from "#test/support/compile.ts"
import type { SchemaDesc as AuthoredSchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { atDeclaredName, type InstalledAt } from "#test/support/kernel/naming.ts"
import { ownedInput, owning } from "#test/support/policy.ts"

/** What a deployment test compiles: a schema value, a decoded SchemaDesc, or a description authored as a fixture. */
export type DeploySubject = AnySchema | SchemaDesc | AuthoredSchemaDesc

/** The owner an installation names: none, as `grizzle generate` drafts it, or a role, as a fresh-install script a
 * superuser runs names it. */
export type InstallOwner =
	| { readonly kind: "unowned" }
	| { readonly kind: "role"; readonly ident: string }
export const unowned: InstallOwner = { kind: "unowned" }
export const ownedBy = (ident: string): InstallOwner => ({ kind: "role", ident })

/** What an installation is compiled under: its schema, its owner, the installer extensions besides the residual
 * laws' and the derived relations' (a workload's index requests), and its codes, a fresh installation's or those a
 * draft drafted from the snapshot it continues (draftCodes). */
export interface CompileOver {
	readonly schema: InstalledAt
	readonly owner: InstallOwner
	readonly extensions: ReadonlyArray<InstallExtension>
	readonly codes: TestCodes
}
/** As `grizzle generate` drafts a first installation: its declared schema, no owner, no workload, a fresh one's codes. */
export const asDrafted: CompileOver = {
	schema: atDeclaredName,
	owner: unowned,
	extensions: [],
	codes: firstCodes
}

/** The complete installation of a schema: natives, residual laws and derived relations (completeInstallOptions, the
 * options generate composes), under `over`. */
export const compile = (desc: DeploySubject, over: CompileOver): Installation => {
	const owned = owning(desc)
	const installation =
		over.schema.kind === "declared"
			? installationsOf(owned)
			: allocatedLevels(over.schema.installation, owned.levels)
	const codes = over.codes.kind === "installed" ? over.codes.codes : firstCodebook(rostersOf(owned))
	return succeeded(
		compileInstallation(owned, {
			...completeInstallOptions(owned, installation, [], over.extensions, codes),
			owner: over.owner.kind === "unowned" ? undefined : over.owner.ident
		})
	)
}

/** The rosters the snapshot `previous` records, each with what a draft under `declared` makes of it against `rosters`
 * (deploy/snapshot/build.ts rosterFates): none for an empty migrations directory. */
const previousRosters = (
	previous: Previous,
	declared: Declarations,
	rosters: ReadonlyArray<Roster>
): ReadonlyArray<PreviousRoster> =>
	previous.kind === "snapshot"
		? rosterFates(
				previous.snapshot,
				declared,
				Arr.map(rosters, (r) => r.closed)
			)
		: noPreviousRosters

/** No rename and no drop declared, as the command line states it: a draft that only adds, or whose drops a test means to
 * see refused. */
export { noDeclarations } from "#cli/renames.ts"

/**
 * The codes `grizzle generate` drafts for `desc` from `previous` (cli/generate.ts draftInput): each roster's codes
 * continued from those of the roster it continues (previousRosters) under the handle renames `declared` declares
 * (cli/renames.ts rosterRenames), or D1's
 * refusal of a roster declared out of its codes' order, or the schema's own refusal where it does not own, as the CLI
 * meets it before it drafts (cli/generate.ts draftInput reads an owned schema). A malformed rename is a defect of the test.
 */
export const draftCodes = (
	desc: DeploySubject,
	previous: Previous,
	declared: Declarations
): Result.Result<Codebook, CompileError> =>
	Result.flatMap(ownedInput(desc), (owned) => {
		const rosters = rostersOf(owned)
		const renames = rosterRenames(declared, rosters)
		if (EffectResult.isFailure(renames)) {
			throw new Error(`the test declares a rename the CLI refuses: ${renames.failure.message}`)
		}
		return Result.mapError(
			draftCodebook(previousRosters(previous, declared, rosters), renames.success, rosters),
			reorderRefusal
		)
	})

/** 2026-10-12T00:00:00Z, the instant before a history's first draft. */
const epoch = 1_791_763_200_000
/** The CLI's clock, stood in for, at a history's `ordinal`-th draft, from 1: that many seconds after the epoch,
 * formatted as the CLI formats it, so a history's folder names sort in drafting order. */
export const draftedAt = (ordinal: number): string =>
	formatTimestamp(DateTime.makeUnsafe(epoch + ordinal * 1000))

/**
 * The committed snapshot a draft continues: the installation's empty snapshot, as a migrations directory without the
 * schema's folder reads, with the schemas that directory holds and the configuration no longer lists, which the CLI
 * names for a schema's first draft (cli/generate.ts abandonedSchemas); or a snapshot drafted before, whose draft
 * abandons none.
 */
export type Previous =
	| { readonly kind: "empty"; readonly abandoned: ReadonlyArray<AbandonedSchema> }
	| { readonly kind: "snapshot"; readonly snapshot: DeploySnapshot }
/** The empty snapshot of a migrations directory that holds no other schema. */
export const fromEmpty: Previous = { kind: "empty", abandoned: [] }
/** The empty snapshot of a migrations directory that still holds `abandoned`, schemas the configuration no longer
 * lists: the draft starts the schema under the loss of their rows, a decision only the reviewer makes. */
export const fromEmptyBeside = (abandoned: NonEmptyReadonlyArray<AbandonedSchema>): Previous => ({
	kind: "empty",
	abandoned
})
export const fromSnapshot = (snapshot: DeploySnapshot): Previous => ({ kind: "snapshot", snapshot })

/** The entries of a schema's migrations directory that are no migration folder: the snapshot's two files and the
 * directory of each kind of file generate writes per login (cli/files.ts loginFiles), by the names the CLI writes them
 * under. */
const besideFolders: ReadonlySet<string> = new Set([
	snapshotFileName,
	manifestFileName,
	...Arr.map(loginFileKinds, (kind) => loginFiles[kind].directory)
])

/** The migration folders among a schema directory's `entries`, in name order, which is drafting order: every entry
 * but the snapshot's files, the login files' directories (`besideFolders`) and a hidden one, which no generator
 * writes. */
export const migrationFolders = (entries: ReadonlyArray<string>): Array<string> =>
	Arr.sort(
		Arr.filter(entries, (n) => !besideFolders.has(n) && !Str.startsWith(".")(n)),
		Order.String
	)

/**
 * How a login's committed files beside the snapshot (cli/files.ts loginFiles) stand to the ones generate writes now:
 * `missing`, none committed; `stale`, committed before a change the OpenAPI document states too. The document is read
 * off the served file (live/openapi.ts) and states the snapshot's fingerprint, as its `version`, and what every program
 * does with the relations it names, a refresh's targets among them, so such a change leaves both files stale.
 */
export type LoginFilesState = "missing" | "stale"

/** The finding `grizzle check` names a login's file of each kind by, in each LoginFilesState. */
const loginFileFinding = {
	served: { missing: "servedMissing", stale: "servedStale" },
	openapi: { missing: "documentMissing", stale: "documentStale" }
} as const satisfies {
	readonly [K in LoginFileKind]: { readonly [S in LoginFilesState]: keyof typeof refusalText }
}

/** One of check's findings on a login's files: its kind, and the kind of file it names. */
export interface LoginFileFinding {
	readonly kind: keyof typeof refusalText
	readonly file: LoginFileKind
}

/**
 * What `grizzle check` finds of one login's files in `state` (LoginFilesState): each kind of file generate writes per
 * login found so, in the order check reads them, the served file's finding, then its document's.
 */
export const loginFileFindings = (state: LoginFilesState): ReadonlyArray<LoginFileFinding> =>
	Arr.map(loginFileKinds, (file) => ({ kind: loginFileFinding[file][state], file }))

/** A migration name a test gives, parsed as `--name` is (folder.ts parseMigrationName): one it refuses is a defect of
 * the test. */
export const parsedMigrationName = (name: string): MigrationName => {
	const parsed = parseMigrationName(name)
	if (parsed === undefined) {
		throw new Error(
			`the test names a migration ${Formatter.format(name)}, of no folder name's shape`
		)
	}
	return parsed
}

/** A draft as `grizzle generate` makes it, every input stated: the snapshot it continues, its workload (noWorkload for
 * none), the renames and drops it declares (noDeclarations for none, `--rename` and `--drop`) and its folder name,
 * parsed as `--name` is (parsedMigrationName). */
export interface DraftInput {
	readonly installation: Installation
	readonly timestamp: string
	readonly previous: Previous
	readonly workload: DraftWorkload
	readonly declared: Declarations
	readonly name: string
}

export const generate = (input: DraftInput): Result.Result<GenerateResult, CompileError> =>
	generateMigration({
		previous:
			input.previous.kind === "snapshot"
				? input.previous.snapshot
				: emptySnapshot({
						schemaName: input.installation.owned.name,
						schema: input.installation.names.schema
					}),
		installation: input.installation,
		workload: input.workload,
		declared: input.declared,
		naming: { kind: "named", name: parsedMigrationName(input.name) },
		timestamp: input.timestamp,
		abandoned: input.previous.kind === "empty" ? input.previous.abandoned : []
	})

/** One step of a chain: the schema drafted, what it is compiled under, and the renames and drops it declares. */
interface Step {
	readonly desc: DeploySubject
	readonly options: CompileOver
	readonly declared: Declarations
}

/** Drafts a chain of migrations, each from the previous step's snapshot, the first from `previous`, its codes drafted
 * from that snapshot's (draftCodes) whatever codes the step's options state; step i is named `step_<i + 1>`, with no
 * workload. */
export const draftChain = (
	steps: ReadonlyArray<Step>,
	previous: Previous
): ReadonlyArray<GenerateResult> => {
	const out: Array<GenerateResult> = []
	let from = previous
	for (const [i, s] of steps.entries()) {
		const codes = succeeded(draftCodes(s.desc, from, s.declared))
		const g = succeeded(
			generate({
				installation: compile(s.desc, { ...s.options, codes: installedCodes(codes) }),
				timestamp: draftedAt(i + 1),
				previous: from,
				workload: noWorkload,
				declared: s.declared,
				name: `step_${i + 1}`
			})
		)
		out.push(g)
		from = fromSnapshot(g.snapshot)
	}
	return out
}
