/**
 * A text pattern is analyzed once, where its descriptor is admitted: compiling a schema, from its str.regex descriptors
 * through ownership, the law model and the installation, runs the text analysis (text/refinement.ts analyzeText) and
 * its subset construction (scalar/regex/dfa.ts minimalDfa) exactly once for each distinct pattern its fields declare,
 * however many relations, keys, containments and closed rows read it. Every later reader, a key's B-tree entry, a row's
 * size, a planned UNIQUE, a text domain, reads the language the descriptor carries.
 *
 * The count is work, never time: V8's precise coverage counts each function's calls while the compile runs
 * (kernel/calls.ts callCounts), so the guard does not depend on the machine. Each case draws the distinct patterns, the
 * relations over them, two keys a relation, a containment between relations of one pattern, and a closed relation
 * whose rows carry a pattern's value.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { uuid } from "#compiler/public/fields.ts"
import { admittedClosedId } from "#compiler/scalar/closed-id.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { closed, closedRelation, relation } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import { containedBuilder, keyBuilder, onBuilder } from "#compiler/schema/statements.ts"
import { regexField } from "#compiler/text/field.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownedInput } from "#test/support/policy.ts"

/** A pattern a field may declare, with a value of its language that a closed row may hold. */
interface Pattern {
	readonly source: string
	readonly flags: "u" | "su"
	readonly member: string
	/** Whether its language bounds its bytes, so a key may hold it. */
	readonly bounded: boolean
}

const patterns: Arr.NonEmptyReadonlyArray<Pattern> = [
	{ source: "^[a-z]{0,8}$", flags: "u", member: "abc", bounded: true },
	{ source: "^.{0,40}$", flags: "su", member: "x\ny", bounded: true },
	{ source: "^(?:yes|no)$", flags: "u", member: "yes", bounded: true },
	{ source: "^[A-Z]{3}$", flags: "u", member: "ABC", bounded: true },
	{ source: "^.*$", flags: "su", member: "", bounded: false }
]

interface CountCase {
	/** The distinct patterns the schema declares, by their place in `patterns`, each once. */
	readonly chosen: Arr.NonEmptyReadonlyArray<number>
	/** Each relation's text fields, by their pattern's place in `chosen`. */
	readonly relations: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<number>>
	readonly containment: boolean
	readonly closedRows: number
}

const caseGen: Gen<CountCase> = (source) => {
	const drawnPatterns = Arr.dedupe(
		source.draw(array(int(0, patterns.length - 1), { min: 1, max: 4 }))
	)
	const chosen: Arr.NonEmptyReadonlyArray<number> = [
		defined(drawnPatterns[0], "a drawn pattern"),
		...Arr.drop(drawnPatterns, 1)
	]
	const fieldsOf: Gen<Arr.NonEmptyReadonlyArray<number>> = (inner) => [
		inner.draw(int(0, chosen.length - 1)),
		...inner.draw(array(int(0, chosen.length - 1), { min: 0, max: 2 }))
	]
	const first = source.draw(fieldsOf)
	const rest = source.draw(array(fieldsOf, { min: 0, max: 11 }))
	const containment = source.draw(boolean)
	const [second, ...others] = rest
	return {
		chosen,
		relations:
			containment && second !== undefined
				? [first, [first[0], ...Arr.drop(second, 1)], ...others]
				: [first, ...rest],
		containment,
		closedRows: source.draw(int(0, 2))
	}
}

/**
 * Whether a case's containment is declared: from its first relation's (id, t0) into its second's, which share t0's
 * pattern, one that bounds its bytes, so the UNIQUE it references is representable.
 */
const containmentOf = (c: CountCase, bounded: (t: number) => boolean): boolean => {
	const [source, target] = c.relations
	return c.containment && target !== undefined && source[0] === target[0] && bounded(source[0])
}

type CountFeature =
	| "one pattern"
	| "several patterns"
	| "a pattern in many keys"
	| "a containment"
	| "closed rows"
	| "an unbounded pattern"

