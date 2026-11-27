import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Fence } from "#compiler/analysis/isolation/certify.ts"
import type { RoleIsolation } from "#compiler/core/certificate.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { AccessIndexRequest, AccessPath } from "#compiler/ir/products.ts"
import { type LivePlan, noLive } from "#compiler/live/notify.ts"
import { pathRequest } from "#compiler/physical/access/paths.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import type { ServedTypes } from "#compiler/physical/ddl/domains.ts"
import type { InstallOptions } from "#compiler/physical/install/compile.ts"
import {
	type InstallContribution,
	type InstallExtension,
	loginFences,
	type RoleCarriers,
	noCarriers,
	noCertificates,
	noContribution,
	noFences,
	noCalls,
	type RoleCall,
	type ServedProgram
} from "#compiler/physical/install/extension.ts"

/** What the installation needs of a compiled workload. */
export interface WorkloadPhysical {
	/** The fingerprint of the schema the workload was compiled against. */
	readonly schema: SchemaFingerprint
	/** Each distinct path of the workload's programs and the roles' write filters, once, in canonical order. */
	readonly paths: ReadonlyArray<AccessPath>
	/**
	 * The types its programs name (physical/ddl/domains.ts ServedTypes): each pattern parameter's own pattern domain,
	 * each contract a parameter is typed by and each text refinement its programs type a value by, so installing the
	 * workload installs the domains its statements name.
	 */
	readonly params: ServedTypes
}

const kindOf = (b: InstallBuilder, relation: string): string | undefined =>
	b.owned.relations[relation]?.kind ??
	(b.checked.canonicalNamed(relation) === undefined ? undefined : "derived")

/** The access requests of a workload for an installation whose vector extension lives in `vectorSchema`. */
export const workloadRequests = (
	workload: WorkloadPhysical,
	vectorSchema: string
): ReadonlyArray<AccessIndexRequest> =>
	workload.paths.map((path) => pathRequest(path, vectorSchema))

/** The workload in the installation: access-path index requests through the installer's extensions, and the types its
 * programs' parameters are cast to (InstallExtension.params), which the installation plans and installs, so no
 * installation of a workload lacks a domain its statements cast a parameter to.
 * The workload compiler extracts each program's access paths and merges them across programs. This extension hands the
 * paths to the one index engine as IndexRequests with role `access`, beside the law-maintenance requests, so a request
 * lands on a key, enforcement or law index that serves it, adding the access reason to that object's reasons, or
 * becomes `<table>__ix__<cols>` justified by it. A path on a derived relation is planned on its stored table like a
 * table's, where the derived relation extension installs the table, and deferred with the table where none does.
 *
 * The workload must have been compiled against this installation's schema: its schema fingerprint is checked, so a
 * workload never lends its paths to another schema's objects. */
export const workloadExtension = (workload: WorkloadPhysical): InstallExtension => ({
	contribute: (b) => {
		if (workload.schema !== b.owned.fingerprint) {
			return Result.err(
				malformedDescription(
					SourceLoc(`workload of schema ${b.owned.name}`, []),
					`a workload compiled against the installed schema ${b.owned.fingerprint}; this one was compiled against ${workload.schema}`
				)
			)
		}
		for (const path of workload.paths) {
			if (kindOf(b, path.relation) !== (path.derived ? "derived" : "relation")) {
				return Result.err(
					malformedDescription(
						SourceLoc(`workload of schema ${b.owned.name}`, []),
						`an access path on a ${path.derived ? "derived" : "stored"} relation; ${path.relation} is none`
					)
				)
			}
		}
		const contribution: InstallContribution = {
			...noContribution,
			indexRequests: workloadRequests(workload, b.settings.vectorSchema)
		}
		return Result.ok(contribution)
	},
	params: () => Result.ok(workload.params),
	certifies: noCertificates,
	carriers: noCarriers,
	calls: noCalls,
	live: noLive,
	fences: noFences
})

/**
 * The served workload's extension: the workload's (workloadExtension), its parameters' types among it; the
 * certificate of every role of every login its plan certified (program/workload/compile.ts servedWorkload), which the
 * installation's guards follow; the roles whose served ChangeSets fill a carrier, which it grants EXECUTE on what the
 * CHECKs of their columns' domains call; the roles whose served programs reach a declared function, which it grants
 * EXECUTE on the function; its live plan; and the relations each login fences, on which it grants the login MAINTAIN.
 */
export const servedWorkloadExtension = (
	workload: WorkloadPhysical & {
		readonly certification: ReadonlyArray<RoleIsolation>
		readonly carriers: ReadonlyArray<RoleCarriers>
		readonly calls: ReadonlyArray<RoleCall>
		readonly live: LivePlan
		readonly fences: ReadonlyArray<Fence>
		readonly programs: ReadonlyArray<ServedProgram>
	}
): InstallExtension => ({
	...workloadExtension(workload),
	contribute: (b) =>
		Result.map(workloadExtension(workload).contribute(b), (c) => ({
			...c,
			programs: workload.programs
		})),
	certifies: workload.certification,
	carriers: workload.carriers,
	calls: workload.calls,
	live: workload.live,
	fences: loginFences(workload.fences)
})

/** Installer options with the workload extension after the caller's extensions. */
export const withWorkload = (
	options: InstallOptions,
	workload: WorkloadPhysical
): InstallOptions => ({
	...options,
	extensions: [...options.extensions, workloadExtension(workload)]
})
