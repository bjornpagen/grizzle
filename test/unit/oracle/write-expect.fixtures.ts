/** What the properties of write-expect.test.ts read: its spaces, models and helpers. */

import { type Aimed, aimed, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record, Result } from "effect"
import { identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { succeeded } from "#test/support/assert.ts"
import { codebookFor, firstCodes, schemaInputOf } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { planRealInstall } from "#test/support/oracle/install/real.ts"
import { type ChangeSetSketch, changeSetSketchGen } from "#test/support/oracle/write/changeset.ts"
import { typeInfo } from "#test/support/oracle/write/domain.ts"
import type { Violations } from "#test/support/oracle/write/expect.ts"
import { type FactsSketch, factsSketchGen, keyOf } from "#test/support/oracle/write/facts.ts"
import type { OutcomeWitness, WriteOutcome } from "#test/support/oracle/write/run.ts"
import {
	buildWSchema,
	columnOf,
	lawNames,
	relationIn,
	type SchemaSketch,
	schemaSketchGen,
	type WGroup,
	type WriteLawNames,
	type WSchema
} from "#test/support/oracle/write/schema.ts"
import { pickGen } from "#test/support/pick.ts"

/**
 * The law names of a generated schema's real compiled installation, built as the pg oracle builds them
 * (oracle/write/run.ts installTarget): the schema value under the oracle's declared name, planned by the real installer
 * under that name's schema with no extension, every law of a write schema being native. The owner names who owns the
 * installed objects, which no law name depends on.
 */
export const writeLawNames = (schema: WSchema): WriteLawNames => {
	const declared = "Wo"
	const value = buildWSchema(schema, declared).value
	const plan = succeeded(
		planRealInstall(value, {
			installation: identity.schema(parsedSchemaName(declared)),
			extensions: [],
			codes: succeeded(codebookFor(schemaInputOf(value), firstCodes)),
			compile: compileInstallation
		})
	)
	return lawNames(plan)
}

/** Every law a group declares. */
export const groupLaws = (group: WGroup, laws: WriteLawNames): ReadonlyArray<LawId> => [
	...Arr.flatMap(group.relations, (r) => [
		laws.primaryKey(r.name),
		...Arr.map(r.keys, (k) => laws.key(r.name, k))
	]),
	...Arr.map(group.containments, (c) => laws.containment(c.from.relation, c.from.fields)),
	...Arr.map(group.projectedKeys, (k) => laws.projectedKey(k.relation, k.fields).law)
]

/** A native violation's witness: PostgreSQL states its key only in its message. */
export const unreported: OutcomeWitness = { kind: "unreported" }

export const refusedOutcome = (
	law: LawId,
	witness: OutcomeWitness
): Result.Result<WriteOutcome, unknown> =>
	Result.succeed({ kind: "invariant-rejected", refused: { kind: "every", laws: [law] }, witness })

/**
 * A domain's refusal of a relation's columns as the adapter reports it: the pattern law of each column the domain
 * types there, `every` where one and `some` where several, keyless.
 */
export const domainRefused = (
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
export const violatingKey = (violations: Violations): OutcomeWitness => ({
	kind: "key",
	relation: violations.relation,
	values: firstKey(violations)
})

/**
 * A key of the law's relation at its fields that is none of its violating keys: a violator's key with one field
 * redrawn from its domain.
 */
export const otherKey = (group: WGroup, violations: Violations): OutcomeWitness | undefined => {
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
export const someKey = (group: WGroup): OutcomeWitness => {
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

export const situations = [
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
	"mutant: applied where refused at bind",
	"mutant: a law's refusal where refused at bind",
	"mutant: a parameter's refusal unclassified",
	"mutant: applied where unorderable",
	"applied: a typmod cast"
] as const

export type WriteExpectFeature = (typeof situations)[number]

/** The planted arms a witness may judge in place of its drawn case (`plantedAimed`). */
type AimedArm = "wider member" | "typmod cast" | "unorderable stratum"

/** The arm a case judges: its drawn ChangeSet, or a planted arm aimed at a pending situation. */
type CaseArm = "drawn" | AimedArm

/** A case: its schema, the group it picks, its facts and its ChangeSet, and the arm it judges. */
type WriteSketch = readonly [SchemaSketch, number, FactsSketch, ChangeSetSketch, CaseArm]

/** A case judging `arm`, its schema, group pick, facts and ChangeSet drawn. */
const sketchOf =
	(arm: CaseArm): Gen<WriteSketch> =>
	(source) => [
		source.draw(schemaSketchGen),
		source.draw(pickGen),
		source.draw(factsSketchGen(5)),
		source.draw(changeSetSketchGen),
		arm
	]

/**
 * A case: its drawn ChangeSet; and where a witness's turn aims at a pending situation, the planted arm that reaches it:
 * a domain refusal's situations, the "wider member" arm, which reads a stored wide text past the narrow domain into it
 * (changeset.ts plantedChangeSet); the typmod cast's, the "typmod cast" arm, which reads a precise numeric into a
 * rounded one; an unorderable stratum's, the "unorderable stratum" arm, whose one stratum's writes the keys order in a
 * cycle. A drawn ChangeSet reaches each too rarely.
 */
export const writeSpace: Aimed<WriteSketch, WriteExpectFeature> = aimed(sketchOf("drawn"), [
	["faithful domain refusal", sketchOf("wider member")],
	["mutant: applied where domain-refused", sketchOf("wider member")],
	["mutant: a domain's violation unclassified", sketchOf("wider member")],
	["applied: a typmod cast", sketchOf("typmod cast")],
	["mutant: applied where unorderable", sketchOf("unorderable stratum")]
])

/**
 * The planted group and arm a case judges in place of its drawn case, as its sketch's arm says, on the schema's planted
 * group. None for a drawn arm, and for a schema without the planted group, which runs as drawn.
 */
export const plantedAimed = (
	schema: WSchema,
	arm: CaseArm
): Option.Option<{ readonly group: WGroup; readonly arm: AimedArm }> =>
	arm === "drawn"
		? Option.none()
		: Option.map(
				Arr.findFirst(schema.groups, (g) => g.role === "planted"),
				(group) => ({ group, arm })
			)
