/**
 * The closed-id and set codecs (codec/scalar.ts over values/identity.ts and values/convert.ts) under an installation's
 * codes, against a naive positional model.
 *
 * - The model: a roster of five codes, each live or a hole, a live code c held by the handle `h<c>`; a closed id is
 *   written as its code's decimal digits, and a set is stored as eight characters, five codes rounded up to whole hex
 *   digits, the character at position c 1 exactly when the set holds code c's handle, so a hole's and every padding
 *   position's is 0, and written as X and the two hex digits of that text (test/support/closed/bit-text.ts).
 * - Universal oracles: convert ∘ encode is the identity on every value, a cell's one text is the value's written text,
 *   and the order of two closed ids is their codes'.
 * - Named invalid variants, each refused with its fault: a removed handle (a hole's), a handle of another roster, a
 *   value that is no Set, and a Set holding a member that is no string; and a closed id of a subset of the live handles
 *   (closedId(R, { only })) writes each handle of the subset as the whole roster's closed id does and refuses every other
 *   live handle with codeSubset.
 *
 * The box, exhausted: every hole pattern of a five-code roster that leaves a handle live, every subset of its live
 * handles, under every variant the pattern admits.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { patterns, roundTrips, type Variant } from "#test/unit/codec/codes.fixtures.ts"

/** The closed-id and set codecs write a code and a set by the installation's codes, read them back, and refuse every named invalid value. */
export const theClosedIdAndSetCodecsWriteACodeAndASetByTheInstallationsCodesReadThemBackAndRefuseEveryNamedInvalidValue =
	property.exhaust(finite(patterns), {
		needs: {},
		situations: [
			"valid",
			"a removed handle",
			"another roster's handle",
			"no Set",
			"a member that is no string",
			"a hole",
			"a handle outside the subset"
		] satisfies ReadonlyArray<Reached<Variant | "a hole" | "a handle outside the subset">>,
		check: (_, c: Case<Variant | "a hole" | "a handle outside the subset">) => (value) =>
			roundTrips(value, c),
		oracle: {
			kind: "second-implementation",
			name: "a naive positional model of the codes"
		},
		box: "every hole pattern of five codes, every subset of its live handles, every variant",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/convert.ts",
				original:
					'\t\tfor (let code = text.indexOf("1"); code >= 0; code = text.indexOf("1", code + 1)) {',
				replacement:
					'\t\tfor (let code = text.indexOf("1", 1); code >= 0; code = text.indexOf("1", code + 1)) {',
				why: "A set's text is read from its second code on, so code 0's handle is lost; convert after encode is no longer the identity."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original:
					'only === undefined || only.has(handle) ? Result.ok(handle) : Result.err("codeSubset")',
				replacement: 'only === undefined || true ? Result.ok(handle) : Result.err("codeSubset")',
				why: "A closed id of a subset admits every live handle of its roster: a handle outside the subset is written as its code where the codec refuses it."
			}
		]
	})
