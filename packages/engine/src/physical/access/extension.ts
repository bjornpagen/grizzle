import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Fence } from "#compiler/analysis/isolation/certify.ts"
import type { RoleIsolation } from "#compiler/core/certificate.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type LivePlan, noLive } from "#compiler/live/notify.ts"
import type { RoleWorldViews } from "#compiler/physical/access/world-views.ts"
import type { ServedTypes } from "#compiler/physical/ddl/domains.ts"
import type { InstallOptions } from "#compiler/physical/install/compile.ts"
import {
	type InstallExtension,
	loginFences,
	type RoleCarriers,
	noCarriers,
	noCertificates,
	noContribution,
	noFences,
	noWorldViews,
	noCalls,
	type RoleCall,
	type ServedProgram
} from "#compiler/physical/install/extension.ts"

/** What the installation needs of a compiled workload. */
export interface WorkloadPhysical {
	/** The fingerprint of the schema the workload was compiled against. */
	readonly schema: SchemaFingerprint
	/**
	 * The types its programs name (physical/ddl/domains.ts ServedTypes): each pattern parameter's own pattern domain,
	 * each contract a parameter is typed by and each text refinement its programs type a value by, so installing the
	 * workload installs the domains its statements name.
	 */
	readonly params: ServedTypes
}

/** The workload in the installation: the types its programs' parameters are cast to (InstallExtension.params), which
 * the installation plans and installs, so no installation of a workload lacks a domain its statements cast a parameter
 * to. What its programs read by index the served workload's extension states, its programs' plans
 * (`servedWorkloadExtension`), whose requests are the only ones the installation asks an index for a workload's read.
 *
 * The workload must have been compiled against this installation's schema: its schema fingerprint is checked, so a
 * workload never lends its types to another schema's objects. */
export const workloadExtension = (workload: WorkloadPhysical): InstallExtension => ({
	contribute: (b) =>
		workload.schema === b.owned.fingerprint
			? Result.ok(noContribution)
			: Result.err(
					malformedDescription(
						SourceLoc(`workload of schema ${b.owned.name}`, []),
						`a workload compiled against the installed schema ${b.owned.fingerprint}; this one was compiled against ${workload.schema}`
					)
				),
	params: () => Result.ok(workload.params),
	certifies: noCertificates,
	carriers: noCarriers,
	calls: noCalls,
	live: noLive,
	fences: noFences,
	worldViews: noWorldViews
})

/**
 * The served workload's extension: the workload's (workloadExtension), its parameters' types among it; its programs,
 * each with the plan of every statement its served file may send, whose reads' requests the installation asks an index
 * for (physical/install/compile.ts); the
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
		readonly worldViews: ReadonlyArray<RoleWorldViews>
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
	fences: loginFences(workload.fences),
	worldViews: workload.worldViews
})

/** Installer options with the workload extension after the caller's extensions. */
export const withWorkload = (
	options: InstallOptions,
	workload: WorkloadPhysical
): InstallOptions => ({
	...options,
	extensions: [...options.extensions, workloadExtension(workload)]
})
