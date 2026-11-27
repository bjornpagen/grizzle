/**
 * The write oracle's judgement against planted realization mutants, on the one side the three-way harness cannot check
 * against PostgreSQL: its strictness. An expectation that accepts too much (an extra law among the acceptable
 * refusals, a key a witness may carry that is not a violating one, a keyless pass for a law whose witness carries its
 * key) lets a wrong realization pass silently, and no run on PostgreSQL can notice.
 *
 * Over the write oracle's own generated groups, facts and ChangeSets, and the planted group's wider member arm where a
 * domain refusal is pending (no database: law names come from the schema's real compiled installation, planned as the
 * pg oracle plans it), each case's expectation (expect.ts) judges, through
 * the harness's own judge (harness.ts), a faithful realization's outcome and mutants of it. The faithful one passes:
 * - a refusal by the first acceptable law, its witness the key of one of its violators, or keyless where that refusal
 *   may be;
 * - a keyless refusal by the domain's laws, where a stored value lies outside its column's domain, as the adapter
 *   classifies the server's check violation by the domain it names: the law of each column the domain types in the
 *   refused relation, `every` where one and `some` where several;
 * - a parameter passed outside its field refused by PostgreSQL as the admission the first statement a call sends
 *   carries binds it, ExecutionFailure with reason ParamRejected naming the parameter;
 * - an applied outcome where a described member reads a numeric of another typmod into its field, the value its fact
 *   holds the cast's, rounded to the field's scale (domain.ts castValue), never the source's, which the exact parse of
 *   a fact (scalar/values/identity.ts parseValue) refuses at the field's typmod.
 * Every mutant fails:
 * - a refusal by a law of the group that no acceptable refusal names;
 * - a witness naming another law than the outcome;
 * - a witness key that is no violating key of the law;
 * - a keyless witness where the law's witness carries its key;
 * - a witness carrying a key where the law's violation is native and keyless;
 * - a refusal where the change applies, and an applied outcome where the domain or the bind refuses, or where a
 *   stratum's writes the keys order in a cycle, which the compile refuses (expect.ts unorderableStrata);
 * - a law's refusal where a parameter lies outside its field: the admission, which the first statement a call sends
 *   carries, refuses it as that statement is bound, before any statement runs, so no law of any stratum answers first;
 * - a domain's refusal naming, decided, one of the several laws of the columns it types in the refused relation;
 * - a domain's check violation left an operational failure, unclassified.
 *
 * The oracle is the specification: the faithful realization the expectation states passes the judge, and each mutant,
 * a planted fault of a realization, fails it. Features: every faithful outcome and every mutant above.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result } from "effect"
import { ExecutionFailure } from "#adapter/errors/execution.ts"
import { ParamRejected } from "#adapter/errors/failures.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { castsTypmod, resolveChangeSet } from "#test/support/oracle/write/changeset.ts"
import { expectChangeSet } from "#test/support/oracle/write/expect.ts"
import { resolveFacts } from "#test/support/oracle/write/facts.ts"
import { judgeWrite, plantedCase } from "#test/support/oracle/write/harness.ts"
import type { GroupState, WriteOutcome } from "#test/support/oracle/write/run.ts"
import { resolveSchema } from "#test/support/oracle/write/schema.ts"
import { pickFrom } from "#test/support/pick.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"
import {
	domainRefused,
	groupLaws,
	otherKey,
	plantedAimed,
	refusedOutcome,
	situations,
	someKey,
	unreported,
	violatingKey,
	type WriteExpectFeature,
	writeLawNames,
	writeSpace
} from "#test/unit/oracle/write-expect.fixtures.ts"

/**
 * The write oracle's judgement passes a faithful realization and refuses every planted mutant of it.
 *
 * Budget: its suite's count before the conversion (unit/oracle/write-judge: 400 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a). At those counts its required situations went unreached at TEST_SEED=1 (faithful refusal
 * at bind, mutant: applied where refused at bind, mutant: a law's refusal where refused at bind, mutant: a parameter's
 * refusal unclassified; toolchain-test run of 2026-11-16 08:21Z), so its steered phase keeps the runner's cap of 200,
 * which it stops short of once every situation is reached.
 */
