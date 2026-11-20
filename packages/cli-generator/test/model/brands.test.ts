/**
 * The model's brands' narrowing predicates (WireName, HeaderName, CookieName, MediaType, MediaRange, PathTemplate,
 * ServerTemplate, MethodToken, SafeText, DocumentUri, JsonPointer) admit exactly what their grammars admit, decided by recognizers
 * written from RFC 9110, RFC 3986, RFC 6901, OpenAPI's templates and the help-safe text categories over text built from
 * the pieces each grammar turns on: dot and empty path segments, percent-encodings, brace expressions, wildcards,
 * quoted parameters, `CONNECT`, controls, format characters, separators and lone surrogates. No brand admits a number,
 * and SafeText's stripper removes exactly the characters its grammar refuses.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	brandSpace,
	expectedOf,
	type Feature,
	featuresOf
} from "#test/model/brands.fixtures.ts"

/**
 * A brand admits a drawn text exactly when its grammar does. Its budget replaces 18 example cases: 18 independent
 * cases, and up to 56 steered while one of its 28 situations is unreached, each reached by its own aimed arm.
 */
export const brandMembership = property.explore(brandSpace, {
	needs: {},
	situations: [
		"WireName admitted",
		"WireName refused",
		"HeaderName admitted",
		"HeaderName refused",
		"CookieName admitted",
		"CookieName refused",
		"MediaType admitted",
		"MediaType refused",
		"MediaRange admitted",
		"MediaRange refused",
		"PathTemplate admitted",
		"PathTemplate refused",
		"ServerTemplate admitted",
		"ServerTemplate refused",
		"MethodToken admitted",
		"MethodToken refused",
		"SafeText admitted",
		"SafeText refused",
		"DocumentUri admitted",
		"DocumentUri refused",
		"JsonPointer admitted",
		"JsonPointer refused",
		"a template of several segments admitted",
		"a dot segment refused",
		"an interior empty segment refused",
		"CONNECT refused",
		"unsafe text stripped",
		"line breaks and tabs kept through the strip"
	],
	check: (_, k: Case<Feature>) => (c) =>
		Effect.sync(() => {
			k.noteAll(featuresOf(c))
			assert.deepEqual(actualOf(c), expectedOf(c))
		}),
	oracle: {
		kind: "second-implementation",
		name: "a recognizer per brand written from its grammar, and the text grammar's own removal"
	},
	kept: [],
	budget: { runs: 18, steered: 56 },
	kills: [
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: "const unsafeCharacter = regex(`(?![\\\\n\\\\t])[",
			replacement: "const unsafeCharacter = regex(`[",
			why: "stripUnsafeText removes line feeds and tabs with the other controls, so help text loses its line breaks; the property fails (found by lane EOCG-NORMALIZE converting test/normalize/docs.test.ts)."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: "!Str.isEmpty(segment) || index === last",
			replacement: "index === last",
			why: "An empty path segment is admitted anywhere, so a template with an interior empty segment decodes; the property fails (CATCH's evidence, mutant 9737c73c19)."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: 'tokenPattern.test(text) && text !== "CONNECT"',
			replacement: "tokenPattern.test(text)",
			why: "MethodToken admits CONNECT, which asks for a tunnel instead of a response; the property fails (CATCH's evidence, mutant 564f9cca57)."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: '\treturn decoded === "." || decoded === ".."',
			replacement: '\treturn decoded === "." || decoded !== ".."',
			why: "No segment reads as a dot segment, so a template with `.`, `..` or their percent-encodings decodes; the property fails (CATCH's evidence, mutant f6cd9a7b46)."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: "text is WireName => wireNamePattern.test(text)",
			replacement: "text is WireName => true",
			why: "WireName checks no pattern, so a name holding a control decodes; the property fails (CATCH's evidence, mutant 679dac1427, on the predicate)."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: "text is HeaderName => tokenPattern.test(text)",
			replacement: "text is HeaderName => true",
			why: "HeaderName checks no token, so a header name holding a separator decodes; the property fails."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: "text is MediaType => mediaTypePattern.test(text)",
			replacement: "text is MediaType => true",
			why: "MediaType checks no pattern, so a wildcard or a bare token decodes as a media type; the property fails."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: "text is ServerTemplate => serverPattern.test(text)",
			replacement: "text is ServerTemplate => true",
			why: "ServerTemplate checks no pattern, so an unbalanced variable decodes; the property fails."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: "text is SafeText => safeTextPattern.test(text)",
			replacement: "text is SafeText => true",
			why: "SafeText checks no category, so a control or a lone surrogate reaches help text; the property fails."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: "text is DocumentUri => uriPattern.test(text)",
			replacement: "text is DocumentUri => true",
			why: "DocumentUri checks no pattern, so a relative or non-ASCII reference decodes as an absolute URI; the property fails."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original: "text is JsonPointer => pointerPattern.test(text)",
			replacement: "text is JsonPointer => true",
			why: "JsonPointer checks no pattern, so a text without its leading slash or with a bare `~` decodes; the property fails (CATCH's evidence, mutant 59d8a9970a)."
		}
	]
})
