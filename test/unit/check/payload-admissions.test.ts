/**
 * A closed relation's str.pattern payload is admitted once for its description, however many checked schemas read it
 * (check/closed.ts payloadAdmissions): each distinct pattern its rows hold admitted as a Text.matches pattern, its
 * parse, its automaton and its language, in the table of the checked schema that first reads the relation's
 * description (scalar/regex/patterns.ts CompilePatterns spelling, scalar/regex/admit.ts matchAdmission), one value
 * shared by every schema whose levels hold it, and read from it by every other checked schema. A
 * generate checks its installation's schemas many times, a level and a slice at a time, each reading the closed
 * relations below it: qti-database's admitted its 429 patterns 3,344 times, a minimal automaton each.
 *
 * The count is work, never time: V8's precise coverage counts each function's calls (kernel/calls.ts callCounts). The
 * box: one to five distinct patterns over one family's alphabet, each a domain's row of a closed relation Pattern, which
 * a CHECK over a stored text matches by key; the schema owned once and checked one, two and three times, each over a
 * schema built afresh, so its description holds no admission before the count.
 *
 * Features: one pattern, several patterns.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, type Gen, int, uniqueArray } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { checkedSchema } from "#compiler/analysis/schema.ts"
import { Text } from "#compiler/public/compute.ts"
import { closedId, int4 } from "#compiler/public/fields.ts"
import { check, closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { ownedInput } from "#test/support/policy.ts"
import { admittedPatternOver, families } from "#test/support/unit/text/generators.ts"

type AdmissionFeature = "one pattern" | "several patterns"

/** One to five distinct patterns over one family's alphabet, each admitted by Text.matches. */
const patternsGen: Gen<Arr.NonEmptyReadonlyArray<string>> = (source) => {
	const family = defined(families[source.draw(int(0, families.length - 1))], "a family")
	const admitted = admittedPatternOver(family.alphabet)
	const drawn = source.draw(uniqueArray(admitted, (p) => element([p]), { min: 1, max: 5 }))
	return Arr.isReadonlyArrayNonEmpty(drawn) ? drawn : [source.draw(admitted)]
}

/** The schema of a case, built afresh: each pattern a domain's, and a CHECK matching a stored text against it. */
const schemaOf = (patterns: Arr.NonEmptyReadonlyArray<string>) => {
	const Domain = closed.ordered(
		"Domain",
		Arr.map(patterns, (_, i) => `D${i}`)
	)
	const Pattern = closed.relation(
		"Pattern",
		{ domain: closedId(Domain), pattern: str.pattern },
		["domain"],
		Arr.map(patterns, (pattern, i) => ({ domain: `D${i}`, pattern }))
	)
	const Value = relation(
		"Value",
		{ id: int4, domain: closedId(Domain), lexical: str.regex("^.*$", "su") },
		["id"]
	)
	const lexical = check("Lexical", Value, (v) =>
		Text.matches(v.lexical, Pattern.at("pattern", v.domain))
	)
	return schema("Patterns", [Domain, Pattern, Value], [lexical])
}

/** The admission of a Text.matches pattern (scalar/regex/admit.ts matchAdmission), counted. */
const admissionSites = Object.freeze({
	admitted: { file: "packages/engine/src/scalar/regex/admit.ts", name: "matchAdmission" }
})

/** The times a case's schema is checked: once, twice and three times. */
const checks = [1, 2, 3] as const

/**
 * The checked schemas over one closed relation admit each pattern its rows hold once between them: one, two or three
 * checks of a schema built afresh admit exactly its distinct patterns, where each check admitting them again admits
 * them once a check.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const theCheckedSchemasOverOneClosedRelationAdmitEachPatternItsRowsHoldOnceBetweenThem =
	property.explore(patternsGen, {
		needs: {},
		situations: ["one pattern", "several patterns"] satisfies ReadonlyArray<
			Reached<AdmissionFeature>
		>,
		check: (_, k: Case<AdmissionFeature>) => (patterns) =>
			Effect.gen(function* () {
				k.note(patterns.length === 1 ? "one pattern" : "several patterns")
				for (const times of checks) {
					const owned = succeeded(ownedInput(schemaOf(patterns)), "the schema owns")
					const [, counts] = yield* callCounts(
						Effect.sync(() => {
							for (const _ of indices(times)) {
								succeeded(checkedSchema(owned), "the schema checks")
							}
						}),
						admissionSites
					)
					assert.equal(
						counts.admitted,
						patterns.length,
						`${times} checks of a schema of ${patterns.length} patterns admit each once`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the distinct patterns a closed relation's rows hold, each admitted once (kernel/calls.ts callCounts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/closed.ts",
				original: "\tfields.set(field, admitted)\n",
				replacement: "",
				why: "A closed relation's payload admissions are not held by its description, so every checked schema over it admits each pattern again, a minimal automaton each: two checks admit every pattern twice."
			}
		]
	})
