import { DateTime } from "effect"
import { formatTimestamp } from "#cli/clock.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import { type GenerateResult, generateMigration } from "#compiler/deploy/render/generate.ts"
import { type DraftWorkload, emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { SchemaDesc } from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import type { AnySchema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import type { SchemaDesc as AuthoredSchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { atDeclaredName, type InstalledAt } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"

/** What a deployment test compiles: a schema value, a decoded SchemaDesc, or a description authored as a fixture. */
export type DeploySubject = AnySchema | SchemaDesc | AuthoredSchemaDesc

/** The owner an installation names: none, as `grizzle generate` drafts it, or a role, as a fresh-install script a
 * superuser runs names it. */
export type InstallOwner =
	| { readonly kind: "unowned" }
	| { readonly kind: "role"; readonly ident: string }
export const unowned: InstallOwner = { kind: "unowned" }
export const ownedBy = (ident: string): InstallOwner => ({ kind: "role", ident })

/** What an installation is compiled under: its schema, its owner, and the installer extensions besides the residual
 * laws' and the derived relations' (a workload's index requests). */
export interface CompileOver {
	readonly schema: InstalledAt
	readonly owner: InstallOwner
	readonly extensions: ReadonlyArray<InstallExtension>
}
/** As `grizzle generate` drafts an installation: its declared schema, no owner, no workload. */
export const asDrafted: CompileOver = { schema: atDeclaredName, owner: unowned, extensions: [] }

/** The complete installation of a schema: natives, residual laws and derived relations (completeInstallOptions, the
 * options generate composes), under `over`. */
export const compile = (desc: DeploySubject, over: CompileOver): Installation => {
	const owned = owning(desc)
	const installation =
		over.schema.kind === "declared" ? owned.installation : over.schema.installation
	return succeeded(
		compileInstallation(owned, {
			...completeInstallOptions(owned, installation, [], over.extensions),
			owner: over.owner.kind === "unowned" ? undefined : over.owner.ident
		})
	)
}

/** 2026-10-12T00:00:00Z, the instant before a history's first draft. */
const epoch = 1_791_763_200_000
/** The CLI's clock, stood in for, at a history's `ordinal`-th draft, from 1: that many seconds after the epoch,
 * formatted as the CLI formats it, so a history's folder names sort in drafting order. */
export const draftedAt = (ordinal: number): string =>
	formatTimestamp(DateTime.makeUnsafe(epoch + ordinal * 1000))

/** The committed snapshot a draft continues: the installation's empty snapshot, as an empty migrations directory reads,
 * or a snapshot drafted before. */
export type Previous =
	| { readonly kind: "empty" }
	| { readonly kind: "snapshot"; readonly snapshot: DeploySnapshot }
export const fromEmpty: Previous = { kind: "empty" }
export const fromSnapshot = (snapshot: DeploySnapshot): Previous => ({ kind: "snapshot", snapshot })

/** A draft as `grizzle generate` makes it, every input stated: the snapshot it continues, its workload (noWorkload for
 * none) and its folder name. */
export interface DraftInput {
	readonly installation: Installation
	readonly timestamp: string
	readonly previous: Previous
	readonly workload: DraftWorkload
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
		naming: { kind: "named", name: input.name },
		timestamp: input.timestamp,
		abandoned: []
	})

/** One step of a chain: the schema drafted and what it is compiled under. */
interface Step {
	readonly desc: DeploySubject
	readonly options: CompileOver
}

/** Drafts a chain of migrations, each from the previous step's snapshot, the first from `previous`; step i is named
 * `step_<i + 1>`, with no workload. */
export const draftChain = (
	steps: ReadonlyArray<Step>,
	previous: Previous
): ReadonlyArray<GenerateResult> => {
	const out: Array<GenerateResult> = []
	let from = previous
	for (const [i, s] of steps.entries()) {
		const g = succeeded(
			generate({
				installation: compile(s.desc, s.options),
				timestamp: draftedAt(i + 1),
				previous: from,
				workload: noWorkload,
				name: `step_${i + 1}`
			})
		)
		out.push(g)
		from = fromSnapshot(g.snapshot)
	}
	return out
}
