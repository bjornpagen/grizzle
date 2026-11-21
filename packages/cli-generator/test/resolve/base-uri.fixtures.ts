/**
 * What the properties of base-uri.test.ts read: the retrieval URIs, `$self` and `$id` members and enclosing bases the
 * base searches cross, the references the fragment search splits, and what each specification gives them: a base read
 * from WHATWG URL's own parse and resolution with its fragment cleared by URL's own setter, where the generator splits
 * its href at the first `#`, and a fragment from the reference's text split at every `#`.
 */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import { word } from "@bjornpagen/testing/dictionary"
import {
	array,
	constant,
	element,
	finite,
	type FiniteSpace,
	type Gen,
	map,
	oneOf
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Result, String as Str } from "effect"
import { Url } from "effect/http"
import type { SpecLine } from "#model/spec-section.ts"
import { specLines } from "#test/model/spec-section.dictionary.ts"

/** A member read for a base URI: absent, or holding a text. */
export type Member = Readonly<{ kind: "absent" }> | Readonly<{ kind: "text"; text: string }>

/** Every line the generator reads: the specification's own list. */
const lineGen: Gen<SpecLine> = word(specLines)

const memberGen = (texts: ReadonlyArray<string> & Readonly<{ 0: string }>): Gen<Member> =>
	oneOf<Member>([
		constant({ kind: "absent" }),
		map(element(texts), (text) => ({ kind: "text", text }))
	])

/** The object a member sits in, under its key. */
const holding = (key: string, member: Member): Json => {
	switch (member.kind) {
		case "absent":
			return {}
		case "text":
			return { [key]: member.text }
	}
}

/** A URL as the resource it names: its href with the fragment and its `#` cleared by URL's own setter. */
const resourceOf = (url: URL): string => Url.setHash(url, "").href

/** A reference resolved against a base as WHATWG URL resolves it, as the resource it names; none where URL refuses. */
const resolvedResource = (reference: string, base: string): Option.Option<string> =>
	Option.map(Result.getSuccess(Url.fromString(reference, base)), resourceOf)

/**
 * A retrieval URI as the resource a document is retrieved as: URL's normal form, fragment cleared; a text URL refuses
 * is kept as written, up to its first `#`, which RFC 3986 section 3.5 makes the fragment's start.
 */
const retrievedResource = (retrieval: string): string =>
	Option.getOrElse(Option.map(Result.getSuccess(Url.fromString(retrieval)), resourceOf), () =>
		Arr.headNonEmpty(Str.split("#")(retrieval))
	)

/** One document base case: a line, the URI a document is retrieved from, and its root's `$self`. */
export type DocumentCase = Readonly<{ line: SpecLine; retrieval: string; self: Member }>

/**
 * The document box: every line; a retrieval URI with a fragment, one with dot segments, a URN no relative reference
 * resolves against, and a text that is no URI; and an absent `$self`, an absolute one with a fragment, and relative
 * ones with and without a fragment.
 */
export const documentSpace: FiniteSpace<DocumentCase> = finite((source) => ({
	line: source.draw(lineGen),
	retrieval: source.draw(
		element([
			"file:///spec/openapi.json#/info",
			"file:///spec/./a/../openapi.json",
			"urn:example:spec",
			"not a uri#frag"
		])
	),
	self: source.draw(
		memberGen(["https://example.com/api/root.json#top", "nested/root.json", "../up/root.json#x"])
	)
}))

export type DocumentFeature =
	| "a 3.0 or 3.1 document holding $self"
	| "a 3.2 document holding $self"
	| "a document with no $self"
	| "a $self that resolves"
	| "a $self that does not resolve"
	| "a retrieval URI with a fragment"
	| "a retrieval URI out of normal form"

export const documentRoot = (c: DocumentCase): Json => holding("$self", c.self)

/**
 * The base a document's non-schema objects resolve against: OpenAPI 3.2.0 section 4.1.2.2 (Establishing the Base
 * URI), a 3.2 document's `$self` resolved against the URI it was retrieved from, its fragment dropped, and none where it
 * does not resolve; else, and on 3.0 and 3.1, which have no `$self`, the retrieval URI as a resource.
 */
export const expectedDocumentBase = (c: DocumentCase): Option.Option<string> => {
	const retrieved = retrievedResource(c.retrieval)
	switch (c.self.kind) {
		case "absent":
			return Option.some(retrieved)
		case "text":
			return c.line === "3.2" ? resolvedResource(c.self.text, retrieved) : Option.some(retrieved)
	}
}

