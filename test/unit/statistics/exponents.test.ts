/**
 * The exponents of a relation's declared statistics (physical/statistics/exponents.ts), a raise from all ones whose work
 * is polynomial in the system's size.
 *
 * Property: over small systems, a free one time in four (one or two anchors, one to four columns, one to six key and
 * apart bounds, each over an anchor, most of them crossing) and else one planted
 * under drawn exponents (up to four anchors, ten columns and eighteen bounds), each column capped one time in four (a
 * column of few values, its cap 1 to 3), each set apart binding two rows or more three times in four and four or more
 * else (a spanning pair's anchor over a set apart over the pair, declared.ts), the raise's exponents keep every column within its cap and meet every bound
 * but the keys their own indexes carry, each short of its anchor's exponent only where every column of it below its cap
 * lies in a largest set apart over its anchor; where it carries none, they stand at the exact least's largest anchor
 * exponent, and the exact search finds exponents for that system; a crossing is a system the exact search finds none
 * for, its named bounds holding none together; an unsettled raise, grizzle's limitation, is noted.
 *
 * Property: over wide systems (planted, up to eight anchors, sixty-four columns and four hundred bounds of at most eight
 * columns each), the raise makes at most (keys + 1) · Σ over the keys of their anchors' sets apart and their columns
 * raises, the work the module's doc bounds, and its exponents meet every bound but the keys their own indexes carry.
 *
 * Oracle: second implementation, e2abf18f2's exact search for the least exponents (exponents.fixtures.ts exactLeast);
 * specification, the module's bound on its raises.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { constant, finite, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { type ExponentSystem, exponentsOf } from "#compiler/physical/statistics/exponents.ts"
import {
	admits,
	exactLeast,
	type ExponentsFeature,
	instanceSystems,
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
			"a key carried by its index",
			"a column at its cap",
			"a set apart of four rows"
		] satisfies ReadonlyArray<Reached<ExponentsFeature>>,
		check: (_, c: Case<ExponentsFeature>) => (system) =>
			Effect.sync(() => {
				if (system.anchors > 1) {
					c.note("two anchors")
				}
				if (Arr.some(system.bounds, (b) => b.kind === "apart" && b.least > 1)) {
					c.note("a set apart of four rows")
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
				if (Arr.some(raised.columns, (x, col) => x === system.caps[col])) {
					c.note("a column at its cap")
				}
				assert.ok(
					admits(system, raised.anchors, raised.columns, raised.carried),
					"the raised exponents keep every column within its cap and meet every bound but the keys their own indexes carry, each short only where no column its type allows lifts it"
				)
				if (Arr.isReadonlyArrayNonEmpty(raised.carried)) {
					c.note("a key carried by its index")
					return
				}
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
		kept: [
			{
				token: ReplayToken(
					"test/unit/statistics/exponents.test.ts#theRaiseMeetsEveryBoundAtTheExactLeastsLargestExponentAndCallsCrossedOnlyWhatHoldsNoExponents:-:0.0.1.0.0.2.0.1.0.1.1.1.1.0"
				),
				reason:
					"A spanning pair's anchor, bound at four rows or more over a set apart over the pair (declared.ts), beside a key of another column over it: the key must reach the anchor's exponent, its set apart's sum and least, 3, where a raise against two rows stops it at 2 and leaves it short",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/statistics/exponents.ts",
				original: "\t\t\t\t[...k.columns].every((c) => s.columns.has(c))",
				replacement: "\t\t\t\t[...k.columns].some((c) => s.columns.has(c))",
				why: "A crossing claimed without its proof: a key a set apart over its anchor holds only in part is called crossed, where the exact search finds exponents for the system."
			},
			{
				file: "packages/engine/src/physical/statistics/exponents.ts",
				original: '\t\tdefined(caps[c], "a column\'s cap") - defined(x[c], "a column\'s exponent")',
				replacement: '\t\tNumber.POSITIVE_INFINITY - defined(x[c], "a column\'s exponent")',
				why: "Caps ignored: a short key raises a capped column past its cap, a boolean to 4 values, where its own index carries it."
			},
			{
				file: "packages/engine/src/physical/statistics/exponents.ts",
				original:
					"\t\t\t\t\t\ttop === undefined ? 0 : top.least + sumOf(top.columns, x) - sumOf(k.columns, x)",
				replacement:
					"\t\t\t\t\t\ttop === undefined ? 0 : 1 + sumOf(top.columns, x) - sumOf(k.columns, x)",
				why: "A key raised against its largest set apart as if every set apart bound two rows: over a set apart of four rows, a spanning pair's anchor's, the key stops a halving short of its anchor's exponent, and binds two rows where it must bind one."
			},
			{
				file: "packages/engine/src/physical/statistics/exponents.ts",
				original: '\t\t\treturn { kind: "exponents", anchors, columns: x, carried, raises }',
				replacement:
					'\t\t\treturn carried.length > 0 ? { kind: "crossing", bounds: [carried[0] ?? 0], raises } : { kind: "exponents", anchors, columns: x, carried, raises }',
				why: "A key its columns' types cannot bring to one row refused, as e637d8a3d refused Rel0x0's workload asking Bool for 2^2 values: a system whose key its own index carries is called crossed, where the exact search finds exponents for it. Serving's generated workloads no longer reach a carried key since the spanning anchors (rxxwzuxy), so the kill lives here."
			}
		]
	})

/** The raises of `system` the module's doc bounds: (keys + 1) times the sets apart over each key's anchor and its
 * columns, each of which a raise fills to its cap at most once. */
