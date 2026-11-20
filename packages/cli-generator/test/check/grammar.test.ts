/**
 * The spec-text checks on values and grammars (check/grammar.ts checkGrammar, design 3.4 rows 10 to 17), and the check
 * entry that runs them beside the structure checks (check/index.ts checkSpecText): server variables, URLs and 3.2
 * names, at operation scope for each operation whose list holds the server; security requirement names, refused as an
 * element while an alternative stays usable and as each operation's refusal when none does; media type keys and
 * header-name tokens wherever a document writes them; discriminators, whose discriminating property must be required
 * through any reuse of schemas, cycles among them; Responses Object keys; Header Object fields, patterns, and the 3.0
 * rows its schema leaves open.
 *
 * Oracle: design 3.4's rows and the OpenAPI text of each line, applied to the drawn documents as they are written.
 */
import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ContentFeature,
	contentActual,
	contentExpected,
	contentFeatures,
	contentSpace,
	diamondActual,
	diamondExpected,
	diamondSpace,
	type DiscriminatorFeature,
	discriminatorActual,
	discriminatorExpected,
	discriminatorFeatures,
	discriminatorSpace,
	type EntryFeature,
	entryActual,
	entryExpected,
	entryFeatures,
	entrySpace,
	type FieldsFeature,
	fieldsActual,
	fieldsExpected,
	fieldsFeatures,
	fieldsSpace,
	type GraphFeature,
	graphActual,
	graphExpected,
	graphFeatures,
	graphSpace,
	type NamesFeature,
	namesActual,
	namesExpected,
	namesFeatures,
	namesSpace,
	type ResponsesFeature,
	responsesActual,
	responsesExpected,
	responsesFeatures,
	responsesSpace,
	type SchemasFeature,
	schemasActual,
	schemasExpected,
	schemasFeatures,
	schemasSpace,
	type SecurityFeature,
	securityActual,
	securityExpected,
	securityFeatures,
	securitySpace,
	type ServersFeature,
	serversActual,
	serversExpected,
	serversFeatures,
	serversSpace
} from "#test/check/grammar.fixtures.ts"

/**
 * Each operation's servers are checked in the list it uses, its own, its path item's or the root's (SRV-15): a query
 * or fragment (SRV-18), a variable used twice (SRV-19), a default outside its enum (SRV-12, a notice in 3.0) and a
 * repeated 3.2 name (SRV-04), each at operation scope for that operation, and a list no operation uses never.
 */
