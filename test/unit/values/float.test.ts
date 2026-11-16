/**
 * The float carriers' values (scalar/values/float.ts): a real is the binary32 value PostgreSQL's float8-to-float4 cast
 * stores, and both float types order as PostgreSQL's float comparison does, one text per value.
 *
 * - Admission: toReal stores a double as the binary32 value nearest it, ties to the even significand, -0 as 0, and
 *   NaN and the infinities as they are; it refuses a finite double the cast rounds to an infinity as realOverflow and a
 *   nonzero one it rounds to zero as realUnderflow.
 * - Order: compareFloat is PostgreSQL's float order, NaN equal to NaN and above every other value, -0 equal to 0, and
 *   otherwise the values' own order; two values compare equal exactly when their identity texts (floatText) are one.
 *
 * Oracles: IEEE 754 binary32 stated apart from the code. A double rounds to an infinity exactly when its magnitude is at
 * least binary32Max plus half its last place, 2^(emax - p + 1) / 2, and to zero exactly when it is nonzero and at most
 * half the least subnormal, 2^(least - 1); a stored value is a binary32 value (Math.fround fixes it) neither of whose
 * binary32 neighbours, stepped by its bit pattern, lies nearer the double. The order's model ranks a double by its
 * IEEE bit pattern read as a sign and a magnitude, -0 as 0, with NaN above it all.
 *
 * Features: a double rounded, one stored exactly, a binary32 subnormal stored, each refusal, -0 stored as 0, a special
 * kept; a NaN against another value, two NaNs, -0 against 0, an infinity, and two distinct finite values.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { compareFloat, floatText } from "#compiler/scalar/values/float.ts"
import { assert } from "#test/support/assert.ts"
import {
	doubleGen,
	modelOrder,
	orderedGen,
	type OrderFeature,
	orderFeatures,
	type RealFeature,
	realVerdict
} from "#test/unit/values/float.fixtures.ts"

/** Real admission stores a double as its nearest binary32 value, ties to even and -0 as 0, and refuses exactly what the cast refuses. */
export const realAdmissionStoresADoubleAsItsNearestBinary32ValueTiesToEvenAnd0As0AndRefusesExactlyWhatTheCastRefuses =
	property.explore(doubleGen, {
		needs: {},
		situations: [
			"rounded",
			"stored exactly",
			"a binary32 subnormal stored",
			"realOverflow",
			"realUnderflow",
			"-0 stored as 0",
			"a special kept"
		] satisfies ReadonlyArray<Reached<RealFeature>>,
		check: (_, c: Case<RealFeature>) => (x) =>
			Effect.sync(() => {
				c.note(realVerdict(x))
			}),
		oracle: {
			kind: "specification",
			name: "binary32's rounding thresholds and nearest neighbours, stated apart from Math.fround's rounding"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original: "\tif (rounded === 0 && x !== 0) {",
				replacement: "\tif (Math.abs(rounded) < 2 ** -126 && x !== 0) {",
				why: "A double that rounds to a binary32 subnormal is refused as realUnderflow; the admission property fails."
			}
		]
	})

/** PostgreSQL's float order is the model's total order, and its equality is the identity text's. */
export const postgreSQLsFloatOrderIsTheModelsTotalOrderAndItsEqualityIsTheIdentityTexts =
	property.explore((source) => [source.draw(orderedGen), source.draw(orderedGen)] as const, {
		needs: {},
		situations: [
			"a NaN against another value",
			"two NaNs",
			"-0 against 0",
			"an infinity",
			"two distinct finite values"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check:
			(_, c: Case<OrderFeature>) =>
			([a, b]) =>
				Effect.sync(() => {
					c.noteAll(orderFeatures(a, b))
					const order = compareFloat(a, b)
					assert.equal(order, modelOrder(a, b), `${a} against ${b}`)
					assert.equal(order === 0, floatText(a) === floatText(b), `${a} and ${b}'s texts`)
				}),
		oracle: {
			kind: "second-implementation",
			name: "a rank by the IEEE bit pattern, -0 as 0, with NaN above it all"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original: "\t\treturn aNaN === bNaN ? 0 : aNaN ? 1 : -1",
				replacement: "\t\treturn aNaN === bNaN ? 0 : aNaN ? -1 : 1",
				why: "compareFloat sorts NaN below every other value; the order property fails."
			}
		]
	})
