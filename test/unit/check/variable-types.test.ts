/**
 * A variable's type is the one its columns' types settle on, whatever order a rule's matches bind it in, and a relation
 * parameter's rows are of its declared heading, wherever it is bound (check/checker.ts RuleCheck #settle, Checker
 * #deliversHeading and #boundRows): a variable bound to several columns holds values that lie in every one of their
 * types, so its type is the one that guarantees all the others (check/refinement guarantees, by the automata of their
 * languages within their byte bounds), each other column bound to a hidden variable of its type, one class with it; a
 * variable no one of whose columns' types guarantees the others is refused, naming each. A relation parameter bound to a
 * query reads the query's rows at its declared types, admitted where each delivered type guarantees its field's and
 * refused otherwise. metis, before: its guards bound a sitting's child first to the signed-in person's column, a Timeback
 * user, then to its assignment's LearnerId, so the sitting delivered the wider type, by the order of the matches alone,
 * and its `sittings` parameter of LearnerId took that wider type for its own, its declared refinement lost.
 *
 * The boxes, exhausted: one variable bound to two holders of a learner's id, a LearnerId's and a person's in either
 * order, one refinement twice, or two that neither holds the other's values of; and a relation parameter declared at a
 * LearnerId or a person's id, bound to a query delivering either (variable-types.fixtures.ts).
 *
 * Oracles: specification, a variable delivers the narrower holder's own type in either order, and two incomparable
 * holders are refused; a parameter delivers its declared type, and a wider delivery is refused.
 *
 * Features: the narrower first, the wider first, one refinement and incomparable; one refinement, a narrower one
 * delivered and a wider one delivered.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, String as Str } from "effect"
import { sameScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import {
	type BindingFeature,
	bindingCaseGen,
	bindingFeature,
	boundOf,
	declaredTypeOf,
	narrowestOf,
	type ParamFeature,
	paramCaseGen,
	paramFeature,
	paramOf
} from "#test/unit/check/variable-types.fixtures.ts"

/** A variable bound to columns of two refinements takes the one that guarantees the other, whatever the match order. */
export const aVariableTakesTheTypeItsColumnsSettleOnWhateverTheOrderOfItsMatches = property.exhaust(
	finite(bindingCaseGen),
	{
		needs: {},
		situations: ["the narrower first", "the wider first", "one refinement", "incomparable"],
		check: (_, k: Case<BindingFeature>) => (c) =>
			Effect.sync(() => {
				const feature = bindingFeature(c)
				k.note(feature)
				const bound = boundOf(c)
				if (feature === "incomparable") {
					assert.ok(
						!bound.ok &&
							Str.includes("no one of whose types guarantees the others'")(bound.error.message),
						`${Formatter.format(c)}: a variable of two incomparable refinements is refused, naming them`
					)
					return
				}
				assert.ok(bound.ok, `${Formatter.format(c)}: the read compiles`)
				const expected = narrowestOf(c)
				assert.ok(
					sameScalarType(bound.value, expected),
					`${Formatter.format(c)}: the variable delivers ${typeLabel(expected)}, not ${typeLabel(bound.value)}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "a variable delivers the narrower holder's own type in either order, and two incomparable holders are refused"
		},
		box: "one variable bound to a LearnerId's and a person's holder in either order, to one refinement twice, or to two incomparable refinements",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					"\t\tif (this.#settled.has(slot.id)) {\n\t\t\treturn\n\t\t}\n\t\tthis.#settled.add(slot.id)\n",
				replacement:
					"\t\tif (this.#settled.has(slot.id) || true) {\n\t\t\treturn\n\t\t}\n\t\tthis.#settled.add(slot.id)\n",
				why: "A variable takes its first binding's type: a sitting's child bound first to a person's id delivers the wider type, by the order of the matches alone, and two incomparable refinements pass."
			}
		]
	}
)

/** A relation parameter's rows are of its declared heading, a binding that delivers a wider type refused. */
export const aRelationParametersRowsAreOfItsDeclaredHeadingWhereverItIsBound = property.exhaust(
	finite(paramCaseGen),
	{
		needs: {},
		situations: ["one refinement", "a narrower one delivered", "a wider one delivered"],
		check: (_, k: Case<ParamFeature>) => (c) =>
			Effect.sync(() => {
				const feature = paramFeature(c)
				k.note(feature)
				const read = paramOf(c)
				if (feature === "a wider one delivered") {
					assert.ok(
						!read.ok && Str.includes("does not hold every value of")(read.error.message),
						`${Formatter.format(c)}: a query delivering a wider type than the parameter declares is refused`
					)
					return
				}
				const expected = declaredTypeOf(c)
				assert.ok(
					read.ok && sameScalarType(read.value, expected),
					`${Formatter.format(c)}: the parameter's rows are of ${typeLabel(expected)}${read.ok ? `, not ${typeLabel(read.value)}` : ""}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "a parameter delivers its declared type, and a wider delivery is refused"
		},
		box: "a relation parameter declared at a LearnerId or a person's id, bound to a query delivering either",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\t\tif (!guarantees(delivered.type, f.type, this.patterns)) {\n",
				replacement: "\t\t\tif (!compatible(delivered.type, f.type)) {\n",
				why: "A binding is admitted where its types are compatible alone: a query delivering a person's id binds a parameter of LearnerId, whose rows then hold values no LearnerId holds."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					"\t\tthis.#deliversHeading(name, heading, rows.heading, loc)\n\t\treturn this.#widenArm(\n",
				replacement:
					"\t\tthis.#deliversHeading(name, heading, rows.heading, loc)\n\t\treturn rows\n\t\treturn this.#widenArm(\n",
				why: "A bound parameter's rows keep the query's types: a parameter declared at a person's id, bound to a query of LearnerIds, reads them as LearnerIds, its declared heading lost."
			}
		]
	}
)
