import {
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	uniqueArray,
	weighted
} from "@grizzle/testing/gen"
import { bigint } from "@grizzle/testing/values"
import { Option } from "effect"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { type FieldDesc, pgScalarNames } from "#compiler/ir/desc.ts"
import {
	numericMaxFractionDigits,
	numericMaxIntegerDigits,
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import { exactType } from "#compiler/scalar/compute/types.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import { numericValue } from "#compiler/scalar/registry.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { textDesc } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { dictionaryNameGen } from "#test/support/kernel/dict.ts"

/**
 * Declared types on the choice stream: every kind a field descriptor has (ir/desc.ts FieldDesc), each drawn within the
 * bounds its kind declares, and the computed types no declaration states, a computed numeric and an exact type. Each is
 * built by the registry's own constructors (scalarOf, numericValue, exactType), so a drawn type is one the schema
 * compiler or the checker gives a field or a term.
 */

/** The rosters a declared type's closed ids and sets read: the closed relation's name and its handles in code order. */
type Rosters = Readonly<Record<string, NonEmptyReadonlyArray<string>>>

/** A declared type as its declaration states it: its descriptor, and the rosters it names. */
type DeclaredSketch = Readonly<{ desc: FieldDesc; rosters: Rosters }>

const noRosters: Rosters = {}

/** A declared name, as the identifier dictionary admits one. */
const nameGen: Gen<string> = map(dictionaryNameGen, (n) => n.declared)

/** A roster of one to five handles, each a distinct declared name, under a declared name of its own. */
const rosterGen: Gen<Readonly<{ name: string; handles: NonEmptyReadonlyArray<string> }>> = (
	source
) => ({
	name: source.draw(nameGen),
	handles: nonEmpty(
		source.draw(uniqueArray(nameGen, (n) => n, { min: 1, max: 5 }, 8)),
		"a roster's handles"
	)
})

/** A value from the small end of a range first, then from the whole range. */
const smallFirst = (small: Gen<number>, whole: Gen<number>): Gen<number> =>
	weighted([
		[3, small],
		[1, whole]
	])

/**
 * A text refinement: a bounded run of letters from `a` to a drawn letter, a bounded run of any code point, or the
 * unbounded wildcard, under the flags each states.
 */
const textGen: Gen<FieldDesc> = oneOf<FieldDesc>([
	(source) => {
		const last = source.draw(codePoint(0x61, 0x7a))
		const lo = source.draw(int(0, 3))
		return textDesc(`^[a-${last}]{${lo},${lo + source.draw(int(0, 4))}}$`, "u")
	},
	map(int(0, 4), (hi) => textDesc(`^.{0,${hi}}$`, "su")),
	map(boolean, (dotAll) => textDesc("^.*$", dotAll ? "su" : "u"))
])

/** A span's endpoint: integer or bigint, or a contract over one. */
const endpointGen: Gen<FieldDesc> = (source) => {
	const base: FieldDesc = { kind: "pg", type: source.draw(boolean) ? "bigint" : "integer" }
	return source.draw(boolean)
		? base
		: { kind: "contract", name: source.draw(nameGen), base, predicate: undefined, facts: [] }
}

/** A declared type of no contract and no set: the kinds a contract's base may be. */
const contractBaseGen: Gen<DeclaredSketch> = oneOf<DeclaredSketch>([
	map(element(pgScalarNames), (type) => ({ desc: { kind: "pg", type }, rosters: noRosters })),
	(source) => ({
		desc: {
			kind: "numeric",
			precision: source.draw(smallFirst(int(1, 12), int(1, numericMaxPrecision.value))),
			scale: source.draw(smallFirst(int(0, 4), int(numericMinScale.value, numericMaxScale.value)))
		},
		rosters: noRosters
	}),
	constant<DeclaredSketch>({ desc: { kind: "uuid" }, rosters: noRosters }),
	map(textGen, (desc) => ({ desc, rosters: noRosters })),
	map(rosterGen, (roster) => ({
		desc: { kind: "closedId", roster: roster.name },
		rosters: { [roster.name]: roster.handles }
	})),
	(source) => ({
		desc: {
			kind: "span",
			endpoint: source.draw(endpointGen),
			width: Option.getOrUndefined(source.draw(option(bigint(1n, 86_400n))))
		},
		rosters: noRosters
	}),
	map(smallFirst(int(1, 4), int(1, vectorMaxDimensions.value)), (dimensions) => ({
		desc: { kind: "vector", dimensions },
		rosters: noRosters
	}))
])

/**
 * A declared type of every kind: a base, a set over a roster, a contract over a base (natural, the builtin contract,
 * among them).
 */
const declaredGen: Gen<DeclaredSketch> = weighted<DeclaredSketch>([
	[6, contractBaseGen],
	[
		1,
		map(rosterGen, (roster) => ({
			desc: { kind: "bits", roster: roster.name },
			rosters: { [roster.name]: roster.handles }
		}))
	],
	[
		2,
		(source) => {
			const base = source.draw(contractBaseGen)
			return {
				desc: {
					kind: "contract",
					name: source.draw(nameGen),
					base: base.desc,
					predicate: undefined,
					facts: []
				},
				rosters: base.rosters
			}
		}
	],
	[1, constant<DeclaredSketch>({ desc: naturalDescriptor.desc, rosters: noRosters })]
])

/** The type a declared sketch states, as the registry builds it. */
const declaredType = (sketch: DeclaredSketch): ScalarType => scalarOf(sketch.desc, sketch.rosters)

/** A computed numeric's bound, within the computed bounds, or an exact type's digits. */
const computedGen: Gen<ScalarType> = oneOf<ScalarType>([
	(source) =>
		numericValue({
			digits: source.draw(
				smallFirst(int(0, 12), int(-numericMaxFractionDigits.value, numericMaxIntegerDigits.value))
			),
			scale: source.draw(smallFirst(int(0, 4), int(0, numericMaxFractionDigits.value)))
		}),
	(source) =>
		exactType(
			source.draw(boolean) ? "exactInteger" : "exactMoney",
			source.draw(smallFirst(int(0, 20), int(0, numericMaxIntegerDigits.value)))
		)
])

/** A scalar type: a declared one, or a computed one no declaration states. */
export const scalarTypeGen: Gen<ScalarType> = weighted([
	[5, map(declaredGen, declaredType)],
	[1, computedGen]
])
