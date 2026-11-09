import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { checkedSchema } from "#compiler/analysis/schema.ts"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import { buildTheory, type Theory } from "#compiler/analysis/theory/theory.ts"
import { type TheoryViolations, theoryViolations } from "#compiler/analysis/theory/violations.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type FieldDecl,
	type FieldDesc,
	type LiteralDesc,
	literalDescShape,
	type StatementDesc
} from "#compiler/ir/desc.ts"
import * as S from "#compiler/ir/shape.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import { own } from "#compiler/schema/own.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { decodedSchema, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { canonicallySpelled } from "#test/support/oracle/gen/domain.ts"
import type { GenFacts, StoredRow } from "#test/support/oracle/gen/facts.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"

/**
 * The theory's families, trees and folds as the unit tests read them: a schema description owned, checked and
 * normalized as compilation does (ownership, the checked schema, the theory), and its laws' violation queries
 * evaluated by the brute-force reference evaluator (test/support/oracle/reference) over host facts.
 */

/** natural, the type every drawn field and every count is. */
export const natural: FieldDesc = naturalDescriptor.desc

/** A natural grizzle draws: a family's index or count, a tree's start or end. */
export const drawnNatural: FieldDecl<object> = { type: natural, writing: { kind: "drawn" } }

/** A field of `type` grizzle fills on the host, `start` at its axis's base. */
export const accumulatedOf = (type: FieldDesc, start: LiteralDesc): FieldDecl<object> => ({
	type,
	writing: { kind: "accumulated", start }
})

/** A schema of `relations` and `statements`, named T, extending nothing. */
export const schemaOf = (
	relations: SchemaDesc["relations"],
	statements: SchemaDesc["statements"]
): SchemaDesc => ({ name: "T", relations, statements, extends: undefined })

/** A theory as the unit tests read it: with its laws' violation queries, by which the reference evaluator reads each
 * law's meaning. */
export interface TestTheory extends Theory {
	readonly violations: TheoryViolations
}

/** The theory of a schema description with its laws' violation queries, or its first refusal. */
export const theoryResult = (desc: SchemaDesc): Result.Result<TestTheory, CompileError> =>
	Result.flatMap(Result.flatMap(own(decodedSchema(desc)), checkedSchema), (checked) =>
		Result.flatMap(buildTheory(checked), (t) =>
			Result.map(theoryViolations(checked), (violations) => Object.freeze({ ...t, violations }))
		)
	)

/** The theory of a schema the test states is lawful. */
export const theoryOf = (desc: SchemaDesc): TestTheory =>
	succeeded(theoryResult(desc), "the schema's theory builds")

/** A schema's statements decoded, each located as ownership locates it: what families.ts resolves. */
export const decodedStatements = (desc: SchemaDesc): ReadonlyArray<StatementDesc> =>
	decodedSchema(desc).statements

/** The theory's relations by name, as the theory's resolution reads them. */
export const relationsOf = (t: Theory): ReadonlyMap<string, Theory["relations"][string]> =>
	new Map(Rec.toEntries(t.relations))

/** The one law of `shape`: a family's, a tree's or a fold's, which a schema of one such statement states once. */
export const lawOfShape = (t: Theory, shape: TheoryLaw["shape"]): TheoryLaw => {
	const laws = Arr.filter(t.laws, (law) => law.shape === shape)
	assert.equal(laws.length, 1, `the theory states one ${shape} law`)
	return defined(laws[0])
}

/** A uuid the tests name rows by: the n-th. */
export const uuidOf = (n: number): string =>
	`00000000-0000-4000-8000-${Str.padStart(12, "0")(n.toString(16))}`

/** Host facts by relation, each fact a Description literal per field. */
export type HostFacts = Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>

/** The schema as the reference evaluator reads it: the theory's ordinary relations and their headings. */
const genSchemaOf = (t: Theory): GenSchema => ({
	name: t.name,
	relations: Arr.flatMap(Rec.values(t.relations), (r) =>
		r.kind === "relation"
			? [
					{
						name: r.name,
						columns: Arr.map(r.heading, (c) => ({ name: c.name, type: c.type })),
						primaryKey: r.primaryKey,
						keys: r.keys,
						mutable: r.mutable
					}
				]
			: []
	),
	closed: [],
	containments: []
})

/** Host facts as typed rows in heading order: each value a Description literal, typed at its column. */
const genFactsOf = (t: Theory, facts: HostFacts): GenFacts =>
	Rec.fromEntries(
		Arr.flatMap(Rec.values(t.relations), (r) =>
			r.kind === "relation"
				? [
						[
							r.name,
							Arr.map(facts[r.name] ?? [], (fact): StoredRow =>
								Arr.map(r.heading, (c) => {
									const literal = succeeded(
										S.decodeWith(literalDescShape, fact[c.name], `${r.name}.${c.name}`),
										`${r.name}.${c.name} holds a Description literal`
									)
									return canonicallySpelled(
										succeeded(
											irLiteral(literal, c.type),
											`${r.name}.${c.name} holds a literal of its type`
										).literal
									)
								})
							)
						] as const
					]
				: []
		)
	)

/**
 * The laws whose violation queries are nonempty over `facts`, each with its witness rows: the reference evaluator's
 * reading of every Forbid node of the theory's DAG.
 */
const violatedLaws = (t: TestTheory, facts: HostFacts): ReadonlyMap<LawId, number> => {
	const ref = Reference.of(t.violations.dag, {
		schema: genSchemaOf(t),
		facts: genFactsOf(t, facts),
		params: {},
		observer: unobserved
	})
	return new Map(
		Arr.flatMap(t.laws, (law) => {
			const forbid = defined(t.violations.forbids.get(law.id), `${law.id}'s violation query`)
			if (forbid.kind !== "Forbid") {
				return assert.fail(`${law.id} names a Forbid node`)
			}
			const rows = ref.eval(forbid.violation, noBindings).rows.length
			return rows > 0 ? [[law.id, rows] as const] : []
		})
	)
}

/** Whether `law`'s violation query is nonempty over `facts`. */
export const violates = (t: TestTheory, law: TheoryLaw, facts: HostFacts): boolean =>
	Option.isSome(Option.fromUndefinedOr(violatedLaws(t, facts).get(law.id)))
