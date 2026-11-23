/**
 * evaluateRules, the worlds model's meaning of a rule set, over rules drawn over the documents base: the reference
 * evaluator, run on the checked DAG of the same rules built as an application builds them (execute/describe.ts
 * definitionOf, the executor's own translation), gives the same rows over the same reality and session. The host is the oracle
 * of the worlds suites; the reference is a second opinion that reads grizzle's own checked form, so a disagreement is
 * a defect of one of the two, never resolved by the other's word.
 *
 * The rules join on shared variables, negate conjunctions of one or two occurrences (correlated, with variables of
 * their own, reading a context), compare variables with literals, other variables and context fields by every
 * operator, read ordinary relations, the closed roster Tier and the contexts Session and Tenant, and union two rules; the session holds each context's fact or none. Values come from small pools, so facts
 * meet each other and the claims.
 *
 * A writable entry's rows are exactly the head projections of its target's facts that isMember holds in it: over the
 * documents worlds' writable entries and drawn realities and sessions, entryRows and isMember agree.
 *
 * A role relation's field set is a key exactly where grizzle's logical analysis proves the read that binds it at most
 * one row (entryKeyed against the empty key among the compiled template's analyzed root's logical keys, ir/rel.ts
 * MetaSpec), over drawn installations of the documents base, each of which the builder must build: a drawn installation
 * it refuses fails the case.
 *
 * The draw's weights are explicit: a field's binding is a shared variable three times in eight, a literal twice, and
 * unnamed, another variable or a context field once each; a term of a kind is each bound variable of the kind twice as
 * often as a literal or the kind's context field. Features: every source, join, negation, comparison and context
 * reading the host's answer shows to matter, a union both rules feed, rows and none; a member and a non-member; a key
 * and no key.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Predicate, Record as Rec, Result } from "effect"
import { queryOver as queryBuilt, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { buildInstall } from "#test/support/worlds/execute/build.ts"
import { definitionOf } from "#test/support/worlds/execute/describe.ts"
import { carrierOf } from "#test/support/worlds/execute/host.ts"
import { pooled } from "#test/support/worlds/generate/domain.ts"
import { headingOf } from "#test/support/worlds/generate/entries.ts"
import { docsBase } from "#test/support/worlds/model/bases/docs.ts"
import { entryRows, evaluateRules, isMember, ruleFaults } from "#test/support/worlds/model/host.ts"
import { entryKeyed } from "#test/support/worlds/model/session/keys.ts"
import {
	answerOf,
	caseGen,
	checkedDag,
	described,
	docsSources,
	featuresOf,
	fieldSets,
	fieldValue,
	type HostFeature,
	hostRows,
	keysSpace,
	referenceRows,
	rulesOfShape,
	schema,
	situations,
	stateOf,
	worldGen,
	writableEntries
} from "#test/unit/world-model/host.fixtures.ts"

/**
 * The worlds model's host semantics evaluates every drawn rule set as the reference evaluates the query an application
 * builds from it.
 *
 * Budget: its suite's count before the conversion (unit/world-model/host: 200 independent cases and 64 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theWorldsModelsHostSemanticsEvaluatesEveryDrawnRuleSetAsTheReferenceEvaluatesTheQueryAnApplicationBuildsFromIt =
	property.explore(caseGen, {
		needs: {},
		situations: situations satisfies ReadonlyArray<Reached<HostFeature>>,
		check: (_, c: Case<HostFeature>) => (drawnCase) =>
			Effect.gen(function* () {
				const rules = rulesOfShape(drawnCase.shape)
				const what = described(rules)
				assert.deepEqual(
					ruleFaults(docsBase, rules),
					[],
					`the drawn rules are well formed: ${what}`
				)
				const built = yield* Effect.result(definitionOf(docsBase, docsSources, rules, schema, what))
				if (Result.isFailure(built)) {
					return assert.fail(`the builder refuses the rules, ${built.failure.message}: ${what}`)
				}
				const query = built.success
				const { reality, session } = drawnCase
				const rows = evaluateRules(docsBase, rules, reality, session)
				const columns = Arr.sort(Rec.keys(rules[0].head), Order.String)
				assert.deepEqual(
					answerOf(columns, hostRows(rows)),
					answerOf(columns, referenceRows(checkedDag(query, schema), reality, session)),
					`the host and the reference agree: ${what}`
				)
				c.noteAll(featuresOf(rules, reality, session, rows.length))
			}),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator over the checked DAG of the query an application builds from the rules"
		},
		budget: { runs: 200, steered: 64 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/expr.ts",
				original: "\t\t...(expr.deps.params.length > 0 || expr.deps.nodes.length > 0",
				replacement: "\t\t...(expr.deps.params.length > 0 || expr.deps.nodes.length <= 0",
				why: "Operator mutant (comparison) at packages/engine/src/ir/expr.ts:1115 in entryProblems: `>` becomes `<=`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * The worlds model's host semantics holds in a writable entry exactly the target facts whose head projections are its
 * rows.
 *
 * Budget: its suite's count before the conversion (unit/world-model/host membership: 100 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const theWorldsModelsHostSemanticsHoldsInAWritableEntryExactlyTheTargetFactsWhoseHeadProjectionsAreItsRows =
	property.explore(worldGen, {
		needs: {},
		situations: ["a member", "a non-member"] satisfies ReadonlyArray<
			Reached<"a member" | "a non-member">
		>,
		check:
			(_, c: Case<"a member" | "a non-member">) =>
			({ reality, session }) =>
				Effect.sync(() => {
					const state = stateOf(reality)
					for (const entry of writableEntries) {
						const facts = reality.get(entry.target) ?? []
						const members = Arr.filter(facts, (f) =>
							isMember(state, entry.role, entry.name, session, f)
						)
						const projected = Arr.map(members, (f) =>
							Rec.fromEntries(
								Arr.map(
									Rec.toEntries(entry.head),
									([h, { field }]) => [h, fieldValue(f, field)] as const
								)
							)
						)
						const columns = Arr.sort(Rec.keys(entry.head), Order.String)
						assert.deepEqual(
							answerOf(columns, hostRows(projected)),
							answerOf(columns, hostRows(entryRows(state, entry.role, entry.name, session))),
							`${entry.role}.${entry.name} holds the projections of its members`
						)
						c.noteAll([
							...(members.length > 0 ? ["a member" as const] : []),
							...(members.length < facts.length ? ["a non-member" as const] : [])
						])
					}
				}),
		oracle: {
			kind: "specification",
			name: "a writable entry's rows are the head projections of the target facts isMember holds"
		},
		budget: { runs: 100, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original:
					'\t\t\tconversion.startsWith("pg_")\n\t\t\t\t? Result.err({ kind: "reserved", conversion })\n\t\t\t\t: Result.ok(schemaName(declared))',
				replacement:
					'\t\t\tconversion.startsWith("pg_")\n\t\t\t\t? Result.ok(schemaName(declared))\n\t\t\t\t: Result.err({ kind: "reserved", conversion })',
				why: "Operator mutant (arm-swap) in parseSchemaName: its pg_ arms swapped, so a pg_ conversion is admitted and every other schema name refused as reserved; the property fails (lane CATCH, grizzle 0baff5d6, quoted as the fault reads since lane REDFIX2)."
			}
		]
	})

/**
 * The worlds model's host semantics proves a role relation's field set a key exactly where grizzle's logical analysis
 * proves its read at most one row.
 *
 * Budget: its suite's count before the conversion (unit/world-model/host get keys: 60 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theWorldsModelsHostSemanticsProvesARoleRelationsFieldSetAKeyExactlyWhereGrizzlesLogicalAnalysisProvesItsReadAtMostOneRow =
	property.explore(keysSpace, {
		needs: {},
		situations: ["a key", "no key"] satisfies ReadonlyArray<Reached<"a key" | "no key">>,
		check: (_, c: Case<"a key" | "no key">) => (install) =>
			Effect.gen(function* () {
				const built = yield* Effect.result(buildInstall(install, "worlds_keys"))
				if (Result.isFailure(built)) {
					return assert.fail(
						`the builder refuses a drawn installation, ${built.failure.message}: ${described(install)}`
					)
				}
				for (const role of install.roles) {
					const roleValue = defined(
						built.success.roles[role.name],
						`the role ${role.name} as built`
					)
					for (const [name, spec] of Rec.toEntries(role.entries)) {
						const heading = headingOf(install.base, spec)
						for (const fields of fieldSets(heading)) {
							const keyed = entryKeyed(
								install.base,
								spec,
								Arr.map(fields, (f) => f.name)
							)
							const value: unknown = Predicate.hasProperty(roleValue.relations, name)
								? roleValue.relations[name]
								: undefined
							const query = queryBuilt(roleValue).rule((r: RuleValue): FinishedValue => {
								const vars = varsOver(value, "value")
								return Arr.reduce(fields, r.match(value, vars), (matched, f) =>
									matched.where(r.eq(vars[f.name], carrierOf(f.domain, pooled(f.domain, 0))))
								).find(vars)
							})
							/** A read the builder refuses before its analysis (a literal it will not type) is the read's own refusal. */
							const compiled = compileTemplate(query, roleValue, testCompile)
							if (!compiled.ok) {
								continue
							}
							assert.equal(
								Arr.some(
									compiled.value.analyzed.roots[0].meta.logicalKeys,
									(proof) => proof.key.length === 0
								),
								keyed,
								`read of ${role.name}.${name} by ${Arr.join(
									Arr.map(fields, (f) => f.name),
									", "
								)}: the model says ${keyed ? "a key" : "no key"}`
							)
							c.note(keyed ? "a key" : "no key")
						}
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "grizzle's logical keys (ir/rel.ts MetaSpec.logicalKeys) of the read the model keys"
		},
		budget: { runs: 60, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/world-model/host.test.ts#theWorldsModelsHostSemanticsProvesARoleRelationsFieldSetAKeyExactlyWhereGrizzlesLogicalAnalysisProvesItsReadAtMostOneRow:-:1.0.0.0.1.0.0.1.0"
				),
				reason:
					"a union keyed by Doc's id where words is 0 and by its org where words is 1: (id, org, words) is a key though no one arm's key beside the separator is",
				since: "2026-11-05"
			}
		],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original:
					"\tObject.fromEntries(Object.entries(b).map(([column, e]) => [column, f(e)] as const))",
				replacement: "\tObject.fromEntries(Object.entries(b).map(([column]) => [column] as const))",
				why: "Operator mutant (element) at packages/engine/src/ir/desc.ts mapBindingTerms, the one map of a binding record, which ParamWalk's bindings read since lane SCALARONE: `[column, f(e)]` becomes `[column]`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
