import type { RoleIsolation } from "#compiler/analysis/isolation/certify.ts"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import type { IndexRequest } from "#compiler/ir/products.ts"
import type { LivePlan } from "#compiler/live/notify.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import type { TextColumnUse } from "#compiler/physical/ddl/domains.ts"
import type { StatisticsRequest } from "#compiler/physical/statistics/statistics.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"

/** What an extension contributes to the installation it runs in beyond the objects it adds to the builder: an
 * extension spreads `noContribution` and states what it contributes. */
export interface InstallContribution {
	readonly indexRequests: ReadonlyArray<IndexRequest>
	readonly statisticsRequests: ReadonlyArray<StatisticsRequest>
	/** The derived relations whose materialized views it installs. */
	readonly derivedRelations: ReadonlyArray<string>
	/** The domains it creates, which PUBLIC is revoked from as from the installation's own: the served workload's
	 * parameters' pattern domains (physical/ddl/domains.ts addParamDomains). */
	readonly domains: ReadonlyArray<ObjectName>
}

export const noContribution: InstallContribution = {
	indexRequests: [],
	statisticsRequests: [],
	derivedRelations: [],
	domains: []
}

/** What another package installs, plugged into an installation: the materialized views of derived relations, the
 * workload access paths and statistics. Each extension runs with the builder
 * after the native objects and the span CHECKs and before the indexes, so its objects join the one obligation graph and
 * order, its index requests join the one index engine, and its statistics requests are planned with the workload's once
 * every extension has run.
 *
 * `contribute` adds the extension's objects to the builder once the native objects exist, each after the objects it
 * reads, named by their handles. An extension whose objects type a column by
 * a text refinement no stored column carries, such as a derived relation's view column, states those columns in
 * `textDomainUses`, which runs before any name is chosen, so the pattern's structural domain is planned and named with
 * the schema's others (`planTextDomains`); every other extension states `noTextDomainUses`. */
export interface InstallExtension {
	readonly contribute: (builder: InstallBuilder) => Result.Result<InstallContribution, CompileError>
	readonly textDomainUses: (
		checked: CheckedSchema
	) => Result.Result<ReadonlyArray<TextColumnUse>, CompileError>
	/**
	 * The certificates of the roles it certifies (analysis/isolation/certify.ts), which the installation reads before
	 * it builds anything, since each table's guard follows the levels of the roles that write it: the served
	 * workload's, one for every role of its logins (physical/access/extension.ts servedWorkloadExtension); every other
	 * extension's, none (`noCertificates`).
	 */
	readonly certifies: ReadonlyArray<RoleIsolation>
	/**
	 * The roles whose served ChangeSets create a carrier, a temporary table (write/carriers/carriers.ts,
	 * write/program/staged.ts), which the installation grants TEMPORARY on the database (physical/ddl/roles.ts
	 * addWorlds): the served workload's, derived from the ChangeSets it serves (program/workload/compile.ts
	 * servedWorkload); every other extension's, none (`noCarriers`).
	 */
	readonly carriers: ReadonlyArray<RoleOfLogin>
	/**
	 * The roles whose served ChangeSets hold a retirable unit (write/hold/statement.ts), each with the unit's header,
	 * which the installation grants EXECUTE on the unit's hold function (physical/ddl/roles.ts addWorlds): the served
	 * workload's, derived from the ChangeSets it serves (program/workload/compile.ts servedWorkload); every other
	 * extension's, none (`noHolds`).
	 */
	readonly holds: ReadonlyArray<RoleHold>
	/**
	 * The live plan of the programs it serves (live/notify.ts LivePlan), whose footprint tables the installation's live
	 * source publishes (physical/ddl/live.ts): the served workload's, derived from its read programs
	 * (program/workload/compile.ts servedWorkload); every other extension's, none (noLive).
	 */
	readonly live: LivePlan
}

/** A role of a login, by their declared names. */
export interface RoleOfLogin {
	readonly login: string
	readonly role: string
}

/** No certificate: what an extension that compiles no served workload certifies. */
export const noCertificates: ReadonlyArray<RoleIsolation> = []

/** No role that creates a carrier: what an extension that compiles no served workload states. */
export const noCarriers: ReadonlyArray<RoleOfLogin> = []

/** A role of a login whose served ChangeSets hold the retirable unit headed by `header`. */
export interface RoleHold extends RoleOfLogin {
	readonly header: string
}

/** No role that holds a unit: what an extension that compiles no served workload states. */
export const noHolds: ReadonlyArray<RoleHold> = []
