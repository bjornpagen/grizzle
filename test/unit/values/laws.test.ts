/**
 * The value carriers' laws, Numeric, Money and Vector together.
 *
 * - Equality: equals, compare, the identity text and the parts of each carrier agree with the value they hold, and
 *   equal values have one identity text. Oracle: a second implementation per carrier, a Numeric's exact rational by
 *   cross multiplication, a Money's count, a Vector's components one by one.
 * - Frozen: every value a constructor returns, the carriers, scalar types of every text check and the public field
 *   descriptors, is frozen, and so is every object it reaches. Oracle: universal, Object.isFrozen over the reachable
 *   objects.
 * - Revival: a written payload revives to the value that writes it, and a near miss of it revives, if at all, to a
 *   value writing exactly the near miss. Oracle: universal, fromCanonical ∘ write = id and write ∘ fromCanonical = id.
 *
 * Features: each carrier's equal and unequal pairs, two vectors apart in their last component alone, each constructor,
 * and each tag written, refused as a near miss, and refused with a leading zero.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import {
	apartInTheLastAlone,
	constructedSpace,
	type Constructor,
	type EqualityFeature,
	offeredSpace,
	pairSpace,
	reached,
	type RevivalFeature,
	rewritten
} from "#test/unit/values/laws.fixtures.ts"

/** The value carriers' laws equality is value identity, every implementation agrees, and equal values have one identity text. Its budget is its suite's before it was a property (test/unit/values/laws.test.ts at 4ca3036a): 2000 runs and 2000 steered cases. */
export const theValueCarriersLawsEqualityIsValueIdentityEveryImplementationAgreesAndEqualValuesHaveOneIdentityText =
	property.explore(pairSpace, {
		needs: {},
		budget: { runs: 2000, steered: 2000 },
		situations: [
			"decimal equal",
			"decimal unequal",
			"money equal",
			"money unequal",
			"vector equal",
			"vector unequal",
			"vector unequal in its last component alone"
		] satisfies ReadonlyArray<Reached<EqualityFeature>>,
		check: (_, c: Case<EqualityFeature>) => (j) =>
			Effect.sync(() => {
				c.note(`${j.carrier} ${j.oracle ? "equal" : "unequal"}`)
				if (j.carrier === "vector" && apartInTheLastAlone(j.components)) {
					c.note("vector unequal in its last component alone")
				}
				for (const [side, verdict] of j.sides) {
					assert.equal(
						verdict,
						j.oracle,
						`${j.carrier}: ${side} says ${verdict}, the value oracle ${j.oracle}`
					)
				}
				if (j.oracle) {
					assert.equal(
						j.identities[0],
						j.identities[1],
						`${j.carrier}: equal values have different identity texts`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "a Numeric's exact rational by cross multiplication, a Money's count, a Vector's components"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/vector.ts",
				original: "\tfor (const x of a.subarray(0, b.length)) {",
				replacement: "\tfor (const x of a.subarray(0, b.length - 1)) {",
				why: "Vector order skips its last component; the equality property fails."
			}
		]
	})

/** The value carriers' laws every value a constructor returns is frozen, and so is every object it reaches. Its budget is its suite's before it was a property (test/unit/values/laws.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const theValueCarriersLawsEveryValueAConstructorReturnsIsFrozenAndSoIsEveryObjectItReaches =
	property.explore(constructedSpace, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"Numeric.fromString",
			"Money.fromCanonical",
			"makeSpan",
			"Vector.canonical",
			"scalarTypeOf",
			"scalarTypeOf, a finite check",
			"scalarTypeOf, a bounded regex check",
			"scalarTypeOf, a regex check of no bound",
			"scalarTypeOf, a byte bound beside a check",
			"scalarTypeOf, a byte bound alone",
			"scalarTypeOf, every text",
			"a public field descriptor",
			"str.regex"
		] satisfies ReadonlyArray<Reached<Constructor>>,
		check: (_, c: Case<Constructor>) => (made) =>
			Effect.sync(() => {
				c.note(made.by)
				for (const object of reached(made.value)) {
					if (!ArrayBuffer.isView(object)) {
						assert.equal(
							Object.isFrozen(object),
							true,
							`${made.by} returns an object reaching an unfrozen one`
						)
					}
				}
			}),
		oracle: {
			kind: "universal",
			name: "Object.isFrozen over every object a constructed value reaches"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/money.ts",
				original: "\t\tObject.freeze(this)\n",
				replacement: "",
				why: "A Money is left unfrozen; the frozen property fails."
			}
		]
	})

/** The value carriers' laws a written payload revives to its value, and only a written payload revives. Its budget is its suite's before it was a property (test/unit/values/laws.test.ts at 4ca3036a): 3000 runs and 3000 steered cases. */
export const theValueCarriersLawsAWrittenPayloadRevivesToItsValueAndOnlyAWrittenPayloadRevives =
	property.explore(offeredSpace, {
		needs: {},
		budget: { runs: 3000, steered: 3000 },
		situations: [
			"d written",
			"d near miss refused",
			"m written",
			"m near miss refused",
			"v written",
			"v near miss refused",
			"d refused, a leading zero",
			"m refused, a leading zero",
			"v refused, a leading zero"
		] satisfies ReadonlyArray<Reached<RevivalFeature>>,
		check: (_, c: Case<RevivalFeature>) => (o) =>
			Effect.sync(() => {
				const back = rewritten(o.tag, o.payload)
				if (o.written) {
					c.note(`${o.tag} written`)
					assert.ok(back.ok, `the written ${o.tag} payload ${o.payload} is refused`)
					assert.equal(back.value, o.payload)
					return
				}
				if (back.ok) {
					assert.equal(
						back.value,
						o.payload,
						`~${o.tag}:${o.payload} revives to a value writing ${back.value}`
					)
				} else {
					c.note(`${o.tag} near miss refused`)
					for (const miss of Option.toArray(o.miss)) {
						c.note(`${o.tag} refused, ${miss}`)
					}
				}
			}),
		oracle: {
			kind: "universal",
			name: "fromCanonical ∘ write = id, and write ∘ fromCanonical = id"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/money.ts",
				original: "\t\t(text.charCodeAt(start) !== 0x30 || text.length === 1)\n",
				replacement: "\t\ttrue\n",
				why: "Money's canonical-integer check is dropped, so a payload with a leading zero revives; the revival property fails."
			}
		]
	})