const boundedRaises = (system: ExponentSystem): number => {
	const aparts = Array.from(
		{ length: system.anchors },
		(_, a) => Arr.filter(system.bounds, (b) => b.kind === "apart" && b.anchor === a).length
	)
	const keys = Arr.filter(system.bounds, (b) => b.kind === "key")
	return (
		(keys.length + 1) *
		Arr.reduce(keys, 0, (n, b) => n + (aparts[b.anchor] ?? 0) + new Set(b.columns).size)
	)
}

/**
 * edullm's Instance relation, on whose bounds e2abf18f2's exact search spun at 71bd2dfc5, is raised within its bounded
 * raises to exponents meeting every bound at the least largest exponent.
 */
export const edullmsInstanceIsRaisedWithinItsBoundedRaisesToExponentsMeetingEveryBoundAtTheLeastLargestExponent =
	property.exhaust(finite(oneOf(Arr.map(instanceSystems, (s) => constant(s)))), {
		needs: {},
		situations: [
			"edullm's Instance at a5f2531ed",
			"edullm's Instance at 71bd2dfc5"
		] satisfies ReadonlyArray<Reached<ExponentsFeature>>,
		check: (_, c: Case<ExponentsFeature>) => (kept) =>
			Effect.sync(() => {
				c.note(
					kept.at === "a5f2531ed"
						? "edullm's Instance at a5f2531ed"
						: "edullm's Instance at 71bd2dfc5"
				)
				const raised = exponentsOf(kept.system)
				assert.ok(
					raised.raises <= boundedRaises(kept.system),
					`the raise makes ${raised.raises} raises, within ${boundedRaises(kept.system)}`
				)
				assert.ok(raised.kind === "exponents", "the raise settles Instance's bounds")
				assert.ok(
					meets(kept.system, raised.anchors, raised.columns),
					"the raised exponents meet every bound"
				)
				assert.equal(raised.carried.length, 0, "no key of Instance is carried by its index alone")
				assert.equal(
					largest(raised.anchors),
					kept.least,
					"the raise's largest exponent is the least"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the module's bound on its raises, the bounds themselves, and the least largest exponent e2abf18f2's exact search found (7) or exhausted below (8)"
		},
		box: "edullm's Instance at a5f2531ed and at 71bd2dfc5",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/statistics/exponents.ts",
				original: "\t\teffects.findLast((e) => !e.short && !e.higher)?.c ??",
				replacement: "\t\teffects.findLast((e) => !e.short)?.c ??",
				why: "A raise blind to the largest exponent: a column whose raise lifts it is taken where one that keeps it would do, and Instance is declared at 11 and 12, not its least, 7 and 8."
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
				const raised = exponentsOf(system)
				assert.ok(
					raised.raises <= boundedRaises(system),
					`the raise makes ${raised.raises} raises, within (keys + 1) · Σ (sets apart + columns) = ${boundedRaises(system)}`
				)
				if (raised.kind !== "exponents") {
					return
				}
				c.note("exponents")
				if (Arr.some(raised.columns, (x) => x > 1)) {
					c.note("a column above 1")
				}
				assert.ok(
					admits(system, raised.anchors, raised.columns, raised.carried),
					"the raised exponents keep every column within its cap and meet every bound but the keys their own indexes carry"
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
				original: "\t\treturn top === undefined ? 0 : top.least + sumOf(top.columns, x)",
				replacement: "\t\treturn top === undefined ? 0 : sumOf(top.columns, x)",
				why: "Each anchor's exponent its largest set apart's sum, not its least more: that set is priced at one row, where it must bind two or more."
			}
		]
	})
