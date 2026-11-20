/**
 * Constructs the generator refuses, notices or emits in a fixed form, each planted into a generated document. A case
 * draws a document and an author config that fits it, and plants one operation (tagged `planted`, so its command is the
 * only one in the `planted` group's modules) holding one construct from a named family; its row, computed from what was
 * drawn (the family's variant, the document's line, the config's scalar switch), says which refusals and notices
 * generation names at the plant's pointers, whether the operation keeps its command, and what the emitted modules hold.
 *
 * The rows: a deepObject over a union that admits a scalar is refused (PRM-27), with its operation when required
 * (OPR-08), unless the scalar switch admits it as one JSON value; a union of objects alone takes JSON. A discriminator
 * with no composition keyword is refused at it (DSC-05); one over allOf, a partial mapping or an inline branch refuses
 * nothing. A multipart part typed as XML over an object is refused at its media type (XML-01), with its operation when
 * required (OPR-09), and never built as a JSON part; an object part sent as JSON is one; an opaque XML body is
 * generated. A 3.0 default outside its type is refused at it (S30-27) and help omits it, where 3.1 and 3.2 keep it. A
 * 3.0 read-only body property is no flag; 3.1 and 3.2 keep it. A password property is a secret-file flag and a password
 * part a secret part flag, each with its description, where a binary part keeps its path flag and an array of
 * passwords has none. A 3.0 byte string and every base64 contentEncoding are base64 files; a 3.1 or 3.2 byte string is
 * a plain string. A number and a safe integer are numeric flags carried as JsonNumber, an int64 its own flag. A
 * requirement naming an undeclared scheme is reported once at the name (SEC-09, SEC-10 on 3.2), and with its operation
 * when no alternative remains (SEC-06). A group whose tag folds to a fixed api module's segment is refused at the tag
 * (TAG-02) and has no command.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import { Digest } from "effect/crypto"
import {
	AIMS,
	brokenEmitted,
	caseGen,
	type Feature,
	generatedAt,
	sortedFacts
} from "#test/emit/constructs.fixtures.ts"
import { digestService } from "#test/support/digest.ts"

/**
 * A planted construct is refused, noticed or emitted exactly as its row says. It replaces 48 example cases (the m2 and
 * m3 fixes of dpany, dsc-fixes, s30-fixes, password-file, fmt-fixes and sec-fixes, and api.test's reserved segment),
 * so its budget is 48 independent cases; every required situation has an aimed arm, so 2 steered cases a situation
 * reach them.
 */