describe("the text analysis", () => {
	it.effect(
		"runs once for each distinct pattern a schema's fields declare, whatever reads it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/text/analysis-once",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<CountFeature>(
							[
								"one pattern",
								"several patterns",
								"a pattern in many keys",
								"a containment",
								"closed rows",
								"an unbounded pattern"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.gen(function* () {
							const patternAt = (i: number): Pattern =>
								defined(patterns[defined(c.chosen[i], "a chosen pattern")], "a pattern")
							const [compiled, counts] = yield* callCounts(
								Effect.sync(() => {
									const descriptors = Arr.map(c.chosen, (_, i) => {
										const p = patternAt(i)
										return p.flags === "u"
											? regexField(p.source, ["u"])
											: regexField(p.source, ["su"])
									})
									const descriptorAt = (i: number): FieldBase =>
										defined(descriptors[i], "a pattern's descriptor")
									const statements: Array<Statement> = []
									const relations = Arr.map(c.relations, (texts, r) => {
										const fields = Rec.fromEntries(
											Arr.map(texts, (t, i): readonly [string, FieldBase] => [
												`t${i}`,
												descriptorAt(t)
											])
										)
										const R = relation(`R${r}`, { id: uuid, ...fields }, ["id"], [])
										Arr.forEach(texts, (t, i) => {
											if (patternAt(t).bounded) {
												statements.push(
													keyBuilder(onBuilder(R, [`t${i}`])),
													keyBuilder(onBuilder(R, ["id", `t${i}`]))
												)
											}
										})
										return { name: `R${r}`, value: R }
									})
									const [source, target] = relations
									if (containmentOf(c, (t) => patternAt(t).bounded) && target !== undefined) {
										statements.push(
											containedBuilder(
												onBuilder(source.value, ["id", "t0"]),
												onBuilder(target.value, ["id", "t0"])
											)
										)
									}
									const Kind = closed("Kind", ["A", "B"], [])
									const label = patternAt(0)
									const Labels = closedRelation(
										"Labels",
										{ kind: admittedClosedId(Kind), label: descriptorAt(0) },
										["kind"],
										Arr.map(Arr.take(["A", "B"], c.closedRows), (kind) => ({
											kind,
											label: label.member
										})),
										[]
									)
									const owned = ownedInput(
										schema(
											"Counted",
											{
												Kind,
												Labels,
												...Rec.fromEntries(Arr.map(relations, (r) => [r.name, r.value] as const))
											},
											statements,
											[]
										)
									)
									return owned.ok
										? compileInstallation(
												owned.value,
												completeInstallOptions(
													owned.value,
													installationsOf(owned.value),
													[],
													[],
													firstCodebook(rostersOf(owned.value))
												)
											)
										: owned
								}),
								{
									analyzeText: {
										file: "packages/engine/src/text/refinement.ts",
										name: "analyzeText"
									},
									minimalDfa: {
										file: "packages/engine/src/scalar/regex/dfa.ts",
										name: "minimalDfa"
									}
								}
							)
							succeeded(compiled, "the schema compiles")
							k.note(c.chosen.length === 1 ? "one pattern" : "several patterns")
							const keyed = Arr.reduce(c.relations, 0, (n, texts) =>
								Arr.reduce(texts, n, (m, t) => (patternAt(t).bounded ? m + 2 : m))
							)
							if (keyed >= 8) {
								k.note("a pattern in many keys")
							}
							if (containmentOf(c, (t) => patternAt(t).bounded)) {
								k.note("a containment")
							}
							if (c.closedRows > 0) {
								k.note("closed rows")
							}
							if (Arr.some(indices(c.chosen.length), (i) => !patternAt(i).bounded)) {
								k.note("an unbounded pattern")
							}
							assert.equal(counts.analyzeText, c.chosen.length, "one analysis a distinct pattern")
							assert.equal(
								counts.minimalDfa,
								c.chosen.length,
								"one subset construction a distinct pattern"
							)
						})
				)
			)
	)
})
