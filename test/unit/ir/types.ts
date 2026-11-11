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
import { dictionaryNameGen, dictionaryNameGenOtherThan } from "#test/support/kernel/dict.ts"

/**
 * Declared types on the choice stream: every kind a field descriptor has (ir/desc.ts FieldDesc), each drawn within the
 * bounds its kind declares, and the computed types no declaration states, a computed numeric and an exact type. Each is
 * built by the registry's own constructors (scalarOf, numericValue, exactType), so a drawn type is one the schema
 * compiler or the checker gives a field or a term. Every descriptor declaredGen draws is one a field declares: a bare
 * `{ kind: "pg", type: "date" }` among them, which is the date field's own descriptor (scalar/date.ts dateDescriptor).
 */

/** The rosters a declared type's closed ids and sets read: the closed relation's name and its handles in code order. */
export type Rosters = Readonly<Record<string, NonEmptyReadonlyArray<string>>>

/** A declared type as its declaration states it: its descriptor, and the rosters it names. */
export type DeclaredSketch = Readonly<{ desc: FieldDesc; rosters: Rosters }>

const noRosters: Rosters = {}

/** A declared name, as the identifier dictionary admits one. */
const nameGen: Gen<string> = map(dictionaryNameGen, (n) => n.declared)

/**
 * A roster of one to five handles under a declared name of its own, each handle a declared name drawn from those the
 * handles before it left, so they are distinct by construction.
 */
const rosterGen: Gen<Readonly<{ name: string; handles: NonEmptyReadonlyArray<string> }>> = (
	source
) => {
	const count = source.draw(int(1, 5))
	const handles: Array<string> = []
	for (let at = 0; at < count; at += 1) {
		handles.push(source.draw(dictionaryNameGenOtherThan(new Set(handles))).declared)
	}
	return { name: source.draw(nameGen), handles: nonEmpty(handles, "a roster's handles") }
}

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
export const textGen: Gen<FieldDesc> = oneOf<FieldDesc>([
	(source) => {
		const last = source.draw(codePoint(0x61, 0x7a))
		const lo = source.draw(int(0, 3))
		return textDesc(`^[a-${last}]{${lo},${lo + source.draw(int(0, 4))}}$`, "u")
	},
	map(int(0, 4), (hi) => textDesc(`^.{0,${hi}}$`, "su")),
	map(boolean, (dotAll) => textDesc("^.*$", dotAll ? "su" : "u"))
])

/** numeric(p, s), its precision and scale anywhere PostgreSQL admits them, small ones first. */
export const numericGen: Gen<FieldDesc> = (source) => ({
	kind: "numeric",
	precision: source.draw(smallFirst(int(1, 12), int(1, numericMaxPrecision.value))),
	scale: source.draw(smallFirst(int(0, 4), int(numericMinScale.value, numericMaxScale.value)))
})

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
	map(numericGen, (desc) => ({ desc, rosters: noRosters })),
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
export const declaredGen: Gen<DeclaredSketch> = weighted<DeclaredSketch>([
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

/** A declared type, as the registry builds a field's: the types a field, and so a fold's plane, can have. */
export const declaredTypeGen: Gen<ScalarType> = map(declaredGen, (sketch) =>
	scalarOf(sketch.desc, sketch.rosters)
)

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
	[5, declaredTypeGen],
	[1, computedGen]
])
