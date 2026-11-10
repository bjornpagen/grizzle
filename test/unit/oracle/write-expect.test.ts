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
 * - a refusal at bind, EncodingFailure refinedValue at the slot of a parameter passed outside its field.
 * Every mutant fails:
 * - a refusal by a law of the group that no acceptable refusal names;
 * - a witness naming another law than the outcome;
 * - a witness key that is no violating key of the law;
 * - a keyless witness where the law's witness carries its key;
 * - a witness carrying a key where the law's violation is native and keyless;
 * - a refusal where the change applies, and an applied outcome where the domain or the bind refuses;
 * - a domain's refusal naming, decided, one of the several laws of the columns it types in the refused relation;
 * - a domain's check violation left an operational failure, unclassified.
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record, Result } from "effect"
import { ExecutionFailure } from "#adapter/errors/execution.ts"
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import { identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { codebookFor, firstCodes, schemaInputOf } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { planRealInstall } from "#test/support/oracle/install/real.ts"
import { changeSetSketchGen, resolveChangeSet } from "#test/support/oracle/write/changeset.ts"
import { typeInfo } from "#test/support/oracle/write/domain.ts"
import { expectChangeSet, type Violations } from "#test/support/oracle/write/expect.ts"
import { factsSketchGen, keyOf, resolveFacts } from "#test/support/oracle/write/facts.ts"
import { judgeWrite, plantedCase } from "#test/support/oracle/write/harness.ts"
import type { GroupState, WriteOutcome, OutcomeWitness } from "#test/support/oracle/write/run.ts"
import {
	buildWSchema,
	columnOf,
	lawNames,
	relationIn,
	resolveSchema,
	schemaSketchGen,
	type WGroup,
	type WriteLawNames,
	type WSchema
} from "#test/support/oracle/write/schema.ts"
import { pickGen, pickFrom } from "#test/support/pick.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"

/**
 * The law names of a generated schema's real compiled installation, built as the pg oracle builds them
 * (oracle/write/run.ts openTarget): the schema value under the oracle's declared name, planned by the real installer
 * under that name's schema with no extension, every law of a write schema being native. The owner names who owns the
 * installed objects, which no law name depends on.
 */
const writeLawNames = (schema: WSchema): WriteLawNames => {
	const declared = "Wo"
	const value = buildWSchema(schema, declared).value
	const plan = succeeded(
		planRealInstall(value, {
			installation: identity.schema(parsedSchemaName(declared)),
			owner: "grizzle_dev",
			logins: [],
			extensions: [],
			codes: succeeded(codebookFor(schemaInputOf(value), firstCodes))
		})
	)
	return lawNames(plan)
}

/** Every law a group declares. */
const groupLaws = (group: WGroup, laws: WriteLawNames): ReadonlyArray<LawId> => [
	...Arr.flatMap(group.relations, (r) => [
		laws.primaryKey(r.name),
		...Arr.map(r.keys, (k) => laws.key(r.name, k))
	]),
	...Arr.map(group.containments, (c) => laws.foreignKey(c.from.relation, c.from.fields)),
	...Arr.map(group.projectedKeys, (k) => laws.projectedKey(k.relation, k.fields).law)
]

/** A native violation's witness: PostgreSQL states its key only in its message. */
const unreported: OutcomeWitness = { kind: "unreported" }

const refused = (law: LawId, witness: OutcomeWitness): Result.Result<WriteOutcome, unknown> =>
	Result.succeed({ kind: "invariant-rejected", refused: { kind: "every", laws: [law] }, witness })

/**
 * A domain's refusal of a relation's columns as the adapter reports it: the pattern law of each column the domain
 * types there, `every` where one and `some` where several, keyless.
 */
const domainRefused = (
	laws: Arr.NonEmptyReadonlyArray<LawId>
): Result.Result<WriteOutcome, unknown> => {
	const [first, second, ...rest] = laws
	return Result.succeed({
		kind: "invariant-rejected",
		refused:
			second === undefined
				? { kind: "every", laws: [first] }
				: { kind: "some", laws: [first, second, ...rest] },
		witness: unreported
	})
}

/** The first violator's values at the law's fields. */
const firstKey = (violations: Violations) =>
	Record.fromEntries(
		Arr.map(violations.fields, (f) => [f, Arr.headNonEmpty(violations.violators)[f]])
	)

/** A violator's key at the law's fields: the key a faithful witness carries. */
const violatingKey = (violations: Violations): OutcomeWitness => ({
	kind: "key",
	relation: violations.relation,
	values: firstKey(violations)
})

/**
 * A key of the law's relation at its fields that is none of its violating keys: a violator's key with one field
 * redrawn from its domain.
 */
const otherKey = (group: WGroup, violations: Violations): OutcomeWitness | undefined => {
	const relation = relationIn(group, violations.relation)
	const { fields, keys } = violations
	const base = firstKey(violations)
	const free = Arr.findFirst(fields, (field) =>
		Arr.findFirst(typeInfo[columnOf(relation, field).kind].values, (value) => {
			const candidate = { ...base, [field]: value }
			return keys.has(keyOf(relation, fields, candidate)) ? Option.none() : Option.some(candidate)
		})
	)
	return Option.isSome(free)
		? { kind: "key", relation: relation.name, values: free.value }
		: undefined
}

/** A key of the group's first relation, its primary key at the first value of each field's domain. */
const someKey = (group: WGroup): OutcomeWitness => {
	const relation = Option.getOrThrowWith(
		Arr.head(group.relations),
		() => new Error("a refused group declares no relation")
	)
	return {
		kind: "key",
		relation: relation.name,
		values: Record.fromEntries(
			Arr.map(relation.primaryKey, (f) => [f, typeInfo[columnOf(relation, f).kind].values[0]])
		)
	}
}

const situations = [
	"faithful refusal",
	"faithful domain refusal",
	"mutant: one of a domain's several laws",
	"mutant: an unacceptable law",
	"mutant: a non-violating key",
	"mutant: a keyless witness of a keyed law",
	"mutant: a keyed witness of a native law",
	"mutant: refused where applied",
	"mutant: applied where domain-refused",
	"mutant: a domain's violation unclassified",
	"faithful refusal at bind",
	"mutant: applied where refused at bind"
] as const

type WriteExpectFeature = (typeof situations)[number]

/** The situations of a domain refusal: the faithful one, and its two mutants. */
const domainSituations: ReadonlyArray<WriteExpectFeature> = [
	"faithful domain refusal",
	"mutant: applied where domain-refused",
	"mutant: a domain's violation unclassified"
]

/**
 * The planted group a witness judges in place of its drawn case, aimed at what no witness reached yet (Case.steering):
 * while a domain refusal's situation is pending, in half its cases by a draw of its own, the schema's planted group,
 * whose "wider member" arm reads a stored wide text past the narrow domain into it (changeset.ts plantedChangeSet), the
 * refusal a drawn ChangeSet reads from a stored value too rarely; none for a schema without it, and for a rotating or
 * kept case, which runs as drawn.
 */
const widerAimed = (schema: WSchema, n: Case<WriteExpectFeature>): Option.Option<WGroup> =>
	Option.filter(
		Arr.findFirst(schema.groups, (g) => g.role === "planted"),
		() =>
			Option.exists(n.steering, (pending) => Arr.some(domainSituations, (s) => pending.has(s))) &&
			n.draw(boolean)
	)

describe("the write oracle's judgement", () => {
	it.effect("passes a faithful realization and refuses every planted mutant of it", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/oracle/write-judge",
					draw: drawn(
						(source) =>
							[
								source.draw(schemaSketchGen),
								source.draw(pickGen),
								source.draw(factsSketchGen(5)),
								source.draw(changeSetSketchGen)
							] as const
					),
					literal: Formatter.format,
					coverage: required<WriteExpectFeature>(situations, { cases: 400, sense: notesOnly }),
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([schemaSketch, groupPick, factsSketch, changesSketch], n) =>
					Effect.sync(() => {
						const schema = n.draw(resolveSchema(schemaSketch))
						const [first, ...rest] = schema.groups
						if (first === undefined) {
							return
						}
						const laws = writeLawNames(schema)
						const { group, facts, c } = Option.match(widerAimed(schema, n), {
							onNone: () => {
								const drawnGroup = pickFrom([first, ...rest], groupPick)
								const drawnFacts = resolveFacts(drawnGroup, factsSketch)
								return {
									group: drawnGroup,
									facts: drawnFacts,
									c: n.draw(resolveChangeSet(drawnGroup, drawnFacts, changesSketch))
								}
							},
							onSome: (planted) => {
								const wider = plantedCase(planted, "wider member", factsSketch)
								return { group: wider.group, facts: wider.facts, c: wider.changes }
							}
						})
						const expected = expectChangeSet({ group, laws }, facts, c, {})
						const state: GroupState = {
							relations: expected.initial.relations,
							sequences: expected.initial.sequences
						}
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
							case "applied":
								if (anyLaw !== undefined) {
									mutant("mutant: refused where applied", refused(anyLaw, unreported))
								}
								return
							case "outsideDomain": {
								const refusing = Arr.findFirst([...expected.domain.typed], ([relation, laws]) =>
									expected.domain.refusing.has(relation) && Arr.isReadonlyArrayNonEmpty(laws)
										? Option.some(laws)
										: Option.none()
								)
								if (Option.isNone(refusing)) {
									throw new Error(
										"a domain refusal expectation refuses no relation the domain types"
									)
								}
								const laws = refusing.value
								n.note("faithful domain refusal")
								assert.deepEqual(verdict(domainRefused(laws)), [])
								if (laws.length > 1) {
									mutant(
										"mutant: one of a domain's several laws",
										refused(Arr.headNonEmpty(laws), unreported)
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
									throw new Error("a refusal at bind names no parameter")
								}
								n.note("faithful refusal at bind")
								assert.deepEqual(
									verdict(Result.fail(encodeFailure("refinedValue", slotPlace(param)))),
									[]
								)
								mutant(
									"mutant: applied where refused at bind",
									Result.succeed({ kind: "no-change", reads: {} })
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
									mutant("mutant: an unacceptable law", refused(other, unreported))
								}
								n.note("faithful refusal")
								switch (refusal.kind) {
									case "key": {
										assert.deepEqual(verdict(refused(law, violatingKey(refusal.violations))), [])
										const at = otherKey(group, refusal.violations)
										if (at !== undefined) {
											mutant("mutant: a non-violating key", refused(law, at))
										}
										mutant("mutant: a keyless witness of a keyed law", refused(law, unreported))
										return
									}
									case "keyOrUnreported": {
										assert.deepEqual(verdict(refused(law, violatingKey(refusal.violations))), [])
										assert.deepEqual(verdict(refused(law, unreported)), [])
										const at = otherKey(group, refusal.violations)
										if (at !== undefined) {
											mutant("mutant: a non-violating key", refused(law, at))
										}
										return
									}
									case "unreported":
										assert.deepEqual(verdict(refused(law, unreported)), [])
										mutant("mutant: a keyed witness of a native law", refused(law, someKey(group)))
										return
								}
							}
						}
					})
			)
		)
	)
})
