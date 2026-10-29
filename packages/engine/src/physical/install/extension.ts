import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type * as Result from "#compiler/core/result.ts"
import type { IndexRequest } from "#compiler/ir/products.ts"
import type { ConstraintLaw } from "#compiler/laws/model/model.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import type { TextColumnUse } from "#compiler/physical/ddl/domains.ts"
import type { StatisticsRequest } from "#compiler/physical/statistics/statistics.ts"

/** What an extension contributes to the installation it runs in beyond the objects it adds to the builder: an
 * extension spreads `noContribution` and states what it contributes. */
export interface InstallContribution {
	readonly indexRequests: ReadonlyArray<IndexRequest>
	readonly statisticsRequests: ReadonlyArray<StatisticsRequest>
	/** The residual laws whose function and triggers it installs. */
	readonly residualLaws: ReadonlyArray<LawId>
	/** The derived relations whose materialized views it installs. */
	readonly derivedRelations: ReadonlyArray<string>
	/** The constraints it installs, each with the law a violation of it reports. */
	readonly constraintLaws: ReadonlyArray<ConstraintLaw>
}

export const noContribution: InstallContribution = {
	indexRequests: [],
	statisticsRequests: [],
	residualLaws: [],
	derivedRelations: [],
	constraintLaws: []
}

/** What another package installs, plugged into an installation: the residual law functions and triggers, the
 * materialized views of derived relations, the workload access paths and statistics. Each extension runs with the builder
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
}