/** What a document's `$self` reaches: none, ignored on a line with no `$self`, or read and resolved or not. */
const selfFeatures = (c: DocumentCase): ReadonlyArray<DocumentFeature> => {
	switch (c.self.kind) {
		case "absent":
			return ["a document with no $self"]
		case "text":
			if (c.line !== "3.2") {
				return ["a 3.0 or 3.1 document holding $self"]
			}
			return [
				"a 3.2 document holding $self",
				Option.isSome(expectedDocumentBase(c))
					? "a $self that resolves"
					: "a $self that does not resolve"
			]
	}
}

export const documentFeatures = (c: DocumentCase): ReadonlyArray<DocumentFeature> => [
	...selfFeatures(c),
	...(Str.includes("#")(c.retrieval) ? (["a retrieval URI with a fragment"] as const) : []),
	...(Str.includes("/./")(c.retrieval) ? (["a retrieval URI out of normal form"] as const) : [])
]

/** One schema base case: a line, the base enclosing a Schema Object, and the schema's `$id`. */
export type SchemaCase = Readonly<{ line: SpecLine; enclosing: string; id: Member }>

/**
 * The schema box: every line; an enclosing file URI and a URN no relative reference resolves against; and an absent
 * `$id`, an absolute one, and a relative one with a fragment.
 */
export const schemaSpace: FiniteSpace<SchemaCase> = finite((source) => ({
	line: source.draw(lineGen),
	enclosing: source.draw(element(["file:///spec/openapi.json", "urn:example:spec"])),
	id: source.draw(memberGen(["https://example.com/s.json", "schemas/pet.json#x"]))
}))

export type SchemaFeature =
	| "a 3.0 schema holding $id"
	| "a 3.1 or 3.2 schema holding $id"
	| "a schema with no $id"
	| "an $id that resolves"
	| "an $id that does not resolve"

export const schemaOf = (c: SchemaCase): Json => holding("$id", c.id)

/**
 * The base inside a Schema Object: JSON Schema 2020-12 section 8.2.1, which 3.1 and 3.2 take, a schema's `$id`
 * resolved against the enclosing base, its fragment dropped, and none where it does not resolve; else, and on 3.0,
 * whose Schema Object has no `$id`, the enclosing base.
 */
export const expectedSchemaBase = (c: SchemaCase): Option.Option<string> => {
	switch (c.id.kind) {
		case "absent":
			return Option.some(c.enclosing)
		case "text":
			return c.line === "3.0" ? Option.some(c.enclosing) : resolvedResource(c.id.text, c.enclosing)
	}
}

export const schemaFeatures = (c: SchemaCase): ReadonlyArray<SchemaFeature> => {
	switch (c.id.kind) {
		case "absent":
			return ["a schema with no $id"]
		case "text":
			return c.line === "3.0"
				? ["a 3.0 schema holding $id"]
				: [
						"a 3.1 or 3.2 schema holding $id",
						Option.isSome(expectedSchemaBase(c))
							? "an $id that resolves"
							: "an $id that does not resolve"
					]
	}
}

/** A URI reference, as RFC 3986 splits it at its first `#`: what comes before, and the fragment, if a `#` starts one. */
export type Split = readonly [resource: string, fragment: Option.Option<string>]

/**
 * The fragment box: every text of up to three pieces of `a`, `/b` and `#`, the empty text among them, so a reference
 * with no `#`, one with a `#` first, last, or twice, and an empty fragment are each in it.
 */
export const referenceSpace: FiniteSpace<string> = finite(
	map(array(element(["a", "/b", "#"]), { min: 0, max: 3 }), (pieces) => Arr.join(pieces, ""))
)

export type FragmentFeature =
	| "no fragment"
	| "an empty fragment"
	| "a fragment holding #"
	| "a fragment with no resource before it"

/** RFC 3986 section 3.5: the fragment is everything after the first `#`, a later `#` its own; none without a `#`. */
export const expectedSplit = (reference: string): Split => {
	const [resource, ...rest] = Str.split("#")(reference)
	return [
		resource,
		Arr.isReadonlyArrayNonEmpty(rest) ? Option.some(Arr.join(rest, "#")) : Option.none()
	]
}

export const fragmentFeatures = (reference: string): ReadonlyArray<FragmentFeature> => {
	const [resource, fragment] = expectedSplit(reference)
	return Option.match(fragment, {
		onNone: () => ["no fragment"],
		onSome: (text) => [
			...(Str.isEmpty(text) ? (["an empty fragment"] as const) : []),
			...(Str.includes("#")(text) ? (["a fragment holding #"] as const) : []),
			...(Str.isEmpty(resource) ? (["a fragment with no resource before it"] as const) : [])
		]
	})
}
