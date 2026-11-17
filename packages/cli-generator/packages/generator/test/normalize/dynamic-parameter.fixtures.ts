/** What the property of dynamic-parameter.test.ts reads: its parameter sketches and the outcome each must have. */

import { boolean, constant, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { Effect } from "effect"
import type { Json } from "#model/pointer.ts"
import { normalizeParameter } from "#normalize/parameters.ts"
import { documentAt, openapiOf, resolvedAt } from "#test/support/normalizing.ts"

/** Where a parameter's schema meets a dynamic or recursive keyword, if anywhere. */
type Reach =
	| "nowhere"
	| "$dynamicRef in place"
	| "$recursiveRef in place"
	| "$dynamicRef in a subschema"
	| "a $ref to a $dynamicAnchor holder"
	| "a $ref to a $recursiveAnchor holder"
	| "a $ref chain to a $dynamicAnchor holder"

/** How the parameter carries its schema: in place, or as its one content entry's. */
type Carrier = "schema" | "content"

/** A parameter of the 2020-12 dialect's lines whose schema may reach a dynamic or recursive keyword. */
type DynamicSketch = Readonly<{
	line: "3.1" | "3.2"
	location: "query" | "header" | "path"
	required: boolean
	carrier: Carrier
	reach: Reach
}>

/** What a case reaches. */
export type DynamicFeature =
	| Reach
	| "content-entry schema"
	| "path parameter"
	| "header parameter"
	| "required parameter refused"
	| "optional parameter refused"

const reach: Gen<Reach> = oneOf([
	constant<Reach>("nowhere"),
	constant<Reach>("$dynamicRef in place"),
	constant<Reach>("$recursiveRef in place"),
	constant<Reach>("$dynamicRef in a subschema"),
	constant<Reach>("a $ref to a $dynamicAnchor holder"),
	constant<Reach>("a $ref to a $recursiveAnchor holder"),
	constant<Reach>("a $ref chain to a $dynamicAnchor holder")
])

/** A parameter, every reach drawn on every location and carrier; a path parameter is required. */
export const dynamicSpace: Gen<DynamicSketch> = (source) => {
	const location = oneOf([
		constant<DynamicSketch["location"]>("query"),
		constant<DynamicSketch["location"]>("header"),
		constant<DynamicSketch["location"]>("path")
	])(source)
	const optional = boolean(source)
	return {
		line: oneOf([constant<"3.1">("3.1"), constant<"3.2">("3.2")])(source),
		location,
		required: location === "path" || !optional,
		carrier: oneOf([constant<Carrier>("schema"), constant<Carrier>("content")])(source),
		reach: reach(source)
	}
}

/** The schema a reach writes at the parameter. */
const schemaOf = (value: Reach): Json => {
	switch (value) {
		case "nowhere":
			return { type: "string" }
		case "$dynamicRef in place":
			return { $dynamicRef: "#node" }
		case "$recursiveRef in place":
			return { $recursiveRef: "#" }
		case "$dynamicRef in a subschema":
			return { allOf: [{ type: "string" }, { $dynamicRef: "#node" }] }
		case "a $ref to a $dynamicAnchor holder":
			return { $ref: "#/components/schemas/DynamicHolder" }
		case "a $ref to a $recursiveAnchor holder":
			return { $ref: "#/components/schemas/RecursiveHolder" }
		case "a $ref chain to a $dynamicAnchor holder":
			return { $ref: "#/components/schemas/Hop" }
	}
}

/** The parameter's name: a path parameter's is its template variable's. */
const nameOf = (sketch: DynamicSketch): string => (sketch.location === "path" ? "id" : "q")

/** The Parameter Object a sketch writes. */
const parameterOf = (sketch: DynamicSketch): Json => ({
	in: sketch.location,
	name: nameOf(sketch),
	required: sketch.required,
	...(sketch.carrier === "schema"
		? { schema: schemaOf(sketch.reach) }
		: { content: { "application/json": { schema: schemaOf(sketch.reach) } } })
})

/** The document holding the parameter on its one operation, beside the holders a reference may reach. */
const documentOf = (sketch: DynamicSketch): Json =>
	documentAt(sketch.line, {
		components: {
			schemas: {
				DynamicHolder: { $dynamicAnchor: "node", type: "string" },
				Hop: { $ref: "#/components/schemas/DynamicHolder" },
				RecursiveHolder: { $recursiveAnchor: true, type: "string" }
			}
		},
		paths: {
			"/a/{id}": {
				get: { parameters: [parameterOf(sketch)], responses: { "200": { description: "ok" } } }
			}
		}
	})

/** An outcome: built, ignored, or refused with its required mark and how many diagnostics it raised itself. */
type Outcome =
	| Readonly<{ kind: "Implemented" }>
	| Readonly<{ kind: "Ignored" }>
	| Readonly<{ kind: "Refused"; required: boolean; diagnostics: number }>

/**
 * A parameter whose schema applies a dynamic or recursive keyword, in place, in a subschema or through any chain of
 * references, cannot be checked, so it is refused keeping its required mark (check reports the keyword, so normalize
 * adds no diagnostic); any other is built.
 */
export const expectedOf = (sketch: DynamicSketch): Outcome =>
	sketch.reach === "nowhere"
		? { kind: "Implemented" }
		: { kind: "Refused", required: sketch.required, diagnostics: 0 }

/** The outcome normalizeParameter gives the drawn parameter. */
export const actualOf = (sketch: DynamicSketch) =>
	Effect.gen(function* () {
		const resolution = yield* resolvedAt(sketch.line, documentOf(sketch), [])
		const outcome = yield* normalizeParameter(resolution, {
			openapi: openapiOf[sketch.line],
			pointer: "/paths/~1a~1{id}/get/parameters/0"
		})
		switch (outcome._tag) {
			case "Implemented":
				return { kind: "Implemented" }
			case "Refused":
				return {
					kind: "Refused",
					required: outcome.required,
					diagnostics: outcome.diagnostics.length
				}
			case "Ignored":
				return { kind: "Ignored" }
		}
	})

/** The features a sketch reaches. */
export const dynamicFeatures = (sketch: DynamicSketch): ReadonlyArray<DynamicFeature> => [
	sketch.reach,
	...(sketch.carrier === "content" ? (["content-entry schema"] as const) : []),
	...(sketch.location === "path" ? (["path parameter"] as const) : []),
	...(sketch.location === "header" ? (["header parameter"] as const) : []),
	...(sketch.reach === "nowhere"
		? []
		: sketch.required
			? (["required parameter refused"] as const)
			: (["optional parameter refused"] as const))
]
