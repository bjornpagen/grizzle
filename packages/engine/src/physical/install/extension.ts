import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Fence } from "#compiler/analysis/isolation/certify.ts"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import type { RoleIsolation } from "#compiler/core/certificate.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { IndexRequest } from "#compiler/ir/products.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import type { LivePlan } from "#compiler/live/notify.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { noServedTypes, type ServedTypes } from "#compiler/physical/ddl/domains.ts"

/** What an extension contributes to the installation it runs in beyond the objects it adds to the builder: an
 * extension spreads `noContribution` and states what it contributes. */
export interface InstallContribution {
	readonly indexRequests: ReadonlyArray<IndexRequest>
	/** The derived relations whose materialized views it installs. */
	readonly derivedRelations: ReadonlyArray<string>
}

export const noContribution: InstallContribution = {
	indexRequests: [],
	derivedRelations: []
}

/** What another package installs, plugged into an installation: the materialized views of derived relations and the
 * workload access paths. Each extension runs with the builder after the native objects and the span CHECKs and before
 * the indexes, so its objects join the one obligation graph and order, and its index requests join the one index
 * engine; every table's declared statistics are planned once every index is (physical/statistics/declared.ts).
 *
 * `contribute` adds the extension's objects to the builder once the native objects exist, each after the objects it
 * reads, named by their handles. */
export interface InstallExtension {
	readonly contribute: (builder: InstallBuilder) => Result.Result<InstallContribution, CompileError>
	/**
	 * The types the programs it serves name (physical/ddl/domains.ts ServedTypes), over the installation's checked
	 * schema: each pattern parameter's own pattern domain, each contract a parameter is typed by and each text refinement
	 * the programs type a value by, which the installation reads before any name is chosen, and installs
	 * (physical/install/compile.ts installationOver), so it serves no statement that names a type it lacks: the
	 * workload's (physical/access/extension.ts workloadExtension), from its programs' checked IR
	 * (program/workload/compile.ts compileWorkload); every other extension's, none (`servesNoParams`).
	 */
	readonly params: (checked: CheckedSchema) => Result.Result<ServedTypes, CompileError>
	/**
	 * The certificates of the roles it certifies (analysis/isolation/certify.ts), which the installation reads before
	 * it builds anything, since each table's guard follows the levels of the roles that write it: the served
	 * workload's, one for every role of its logins (physical/access/extension.ts servedWorkloadExtension); every other
	 * extension's, none (`noCertificates`).
	 */
	readonly certifies: ReadonlyArray<RoleIsolation>
	/**
	 * The roles whose served ChangeSets create a carrier, a temporary table (write/carriers/carriers.ts,
	 * write/program/staged.ts), with the types of its program carriers' columns (RoleCarriers), which the installation
	 * grants TEMPORARY on the database and USAGE on each domain of those types (physical/ddl/roles.ts addWorlds): the
	 * served workload's, derived from the ChangeSets it serves (program/workload/compile.ts servedWorkload); every other
	 * extension's, none (`noCarriers`).
	 */
	readonly carriers: ReadonlyArray<RoleCarriers>
	/**
	 * The roles whose served programs call a declared function (schema/function.ts fn), each with the function's name,
	 * which the installation grants EXECUTE on the function (physical/ddl/roles.ts addWorlds), and no role else: the
	 * served workload's, derived from the programs it serves (program/workload/compile.ts servedWorkload); every other
	 * extension's, none (`noCalls`).
	 */
	readonly calls: ReadonlyArray<RoleCall>
	/**
	 * The live plan of the programs it serves (live/notify.ts LivePlan), whose footprint tables the installation's live
	 * source publishes (physical/ddl/live.ts): the served workload's, derived from its read programs
	 * (program/workload/compile.ts servedWorkload); every other extension's, none (noLive).
	 */
	readonly live: LivePlan
	/**
	 * The relations each login fences (analysis/isolation/certify.ts Fence), on whose tables the installation grants
	 * the login MAINTAIN, the least privilege that permits the LOCK TABLE ... IN EXCLUSIVE MODE its fenced writes send
	 * as the login before their snapshot (physical/ddl/roles.ts addWorlds): the served workload's, from its
	 * certification (program/workload/compile.ts servedWorkload); every other extension's, none (`noFences`).
	 */
	readonly fences: ReadonlyArray<LoginFence>
}

/** No parameter type: what an extension that serves no program states. */
export const servesNoParams = (): Result.Result<ServedTypes, CompileError> =>
	Result.ok(noServedTypes)

/** The relations a login fences, by their declared names, in code-unit order. */
export interface LoginFence {
	readonly login: string
	readonly relations: NonEmptyReadonlyArray<string>
}

/** A role of a login, by their declared names. */
export interface RoleOfLogin {
	readonly login: string
	readonly role: string
}

/** No certificate: what an extension that compiles no served workload certifies. */
export const noCertificates: ReadonlyArray<RoleIsolation> = []

/** No role that creates a carrier: what an extension that compiles no served workload states. */
export const noCarriers: ReadonlyArray<RoleCarriers> = []

/**
 * A role of a login whose served ChangeSets create a carrier, with the type of each column of every program carrier
 * they create (write/carriers/carriers.ts WriteCarrier), each a value's own (CarrierTyping): a domain one of them names,
 * a function result's or a token's refinement among them, is one PostgreSQL checks USAGE on as the carrier is created,
 * whatever the role reads or writes.
 */
export interface RoleCarriers extends RoleOfLogin {
	readonly columns: ReadonlyArray<HeadingColumn>
}

/** A role of a login whose served programs call the declared function `function`. */
export interface RoleCall extends RoleOfLogin {
	readonly function: string
}

/** No role that calls a declared function: what an extension that compiles no served workload states. */
export const noCalls: ReadonlyArray<RoleCall> = []

/** No fence: what an extension that compiles no served workload states. */
export const noFences: ReadonlyArray<LoginFence> = []

/** The relations each login of `fences` fences, in the fences' order, by login then relation. */
export const loginFences = (fences: ReadonlyArray<Fence>): ReadonlyArray<LoginFence> => {
	const by = new Map<string, Array<string>>()
	for (const f of fences) {
		const relations = by.getOrInsertComputed(f.login, () => [])
		relations.push(f.relation)
	}
	return [...by].flatMap(([login, relations]): ReadonlyArray<LoginFence> =>
		isNonEmpty(relations) ? [{ login, relations }] : []
	)
}
