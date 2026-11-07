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
 * - a keyless refusal by the column domain's law, where a stored value lies outside its column's domain, as the adapter
 *   classifies the server's check violation by the domain it names;
 * - a refusal at bind, EncodingFailure refinedValue at the slot of a parameter passed outside its field.
 * Every mutant fails:
 * - a refusal by a law of the group that no acceptable refusal names;
 * - a witness naming another law than the outcome;
 * - a witness key that is no violating key of the law;
 * - a keyless witness where the law's witness carries its key;
 * - a witness carrying a key where the law's violation is native and keyless;
 * - a refusal where the change applies, and an applied outcome where the domain or the bind refuses;
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
import type { Fact } from "#test/support/oracle/addwins.ts"
import { planRealInstall } from "#test/support/oracle/install/real.ts"
import { changeSetSketchGen, resolveChangeSet } from "#test/support/oracle/write/changeset.ts"
import { typeInfo } from "#test/support/oracle/write/domain.ts"
import { type AcceptableRefusal, expectChangeSet } from "#test/support/oracle/write/expect.ts"
import { factsSketchGen, keyOf, resolveFacts } from "#test/support/oracle/write/facts.ts"
import { judgeWrite, plantedCase } from "#test/support/oracle/write/harness.ts"
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
	const value = buildSchema(schema, declared).value
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
	Result.succeed({ kind: "invariant-rejected", laws: [law], witness })

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

const situations = [
	"faithful refusal",
	"faithful domain refusal",
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