export const serverRules = property.explore(serversSpace, {
	needs: {},
	situations: [
		"operation servers",
		"path item servers",
		"root servers",
		"no servers",
		"an empty override",
		"root servers no operation uses",
		"one list for two operations",
		"a query",
		"a fragment",
		"a repeated variable",
		"a default outside its enum, refused",
		"a default outside its enum, a 3.0 notice",
		"a default among its enum",
		"a repeated name in 3.2",
		"a repeated name before 3.2"
	] satisfies ReadonlyArray<Reached<ServersFeature>>,
	check: (_, c: Case<ServersFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(serversFeatures(sketch))
			const actual = yield* serversActual(sketch)
			unorderedEqual(actual, serversExpected(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "the Server Object rules of each line (SRV-04, SRV-12, SRV-18, SRV-19) over the list SRV-15 gives each operation"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'resolution.line === "3.0" ? "notice" : "refusal"',
			replacement: 'resolution.line === "3.0" ? "refusal" : "notice"',
			why: "A default outside its enum is a 3.0 refusal and a notice after; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "Option.orElse(() => ownServers(operation.item.node, operation.item.pointer)),",
			replacement: "",
			why: "An operation under a path item with servers reads the root's, so the path item's defects go unreported and the root's are reported in their place; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "!Arr.contains(members, fallback)",
			replacement: "Arr.contains(members, fallback)",
			why: "A default among its enum is refused and one outside it passes; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'regex("[?#]", "u")',
			replacement: 'regex("[?]", "u")',
			why: "A server URL with a fragment passes; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "Arr.dedupe(names).length !== names.length",
			replacement: "Arr.dedupe(names).length === names.length",
			why: "A URL using each variable once is refused as repeating one, and a repeat passes; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'if (resolution.line !== "3.2") {',
			replacement: 'if (resolution.line === "3.2") {',
			why: "Server names are held unique before 3.2, which has none, and not in 3.2; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "(finding) => ({ ...finding, operation })",
			replacement: "(finding) => finding",
			why: "A server finding names no operation, so the operations a server list fails go unsaid; the property fails."
		}
	]
})

/**
 * A security requirement name that resolves to no scheme (SEC-09; SEC-10 in 3.2, where a scheme's URI resolves too) is
 * an element refusal while its list keeps a usable alternative, and each operation's refusal when the list leaves it
 * none, the root's list for each operation that inherits it; a 3.0 scheme that takes no scopes lists none (SEC-12).
 */
export const securityRules = property.explore(securitySpace, {
	needs: {},
	situations: [
		"an unresolved name beside a usable alternative",
		"every alternative unresolved",
		"an empty alternative",
		"a root list no alternative of leaves to an operation",
		"a root list no alternative of, every operation its own",
		"a scheme URI in 3.2",
		"a scheme URI before 3.2",
		"scopes on a scheme that takes none, in 3.0",
		"scopes on a scheme that takes them",
		"scopes on a scheme that takes none, after 3.0"
	] satisfies ReadonlyArray<Reached<SecurityFeature>>,
	check: (_, c: Case<SecurityFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(securityFeatures(sketch))
			const actual = yield* securityActual(sketch)
			unorderedEqual(actual, securityExpected(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "the Security Requirement Object of each line (SEC-09, SEC-10, SEC-12): names, the alternatives a list keeps, the operations that inherit the root's"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "found.exhausted ? operationScoped(found.unresolved, operation) : found.unresolved",
			replacement: "found.unresolved",
			why: "An operation whose own list leaves it no alternative gets element refusals, not its own; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original:
				"Arr.every(requirements, (requirement) => Arr.isReadonlyArrayNonEmpty(requirement.unresolved))",
			replacement:
				"Arr.some(requirements, (requirement) => Arr.isReadonlyArrayNonEmpty(requirement.unresolved))",
			why: "A list with one unresolved alternative beside a usable one is read as leaving none; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original:
				'resolution.line === "3.2" ? "SEC-10/unresolved-scheme" : "SEC-09/unresolved-scheme"',
			replacement:
				'resolution.line === "3.2" ? "SEC-09/unresolved-scheme" : "SEC-10/unresolved-scheme"',
			why: "Each line's unresolved name carries the other line's code; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'kind === "oauth2" || kind === "openIdConnect"',
			replacement: 'kind === "oauth2"',
			why: "OpenID Connect is read as taking no scopes, so its 3.0 scopes are refused; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "found.exhausted && Arr.isReadonlyArrayNonEmpty(inheriting)",
			replacement: "found.exhausted",
			why: "A root list with no usable alternative that no operation inherits reports nothing; the property fails."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: 'return section === "schemas" || resolution.line === "3.2"',
			replacement: 'return section === "schemas"',
			why: "A 3.2 security scheme's URI resolves to nothing, so it is refused; the property fails."
		}
	]
})

/** A Content map's key that is no RFC 9110 media type or range is refused at the key (MED-24), in every Content map. */
export const contentKeys = property.explore(contentSpace, {
	needs: {},
	situations: [
		"a key that is no media range, under parameter",
		"a key that is no media range, under requestBody",
		"a key that is no media range, under response",
		"a key that is no media range, under responseHeader",
		"a key that is no media range, under callback",
		"a key that is no media range, under webhook",
		"a key that is no media range, under componentParameter",
		"a key that is no media range, under componentRequestBody",
		"a key that is no media range, under componentResponse",
		"a key that is no media range, under componentHeader",
		"a media range",
		"a webhook in 3.0"
	] satisfies ReadonlyArray<Reached<ContentFeature>>,
	check: (_, c: Case<ContentFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(contentFeatures(sketch))
			const actual = yield* contentActual(sketch)
			unorderedEqual(actual, contentExpected(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "RFC 9110's media-range grammar for every Content map's keys (MED-24), and the webhooks of 3.1 and 3.2"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original:
				'...each("requestBodies", (node, pointer) =>\n\t\t\t\trequestBodyFindings(resolution, search, node, pointer)\n\t\t\t),',
			replacement: "",
			why: "The components' request bodies go unread, so their content keys pass; the property fails (TESTPOLICY2's census of the module, mutant c7ab4cbd34)."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original:
				'isMediaRange(name) ? [] : [at("MED-24/invalid-media-type", childPointer(pointer, name))]',
			replacement:
				'isMediaRange(name) ? [at("MED-24/invalid-media-type", childPointer(pointer, name))] : []',
			why: "Every media range is refused and every key that is none passes; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: '...(resolution.line === "3.0" ? [] : under("webhooks")),',
			replacement: '...under("webhooks"),',
			why: "A 3.0 document's webhooks member, no field of 3.0, is read as webhooks; the property fails."
		}
	]
})

/**
 * A header name that is no RFC 9110 token is refused: a header parameter's at its name (PRM-20), a response header's
 * (RSP-09) and an encoding header's (HDR-01) at its key; a query parameter's name is no header name.
 */
export const headerNames = property.explore(namesSpace, {
	needs: {},
	situations: [
		"a name that is no token, at operationParameter",
		"a name that is no token, at pathItemParameter",
		"a name that is no token, at componentParameter",
		"a name that is no token, at queryParameter",
		"a name that is no token, at responseHeader",
		"a name that is no token, at componentResponseHeader",
		"a name that is no token, at encodingHeader",
		"a token"
	] satisfies ReadonlyArray<Reached<NamesFeature>>,
	check: (_, c: Case<NamesFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(namesFeatures(sketch))
			const actual = yield* namesActual(sketch)
			unorderedEqual(actual, namesExpected(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "RFC 9110's token grammar for header parameter, response header and encoding header names (PRM-20, RSP-09, HDR-01)"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original:
				'stringMember(parameter, "in") === "header" && name !== undefined && !isHeaderName(name)',
			replacement: "name !== undefined && !isHeaderName(name)",
			why: "A query parameter's name is held to the header token grammar; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "isHeaderName(name) ? [] : [at(code, childPointer(pointer, name))]",
			replacement: "[]",
			why: "No response or encoding header key is refused; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: '"HDR-01/invalid-header-name"\n\t\t\t)',
			replacement: '"RSP-09/invalid-header-name"\n\t\t\t)',
			why: "An encoding header's name is refused as a response header's; the property fails."
		}
	]
})

/**
 * A discriminator beside no composition and on no allOf base is refused (DSC-05); otherwise a discriminating
 * property the schema does not require, itself, through an allOf member or through every alternative, is refused in
 * 3.0 and 3.1 (DSC-09) and in 3.2 without a defaultMapping (DSC-10), and a mapping value (DSC-03) or 3.2
 * defaultMapping (DSC-04) that names no schema of the set is refused.
 */
export const discriminatorRules = property.explore(discriminatorSpace, {
	needs: {},
	situations: [
		"no composition",
		"an allOf base",
		"members under allOf",
		"members under oneOf",
		"members under anyOf",
		"an inline member",
		"required by the schema itself",
		"required through its allOf members, sparing a refusal",
		"required through its oneOf members, sparing a refusal",
		"required through its anyOf members, sparing a refusal",
		"not required",
		"not required, with a defaultMapping in 3.2",
		"a mapping target that resolves",
		"a mapping target that does not resolve",
		"a defaultMapping that does not resolve",
		"a defaultMapping before 3.2",
		"in a request body"
	] satisfies ReadonlyArray<Reached<DiscriminatorFeature>>,
	check: (_, c: Case<DiscriminatorFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(discriminatorFeatures(sketch))
			const actual = yield* discriminatorActual(sketch)
			unorderedEqual(actual, discriminatorExpected(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "the Discriminator Object of each line (DSC-03, DSC-04, DSC-05, DSC-09, DSC-10, DSC-11)"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "!composes(place.node) && !allOfReferrers(resolution).has(self)",
			replacement: "!composes(place.node)",
			why: "The base schema an allOf child references is refused as composing nothing; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'name === undefined || required || resolution.line === "3.2"',
			replacement: "name === undefined || required",
			why: "A 3.2 discriminating property that is not required is refused under DSC-09 beside DSC-10; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'resolution.line === "3.2" &&\n\t\tdefaultMapping !== undefined &&',
			replacement: "defaultMapping !== undefined &&",
			why: "A defaultMapping before 3.2, no field there, is checked; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "if (!inner.found) {",
			replacement: "if (inner.found) {",
			why: "A property one alternative requires counts as required by them all; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'for (const member of [...referenced, ...members("allOf")]) {',
			replacement: "for (const member of referenced) {",
			why: "A property an allOf member requires is not found; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "onSome: (key) => Option.exists(nodeAt(resolution.value, key.pointer), isObject)",
			replacement: "onSome: () => false",
			why: "No mapping value resolves, so every one is refused; the property fails."
		}
	]
})

/**
 * Over graphs of four component schemas that reference one another, cycles among them, a schema requires its
 * discriminating property exactly when the least fixed point of the requirement equations says so: a cycle proves
 * nothing by itself, and a requirement reached around one still counts.
 */
export const requirementFixpoint = property.explore(graphSpace, {
	needs: {},
	situations: [
		"a cycle",
		"a requirement reached around a cycle, met first while its schema is walked",
		"required through allOf",
		"required through every alternative",
		"not required",
		"an alternative not required",
		"a schema that composes nothing",
		"an allOf base composing nothing"
	] satisfies ReadonlyArray<Reached<GraphFeature>>,
	check: (_, c: Case<GraphFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(graphFeatures(sketch))
			const actual = yield* graphActual(sketch)
			unorderedEqual(actual, graphExpected(sketch))
		}),
	oracle: {
		kind: "second-implementation",
		name: "the least fixed point of the requirement equations, iterated from none"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "return { found: false, low: walking }",
			replacement: "return settled(true)",
			why: "A schema met again on its own path counts as requiring the property, so a cycle proves it; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "answer.found || answer.low >= depth",
			replacement: "true",
			why: "A no that leaned on a schema still being walked is kept, so a requirement reached around a cycle is lost to the schemas inside it; the property fails."
		}
	]
})

/**
 * A diamond of every depth up to 64, under each composition keyword, its leaf requiring the property or not, is
 * checked in time linear in its depth: each schema is walked once for a name, so no walk follows its 2^64 paths.
 */
export const sharedSchemasWalkedOnce = property.exhaust(diamondSpace, {
	box: "every diamond of depth 1 to 64, on every line, under allOf, oneOf and anyOf, its leaf requiring the property or not",
	needs: {},
	situations: [],
	check: () => (sketch) =>
		Effect.gen(function* () {
			const actual = yield* diamondActual(sketch)
			unorderedEqual(actual, diamondExpected(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "the Discriminator Object's required property (DSC-09, DSC-10) through every path of the diamond to its leaf"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "search.memo.set(key, answer.found)",
			replacement: "",
			why: "No answer is kept, so each schema is walked once per path to it and a deep diamond never finishes; the property fails."
		}
	]
})

/**
 * A Responses Object key that is no status code from 100 to 599, range from 1XX to 5XX, default or extension is
 * refused at the key (RSS-10); a 3.0 Responses Object of extensions alone is refused for the document (RSS-04).
 */
export const responseKeys = property.explore(responsesSpace, {
	needs: {},
	situations: [
		"a key that is no status",
		"a status",
		"extensions alone, in 3.0",
		"extensions alone, after 3.0",
		"an extension beside a status"
	] satisfies ReadonlyArray<Reached<ResponsesFeature>>,
	check: (_, c: Case<ResponsesFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(responsesFeatures(sketch))
			const actual = yield* responsesActual(sketch)
			unorderedEqual(actual, responsesExpected(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "the Responses Object's keys of each line (RSS-04, RSS-10)"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'regex("^(?:[1-5][0-9]{2}|[1-5]XX|default)$", "u")',
			replacement: 'regex("^(?:[1-5][0-9]{2}|default)$", "u")',
			why: "A status range is refused; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'resolution.line === "3.0" &&\n\t\tArr.isReadonlyArrayNonEmpty(keys)',
			replacement: "Arr.isReadonlyArrayNonEmpty(keys)",
			why: "A 3.1 or 3.2 Responses Object of extensions alone is refused, a rule those lines' schemas own; the property fails."
		}
	]
})

/**
 * In 3.0, a Header Object's allowEmptyValue or allowReserved is refused at the field, for the document (HDR-13),
 * wherever the header is written; a parameter keeps both, and 3.1 and 3.2 leave the rule to their schemas.
 */
export const headerFields = property.explore(fieldsSpace, {
	needs: {},
	situations: [
		"a parameter-only field at responseHeader",
		"a parameter-only field at componentHeader",
		"a parameter-only field at encodingHeader",
		"a parameter-only field at componentResponseHeader",
		"a parameter-only field at parameter",
		"a parameter-only field after 3.0"
	] satisfies ReadonlyArray<Reached<FieldsFeature>>,
	check: (_, c: Case<FieldsFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(fieldsFeatures(sketch))
			const actual = yield* fieldsActual(sketch)
			unorderedEqual(actual, fieldsExpected(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "the 3.0 Header Object, which takes neither of a parameter's allowEmptyValue and allowReserved (HDR-13)"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'resolution.line === "3.0"\n\t\t? whenSome(ownObject(node), (header) =>',
			replacement: 'resolution.line !== "3.0"\n\t\t? whenSome(ownObject(node), (header) =>',
			why: "The parameter-only fields are refused after 3.0 and allowed in it; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: "...headerFieldFindings(resolution, node, pointer),",
			replacement: "",
			why: "A component header's parameter-only fields pass; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original:
				'const parameterOnlyFields: readonly string[] = ["allowEmptyValue", "allowReserved"]',
			replacement: 'const parameterOnlyFields: readonly string[] = ["allowEmptyValue"]',
			why: "A header's allowReserved passes; the property fails."
		}
	]
})

/**
 * Every schema of a document, wherever it is nested: a pattern that does not compile in Unicode mode is a notice
 * (S30-09 in 3.0, SCH-37 after), and in 3.0 an array without items (S30-22) and readOnly beside writeOnly (S30-30)
 * are refused; a 3.0 Reference Object's siblings are no keywords.
 */
export const schemaKeywords = property.explore(schemasSpace, {
	needs: {},
	situations: [
		"a pattern that fails in Unicode mode, in 3.0",
		"a pattern that fails in Unicode mode, after 3.0",
		"a pattern that compiles",
		"an array without items, in 3.0",
		"an array whose items is the nested schema",
		"an array without items, after 3.0",
		"readOnly and writeOnly, in 3.0",
		"readOnly and writeOnly, after 3.0",
		"a reference beside findings, in 3.0",
		"a reference beside findings, after 3.0",
		"a schema under properties",
		"a schema under items",
		"a schema under allOf",
		"a schema under oneOf",
		"a schema under additionalProperties",
		"a schema under not"
	] satisfies ReadonlyArray<Reached<SchemasFeature>>,
	check: (_, c: Case<SchemasFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(schemasFeatures(sketch))
			const actual = yield* schemasActual(sketch)
			unorderedEqual(actual, schemasExpected(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "ECMAScript's Unicode-mode pattern grammar (SCH-37, S30-09), the 3.0 Schema Object (S30-22, S30-30) and design 3.3's Reference Object"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'regex.as(source, "u")',
			replacement: "regex.as(source)",
			why: "A pattern is compiled outside Unicode mode, where `\\-` is a plain hyphen, so it passes; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'const legacy = resolution.line === "3.0"',
			replacement: 'const legacy = resolution.line !== "3.0"',
			why: "Each line's rows are the other lines', so 3.0's notice carries SCH-37 and its own rows hold after it; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'resolution.line === "3.0" && isReference(schema)',
			replacement: "isReference(schema)",
			why: "A 3.1 or 3.2 Reference Object's siblings, keywords on those lines, go unread; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'isTrue(node, "readOnly") && isTrue(node, "writeOnly")',
			replacement: 'isTrue(node, "readOnly") || isTrue(node, "writeOnly")',
			why: "A schema that is readOnly alone is refused; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: '"if",\n\t"items",',
			replacement: '"if",',
			why: "A schema's items go unread, so a pattern inside them passes; the property fails."
		}
	]
})

/** The check entry reports every structure and every grammar finding, in document order: by pointer, then by code. */
export const specTextInOrder = property.explore(entrySpace, {
	needs: {},
	situations: [
		"a componentKey defect",
		"a pathVariable defect",
		"a contentKey defect",
		"a pattern defect",
		"a headerName defect",
		"a serverQuery defect",
		"a finding inside another's pointer",
		"a clean document"
	] satisfies ReadonlyArray<Reached<EntryFeature>>,
	check: (_, c: Case<EntryFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(entryFeatures(sketch))
			const actual = yield* entryActual(sketch)
			assert.deepEqual<ReadonlyArray<readonly [string, string]>>(actual, entryExpected(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "design 3.7's document order over the structure rows (CMP-13, PTH-03) and the grammar rows of design 3.4"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/index.ts",
			original: "return sortDiagnostics([resolution.document], [...structure, ...grammar])",
			replacement: "return [...structure, ...grammar]",
			why: "The findings come in the order each check made them, structure first; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/index.ts",
			original: "[...structure, ...grammar])",
			replacement: "[...grammar])",
			why: "The structure checks' findings are dropped; the property fails."
		}
	]
})
