/**
 * The deleted host validators against PostgreSQL 19: every value the old bind-time check of a parameter's contract and
 * pattern refused (test/support/oracle/refinement.ts refinedMember, the test-only copy of codec/scalar.ts's deleted
 * check) PostgreSQL refuses through the new path, as it binds the parameter, by the same rule, and classified as the
 * refusal grizzle reports; and nothing else.
 *
 * - Differential: one schema declares a pattern on a stored field (Slug), a pattern no field declares (Tag), a bound
 *   contract over bigint (Cents) and an exact rate contract over numeric(7, 6) (Rate). Each lookup reads one of them as
 *   a scalar parameter or as a field of a relation parameter's facts, its placeholder cast to the parameter's own
 *   pattern domain or to the contract's domain, which installing the lookups' workload creates for every pattern a
 *   parameter names (physical/access/extension.ts workloadExtension). Every drawn value is of its base carrier, which the host
 *   parses and binds, refusing nothing a refinement refuses, and is run: PostgreSQL refuses it with 23514 exactly where the old check refused it, the reported data type the
 *   domain it was cast to, and the role's classifier (witness/classify.ts domainRefusal, through the served witness)
 *   reads the refusal as the one grizzle reports: a pattern's as ParamRejected at the parameter's place (a scalar's
 *   name, or a relation parameter's and its field's) and the pattern as its type spells it, a contract's as LawRejected naming the
 *   contract's law, `every` of it. A value inside its rule matches exactly its rows.
 *
 * The one refusal the host made that PostgreSQL never makes is deleted on purpose and stated here, not searched: two
 * facts one stratum deletes at one key (docs/reads-and-writes.md "A relation's rows are a set").
 *
 * Oracle: the old host check, run beside the new path; PostgreSQL's report and the classifier's reading of it.
 *
 * Features: per lookup, "<lookup> refused alike" and "<lookup> admitted alike".
 */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Formatter, Option } from "effect"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import {
	caseGen,
	type DifferentialFeature,
	judgedType,
	lookups,
	readsAsRule,
	serverErrorOf,
	shopCodes,
	shopTemplate
} from "#test/pg/input/differential.fixtures.ts"
import { paramValues } from "#test/support/compile.ts"
import { refinedMember } from "#test/support/oracle/refinement.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The deleted host validators against PostgreSQL 19 PostgreSQL refuses exactly what the old host check refused, by the same rule, read as grizzle reports it.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/input/differential.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/input/differential.test.ts` at its budget
 *   before, `{ runs: 200, steered: 200 }`, each kill's verdict printed with where its witnesses went red (judgedLine
 *   with the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget
 *   run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const theDeletedHostValidatorsAgainstPostgreSQL19PostgreSQLRefusesExactlyWhatTheOldHostCheckRefusedByTheSameRuleReadAsGrizzleReportsIt =
	property.explore(caseGen, {
		needs: { shop: Substrate.rolledBack(shopTemplate) },
		situations: nonEmpty(
			Arr.flatMap(lookups, (l): ReadonlyArray<DifferentialFeature> => [
				`${l.label} refused alike`,
				`${l.label} admitted alike`
			]),
			"the features"
		) satisfies ReadonlyArray<Reached<DifferentialFeature>>,
		budget: { runs: 1, steered: 200 },
		check:
			({ shop }, c: CaseOf<DifferentialFeature>) =>
			({ lookup, values }) =>
				Effect.gen(function* () {
					const { session, value } = yield* shop
					const { templates, witness } = value

					const template = templates.get(lookup)
					if (template === undefined) {
						throw new Error(`the template of ${lookup.label}`)
					}
					const old = refinedMember(judgedType(template, lookup), new CompilePatterns())
					if (old === undefined) {
						throw new Error(`${lookup.label} reads a refined type`)
					}
					const spec = template.optimized[0]
					if (spec === undefined) {
						throw new Error(`${lookup.label} holds a statement`)
					}
					for (const value of values) {
						const bound = lookup.bind(value)
						assert.equal(
							executionInputs(paramCodecs(template.params, shopCodes), bound)._tag,
							"Success",
							`${lookup.label}: the host parses ${Formatter.format(value)} as its base carrier alone, refusing nothing a refinement refuses`
						)
						const ran = yield* Effect.exit(
							session.values(
								spec.sql,
								paramValues(spec, bound, { params: template.params, codes: shopCodes })
							)
						)
						const oldRefused = !old(value)
						if (Exit.isSuccess(ran)) {
							assert.ok(
								!oldRefused,
								`${lookup.label}: PostgreSQL admits ${Formatter.format(value)}, which the old check refused`
							)
							c.note(`${lookup.label} admitted alike`)
							continue
						}
						const failure = Option.getOrUndefined(Exit.findErrorOption(ran))
						const reported = failure === undefined ? undefined : serverErrorOf(failure)
						assert.ok(
							oldRefused,
							`${lookup.label}: PostgreSQL refuses ${Formatter.format(value)}, which the old check admitted: ${Formatter.format(reported)}`
						)
						assert.equal(
							reported?.sqlstate,
							sqlstates.checkViolation,
							`${lookup.label}: a domain's refusal`
						)
						assert.ok(
							reported !== undefined && readsAsRule(lookup, witness.domain(reported)),
							`${lookup.label}: ${Formatter.format(reported)} reads as ${Formatter.format(
								reported === undefined ? undefined : witness.domain(reported)
							)}`
						)
						c.note(`${lookup.label} refused alike`)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the old host check of a parameter's contract and pattern, and the classifier's reading of PostgreSQL's report"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/context.ts",
				original: '\t\tconst checked = this.paramTypeRef(p.type, { kind: "scalar", name: param })',
				replacement: "\t\tconst checked = this.baseTypeRef(p.type)",
				why: "A scalar parameter's placeholder is cast to its base (lower/conservative/context.ts scalarParam), so no domain checks it, and PostgreSQL admits what the old check refused."
			}
		]
	})
