/**
 * A variant over a subset of its roster (schema/variant.ts readArms, scalar/registry.ts variantAt and variantTagType):
 * the subset is the handles its arms name, every handle or some, and its tag is a closed id of that subset, as
 * closedId(roster, { only }) holds one.
 *
 * The box, exhausted over a four-handle roster: every ordered list of distinct handles, of none to all four, written as
 * the arms record's keys in that order, and each such list with a handle off the roster written at every place in it,
 * which only a JavaScript caller writes. The oracle is the subset as the arms name it, read here apart from the engine:
 * the listed handles in the roster's order. A record of no arm, and one naming a handle off the roster, is refused by
 * the rule; every other is admitted, its Description and its type holding its arms in the roster's order whatever order
 * they were listed in, its type crossing the IR's decoder as itself, and its tag typed as a closed id of the subset, of
 * no subset where its arms name every handle. Its Description or its type with two arms out of the roster's order is
 * malformed, refused at each boundary that reads one.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { onlyOf } from "#compiler/ir/scalar.ts"
import { typedTermOf } from "#compiler/scalar/compute/term.ts"
import { describeField, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import {
	handles,
	type Listing,
	listings,
	namedBy,
	variantOf
} from "#test/unit/scalar/variant-subset.fixtures.ts"

type Feature =
	| "every handle"
	| "a subset"
	| "listed out of the roster's order"
	| "no arm refused"
	| "a handle off the roster refused"

const loc = SourceLoc("variant subset", [])

/** A variant's arms are the subset of its roster they name, held in its order, and its tag is a closed id of them. */
export const aVariantsArmsAreTheSubsetOfItsRosterTheyName = property.exhaust(finite(listings), {
	box: "every ordered list of distinct handles of four, none to all, as an arms record's keys, and each with a handle off the roster at every place in it",
	needs: {},
	situations: [
		"every handle",
		"a subset",
		"listed out of the roster's order",
		"no arm refused",
		"a handle off the roster refused"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, c: Case<Feature>) => (l: Listing) =>
		Effect.sync(() => {
			if (l.door === "foreign") {
				c.note("a handle off the roster refused")
				throwsRefused(
					() => variantOf(l.listed),
					"Refused",
					"an arm named by a handle off the roster is refused by the rule"
				)
				return
			}
			const named = namedBy(l.listed)
			if (named.length === 0) {
				c.note("no arm refused")
				throwsRefused(
					() => variantOf(l.listed),
					"Refused",
					"a variant of no arm is refused by the rule"
				)
				return
			}
			c.note(named.length === handles.length ? "every handle" : "a subset")
			if (Arr.some(l.listed, (handle, i) => handle !== named[i])) {
				c.note("listed out of the roster's order")
			}
			const V = variantOf(l.listed)
			const described = succeeded(describeField(V, loc), "the variant is a field descriptor")
			const { desc, scalar } = described
			if (desc.kind !== "variant" || scalar.carrier !== "variant") {
				return assert.fail("a variant's descriptor is described as a variant")
			}
			assert.deepEqual<ReadonlyArray<string>>(
				Arr.map(desc.arms, (arm) => arm.handle),
				named,
				"the Description holds the arms the record names, in the roster's order"
			)
			assert.deepEqual<ReadonlyArray<string>>(
				Arr.map(scalar.variant.arms, (arm) => arm.handle),
				named,
				"and so does its type"
			)
			assert.deepEqual(
				succeeded(decodeScalarType(scalar), "the type crosses the IR's decoder"),
				scalar,
				"as itself"
			)
			const first = defined(named[0], "an arm")
			const tag = defined(
				typedTermOf(V.tag(V.make(first, { value: 1 }))),
				"a variant's tag is a typed term"
			)
			assert.deepEqual<ReadonlyArray<string> | undefined>(
				onlyOf(tag.type),
				named.length === handles.length ? undefined : named,
				"the tag is a closed id of the subset the arms name, of no subset where they name every handle"
			)
			if (named.length < 2) {
				return
			}
			const reversed = Arr.reverse(desc.arms)
			const roster = scalar.variant.roster
			refused(
				scalarTypeOf(
					{ ...desc, arms: reversed },
					{ kind: "builder", roster: (name) => (name === roster.closed ? roster : undefined) },
					loc
				),
				"MalformedDescription",
				"a Description of two arms out of the roster's order is malformed"
			)
			refused(
				decodeScalarType({
					...scalar,
					variant: { ...scalar.variant, arms: Arr.reverse(scalar.variant.arms) }
				}),
				"MalformedDescription",
				"a type of two arms out of the roster's order is malformed"
			)
		}),
	oracle: {
		kind: "specification",
		name: "the subset as the arms name it: the listed handles, in the roster's order"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/schema/variant.ts",
			original: "\t\t\tif (keys.some((key) => !handles.includes(key))) {\n",
			replacement: "\t\t\tif (false) {\n",
			why: "An arm named by a handle off the roster is admitted and dropped, where the variant is refused by the rule."
		},
		{
			file: "packages/engine/src/schema/variant.ts",
			original: "\t\t\tfor (const handle of handles.filter((h) => keys.includes(h))) {\n",
			replacement: "\t\t\tfor (const handle of keys) {\n",
			why: "The arms are held in the order the record lists them, not the roster's: a variant listed out of order is a Description its own type refuses, so two spellings of one variant are not one."
		},
		{
			file: "packages/engine/src/scalar/registry.ts",
			original:
				'\t\t\truleRefused(loc, "a variant holds at least one arm, each named by a handle of its roster")\n\t\t)\n\t}\n\tconst unchecked',
			replacement:
				'\t\t\tmalformedDescription(loc, "a variant of at least one arm")\n\t\t)\n\t}\n\tconst unchecked',
			why: "A variant of no arm is a malformed description, not the rule's refusal its type states."
		},
		{
			file: "packages/engine/src/scalar/registry.ts",
			original:
				"\t\t!inRosterOrder(\n\t\t\troster.value,\n\t\t\tdesc.arms.map((arm) => arm.handle)\n\t\t)\n\t) {\n",
			replacement: "\t\tfalse\n\t) {\n",
			why: "A Description of arms out of the roster's order is typed as it stands: one variant has two Descriptions, and its layout's arms their codes' order apart from its own."
		},
		{
			file: "packages/engine/src/ir/scalar-shape.ts",
			original:
				"\t\tinRosterOrder(\n\t\t\tv.roster,\n\t\t\tv.arms.map((arm) => arm.handle)\n\t\t) &&\n",
			replacement: "\t\ttrue &&\n",
			why: "The IR's decoder admits a variant's type of arms out of the roster's order, which no compile makes."
		},
		{
			file: "packages/engine/src/scalar/registry.ts",
			original: "\t\tonly: variantOnly(variant)\n",
			replacement: "\t\tonly: undefined\n",
			why: "A variant's tag is typed as a closed id of every handle of its roster, the handles no arm names among them."
		},
		{
			file: "packages/engine/src/ir/scalar.ts",
			original: "\tvariant.arms.length === variant.roster.handles.length\n\t\t? undefined\n",
			replacement: "\tfalse\n\t\t? undefined\n",
			why: "A variant of every handle's tag is typed by a subset of all of them, a second spelling of the whole roster's closed id."
		}
	]
})
