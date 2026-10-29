/**
 * The write oracle's judgement against planted realization mutants, on the one side the three-way harness cannot check
 * against PostgreSQL: its strictness. An expectation that accepts too much (an extra law among the acceptable
 * refusals, a key a witness may carry that is not a violating one, a keyless pass for a law whose witness carries its
 * key) lets a wrong realization pass silently, and no run on PostgreSQL can notice.
 *
 * Over the write oracle's own generated groups, facts and ChangeSets (no database: law names come from the schema's
 * real compiled installation, planned as the pg oracle plans it), each case's expectation (expect.ts) judges, through
 * the harness's own judge (harness.ts), a faithful realization's outcome and mutants of it. The faithful one passes:
 * - a refusal by the first acceptable law, its witness the key of one of its violators, or keyless where that refusal
 *   may be;
 * - a keyless refusal by the column domain's law, where a value lies outside its column's domain, as the adapter
 *   classifies the server's check violation by the domain it names.
 * Every mutant fails:
 * - a refusal by a law of the group that no acceptable refusal names;
 * - a witness naming another law than the outcome;
 * - a witness key that is no violating key of the law;
 * - a keyless witness where the law's witness carries its key;
 * - a witness carrying a key where the law's violation is native and keyless;
 * - a refusal where the change applies, and an applied outcome where the domain refuses;
 * - a domain's check violation left an operational failure, unclassified.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Record, Result } from "effect"
import { ExecutionFailure } from "#adapter/errors/execution.ts"
import { identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { Fact } from "#test/support/oracle/addwins.ts"
import { planRealInstall } from "#test/support/oracle/install/real.ts"
import { changeSetSketchGen, resolveChangeSet } from "#test/support/oracle/write/changeset.ts"
import { typeInfo } from "#test/support/oracle/write/domain.ts"
import { type AcceptableRefusal, expectChangeSet } from "#test/support/oracle/write/expect.ts"
import { factsSketchGen, keyOf, resolveFacts } from "#test/support/oracle/write/facts.ts"
import { judgeWrite } from "#test/support/oracle/write/harness.ts"
import type { GroupState, WriteOutcome, OutcomeWitness } from "#test/support/oracle/write/run.ts"
import {
	buildSchema,
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
	const plan = succeeded(
		planRealInstall(buildSchema(schema, declared).value, {
			installation: identity.schema(parsedSchemaName(declared)),
			owner: "grizzle_dev",
			logins: [],
			extensions: []
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
	...Arr.map(group.capacities, (c) => laws.capacity(c.source.relation, c.source.fields).law)
]

/** A native violation's witness: PostgreSQL states its key only in its message. */
const unreported: OutcomeWitness = { kind: "unreported" }

const refused = (law: LawId, witness: OutcomeWitness): Result.Result<WriteOutcome, unknown> =>
	Result.succeed({ kind: "invariant-rejected", law, witness })

/** A violator's values at the refusal's fields: the key a faithful witness carries. */
const keyAt = (refusal: AcceptableRefusal, fact: Fact): Fact =>
	Record.fromEntries(Arr.map(refusal.fields, (f) => [f, fact[f]]))

/**
 * A key of the refusal's relation at its fields that is none of its violating keys: a violator's key with one field
 * redrawn from its domain, or, for a refusal without violators, the first value of each field's domain.
 */
const otherKey = (group: WGroup, refusal: AcceptableRefusal): Fact | undefined => {
	const relation = relationIn(group, refusal.relation)
	const kindOf = (field: string) =>
		Option.getOrThrowWith(
			Arr.findFirst(relation.columns, (c) => c.name === field),
			() => new Error(`${field} is no column of ${relation.name}`)
		).kind
	const [violator] = refusal.violators
	const base: Fact =
		violator === undefined
			? Record.fromEntries(Arr.map(refusal.fields, (f) => [f, typeInfo[kindOf(f)].values[0]]))
			: keyAt(refusal, violator)
	if (!refusal.keys.has(keyOf(relation, refusal.fields, base))) {
		return base
	}
	for (const field of refusal.fields) {
		const free = Arr.findFirst(typeInfo[kindOf(field)].values, (value) => {
			const candidate = { ...base, [field]: value }
			return refusal.keys.has(keyOf(relation, refusal.fields, candidate))
				? Option.none()
				: Option.some(candidate)
		})
		if (Option.isSome(free)) {
			return free.value
		}
	}
	return undefined
}

const required = [
	"faithful refusal",
	"faithful domain refusal",
	"mutant: an unacceptable law",
	"mutant: a non-violating key",
	"mutant: a keyless witness of a keyed law",
	"mutant: a keyed witness of a native law",
	"mutant: refused where applied",
	"mutant: applied where domain-refused",
	"mutant: a domain's violation unclassified"
] as const

type WriteExpectFeature = (typeof required)[number]

describe("the write oracle's judgement", () => {
	it.effect("passes a faithful realization and refuses every planted mutant of it", (ctx) =>
		searched(
			ctx,
			explore(
				{
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
					features: features<WriteExpectFeature>(required),
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				([schemaSketch, groupPick, factsSketch, changesSketch], n) =>
					Effect.sync(() => {
						const schema = n.draw(resolveSchema(schemaSketch))
						const [first, ...rest] = schema.groups
						if (first === undefined) {
							return
						}
						const laws = writeLawNames(schema)
						const group = pickFrom([first, ...rest], groupPick)
						const facts = resolveFacts(group, factsSketch)
						const c = n.draw(resolveChangeSet(group, facts, changesSketch))
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
								/** The domain refusals lead the acceptable ones (expect.ts domainRefusals). */
								const [domain] = expected.refusals
								if (domain === undefined) {
									throw new Error("a domain refusal expectation names no law")
								}
								n.note("faithful domain refusal")
								assert.deepEqual(verdict(refused(domain.law, unreported)), [])
								mutant(
									"mutant: applied where domain-refused",
									Result.succeed({ kind: "no-change", reads: {} })
								)
								mutant(
									"mutant: a domain's violation unclassified",
									Result.fail(
										ExecutionFailure.make({
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
								const [refusal] = expected.refusals
								if (refusal === undefined) {
									return
								}
								const [violator] = refusal.violators
								const faithful: OutcomeWitness =
									refusal.keyless || violator === undefined
										? unreported
										: { kind: "key", relation: refusal.relation, values: keyAt(refusal, violator) }
								n.note("faithful refusal")
								assert.deepEqual(verdict(refused(refusal.law, faithful)), [])
								const acceptable = new Set(Arr.map(expected.refusals, (r) => r.law))
								const [other] = Arr.filter(groupLaws(group, laws), (l) => !acceptable.has(l))
								if (other !== undefined) {
									mutant("mutant: an unacceptable law", refused(other, unreported))
								}
								const at = otherKey(group, refusal)
								if (at !== undefined) {
									mutant(
										"mutant: a non-violating key",
										refused(refusal.law, { kind: "key", relation: refusal.relation, values: at })
									)
								}
								if (!refusal.keyless) {
									mutant(
										"mutant: a keyless witness of a keyed law",
										refused(refusal.law, unreported)
									)
								}
								if (refusal.keyless && refusal.keys.size === 0 && at !== undefined) {
									mutant(
										"mutant: a keyed witness of a native law",
										refused(refusal.law, { kind: "key", relation: refusal.relation, values: at })
									)
								}
								return
							}
						}
					})
			)
		)
	)
})
