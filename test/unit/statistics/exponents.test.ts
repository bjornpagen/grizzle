/**
 * The exponents of a relation's declared statistics (physical/statistics/exponents.ts), a raise from all ones whose work
 * is polynomial in the system's size.
 *
 * Property: over small systems, a free one time in four (one or two anchors, one to four columns, one to six key and
 * apart bounds, each over an anchor or a pair of anchors a dependency ties, most of them crossing) and else one planted
 * under drawn exponents (up to four anchors, ten columns and eighteen bounds), the raise's exponents meet every bound,
 * at the exact least's largest anchor exponent, and the exact search finds exponents for that system; a crossing is a
 * system the exact search finds none for, its named bounds holding none together; an unsettled raise, grizzle's
 * limitation, is noted.
 *
 * Property: over wide systems (planted, up to eight anchors, sixty-four columns and four hundred bounds of at most eight
 * columns each), the raise makes at most (keys + 1) · Σ over the keys of their anchors' sets apart raises, the work the
 * module's doc bounds, and its exponents meet every bound.
 *
 * Oracle: second implementation, e2abf18f2's exact search for the least exponents (exponents.fixtures.ts exactLeast);
 * specification, the module's bound on its raises.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { exponentsOf } from "#compiler/physical/statistics/exponents.ts"
import {
	exactLeast,
	type ExponentsFeature,
	meets,
	systemGen,
	wideSystemGen
} from "#test/unit/statistics/exponents.fixtures.ts"

/** The largest of `exponents`, or 0. */
const largest = (exponents: ReadonlyArray<number>): number =>
	Arr.reduce(exponents, 0, (m, y) => Math.max(m, y))

/**
 * The raise meets every bound at the exact search's largest anchor exponent, and calls crossed only a system the exact
 * search finds no exponents for.
 */
export const theRaiseMeetsEveryBoundAtTheExactLeastsLargestExponentAndCallsCrossedOnlyWhatHoldsNoExponents =
	property.explore(systemGen, {
		needs: {},
		situations: [
			"exponents",
			"a crossing",
			"an anchor above 1",
			"a column above 1",
			"two anchors",
			"a bound over a pair"
		] satisfies ReadonlyArray<Reached<ExponentsFeature>>,
		check: (_, c: Case<ExponentsFeature>) => (system) =>
			Effect.sync(() => {
				if (system.anchors > 1) {
					c.note("two anchors")
				}
				if (Arr.some(system.bounds, (b) => b.over.kind === "pair")) {
					c.note("a bound over a pair")
				}
				const raised = exponentsOf(system)
				const exact = exactLeast(system)
				if (raised.kind === "unsettled") {
					c.note("an unsettled raise")
					return
				}
				if (raised.kind === "crossing") {
					c.note("a crossing")
					if (raised.raises > 0) {
						c.note("a crossing the raise's last round proves")
					}
					assert.equal(exact.kind, "none", "a crossed system holds no exponents")
					assert.equal(
						exactLeast({
							...system,
							bounds: Arr.map(raised.bounds, (i) => defined(system.bounds[i], "a bound"))
						}).kind,
						"none",
						"a crossing's bounds hold no exponents together"
					)
					return
				}
				c.note("exponents")
				if (Arr.some(raised.anchors, (y) => y > 1)) {
					c.note("an anchor above 1")
				}
				if (Arr.some(raised.columns, (x) => x > 1)) {
					c.note("a column above 1")
				}
				assert.ok(
					meets(system, raised.anchors, raised.columns),
					"the raised exponents meet every bound"
				)
				assert.ok(exact.kind === "least", "the exact search finds exponents where the raise does")
				assert.equal(
					largest(raised.anchors),
					largest(exact.anchors),
					"the raise's largest anchor exponent is the exact least's"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "e2abf18f2's exact search for the least exponents (exponents.fixtures.ts exactLeast)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/statistics/exponents.ts",
				original: "\t\t\t\t[...k.columns].every((c) => s.columns.has(c))",
				replacement: "\t\t\t\t[...k.columns].some((c) => s.columns.has(c))",
				why: "A crossing claimed without its proof: a key a set apart over its anchor holds only in part is called crossed, where the exact search finds exponents for the system."
			}
		]
	})

/** On a wide schema's system the raise ends within the raises the module's doc bounds, and its exponents meet every bound. */
export const onAWideSchemasSystemTheRaiseEndsWithinItsBoundedRaisesAndItsExponentsMeetEveryBound =
	property.explore(wideSystemGen, {
		needs: {},
		situations: ["exponents", "a column above 1"] satisfies ReadonlyArray<
			Reached<ExponentsFeature>
		>,
		check: (_, c: Case<ExponentsFeature>) => (system) =>
			Effect.sync(() => {
				const aparts = Array.from(
					{ length: system.anchors },
					(_, a) =>
						Arr.filter(
							system.bounds,
							(b) => b.kind === "apart" && b.over.kind === "anchor" && b.over.at === a
						).length
				)
				const keys = Arr.filter(system.bounds, (b) => b.kind === "key" && b.over.kind === "anchor")
				const perRound = Arr.reduce(keys, 0, (n, b) =>
					b.over.kind === "anchor" ? n + (aparts[b.over.at] ?? 0) : n
				)
				const raised = exponentsOf(system)
				assert.ok(
					raised.raises <= (keys.length + 1) * perRound,
					`the raise makes ${raised.raises} raises, within (keys + 1) · Σ sets apart = ${(keys.length + 1) * perRound}`
				)
				if (raised.kind !== "exponents") {
					return
				}
				c.note("exponents")
				if (Arr.some(raised.columns, (x) => x > 1)) {
					c.note("a column above 1")
				}
				assert.ok(
					meets(system, raised.anchors, raised.columns),
					"the raised exponents meet every bound"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the module's bound on its raises (exponents.ts), and the bounds themselves"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/statistics/exponents.ts",
				original: "\t\treturn top === undefined ? 0 : 1 + sumOf(top.columns, x)",
				replacement: "\t\treturn top === undefined ? 0 : sumOf(top.columns, x)",
				why: "Each anchor's exponent its largest set apart's sum, not one more: that set is priced at one row, where it must bind two or more."
			}
		]
	})
