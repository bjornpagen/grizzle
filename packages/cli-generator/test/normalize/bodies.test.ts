/**
 * Request bodies, as normalizeBody builds their alternatives and the operation assembly reads them (design 2.2, 6.3):
 * each content key in member order is an alternative whose codec follows its media type alone, never its schema; a
 * key that is no media type is dropped (the grammar check reports it), an empty content map leaves nothing to send and
 * is refused; a schema is keyed by its component name or its canonical pointer, an XML body is opaque and carries none;
 * a multipart body without a schema is refused before 3.2, a form-data array and an object on another multipart type
 * are refused at the media type; Encoding Objects on a media type that reads none and a 3.2 media type description are
 * ignored with a notice; a referenced body's diagnostics stand at its use site with the place in its target related;
 * and a refused required body raises its operation.
 *
 * Oracle: design 6.3's alternative rules and codec table, applied to the drawn body.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import {
	actualOf,
	type BodyFeature,
	bodyFeatures,
	bodySpace,
	discriminatorActual,
	discriminatorExpected,
	type DiscriminatorFeature,
	discriminatorFeatures,
	discriminatorSpace,
	expectedOf,
	invalidKeyActual,
	invalidKeyExpected,
	invalidKeySpace,
	sharedActual,
	sharedExpected,
	sharedSpace
} from "#test/normalize/bodies.fixtures.ts"
import { digestService } from "#test/support/digest.ts"

/**
 * A request body's alternatives, findings and operation are what design 6.3 states. Its budget replaces the thirty
 * example cases of the suites' alternative and media-type rules it converts (bodies and media-fixes), twice over.
 */
export const bodyAlternatives = property.explore(bodySpace, {
	needs: {},
	situations: [
		"JSON alternative",
		"text alternative",
		"XML alternative carries no schema",
		"binary alternative",
		"media range",
		"sequential alternative",
		"form alternative",
		"multipart alternative",
		"form-data object body kept",
		"component schema",
		"inline schema",
		"no schema",
		"key that is no media type dropped",
		"empty content refused",
		"multipart without a schema refused",
		"form-data array refused",
		"unnamed multipart parts refused",
		"encoding ignored",
		"3.2 media description ignored",
		"referenced body",
		"required body refused raises its operation",
		"several alternatives"
	] satisfies ReadonlyArray<Reached<BodyFeature>>,
	check: (_, c: Case<BodyFeature>) => (sketch) =>
		Effect.gen(function* () {
			const expected = expectedOf(sketch)
			c.noteAll(bodyFeatures(sketch, expected))
			const actual = yield* actualOf(sketch)
			assert.deepEqual(actual, expected)
		}),
	oracle: {
		kind: "specification",
		name: "design 6.3's alternative rules and codec table, applied to the drawn body"
	},
	kept: [],
	budget: { runs: 60, steered: 256 },
	kills: [
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original: '[line === "3.2" ? "ENC-28" : "ENC-27", "ENC-29"]',
			replacement: '["ENC-29"]',
			why: "A form alternative loses its line's form row (ENC-27, ENC-28 on 3.2) and keeps only ENC-29; the property fails (CATCH's evidence, mutant 06fd155f3a)."
		},
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original: "\tif (node.schema !== undefined && !opaque) {",
			replacement: "\tif (node.schema !== undefined) {",
			why: "An XML alternative carries its schema, so an opaque body reads as schema-driven; the property fails (CATCH's evidence, mutant ca8053deda)."
		},
		{
			file: "packages/cli-generator/src/model/entities.ts",
			original:
				'[\n\t\t\t"binary",\n\t\t\t"form",\n\t\t\t"json",\n\t\t\t"jsonseq",\n\t\t\t"multipart",\n\t\t\t"ndjson",\n\t\t\t"sse",\n\t\t\t"text",\n\t\t\t"xml"\n\t\t]',
			replacement: '["binary", "form", "json", "jsonseq", "multipart", "ndjson", "sse", "xml"]',
			why: "The text codec is no codec a body may carry, so a body with a text alternative cannot be built; the property fails (CATCH's evidence, mutant f3b47c768f)."
		},
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original:
				'schema !== undefined &&\n\t\tbase === "multipart/form-data" &&\n\t\t(yield* isArrayBody(ctx.walk, schema, members))',
			replacement: 'schema !== undefined && base === "multipart/form-data"',
			why: "Every multipart/form-data body with a schema is refused as an array body; the property fails (CATCH's evidence, mutant 965d604df9)."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: "\tfor (let index = items.length - 1; index >= 0; index -= 1) {",
			replacement: "\tfor (let index = items.length - 1; index >= 0; index -= 0) {",
			why: "The resolver's walk never steps past its last item, so resolving a document with a reference does not end within the case deadline; the property fails (CATCH's evidence, mutant 041212ab52)."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original:
				'invalidEscape.test(token)\n\t\t? Result.fail(PointerSyntaxError.make({ pointer: token, reason: "invalid-escape" }))\n\t\t: Result.succeed(JsonPointer.unescapeToken(token))',
			replacement:
				'invalidEscape.test(token) ? Result.succeed(JsonPointer.unescapeToken(token)) : Result.fail(PointerSyntaxError.make({ pointer: token, reason: "invalid-escape" }))',
			why: "A pointer token is refused exactly when its escapes are valid, so no pointer into the document reads; the property fails (CATCH's evidence, mutant ec2c5d7c2a)."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: "Schema.String.pipe(Schema.check(Schema.isPattern(regExp)))",
			replacement: "Schema.String",
			why: "A brand built on a pattern checks none, so a content key that is no media type becomes an alternative; the property fails (CATCH's evidence, mutant 679dac1427)."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original: '!Str.startsWith("#")(fragment)',
			replacement: 'Str.startsWith("#")(fragment)',
			why: "A `$ref` fragment is read as no pointer exactly when it is one, so a schema reference to a component is never followed; the property fails (CATCH's evidence, mutant 40bb5e087c)."
		},
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original: "\t\t(member) => member !== undefined",
			replacement: "\t\t(member) => member === undefined",
			why: "A media type that reads no Encoding Object is noticed for encoding fields it does not have; the property fails (CATCH's evidence, mutant 40bc671419)."
		}
	]
})

