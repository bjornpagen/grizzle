/**
 * A roster may hold no handle, the empty domain a registry of nothing is (edullm's QTI composition, whose grader roster
 * is empty since the graders are another installation's): a closed id over it is the empty type and a set over it holds
 * only the empty set, so a relation with a field of it holds no fact.
 *
 * Over drawn rosters of zero to three handles, ordered or not, and a relation holding a closed id of one and a set over
 * it (empty-roster.fixtures.ts):
 *
 * - The schema builds, owns and compiles its installation as `grizzle generate` compiles it: the roster's domain over
 *   its names constant, which holds exactly its handles (none for the empty one), and a set's bits domain one hex digit
 *   wide at least, PostgreSQL's bit(n) holding a bit at least.
 * - A write's value of the closed id is admitted exactly where it is a handle of the roster, so every value is refused
 *   over the empty roster; a set's exactly where each member is one, the empty set always.
 * - The roster's facts, what a read of it delivers, are its handles, none for the empty roster.
 *
 * Oracle: the specification, the roster's handles as drawn.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import {
	compiledCase,
	type Feature,
	rosterCaseGen,
	valueAdmitted
} from "#test/unit/schema/empty-roster.fixtures.ts"

/** A roster of any number of handles, none among them, types its closed ids, its sets, its writes and its reads. */
export const aRosterOfAnyNumberOfHandlesNoneAmongThemTypesItsClosedIdsItsSetsItsWritesAndItsReads =
	property.explore(rosterCaseGen, {
		needs: {},
		situations: [
			"an empty roster",
			"a roster of one handle",
			"a roster of several handles",
			"an unordered roster",
			"a closed id's value admitted",
			"a closed id's value refused",
			"a set's value refused"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (drawn) =>
			Effect.sync(() => {
				c.note(
					drawn.handles.length === 0
						? "an empty roster"
						: drawn.handles.length === 1
							? "a roster of one handle"
							: "a roster of several handles"
				)
				if (drawn.order === "unordered") {
					c.note("an unordered roster")
				}
				const compiled = compiledCase(drawn)
				assert.deepEqual(
					Arr.sort(compiled.names, Order.String),
					Arr.sort(drawn.handles, Order.String),
					"the roster's names constant holds exactly its handles"
				)
				assert.ok(compiled.bitsWidth >= 4, `a set's bits domain of ${compiled.bitsWidth} bits`)
				assert.deepEqual(
					Arr.sort(compiled.facts, Order.String),
					Arr.sort(drawn.handles, Order.String),
					"a read of the roster delivers its handles"
				)
				for (const value of drawn.values) {
					const admitted = valueAdmitted(compiled, "code", value).ok
					assert.equal(
						admitted,
						drawn.handles.includes(value),
						`the closed id's value "${value}" over ${Arr.join(drawn.handles, ", ")}`
					)
					c.note(admitted ? "a closed id's value admitted" : "a closed id's value refused")
				}
				assert.ok(
					valueAdmitted(compiled, "bits", new Set<string>()).ok,
					"the empty set is a set over every roster"
				)
				for (const value of drawn.values) {
					const admitted = valueAdmitted(compiled, "bits", new Set([value])).ok
					assert.equal(
						admitted,
						drawn.handles.includes(value),
						`the set {"${value}"} over ${Arr.join(drawn.handles, ", ")}`
					)
					if (!admitted) {
						c.note("a set's value refused")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the roster's handles as drawn: the values its closed ids and sets hold, and the facts a read of it delivers"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/relation.ts",
				original: "\t\tvalue.length === 0\n\t\t\t? []\n\t\t\t: requireNames(",
				replacement: "\t\tvalue.length === -1\n\t\t\t? []\n\t\t\t: requireNames(",
				why: "A roster of no handle is refused as a malformed declaration, as a nonempty list of names was required, so the empty registry edullm's composition states cannot be written."
			},
			{
				file: "packages/engine/src/ir/codes.ts",
				original: "\t\twidth: wholeDigitBits(Math.max(codes.length, 1)),",
				replacement: "\t\twidth: wholeDigitBits(codes.length),",
				why: "A set over an empty roster is a bit(0), which PostgreSQL refuses (bit lengths start at 1), so the installation of a set over the empty roster could not be created."
			}
		]
	})