export const constructs = property.explore(aimed(caseGen, AIMS), {
	needs: { dir: Scratch.dir, digest: digestService },
	situations: [
		"a deepObject over an object or a scalar",
		"a deepObject over objects alone",
		"a discriminator with no composition",
		"a discriminator over a composition",
		"a schema-driven XML part",
		"a JSON object part",
		"an opaque XML body",
		"a default outside its type",
		"a read-only body property",
		"a password property",
		"a password or binary part",
		"a byte or base64 property",
		"a numeric property",
		"an undeclared requirement name",
		"a tag folding to a fixed api module",
		"a required deepObject refused with its operation",
		"a deepObject the scalar switch admits",
		"a required XML part refused with its operation",
		"a 3.0 default refused",
		"a nonconforming default kept as an annotation",
		"a 3.0 read-only property left out",
		"a read-only property through a reference",
		"a described password",
		"a binary part",
		"a 3.0 byte property",
		"a base64 contentEncoding",
		"an int64 property",
		"an undeclared name beside a declared one",
		"a 3.2 undeclared name",
		"a tag folding to servers"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check:
		({ dir, digest }, k: Case<Feature>) =>
		(drawnCase) =>
			Effect.gen(function* () {
				const { plant } = drawnCase
				k.note(plant.family)
				k.noteAll(plant.variants)
				const root = yield* dir
				const service = yield* digest
				const generated = yield* Effect.provideService(
					generatedAt(root, drawnCase),
					Digest.Digest,
					service
				)
				assert.deepEqual(
					{
						facts: sortedFacts(generated.facts),
						commanded: generated.commanded,
						broken: plant.commanded ? brokenEmitted(generated.modules, plant.emitted) : []
					},
					{ facts: sortedFacts(plant.facts), commanded: plant.commanded, broken: [] }
				)
			}),
	oracle: {
		kind: "specification",
		name: "each planted construct's row: its refusals and notices at the plant, its command, and the emitted modules' text"
	},
	kept: [],
	budget: { runs: 48, steered: 58 },
	kills: [
		{
			file: "packages/cli-generator/src/emit/printer.ts",
			original: "!reservedWords.has(value)",
			replacement: "reservedWords.has(value)",
			why: "Only a reserved word reads as a binding name (printer.ts isIdentifier), so every command, schema and module name the emitters read through it is refused unprintable and no planted construct generates; the property fails (TESTPOLICY2's census mutant 5179ff1319, which cli-package.test.ts#binRun killed only while printer.ts checked its own literal names as it loaded)."
		},
		{
			file: "packages/cli-generator/src/generate.ts",
			original: "[...planned, ...emitted]",
			replacement: "[...emitted]",
			why: "Generation reports only the emitters' diagnostics and drops the names plan's, so a planted construct's plan refusals go unreported; the property fails (CATCH's evidence, mutant b010c7e5d4)."
		},
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: "\tif (types.length > 0) {",
			replacement: "\tif (types.length > (-1)) {",
			why: "A deepObject's own verdict refuses every parameter as if its union admitted a scalar, so a union of objects alone is refused; the property fails (CATCH's evidence, mutant cea7370574)."
		},
		{
			file: "packages/cli-generator/src/generate.ts",
			original:
				"[\n\t\t\tdomain,\n\t\t\t...apiFiles,\n\t\t\t...cli.files,\n\t\t\t...scaffold,\n\t\t\t{ content: yield* printGenerationReport(report, document), path: reportPath }\n\t\t]",
			replacement:
				"[domain, ...apiFiles, ...scaffold, { content: yield* printGenerationReport(report, document), path: reportPath }]",
			why: "Generation writes no cli module, so a planted operation's flags are never emitted; the property fails (CATCH's evidence, mutant cc03257159)."
		},
		{
			file: "packages/cli-generator/src/generate.ts",
			original:
				"\t\t(operation) => !Arr.some(named, (key) => sameKey(operation, key.method, key.path))",
			replacement:
				"\t\t(operation) => !Arr.every(named, (key) => sameKey(operation, key.method, key.path))",
			why: "Generation drops every operation unless an operation-scope refusal names them all, so a planted operation refused with its operation keeps its command; the property fails (CATCH's evidence, mutant 17eccca995)."
		},
		{
			file: "packages/cli-generator/src/generate.ts",
			original: "[...validated, ...resolution.diagnostics, ...checked, ...outside]",
			replacement: "[...validated, ...resolution.diagnostics, ...outside]",
			why: "Generation drops check's spec-text diagnostics, so an undeclared requirement name or a discriminator check refuses goes unreported; the property fails (CATCH's evidence, mutant fc539bd378)."
		},
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original:
				"\tconst hasStyle = Struct.keys(given).length > 0\n\tconst findings: Finding[] = []",
			replacement:
				"\tconst hasStyle = Struct.keys(given).length > (-1)\n\tconst findings: Finding[] = []",
			why: "Every multipart part is taken to have an Encoding style, so a part's typing from its content type is lost and a schema-driven XML part is not refused; the property fails (CATCH's evidence, mutant 7c01739c69)."
		},
		{
			file: "packages/cli-generator/src/normalize/schemas.ts",
			original:
				'[\n\t[\n\t\t"alias-cycle",\n\t\t{\n\t\t\tanchor: "handling-reference-cycles",\n\t\t\telement: "Schema reference cycle",\n\t\t\tmessage:\n\t\t\t\t"A cycle of schema references returns to a schema without descending into the instance.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t],\n\t[\n\t\t"dependencies",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema dependencies",\n\t\t\tmessage:\n\t\t\t\t"dependencies is not a keyword of the OpenAPI dialect; use dependentRequired or dependentSchemas.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t],\n\t[\n\t\t"dynamic-anchor",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema $dynamicAnchor",\n\t\t\tmessage: "$dynamicAnchor is not supported.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t],\n\t[\n\t\t"dynamic-ref",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema $dynamicRef",\n\t\t\tmessage: "$dynamicRef is not supported.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t],\n\t[\n\t\t"int64-range",\n\t\t{\n\t\t\tanchor: "data-type-format",\n\t\t\telement: "Schema integer range",\n\t\t\tmessage: "int64 range is not asserted client-side.",\n\t\t\tseverity: "notice"\n\t\t}\n\t],\n\t[\n\t\t"non-schema-target",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema $ref target",\n\t\t\tmessage: "The $ref target is the document root or another object that is not a schema.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t],\n\t[\n\t\t"nonconforming-default",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema default",\n\t\t\tmessage: "The default does not conform to the schema type; it is never sent.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t],\n\t[\n\t\t"not-asserted",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema keyword",\n\t\t\tmessage: "The schema is not asserted here client-side; the value is sent unvalidated.",\n\t\t\tseverity: "notice"\n\t\t}\n\t],\n\t[\n\t\t"nullable-no-effect",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema nullable",\n\t\t\tmessage: \'nullable has no effect in OpenAPI 3.1 and later; use type: [..., "null"].\',\n\t\t\tseverity: "notice"\n\t\t}\n\t],\n\t[\n\t\t"outside-type",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema enum member",\n\t\t\tmessage: "An enum member outside the declared type is dropped.",\n\t\t\tseverity: "notice"\n\t\t}\n\t],\n\t[\n\t\t"read-only-required",\n\t\t{\n\t\t\tanchor: "validating-readonly-and-writeonly",\n\t\t\telement: "Schema required",\n\t\t\tmessage:\n\t\t\t\t"A required read-only property is not asserted client-side on a request; the server decides.",\n\t\t\tseverity: "notice"\n\t\t}\n\t],\n\t[\n\t\t"recursive-anchor",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema $recursiveAnchor",\n\t\t\tmessage: "$recursiveAnchor is not supported.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t],\n\t[\n\t\t"recursive-ref",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema $recursiveRef",\n\t\t\tmessage: "$recursiveRef is not supported.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t],\n\t[\n\t\t"vocabulary",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema $vocabulary",\n\t\t\tmessage: "$vocabulary is not supported; schemas must use the OpenAPI dialect.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t],\n\t[\n\t\t"union-not-asserted",\n\t\t{\n\t\t\tanchor: "composition-and-inheritance-polymorphism",\n\t\t\telement: "Schema composition",\n\t\t\tmessage:\n\t\t\t\t"These allOf, anyOf or oneOf alternatives cannot be intersected; the schema is not asserted client-side.",\n\t\t\tseverity: "notice"\n\t\t}\n\t]\n]',
			replacement:
				'[[\n\t\t"alias-cycle",\n\t\t{\n\t\t\tanchor: "handling-reference-cycles",\n\t\t\telement: "Schema reference cycle",\n\t\t\tmessage:\n\t\t\t\t"A cycle of schema references returns to a schema without descending into the instance.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t], [\n\t\t"dependencies",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema dependencies",\n\t\t\tmessage:\n\t\t\t\t"dependencies is not a keyword of the OpenAPI dialect; use dependentRequired or dependentSchemas.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t], [\n\t\t"dynamic-anchor",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema $dynamicAnchor",\n\t\t\tmessage: "$dynamicAnchor is not supported.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t], [\n\t\t"dynamic-ref",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema $dynamicRef",\n\t\t\tmessage: "$dynamicRef is not supported.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t], [\n\t\t"int64-range",\n\t\t{\n\t\t\tanchor: "data-type-format",\n\t\t\telement: "Schema integer range",\n\t\t\tmessage: "int64 range is not asserted client-side.",\n\t\t\tseverity: "notice"\n\t\t}\n\t], [\n\t\t"non-schema-target",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema $ref target",\n\t\t\tmessage: "The $ref target is the document root or another object that is not a schema.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t], [\n\t\t"not-asserted",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema keyword",\n\t\t\tmessage: "The schema is not asserted here client-side; the value is sent unvalidated.",\n\t\t\tseverity: "notice"\n\t\t}\n\t], [\n\t\t"nullable-no-effect",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema nullable",\n\t\t\tmessage: \'nullable has no effect in OpenAPI 3.1 and later; use type: [..., "null"].\',\n\t\t\tseverity: "notice"\n\t\t}\n\t], [\n\t\t"outside-type",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema enum member",\n\t\t\tmessage: "An enum member outside the declared type is dropped.",\n\t\t\tseverity: "notice"\n\t\t}\n\t], [\n\t\t"read-only-required",\n\t\t{\n\t\t\tanchor: "validating-readonly-and-writeonly",\n\t\t\telement: "Schema required",\n\t\t\tmessage:\n\t\t\t\t"A required read-only property is not asserted client-side on a request; the server decides.",\n\t\t\tseverity: "notice"\n\t\t}\n\t], [\n\t\t"recursive-anchor",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema $recursiveAnchor",\n\t\t\tmessage: "$recursiveAnchor is not supported.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t], [\n\t\t"recursive-ref",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema $recursiveRef",\n\t\t\tmessage: "$recursiveRef is not supported.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t], [\n\t\t"vocabulary",\n\t\t{\n\t\t\tanchor: keywordsSection,\n\t\t\telement: "Schema $vocabulary",\n\t\t\tmessage: "$vocabulary is not supported; schemas must use the OpenAPI dialect.",\n\t\t\tseverity: "refusal"\n\t\t}\n\t], [\n\t\t"union-not-asserted",\n\t\t{\n\t\t\tanchor: "composition-and-inheritance-polymorphism",\n\t\t\telement: "Schema composition",\n\t\t\tmessage:\n\t\t\t\t"These allOf, anyOf or oneOf alternatives cannot be intersected; the schema is not asserted client-side.",\n\t\t\tseverity: "notice"\n\t\t}\n\t]]',
			why: "The schema copy's table of removed keywords loses an entry, so a removal is reported under the wrong code or not at all; the property fails (CATCH's evidence, mutant af6dca3506)."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: "\tfor (let index = items.length - 1; index >= 0; index -= 1) {",
			replacement: "\tfor (let index = items.length - 1; index >= 0; index -= 0) {",
			why: "The resolver's ordered push never steps past its last item, so resolving a document with nested members never ends; the property fails (CATCH's evidence, mutant 041212ab52)."
		},
		{
			file: "packages/cli-generator/src/emit/cli.ts",
			original: '\t\tdeprecated: own(json, "deprecated") === true,',
			replacement: '\t\tdeprecated: own(json, "deprecated") !== true,',
			why: "Every body field reads as deprecated, so its help line carries a deprecated mark it does not have; the property fails (CATCH's evidence, mutant d580f26a10)."
		},
		{
			file: "packages/cli-generator/src/normalize/operations.ts",
			original: "Option.getOrElse(item.additionalOperations, Record.empty)",
			replacement: "Option.getOrUndefined(item.additionalOperations)",
			why: "A path item without additionalOperations is read as holding undefined ones, so normalizing a planted path fails; the property fails (CATCH's evidence, mutant cd059841a8)."
		},
		{
			file: "packages/cli-generator/src/names/fold.ts",
			original:
				"export const foldKebab = (input: string): Result.Result<Folded<string>, EmptyFold> => {\n\tconst parts = words(input)\n\tif (parts.length === 0) {\n\t\treturn Result.fail(new EmptyFold({ input }))\n\t}",
			replacement:
				"export const foldKebab = (input: string): Result.Result<Folded<string>, EmptyFold> => {\n\tconst parts = words(input)\n\tif (parts.length !== 0) {\n\t\treturn Result.fail(new EmptyFold({ input }))\n\t}",
			why: "Folding a name refuses every non-empty name, so no operation, parameter or field gets a name; the property fails (CATCH's evidence, mutant 077846b20e)."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: "[member.document, member.value]",
			replacement: "[member.value]",
			why: "A document set's members lose their documents, so references between them do not resolve; the property fails (CATCH's evidence, mutant 65477481ca)."
		},
		{
			file: "packages/cli-generator/src/normalize/security.ts",
			original:
				'[\n\t\t...Option.toArray(\n\t\t\tOption.map(operation, (tokens): Source => ({\n\t\t\t\tpointer: formatPointer([...tokens, "security"]),\n\t\t\t\trows: ["SEC-01", "SEC-04"]\n\t\t\t}))\n\t\t),\n\t\t{ pointer: formatPointer(["security"]), rows: ["SEC-01", "SEC-03"] }\n\t]',
			replacement: '[{ pointer: formatPointer(["security"]), rows: ["SEC-01", "SEC-03"] }]',
			why: "An operation's own security list is ignored for the document's, so an undeclared name in it is never reported; the property fails (CATCH's evidence, mutant 0d376bbffa)."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original:
				'if (this.entry.line !== "3.2" || Option.isNone(schemes) || !isObject(schemes.value)) {\n\t\t\treturn\n\t\t}',
			replacement: "{}",
			why: "3.2's security scheme URIs are read on every line, so a 3.0 or 3.1 requirement name resolves where it must not; the property fails (CATCH's evidence, mutant 46487dc2a4)."
		},
		{
			file: "packages/cli-generator/src/emit/api.ts",
			original: '["operationId", str(operation.operationId)]',
			replacement: '["operationId"]',
			why: "A command's operationId statement loses its value, so the emitted api module is not TypeScript; the property fails (CATCH's evidence, mutant 83b0158956)."
		},
		{
			file: "packages/cli-generator/src/normalize/security.ts",
			original: "\treturn writers.length < 2",
			replacement: "\treturn writers.length >= 2",
			why: "A requirement alternative is refused unless it names two Authorization writers, inverting the conflict rule; the property fails (CATCH's evidence, mutant 0335859d0c)."
		},
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: 'node.in === "path" && node.required !== true',
			replacement: "node.required !== true",
			why: "Every optional parameter is refused as a path parameter that is not required; the property fails (CATCH's evidence, mutant ae15199854)."
		},
		{
			file: "packages/cli-generator/src/names/index.ts",
			original:
				'const reservedSegments: ReadonlySet<string> = new Set(["root", "security", "servers"])',
			replacement: 'const reservedSegments: ReadonlySet<string> = new Set(["root", "security"])',
			why: "A group whose tag folds to servers is no longer refused, so its api module would overwrite api/servers.ts, the servers table; the property fails (api.test's claim, carried here)."
		}
	]
})
