import type { Fence, RoleIsolation } from "#compiler/analysis/isolation/certify.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { AccessIndexRequest, AccessPath } from "#compiler/ir/products.ts"
import { type LivePlan, noLive } from "#compiler/live/notify.ts"
import { pathRequest } from "#compiler/physical/access/paths.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import {
	addParamDomains,
	noTextDomainUses,
	type ParamDomainUse
} from "#compiler/physical/ddl/domains.ts"
import type { InstallOptions } from "#compiler/physical/install/compile.ts"
import {
	type InstallContribution,
	type InstallExtension,
	loginFences,
	type RoleHold,
	type RoleOfLogin,
	noCarriers,
	noCertificates,
	noContribution,
	noFences,
	noHolds
} from "#compiler/physical/install/extension.ts"
import type { StatisticsRequest } from "#compiler/physical/statistics/statistics.ts"

/** What the installation needs of a compiled workload. */
export interface WorkloadPhysical {
	/** The fingerprint of the schema the workload was compiled against. */
	readonly schema: SchemaFingerprint
	/** Each distinct path of the workload's programs and the roles' write filters, once, in canonical order. */
	readonly paths: ReadonlyArray<AccessPath>
	readonly statistics: ReadonlyArray<StatisticsRequest>
	/**
	 * Every pattern its programs' declared parameters name, at the parameter's place (physical/ddl/domains.ts
	 * paramDomainUses): each parameter's own pattern domain, which every placeholder of it is cast to, so installing the
	 * workload installs the domains its statements name.
	 */
	readonly paramDomains: ReadonlyArray<ParamDomainUse>
}

const kindOf = (b: InstallBuilder, relation: string): string | undefined =>
	b.owned.relations[relation]?.kind

/** The access requests of a workload for an installation whose vector extension lives in `vectorSchema`. */
export const workloadRequests = (
	workload: WorkloadPhysical,
	vectorSchema: string
): ReadonlyArray<AccessIndexRequest> =>
	workload.paths.map((path) => pathRequest(path, vectorSchema))

/** The workload in the installation: access-path index requests and statistics through the installer's extensions,
 * and the pattern domain of every pattern its programs' parameters name (physical/ddl/domains.ts addParamDomains), so
 * no installation of a workload lacks a domain its statements cast a parameter to.
 * The workload compiler extracts each program's access paths and statistics and merges them across programs. This
 * extension hands the paths to the one index engine as IndexRequests with role `access`, beside the law-maintenance
 * requests, so a request lands on a key, enforcement or law index that serves it, adding the access reason to that
 * object's reasons, or becomes `<table>__ix__<cols>` justified by it, and hands the statistics to the installer, which
 * plans them once every extension has run. A path or statistics object on a derived relation is planned
 * on its materialized view like a table's, where the derived relation extension installs the view, and deferred with
 * the view where none does.
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
			indexRequests: workloadRequests(workload, b.settings.vectorSchema),
			statisticsRequests: workload.statistics,
			domains: addParamDomains(b, workload.paramDomains)
		}
		return Result.ok(contribution)
	},
	textDomainUses: noTextDomainUses,
	certifies: noCertificates,
	carriers: noCarriers,
	holds: noHolds,
	live: noLive,
	fences: noFences
})

/**
 * The served workload's extension: the workload's (workloadExtension), its parameters' pattern domains among it; the
 * certificate of every role of every login its plan certified (program/workload/compile.ts servedWorkload), which the
 * installation's guards follow; the roles whose served ChangeSets create a carrier, which it grants TEMPORARY on
 * the database; the roles whose served ChangeSets hold a retirable unit, which it grants EXECUTE on the unit's hold
 * function; its live plan; and the relations each login fences, on which it grants the login MAINTAIN.
 */
export const servedWorkloadExtension = (
	workload: WorkloadPhysical & {
		readonly certification: ReadonlyArray<RoleIsolation>
		readonly carriers: ReadonlyArray<RoleOfLogin>
		readonly holds: ReadonlyArray<RoleHold>
		readonly live: LivePlan
		readonly fences: ReadonlyArray<Fence>
	}
): InstallExtension => ({
	...workloadExtension(workload),
	certifies: workload.certification,
	carriers: workload.carriers,
	holds: workload.holds,
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
