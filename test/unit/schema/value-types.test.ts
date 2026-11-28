/**
 * A value type is a descriptor, and every admission of one takes the same first step (schema/relation.ts refuseWritten):
 * a field a field builder made, drawn or accumulated, is no value type, refused by the admission's own
 * reason before its value is described, where the description would refuse it as no descriptor. The box: each such
 * field at each admission that reads a value type, beside the context's (test/unit/schema/worlds.test.ts): an
 * accumulated field's type, a generated field's type, a closed relation's field and a heading's field (rows, which a
 * declared function's signature reads too).
 *
 * Oracle: each admission's documented reason, a specification.
 *
 * Features: every admission at every written field.
 */
import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { accumulated, drawn, natural, int8 } from "#compiler/public/fields.ts"
import { rows } from "#compiler/public/schema.ts"
import { admitClosedRelation, generatedField } from "#compiler/schema/relation.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { throwsRefused } from "#test/support/assert.ts"

/** The fields a field builder makes that are no value type, each by its builder. */
const writtenFields = {
	"drawn(natural)": () => drawn(natural),
	"accumulated(int8, 0n)": () => accumulated(int8, 0n)
} as const satisfies Readonly<Record<string, () => FieldBase>>

type Written = keyof typeof writtenFields

/** Each admission of a value type: how it is called with a value, and the reason it refuses a written field by. */
const admissions = {
	"an accumulated field's type": {
		admit: (value: FieldBase) => accumulated(value, 0n),
		tag: "Refused",
		reason:
			"an accumulated field is of a value type: no range, vector or field of a writing of its own"
	},
	"a generated field's type": {
		admit: (value: FieldBase) => generatedField(value, 0n, []),
		tag: "MalformedDescription",
		reason: "a value type, which no field of a writing of its own is"
	},
	"a closed relation's field": {
		admit: (value: FieldBase) => admitClosedRelation("Held", { f: value }, ["f"], [], []),
		tag: "MalformedDescription",
		reason: "fields its declaration's rows hold; f is written by grizzle"
	},
	"a heading's field": {
		admit: (value: FieldBase) => rows({ f: value }),
		tag: "MalformedDescription",
		reason: "a value type, which no field of a writing of its own is"
	}
} as const

type Admission = keyof typeof admissions

type ValueTypeFeature = `${Admission} at ${Written}`

/** Every admission at every written field. */
const cases = nonEmpty(
	Arr.flatMap(Rec.keys(admissions), (admission) =>
		Arr.map(Rec.keys(writtenFields), (written) => [admission, written] as const)
	),
	"the box's cases"
)

/** The text a refusal states its reason in: a rule's refusal, or a malformed description's rule. */
const reasonText = (reason: { readonly _tag: string }): string | undefined =>
	"refusal" in reason && typeof reason.refusal === "string"
		? reason.refusal
		: "what" in reason && typeof reason.what === "string"
			? reason.what
			: undefined

/** Every admission of a value type refuses a field a field builder made, by its own reason, before describing it. */
export const everyAdmissionOfAValueTypeRefusesAFieldAFieldBuilderMadeByItsOwnReasonBeforeDescribingIt =
	property.exhaust(
		finite((source) => source.draw(element(cases))),
		{
			box: "each written field (drawn, accumulated) at each admission that reads a value type",
			needs: {},
			situations: Arr.map(
				cases,
				([admission, written]): ValueTypeFeature => `${admission} at ${written}`
			) satisfies ReadonlyArray<Reached<ValueTypeFeature>>,
			check: (_, c: Case<ValueTypeFeature>) => (drawnCase) =>
				Effect.sync(() => {
					const [admission, written] = drawnCase
					const { admit, tag, reason } = admissions[admission]
					const e = throwsRefused(() => admit(writtenFields[written]()), tag)
					assert.equal(
						reasonText(e.reason),
						reason,
						`${admission} refuses ${written} by its own reason`
					)
					c.note(`${admission} at ${written}`)
				}),
			oracle: {
				kind: "specification",
				name: "each admission's documented reason for a field of a writing of its own"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/relation.ts",
					original:
						'\tif (entry?.kind === "written" || entry?.kind === "instant" || entry?.kind === "generated") {',
					replacement: "\tif (false) {",
					why: "No admission takes the first step: every written field is refused as no descriptor, by no admission's reason."
				},
				{
					file: "packages/engine/src/schema/relation.ts",
					original: '\t\tbuilderRefusal("accumulated", valueType)',
					replacement: '\t\tmalformed("accumulated", valueType)',
					why: "An accumulated field's written type refused as a malformed description, not by the rule the types name."
				},
				{
					file: "packages/engine/src/schema/relation.ts",
					original:
						'\t\tmalformed("generated", "a value type, which no field of a writing of its own is")',
					replacement: '\t\tmalformed("generated", "a value type")',
					why: "A generated field's written type refused by another reason."
				},
				{
					file: "packages/engine/src/schema/relation.ts",
					original: "is written by grizzle`)",
					replacement: "is written`)",
					why: "A closed relation's written field refused by another reason."
				},
				{
					file: "packages/engine/src/schema/function.ts",
					original:
						'\t\tmalformed(label, "a value type, which no field of a writing of its own is")',
					replacement: '\t\tmalformed(label, "a value type")',
					why: "A heading's written field refused by another reason."
				}
			]
		}
	)