export const theWriteOraclesJudgementPassesAFaithfulRealizationAndRefusesEveryPlantedMutantOfIt =
	property.explore(writeSpace, {
		needs: {},
		situations: situations satisfies ReadonlyArray<Reached<WriteExpectFeature>>,
		check:
			(_, n: Case<WriteExpectFeature>) =>
			([schemaSketch, groupPick, factsSketch, changesSketch, arm]) =>
				Effect.sync(() => {
					const schema = n.draw(resolveSchema(schemaSketch))
					const [first, ...rest] = schema.groups
					if (first === undefined) {
						return
					}
					const laws = writeLawNames(schema)
					const { group, facts, c } = Option.match(plantedAimed(schema, arm), {
						onNone: () => {
							const drawnGroup = pickFrom([first, ...rest], groupPick)
							const drawnFacts = resolveFacts(drawnGroup, factsSketch)
							return {
								group: drawnGroup,
								facts: drawnFacts,
								c: n.draw(resolveChangeSet(drawnGroup, drawnFacts, changesSketch))
							}
						},
						onSome: ({ group: planted, arm }) => {
							const aimed = plantedCase(planted, arm, factsSketch)
							return { group: aimed.group, facts: aimed.facts, c: aimed.changes }
						}
					})
					const expected = expectChangeSet({ group, laws }, facts, c)
					/** The state a side commits: the initial one, or none where the compile refuses the ChangeSet. */
					const state: GroupState =
						expected.kind === "unorderable"
							? { relations: new Map() }
							: { relations: expected.initial.relations }
					const verdict = (outcome: Result.Result<WriteOutcome, unknown>) =>
						judgeWrite(group, c, expected, outcome, state)
					const mutant = (
						name: WriteExpectFeature,
						outcome: Result.Result<WriteOutcome, unknown>
					) => {
						n.note(name)
						assert.notDeepEqual(verdict(outcome), [], `${name} passed the judge`)
					}
					const [anyLaw] = groupLaws(group, laws)
					switch (expected.kind) {
						case "unorderable":
							mutant(
								"mutant: applied where unorderable",
								Result.succeed({ kind: "no-change", reads: {} })
							)
							return
						case "applied":
							if (castsTypmod(c)) {
								n.note("applied: a typmod cast")
							}
							if (anyLaw !== undefined) {
								mutant("mutant: refused where applied", refusedOutcome(anyLaw, unreported))
							}
							return
						case "outsideDomain": {
							const refusing = Arr.findFirst([...expected.domain.typed], ([relation, laws]) =>
								expected.domain.refusing.has(relation) && Arr.isReadonlyArrayNonEmpty(laws)
									? Option.some(laws)
									: Option.none()
							)
							if (Option.isNone(refusing)) {
								throw new Error("a domain refusal expectation refuses no relation the domain types")
							}
							const laws = refusing.value
							n.note("faithful domain refusal")
							assert.deepEqual(verdict(domainRefused(laws)), [])
							if (laws.length > 1) {
								mutant(
									"mutant: one of a domain's several laws",
									refusedOutcome(Arr.headNonEmpty(laws), unreported)
								)
							}
							mutant(
								"mutant: applied where domain-refused",
								Result.succeed({ kind: "no-change", reads: {} })
							)
							mutant(
								"mutant: a domain's violation unclassified",
								Result.fail(
									new ExecutionFailure({
										reason: serverError({
											...nothingReported,
											sqlstate: sqlstates.checkViolation
										})
									})
								)
							)
							return
						}
						case "unbound": {
							const [param] = [...expected.params]
							if (param === undefined) {
								throw new Error("a parameter's refusal names no parameter")
							}
							n.note("faithful refusal at bind")
							assert.deepEqual(
								verdict(
									Result.fail(
										new ExecutionFailure({
											reason: new ParamRejected({
												param: { kind: "scalar", name: param },
												patterns: [{ source: "^.{0,3}$", flags: "su" }]
											})
										})
									)
								),
								[]
							)
							mutant(
								"mutant: applied where refused at bind",
								Result.succeed({ kind: "no-change", reads: {} })
							)
							if (anyLaw !== undefined) {
								mutant(
									"mutant: a law's refusal where refused at bind",
									refusedOutcome(anyLaw, unreported)
								)
							}
							mutant(
								"mutant: a parameter's refusal unclassified",
								Result.fail(
									new ExecutionFailure({
										reason: serverError({
											...nothingReported,
											sqlstate: sqlstates.checkViolation
										})
									})
								)
							)
							return
						}
						case "rejected": {
							const [first] = [...expected.refusals]
							if (first === undefined) {
								return
							}
							const [law, refusal] = first
							const [other] = Arr.filter(groupLaws(group, laws), (l) => !expected.refusals.has(l))
							if (other !== undefined) {
								mutant("mutant: an unacceptable law", refusedOutcome(other, unreported))
							}
							n.note("faithful refusal")
							switch (refusal.kind) {
								case "key": {
									assert.deepEqual(
										verdict(refusedOutcome(law, violatingKey(refusal.violations))),
										[]
									)
									const at = otherKey(group, refusal.violations)
									if (at !== undefined) {
										mutant("mutant: a non-violating key", refusedOutcome(law, at))
									}
									mutant(
										"mutant: a keyless witness of a keyed law",
										refusedOutcome(law, unreported)
									)
									return
								}
								case "keyOrUnreported": {
									assert.deepEqual(
										verdict(refusedOutcome(law, violatingKey(refusal.violations))),
										[]
									)
									assert.deepEqual(verdict(refusedOutcome(law, unreported)), [])
									const at = otherKey(group, refusal.violations)
									if (at !== undefined) {
										mutant("mutant: a non-violating key", refusedOutcome(law, at))
									}
									return
								}
								case "unreported":
									assert.deepEqual(verdict(refusedOutcome(law, unreported)), [])
									mutant(
										"mutant: a keyed witness of a native law",
										refusedOutcome(law, someKey(group))
									)
									return
							}
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "the expectation's faithful realization passes the judge and every planted mutant of it fails"
		},
		budget: { runs: 400, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/install/compile.ts",
				original: '\t\tif (!(lower || ch === "_" || (i > 0 && isAsciiDigit(ch.charCodeAt(0))))) {',
				replacement:
					'\t\tif ((lower || ch === "_" || (i > 0 && isAsciiDigit(ch.charCodeAt(0))))) {',
				why: 'Operator mutant (negation) at packages/engine/src/physical/install/compile.ts:239 in admittedSchema: `!(lower || ch === "_" || (i > 0 && ch >= "0" && ch <= "9"))` becomes `(lower || ch === "_" || (i > 0 && ch >= "0" && ch <= "9"))`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})
