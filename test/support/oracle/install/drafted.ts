import * as Result from "@bjornpagen/grizzle-text/base/result"
import { Effect, Result as EffectResult } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Identity } from "#compiler/core/identity.ts"
import { type Codebook, firstCodebook } from "#compiler/ir/codes.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import { admitSchemaDesc } from "#compiler/schema/admit.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { declaredTypes } from "#test/support/compile.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { describedPlan } from "#test/support/generate-draft.ts"
import { oracleLogin, type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { ownedInput } from "#test/support/policy.ts"

/**
 * The plan of a generated schema on the real installer under `installation`, installed as `grizzle generate` installs a
 * schema's Description with the one login a generated schema runs as (oracleLogin), which serves no workload
 * (generate-draft.ts describedPlan): every grant, certificate, guard and fence generate gives such a login, its
 * rosters numbered by `codes`, the codes its case states, holes included, which every literal and parameter of the
 * case is encoded by. The oracle reads the plan alone, so no migration is drafted and no served file compiled.
 *
 * Beside them the login states the one test addition left: the types the case's query casts its declared parameters
 * `params` to (test/support/compile.ts declaredTypes), each pattern parameter's own domain and each contract outside
 * the base, which a workload's programs state in production, and which the plan's names name (physical/install/plan.ts
 * ParamSource `planned`), so a program lowered over its names casts a parameter only to a type the installation
 * installs. The case's query is a checked DAG, which no workload value holds, so it states nothing else of a program.
 */
export const oraclePlanUnder = (
	desc: SchemaDesc,
	installation: Identity<"schema">,
	codes: Codebook,
	params: ReadonlyArray<ParamDecl>
): Result.Result<RealInstallPlan, CompileError> =>
	Result.flatMap(admitSchemaDesc(desc), (admitted) =>
		Result.flatMap(
			catchCompileError(() => oracleLogin(desc)),
			(login) => {
				const planned = Effect.runSync(
					Effect.result(
						describedPlan(
							admitted,
							[{ desc: login, stated: declaredTypes("the case's query", params) }],
							installation,
							codes
						)
					)
				)
				return EffectResult.isSuccess(planned)
					? Result.ok(planned.success)
					: Result.err(planned.failure)
			}
		)
	)

/**
 * The plan of a generated schema as oraclePlanUnder plans it, as a fresh installation numbers its rosters
 * (firstCodebook): what every oracle suite installs whose case states no codes of its own.
 */
export const oraclePlan = (
	desc: SchemaDesc,
	installation: Identity<"schema">,
	params: ReadonlyArray<ParamDecl>
): Result.Result<RealInstallPlan, CompileError> =>
	Result.flatMap(ownedInput(desc), (owned) =>
		oraclePlanUnder(desc, installation, firstCodebook(rostersOf(owned)), params)
	)
