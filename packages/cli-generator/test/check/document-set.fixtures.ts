/**
 * What the properties of document-set.test.ts read: an entry document whose operation repeats a parameter or whose
 * discriminator's branch names its property, the repeated parameter or the branch sitting in the entry document or in a
 * second document of the set, and what the specification finds of each.
 */

import { word } from "@bjornpagen/testing/dictionary"
import { element, finite, type FiniteSpace, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, String as Str } from "effect"
import { checkSpecText } from "#check/index.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import type { Json } from "#model/pointer.ts"
import { resolve } from "#resolve/index.ts"
import { type Site, sites } from "#test/check/document-set.dictionary.ts"

const siteGen: Gen<Site> = word(sites)

const entry = fixedDocumentUri("file:///spec/openapi.json")

const second = fixedDocumentUri("file:///spec/common.json")

/** The reference to a component of either document, from the entry document. */
const referenceTo = (site: Site, pointer: string): string => {
	switch (site) {
		case "entry":
			return `#${pointer}`
		case "second":
			return `common.json#${pointer}`
	}
}

/** A component one document of the set holds: its group under `components`, its name, and its value. */
type Held = Readonly<{ group: string; name: string; value: Json }>

/** The entry document's own components, by group and name. */
type Components = Readonly<Record<string, Readonly<Record<string, Json>>>>

/** The components a document holds: its own, and the held one when it is the document `site` names. */
const componentsOf = (own: Components, held: Held, holds: boolean): Components =>
	holds ? { ...own, [held.group]: { ...own[held.group], [held.name]: held.value } } : own

/**
 * The codes the check finds in a document set of two: the entry document with its paths and components, the held
 * component in the document `site` names, as `code pointer`.
 */
const findings = (
	site: Site,
	paths: Json,
	own: Components,
	held: Held
): Effect.Effect<ReadonlyArray<string>> =>
	resolve({
		document: entry,
		line: "3.1",
		members: [
			{ document: second, value: { components: componentsOf({}, held, site === "second") } }
		],
		value: {
			components: componentsOf(own, held, site === "entry"),
			info: { title: "t", version: "1" },
			openapi: "3.1.2",
			paths
		}
	}).pipe(
		Effect.flatMap(checkSpecText),
		Effect.map((diagnostics) =>
			Arr.map(diagnostics, (diagnostic) => `${diagnostic.code} ${diagnostic.pointer}`)
		),
		Effect.orDie
	)

/** A parameter's identity: its location and its name. */
export type Identity = Readonly<{ in: "query" | "header"; name: string }>

const identityGen: Gen<Identity> = (source) => ({
	in: source.draw(element(["query", "header"])),
	name: source.draw(element(["limit", "Limit"]))
})

/** One parameter case: an operation's own parameter, and a referenced one held where `site` says. */
export type ParameterCase = Readonly<{ site: Site; own: Identity; referenced: Identity }>

/** The parameter box: either site, and each identity of a query or header parameter named `limit` or `Limit`. */
export const parameterSpace: FiniteSpace<ParameterCase> = finite((source) => ({
	site: source.draw(siteGen),
	own: source.draw(identityGen),
	referenced: source.draw(identityGen)
}))

export type ParameterFeature =
	| "a parameter of the second document"
	| "a parameter of the entry document"
	| "a repeated parameter"
	| "a header repeated in another case"
	| "two distinct parameters"

/**
 * OpenAPI 3.1.1 section 4.8.12: an operation's parameters are unique by name and location, and a header's name is
 * case-insensitive (RFC 9110 section 5.1); every other location's name is compared as written.
 */
const repeats = (c: ParameterCase): boolean =>
	c.own.in === c.referenced.in &&
	(c.own.in === "header"
		? Str.toLowerCase(c.own.name) === Str.toLowerCase(c.referenced.name)
		: c.own.name === c.referenced.name)

/** How a case's two parameters compare: distinct, the same as written, or the same header in another case. */
const comparison = (c: ParameterCase): ReadonlyArray<ParameterFeature> => {
	if (!repeats(c)) {
		return ["two distinct parameters"]
	}
	return c.own.name === c.referenced.name
		? ["a repeated parameter"]
		: ["a repeated parameter", "a header repeated in another case"]
}

export const parameterFeatures = (c: ParameterCase): ReadonlyArray<ParameterFeature> => [
	c.site === "second" ? "a parameter of the second document" : "a parameter of the entry document",
	...comparison(c)
]

/** The codes the check finds in the parameter case's document set. */
export const parameterFindings = (c: ParameterCase): Effect.Effect<ReadonlyArray<string>> =>
	findings(
		c.site,
		{
			"/a": {
				get: {
					parameters: [
						{ in: c.own.in, name: c.own.name, schema: { type: "integer" } },
						{ $ref: referenceTo(c.site, "/components/parameters/Limit") }
					],
					responses: { "200": { description: "ok" } }
				}
			}
		},
		{},
		{
			group: "parameters",
			name: "Limit",
			value: { in: c.referenced.in, name: c.referenced.name, schema: {} }
		}
	)

/** The second parameter repeats the first, found at the use site that repeats it, whichever document holds it. */
export const expectedParameterFindings = (c: ParameterCase): ReadonlyArray<string> =>
	repeats(c) ? ["PTH-28/duplicate-parameter /paths/~1a/get/parameters/1"] : []

/** One branch case: the properties a discriminator's branch requires, the branch held where `site` says. */
export type BranchCase = Readonly<{ site: Site; required: ReadonlyArray<string> }>

/** The branch box: either site, and a branch requiring nothing, the discriminator's property, or its other property. */
export const branchSpace: FiniteSpace<BranchCase> = finite((source) => ({
	site: source.draw(siteGen),
	required: source.draw(element<ReadonlyArray<string>>([[], ["kind"], ["name"]]))
}))

export type BranchFeature =
	| "a branch of the second document"
	| "a branch of the entry document"
	| "a branch requiring the property"
	| "a branch not requiring the property"

/** OpenAPI 3.1.1 section 4.8.25: the property a discriminator names must be required by every branch. */
const requiresProperty = (c: BranchCase): boolean => Arr.contains(c.required, "kind")

export const branchFeatures = (c: BranchCase): ReadonlyArray<BranchFeature> => [
	c.site === "second" ? "a branch of the second document" : "a branch of the entry document",
	requiresProperty(c) ? "a branch requiring the property" : "a branch not requiring the property"
]

/** The codes the check finds in the branch case's document set. */
export const branchFindings = (c: BranchCase): Effect.Effect<ReadonlyArray<string>> =>
	findings(
		c.site,
		{},
		{
			schemas: {
				Pet: {
					discriminator: { propertyName: "kind" },
					oneOf: [{ $ref: referenceTo(c.site, "/components/schemas/Cat") }]
				}
			}
		},
		{
			group: "schemas",
			name: "Cat",
			value: {
				properties: { kind: { type: "string" }, name: { type: "string" } },
				required: c.required,
				type: "object"
			}
		}
	)

/** A branch that does not require the property is found at the discriminator, whichever document holds the branch. */
export const expectedBranchFindings = (c: BranchCase): ReadonlyArray<string> =>
	requiresProperty(c)
		? []
		: ["DSC-09/property-not-required /components/schemas/Pet/discriminator/propertyName"]