/**
 * The discriminator hint of a JSON body (design D-OQ9; DSC-01, 07, 09, 11): over oneOf or anyOf branches, each branch in
 * composition order labeled by the mapping keys that target it, else by its component's name, an inline branch
 * unlabeled; over an allOf base, the entry components whose allOf references it, in key order; none when check refused
 * the discriminator (a branch that does not require the property, DSC-09) or there is none. Its budget replaces the four
 * example cases of the suite it converts, three times over.
 */
export const discriminatorHint = property.explore(discriminatorSpace, {
	needs: {},
	situations: [
		"branches labeled by mapping keys",
		"branch labeled by its component name",
		"inline branch unlabeled",
		"anyOf branches",
		"refused discriminator gives no hint",
		"allOf base lists its children",
		"no discriminator"
	] satisfies ReadonlyArray<Reached<DiscriminatorFeature>>,
	check: (_, c: Case<DiscriminatorFeature>) => (sketch) =>
		Effect.gen(function* () {
			const expected = discriminatorExpected(sketch)
			c.noteAll(discriminatorFeatures(sketch, expected))
			const actual = yield* discriminatorActual(sketch)
			assert.deepEqual(actual, expected)
		}),
	oracle: {
		kind: "specification",
		name: "design D-OQ9's discriminator hint, applied to the drawn body"
	},
	kept: [],
	budget: { runs: 12, steered: 128 },
	kills: [
		{
			file: "packages/cli-generator/src/check/structure.ts",
			original: "other.use !== item.use",
			replacement: "true",
			why: "Every pair of a grammar check's items reads as two uses of one site, so a discriminator's findings are reported where none is and its hint is withheld; the property fails (CATCH's evidence, mutant c892821416)."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original: '!Str.startsWith("#")(fragment)',
			replacement: 'Str.startsWith("#")(fragment)',
			why: "A `$ref` fragment is read as no pointer exactly when it is one, so a branch's reference to its component is never followed; the property fails (CATCH's evidence, mutant 40bb5e087c)."
		}
	]
})

/**
 * allOf members many parents share are expanded once and a schema listing itself terminates: a multipart body over a
 * diamond of up to 64 levels, each an allOf of up to 8 references to the next (8 ** 64 nodes unfolded, 65 in the
 * graph), or a schema whose allOf lists itself, finds its one part within the case deadline. Its budget replaces the
 * three example cases of the suite it converts, twice over.
 */
export const sharedAllOf = property.explore(sharedSpace, {
	needs: {},
	situations: [],
	check: () => (sketch) =>
		Effect.gen(function* () {
			const actual = yield* sharedActual(sketch)
			assert.deepEqual<ReadonlyArray<string>>(actual, sharedExpected(sketch))
		}),
	oracle: { kind: "specification", name: "the one part the shared schema declares" },
	kept: [],
	budget: { runs: 6, steered: 0 },
	kills: [
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original: '!Str.startsWith("#")(fragment)',
			replacement: 'Str.startsWith("#")(fragment)',
			why: "A `$ref` fragment is read as no pointer exactly when it is one, so no shared allOf member is reached and the leaf part is never found; the property fails (CATCH's evidence, mutant 40bb5e087c)."
		}
	]
})

/**
 * A content key that is no media type is reported once, by the grammar check, however many stages read the body
 * (MED-24): a generation of documents holding such keys reports exactly one refusal per key. Its budget replaces the one
 * example case of the suite it converts, on two drawn documents.
 */
export const invalidMediaKeyOnce = property.explore(invalidKeySpace, {
	needs: { scratch: Scratch.dir, digest: digestService },
	situations: [],
	check: (resources) => (sketch) =>
		Effect.gen(function* () {
			const scratch = yield* resources.scratch
			const digest = yield* resources.digest
			const actual = yield* invalidKeyActual(scratch, digest, sketch)
			assert.equal(actual, invalidKeyExpected(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "one MED-24 refusal per content key that is no media type"
	},
	kept: [],
	budget: { runs: 2, steered: 0 },
	kills: [
		{
			file: "packages/cli-generator/src/generate.ts",
			original: "\t\tif (diagnosis.refusals.length > 0) {",
			replacement: "\t\tif (diagnosis.refusals.length <= 0) {",
			why: "Generation refuses a document exactly when validation finds nothing to refuse, so a document whose only fault is an invalid content key is refused by validation instead and its MED-24 count is lost; the property fails (CATCH's evidence, mutant cadc46d05f)."
		}
	]
})
