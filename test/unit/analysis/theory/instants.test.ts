/**
 * The classifier of a schema's instants (analysis/theory/instants.ts): every instant field is a clock or a reference,
 * read off the theory's containments, a clock outside its primary key refused, and each reference stamped by the one
 * clock its containments all reach at a child they carry its row to, or by none.
 *
 * The box, exhausted: P(c, at), Q(c, at, v) and X(c, at), each `at` an instant; P keyed (c, at), (at, c) or (c), Q
 * (c, at, v) or (c, v); Q's containment into P from every row, from a selection of its rows, of `at` alone, Q's own
 * gapless law over pred(v), or none; X's into Q, into P, into both, or none; and P's into X, which closes a cycle, or
 * none. 240 cases.
 *
 * Properties, per case, against the model (instants.fixtures.ts modelOf), the rule stated again over the case's own
 * shape and sharing no code with the classifier:
 * - a case the model refuses is refused as InstantRefused at the `at` of the relation it names, the first by name of
 *   the clocks outside their keys (`clockOutsideKey`) or first in them (`childless`);
 * - any other case's theory holds each relation's `at` at the model's role: a clock with its child, or a reference with
 *   as many containments as carry it and the model's stamp, its clock and the stamped row's child fields, or none.
 *
 * Features: a clock outside its key, and first in it; a clock with a child; a reference stamped through a reference, and
 * by its clock directly; a reference no clock stamps, for a child no containment carries, for two clocks and for a
 * cycle; and a containment over a selection, and one with a pred term, which carry nothing.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { ClockStamp } from "#compiler/ir/instant.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import {
	type InstantsFeature,
	instantsGen,
	instantsSchema,
	type ModelRole,
	type ModelStamp,
	modelOf
} from "#test/unit/analysis/theory/instants.fixtures.ts"
import { theoryResult } from "#test/unit/analysis/theory/support.ts"

/** An instant is a clock or a reference by the containments that carry it, a clock outside its key refused, and a reference stamped by the one clock they all reach at a child they carry. */
export const anInstantIsAClockOrAReferenceByTheContainmentsThatCarryItAClockOutsideItsKeyRefusedAndAReferenceStampedByTheOneClockTheyAllReachAtAChildTheyCarry =
	property.exhaust(finite(instantsGen), {
		needs: {},
		situations: [
			"a clock outside its key, refused",
			"a clock first in its key, refused",
			"a clock with a child",
			"a reference stamped through another reference",
			"a reference stamped by its clock directly",
			"a reference no clock stamps: no child carried",
			"a reference no clock stamps: two clocks",
			"a reference no clock stamps: a cycle",
			"a containment over a selection carries nothing",
			"a containment with a pred term carries nothing"
		] satisfies ReadonlyArray<Reached<InstantsFeature>>,
		check: (_, k: Case<InstantsFeature>) => (c) =>
			Effect.sync(() => {
				const model = modelOf(c)
				const built = theoryResult(instantsSchema(c))
				if (model.kind === "refused") {
					const reason = refused(
						built,
						"InstantRefused",
						`the clock ${model.relation}.at, ${model.rule}`
					).reason
					if (reason._tag === "InstantRefused") {
						assert.deepEqual(
							{ relation: reason.relation, field: reason.field, rule: reason.rule.kind },
							{ relation: model.relation, field: "at", rule: model.rule },
							`the first clock refused, by relation name: ${Formatter.format(c)}`
						)
					}
					k.note(
						model.rule === "childless"
							? "a clock first in its key, refused"
							: "a clock outside its key, refused"
					)
					return
				}
				const theory = succeeded(built, `the theory of ${Formatter.format(c)}`)
				for (const [relation, expected] of model.roles) {
					const role = defined(
						Arr.findFirst([...theory.instants.roles], ([name]) => name === relation).pipe(
							Option.flatMap(([, roles]) => Option.fromUndefinedOr(roles.get("at"))),
							Option.getOrUndefined
						),
						`the role of ${relation}.at`
					)
					const stampOf = (s: ClockStamp | undefined): ModelStamp | undefined =>
						s === undefined
							? undefined
							: { clock: s.clock.relation, child: Arr.map(s.child, (f) => f.name) }
					const got: ModelRole =
						role.kind === "clock"
							? { kind: role.kind, stamp: defined(stampOf(role.stamp), "a clock's stamp") }
							: { kind: role.kind, carriers: role.laws.length, stamp: stampOf(role.stamp) }
					assert.deepEqual(got, expected, `${relation}.at's role in ${Formatter.format(c)}`)
					if (expected.kind === "clock") {
						k.note("a clock with a child")
					} else if (expected.stamp !== undefined) {
						k.note(
							expected.stamp.clock === "P" && relation === "X" && c.x === "q"
								? "a reference stamped through another reference"
								: "a reference stamped by its clock directly"
						)
					} else if (c.p === "x" && relation !== "Q") {
						k.note("a reference no clock stamps: a cycle")
					} else if (relation === "Q" && c.q === "unchilded") {
						k.note("a reference no clock stamps: no child carried")
					} else if (relation === "X" && c.x === "both") {
						k.note("a reference no clock stamps: two clocks")
					}
				}
				if (c.q === "selected") {
					k.note("a containment over a selection carries nothing")
				}
				if (c.q === "gapless") {
					k.note("a containment with a pred term carries nothing")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the classifier's rule stated again over the case's shape (instants.fixtures.ts modelOf)"
		},
		box: "P, Q and X over (c, at), P keyed (c, at), (at, c) or (c), Q (c, at, v) or (c, v); Q's containment into P whole, selected, of at alone, Q's own gapless law over pred(v) or none; X's into Q, P, both or none; P's into X or none",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original: "\t\t\td.from.selection.conjuncts.length > 0 ||\n",
				replacement: "\t\t\tfalse ||\n",
				why: "A containment over a selection of its source carries its instants, so an arm's mirrors' way back would make a parent's clock a reference: Q's selected containment makes Q.at a reference the model holds a clock, and the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original: "\t\t\tconst child = r.primaryFields.slice(0, at)\n",
				replacement: "\t\t\tconst child = r.primaryFields.slice(0, at + 1)\n",
				why: "A clock's child holds the clock itself, so P's clock keyed (c, at) holds the child (c, at), not (c), and the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original: "\t\t\tif (at < 0 || !isNonEmpty(child)) {\n",
				replacement: "\t\t\tif (at < 0) {\n",
				why: "A clock first in its primary key is admitted, ordering its whole relation as one child, so P keyed (at, c) compiles where the model refuses it, and the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original: '\t\t\td.from.terms.some((t) => t.kind === "pred")\n',
				replacement: "\t\t\tfalse\n",
				why: "A containment with a pred term carries every row's instant, though it holds only where its field is above zero, so a gapless law makes its relation's clock a reference to itself, which no clock stamps: Q's gapless law makes Q.at a reference the model holds a clock, and the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original:
					"\t\t\tfirst !== undefined && rest.every((s) => s !== undefined && sameClockStamp(s, first))\n",
				replacement: "\t\t\tfirst !== undefined\n",
				why: "A reference is stamped by its first containment's clock whatever its others reach, so X carried into a clock Q and into P is stamped by Q's where the model stamps it by none, and the property fails."
			}
		]
	})
