/** What the property of header-object.test.ts reads: its header sketches and the marks the Header Object states. */

import { boolean, constant, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import type { Json } from "#model/pointer.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { type HeaderMarks, headerMarks } from "#normalize/header-object.ts"
import { documentAt, entryUri, lineGen, nonBoolean, resolvedAt } from "#test/support/normalizing.ts"

/** A mark as a Header Object writes it: absent, a boolean, or a value of another type. */
type Mark =
	| Readonly<{ kind: "absent" }>
	| Readonly<{ kind: "boolean"; value: boolean }>
	| Readonly<{ kind: "other"; value: Json }>

/**
 * A Header Object under `components/headers`, read at the end of a chain of `hops` references (none: the header
 * itself), with its two marks and whether it carries a schema.
 */
type HeaderSketch = Readonly<{
	line: SpecLine
	hops: 0 | 1 | 2
	required: Mark
	deprecated: Mark
	schema: boolean
}>

/** What a case reaches. */
export type HeaderFeature =
	| "inline header"
	| "header behind one reference"
	| "header behind a chain of references"
	| "a mark that is no boolean"
	| "an absent mark"
	| "a true mark behind a reference"

const mark: Gen<Mark> = oneOf([
	constant<Mark>({ kind: "absent" }),
	(source): Mark => ({ kind: "boolean", value: boolean(source) }),
	(source): Mark => ({ kind: "other", value: nonBoolean(source) })
])

const chainLength: Gen<HeaderSketch["hops"]> = oneOf([constant(0), constant(1), constant(2)])

/** A Header Object, its marks drawn apart. */
export const headerSpace: Gen<HeaderSketch> = (source) => ({
	line: lineGen(source),
	hops: chainLength(source),
	required: mark(source),
	deprecated: mark(source),
	schema: boolean(source)
})

/** The members a mark writes under its name. */
const written = (name: string, value: Mark): Readonly<Record<string, Json>> =>
	value.kind === "absent" ? {} : { [name]: value.value }

/** The references a chain of `hops` writes, each to the one before it and the first to the header. */
const chainOf = (hops: HeaderSketch["hops"]): Readonly<Record<string, Json>> => {
	switch (hops) {
		case 0:
			return {}
		case 1:
			return { Header1: { $ref: "#/components/headers/Header0" } }
		case 2:
			return {
				Header1: { $ref: "#/components/headers/Header0" },
				Header2: { $ref: "#/components/headers/Header1" }
			}
	}
}

/** The document whose `components/headers` holds the header and its chain of references. */
const documentOf = (sketch: HeaderSketch): Json =>
	documentAt(sketch.line, {
		components: {
			headers: {
				Header0: {
					...written("required", sketch.required),
					...written("deprecated", sketch.deprecated),
					...(sketch.schema ? { schema: { type: "string" } } : {})
				},
				...chainOf(sketch.hops)
			}
		},
		paths: {}
	})

/** A mark as the specification reads it: true only when written as the boolean true. */
const markOf = (value: Mark): boolean => value.kind === "boolean" && value.value

/** The marks the header states, wherever its use site's references lead. */
export const expectedOf = (sketch: HeaderSketch): HeaderMarks => ({
	deprecated: markOf(sketch.deprecated),
	required: markOf(sketch.required)
})

/** The marks headerMarks reads at the start of the header's chain. */
export const actualOf = (sketch: HeaderSketch) =>
	Effect.gen(function* () {
		const resolution = yield* resolvedAt(sketch.line, documentOf(sketch), [])
		const document = yield* entryUri
		return yield* headerMarks(resolution, {
			document,
			pointer: `/components/headers/Header${sketch.hops}`
		})
	})

/** The features a sketch reaches. */
export const headerFeatures = (sketch: HeaderSketch): ReadonlyArray<HeaderFeature> => {
	const marks = [sketch.required, sketch.deprecated]
	return [
		...(sketch.hops === 0 ? (["inline header"] as const) : []),
		...(sketch.hops === 1 ? (["header behind one reference"] as const) : []),
		...(sketch.hops === 2 ? (["header behind a chain of references"] as const) : []),
		...(Arr.some(marks, (each) => each.kind === "other")
			? (["a mark that is no boolean"] as const)
			: []),
		...(Arr.some(marks, (each) => each.kind === "absent") ? (["an absent mark"] as const) : []),
		...(sketch.hops > 0 && Arr.some(marks, markOf)
			? (["a true mark behind a reference"] as const)
			: [])
	]
}
