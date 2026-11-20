/**
 * The base URIs a document set resolves its references against (resolve/base-uri.ts, model/uri.ts): over every line, a
 * document's non-schema objects resolve against its retrieval URI in normal form, or on 3.2 against its `$self`
 * resolved there; a Schema Object's base is its `$id` resolved against the enclosing base on 3.1 and 3.2, the
 * enclosing base on 3.0; and a reference's fragment starts at its first `#`. Each base drops its fragment, and a member
 * that does not resolve gives none.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { splitFragment, stripFragment } from "#model/uri.ts"
import { documentBase, schemaBase } from "#resolve/base-uri.ts"
import {
	type DocumentFeature,
	documentFeatures,
	documentRoot,
	documentSpace,
	expectedDocumentBase,
	expectedSchemaBase,
	expectedSplit,
	type FragmentFeature,
	fragmentFeatures,
	referenceSpace,
	type SchemaFeature,
	schemaFeatures,
	schemaOf,
	schemaSpace,
	type Split
} from "#test/resolve/base-uri.fixtures.ts"

/** A document's base is the one its line's specification gives it, over the whole document box. */
export const documentBases = property.exhaust(documentSpace, {
	box: "every line; a retrieval URI with a fragment, one with dot segments, a URN and a text that is no URI; no $self, an absolute $self with a fragment, and relative ones with and without one",
	needs: {},
	situations: [
		"a 3.0 or 3.1 document holding $self",
		"a 3.2 document holding $self",
		"a document with no $self",
		"a $self that resolves",
		"a $self that does not resolve",
		"a retrieval URI with a fragment",
		"a retrieval URI out of normal form"
	] satisfies ReadonlyArray<Reached<DocumentFeature>>,
	check: (_, k: Case<DocumentFeature>) => (c) =>
		Effect.sync(() => {
			k.noteAll(documentFeatures(c))
			assert.deepEqual(documentBase(c.line, c.retrieval, documentRoot(c)), expectedDocumentBase(c))
		}),
	oracle: {
		kind: "specification",
		name: "OpenAPI 3.2.0 section 4.1.2.2: a 3.2 document's $self resolved against its retrieval URI, else the retrieval URI, each as a resource by WHATWG URL"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/resolve/base-uri.ts",
			original: 'line === "3.2" ? stringMember(root, "$self") : undefined',
			replacement: 'stringMember(root, "$self")',
			why: "A 3.0 or 3.1 document's $self is read as its base, a member neither line has; the property fails."
		},
		{
			file: "packages/generator/src/resolve/base-uri.ts",
			original: "Option.map(resolveUri(self, normalized), stripFragment)",
			replacement: "resolveUri(self, normalized)",
			why: "A $self keeps its fragment, so the base names no resource; the property fails."
		},
		{
			file: "packages/generator/src/model/uri.ts",
			original: "Option.getOrElse(resolveUri(retrieval, retrieval), () => retrieval)",
			replacement: "retrieval",
			why: "A retrieval URI is taken as written, its dot segments kept, so one document is two resources; the property fails."
		}
	]
})

/** A Schema Object's base is the one its line's specification gives it, over the whole schema box. */
export const schemaBases = property.exhaust(schemaSpace, {
	box: "every line; an enclosing file URI and a URN; no $id, an absolute $id, and a relative one with a fragment",
	needs: {},
	situations: [
		"a 3.0 schema holding $id",
		"a 3.1 or 3.2 schema holding $id",
		"a schema with no $id",
		"an $id that resolves",
		"an $id that does not resolve"
	] satisfies ReadonlyArray<Reached<SchemaFeature>>,
	check: (_, k: Case<SchemaFeature>) => (c) =>
		Effect.sync(() => {
			k.noteAll(schemaFeatures(c))
			assert.deepEqual(schemaBase(c.line, c.enclosing, schemaOf(c)), expectedSchemaBase(c))
		}),
	oracle: {
		kind: "specification",
		name: "JSON Schema 2020-12 section 8.2.1 on 3.1 and 3.2: a schema's $id resolved against the enclosing base by WHATWG URL; 3.0's Schema Object has no $id"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/resolve/base-uri.ts",
			original: 'line === "3.0" ? undefined : stringMember(schema, "$id")',
			replacement: 'stringMember(schema, "$id")',
			why: "A 3.0 schema's $id is read as its base, a keyword 3.0's Schema Object does not have; the property fails."
		},
		{
			file: "packages/generator/src/resolve/base-uri.ts",
			original: "Option.map(resolveUri(id, enclosing), stripFragment)",
			replacement: "resolveUri(id, enclosing)",
			why: "An $id keeps its fragment, so the schema's base names no resource; the property fails."
		}
	]
})

/** A reference splits at its first `#`, and stripping its fragment keeps what comes before, over every short text. */
export const fragments = property.exhaust(referenceSpace, {
	box: "every text of up to three pieces of `a`, `/b` and `#`",
	needs: {},
	situations: [
		"no fragment",
		"an empty fragment",
		"a fragment holding #",
		"a fragment with no resource before it"
	] satisfies ReadonlyArray<Reached<FragmentFeature>>,
	check: (_, k: Case<FragmentFeature>) => (reference) =>
		Effect.sync(() => {
			k.noteAll(fragmentFeatures(reference))
			const expected = expectedSplit(reference)
			assert.deepEqual<Split>(splitFragment(reference), expected)
			assert.equal(stripFragment(reference), expected[0])
		}),
	oracle: {
		kind: "specification",
		name: "RFC 3986 section 3.5: a fragment is everything after a reference's first #"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/model/uri.ts",
			original: 'Str.indexOf("#")(uri)',
			replacement: 'Str.lastIndexOf("#")(uri)',
			why: "A reference splits at its last #, so a fragment holding # loses its head to the resource; the property fails."
		},
		{
			file: "packages/generator/src/model/uri.ts",
			original: "Str.slice(hash + 1)(uri)",
			replacement: "Str.slice(hash)(uri)",
			why: "A fragment keeps the # that starts it; the property fails."
		}
	]
})
