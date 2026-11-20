/**
 * The elements the generator reads and counts but never sends (design 2.4), as collectInformational records them: info,
 * contact and license; external documentation; tags; webhooks, callbacks, links and examples; specification
 * extensions (the reserved `x-oai-` and `x-oas-` prefixes on their own row). Each is one record at its use site, a
 * declared but empty informative map is one record at the map, an informational element and a Reference Object are
 * recorded and never walked, a key that only looks like an extension in a map of names is none, and the walk's order
 * is fixed: info, extensions, external docs, tags, servers, webhooks, paths (each path item's methods in name order),
 * components. Every record points at a node of the document.
 *
 * Oracle: design 2.4's accounting, applied to the drawn document as it is built.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	documentOf,
	type InformationalFeature,
	informationalFeatures,
	informationalSpace
} from "#test/normalize/informational.fixtures.ts"

/**
 * Every informational element of a document is accounted for once, in the walk's order, at a node of the document. Its
 * budget replaces the eighteen example cases of the suite it converts, twice over.
 */
export const informationalAccounting = property.explore(informationalSpace, {
	needs: {},
	situations: [
		"info parts",
		"root extensions",
		"reserved extension prefix",
		"tag with external docs",
		"server extension",
		"webhooks",
		"empty webhooks map",
		"operation callback",
		"empty informative map",
		"parameter examples",
		"media type examples",
		"response links",
		"link by reference",
		"header examples",
		"component callbacks, examples and links",
		"post operation",
		"put operation",
		"name that looks like an extension",
		"nothing but info"
	] satisfies ReadonlyArray<Reached<InformationalFeature>>,
	check: (_, c: Case<InformationalFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(informationalFeatures(sketch))
			const [, expected] = documentOf(sketch)
			const actual = yield* actualOf(sketch)
			assert.deepEqual(actual, { records: expected, dangling: [] })
		}),
	oracle: {
		kind: "specification",
		name: "design 2.4's accounting of informational elements, in the walk's fixed order"
	},
	kept: [],
	budget: { runs: 36, steered: 256 },
	kills: [
		{
			file: "packages/cli-generator/src/normalize/informational.ts",
			original: '["informative", "links", "link"]',
			replacement: '["informative", "link"]',
			why: "A response's links are no longer an edge of the walk, so no link is recorded; the property fails (CATCH's evidence, mutant 1f1d3e1f28)."
		},
		{
			file: "packages/cli-generator/src/model/path-item.ts",
			original:
				'[\n\t"get",\n\t"put",\n\t"post",\n\t"delete",\n\t"options",\n\t"head",\n\t"patch",\n\t"trace"\n]',
			replacement: '["get", "post", "delete", "options", "head", "patch", "trace"]',
			why: "`put` is no longer a method of a path item, so a put operation's informational elements are never recorded; the property fails (CATCH's evidence, mutant 3f830c71d2)."
		},
		{
			file: "packages/cli-generator/src/model/path-item.ts",
			original:
				'[\n\t"get",\n\t"put",\n\t"post",\n\t"delete",\n\t"options",\n\t"head",\n\t"patch",\n\t"trace"\n]',
			replacement: '["get", "put", "delete", "options", "head", "patch", "trace"]',
			why: "`post` is no longer a method of a path item, so a post operation's informational elements are never recorded; the property fails (CATCH's evidence, mutant 28accd0cf9)."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original:
				"if (Arr.isArray<Json>(current)) {\n\t\treturn Result.fromOption(\n\t\t\tarrayIndex.test(token) ? Arr.get(current, Number(token)) : Option.none(),\n\t\t\t() => new PointerIndexOutOfRange({ pointer, token })\n\t\t)\n\t}",
			replacement: "{}",
			why: "A pointer into an array names no node, so a record under a tag, a server or a parameter points at nothing; the property fails (CATCH's evidence, mutant 41318bc6f6)."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: "\treturn { invalidBase: base === undefined, member }",
			replacement: "\treturn { invalidBase: base !== undefined, member }",
			why: "Every document with a base URI is read as having none, so resolution refuses every document; the property fails (CATCH's evidence, mutant 96109f34de)."
		}
	]
})
