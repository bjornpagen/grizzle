/**
 * The validation stage's diagnosis of a document (validate/index.ts diagnoseDocument, design 3.2): on every line, a
 * known disagreement between the official schema and the text (design 10.4) is a notice and nothing more, and every
 * other error of the line's official schema is a document refusal under the line's row, at the decoded instance it
 * rejects, citing the rejecting keyword, so neither hides the other. A property name holding a lone UTF-16 surrogate is
 * refused at its pointer, the surrogate escaped, before any schema reads the document. The 3.1 text's dialect id is
 * rewritten to the dated id in a copy, wherever a `$schema` holds it and at the root's `jsonSchemaDialect`, and the
 * input is never changed. A fixed method as a 3.2 `additionalOperations` key, in any spelling, is left to the structure
 * check (PTH-24).
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { digestService } from "#test/support/digest.ts"
import {
	type DialectFeature,
	dialectedSpace,
	dialectFeaturesOf,
	type DiagnosisFeature,
	diagnosisFeaturesOf,
	expectedMethodKey,
	expectedNamedOf,
	expectedPlantedOf,
	expectedRewriteOf,
	type MethodKeyFeature,
	methodKeyAnswerOf,
	methodKeyFeaturesOf,
	methodKeySpace,
	namedAnswerOf,
	type NamedFeature,
	namedFeaturesOf,
	namedSpace,
	plantedAnswerOf,
	plantedSpace,
	rewriteAnswerOf
} from "#test/validate/diagnostics.fixtures.ts"

/**
 * A document holding up to three planted constructs is left as it was built and diagnosed as its line's official
 * schema and the table of known disagreements say.
 */
export const plantedDiagnosis = property.exhaust(plantedSpace, {
	box: "every line, with no construct and with every one, two or three of the eleven together",
	needs: { digest: digestService },
	situations: [
		"no diagnostic",
		"a notice beside a refusal",
		"two notices of one row",
		"a DOC-02 notice",
		"a DOC-03 notice",
		"a SCH-01 notice",
		"a LNK-04 notice",
		"a PRM-35 notice",
		"a VAL-02 refusal",
		"a VAL-03 refusal",
		"a VAL-04 refusal"
	],
	check: (resources, k: Case<DiagnosisFeature>) => (planted) =>
		Effect.gen(function* () {
			k.noteAll(diagnosisFeaturesOf(planted))
			const digest = yield* resources.digest
			const actual = yield* plantedAnswerOf(planted, digest)
			assert.deepEqual(actual, expectedPlantedOf(planted))
		}),
	oracle: {
		kind: "specification",
		name: "each line's official schema, its known disagreements with the text (design 10.4) and its refusal row"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/validate/index.ts",
			original: "Arr.filter(matched, ({ entry }) => Option.isNone(entry)),",
			replacement: "matched,",
			why: "Every error group is a refusal, a known disagreement too, so each notice comes with a refusal at its pointer; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/disagreements.ts",
			original: '"3.0": { anchor: "schema-0", row: "VAL-02" },',
			replacement: '"3.0": { anchor: "schema-0", row: "VAL-03" },',
			why: "A 3.0 document is refused under the 3.1 line's row; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/index.ts",
			original: "const rewriteNotices = Arr.isReadonlyArrayNonEmpty(rewritten.occurrences)",
			replacement: "const rewriteNotices = Arr.isReadonlyArrayEmpty(rewritten.occurrences)",
			why: "The rewritten dialect ids give no SCH-01 notice, so the 3.1 text's id passes unsaid; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/disagreements.ts",
			original: "match.instance(tokens) &&",
			replacement: "true &&",
			why: "A disagreement matches by its keyword alone, wherever the instance sits, so 3.1's unknown Parameter Object member reads as PRM-35's allowReserved and is a notice where it is a refusal; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/index.ts",
			original: "const result = yield* validateCopy(rewritten.copy)",
			replacement: "const result = yield* validateCopy(validatorCopy(document))",
			why: "The schema validates the document as written, not its rewritten copy, so the 3.1 text's dialect id is refused beside its SCH-01 notice; the property fails."
		}
	]
})

/** A property name holding a lone surrogate is refused at its escaped pointer, and nothing else is said. */
export const loneSurrogateNames = property.exhaust(namedSpace, {
	box: "every line, every name of one to three code units of a letter and U+1F600's two halves, with no construct beside it or each one alone",
	needs: { digest: digestService },
	situations: [
		"a lone high surrogate",
		"a lone low surrogate",
		"a surrogate pair",
		"a lone surrogate beside a construct",
		"a well-formed name beside a construct"
	],
	check: (resources, k: Case<NamedFeature>) => (named) =>
		Effect.gen(function* () {
			k.noteAll(namedFeaturesOf(named))
			const digest = yield* resources.digest
			const actual = yield* namedAnswerOf(named, digest)
			assert.deepEqual(actual, expectedNamedOf(named))
		}),
	oracle: {
		kind: "specification",
		name: "UTF-16's surrogate pairing, read unit by unit, and DOC-14's refusal of a name that is no Unicode text"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/validate/surrogates.ts",
			original:
				"...(loneSurrogate.test(key) ? [pointerOf([...tokens, key])] : []),\n\t\t\t...folded",
			replacement: "...folded",
			why: "No property name is a surrogate site, so a lone surrogate reaches the validator, which cannot percent-encode it, and no DOC-14 refusal is made; the property fails (TESTPOLICY2's census, mutant 30c9af81c7)."
		},
		{
			file: "packages/cli-generator/src/validate/surrogates.ts",
			original: "loneSurrogate.test(codePoint) ?",
			replacement: "false ?",
			why: "A lone surrogate stands in the pointer as itself, unescaped, so the refusal's pointer is no Unicode text; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/surrogates.ts",
			original:
				"Str.toUpperCase(Option.getOrElse(Str.codePointAt(0)(codePoint), () => 0).toString(16))",
			replacement: "Option.getOrElse(Str.codePointAt(0)(codePoint), () => 0).toString(16)",
			why: "A lone surrogate is escaped in lowercase hexadecimal digits, which is not how a pointer shows it; the property fails."
		}
	]
})

/** The dialect id is rewritten in a copy at every place it counts on 3.1, and nowhere else. */
export const dialectRewrite = property.exhaust(dialectedSpace, {
	box: "every line, with every set of the seven places a dialect id may sit",
	needs: {},
	situations: [
		"no site",
		"an id rewritten",
		"an id left on 3.0",
		"an id left on 3.2",
		"a jsonSchemaDialect below the root left",
		"another dialect's id left"
	],
	check: (_, k: Case<DialectFeature>) => (dialected) =>
		Effect.gen(function* () {
			k.noteAll(dialectFeaturesOf(dialected))
			const actual = yield* rewriteAnswerOf(dialected)
			assert.deepEqual(actual, expectedRewriteOf(dialected))
		}),
	oracle: {
		kind: "specification",
		name: "design 3.2's dialect id substitution: the 3.1 text's id, at the root's jsonSchemaDialect or any $schema, in a copy"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/validate/dialect.ts",
			original: 'const occurrences = line === "3.1" ? foldJson(document, sites, []) : []',
			replacement: "const occurrences = foldJson(document, sites, [])",
			why: "The rewrite counts the text's dialect id on 3.0 and 3.2 too, lines whose text has no such id; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/dialect.ts",
			original: '(tokens.length === 0 && key === "jsonSchemaDialect")',
			replacement: 'key === "jsonSchemaDialect"',
			why: "A jsonSchemaDialect member below the root is rewritten and counted as if it were the document's own; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/dialect.ts",
			original: 'rewriting(line === "3.1")',
			replacement: "rewriting(true)",
			why: "The copy of a 3.0 or 3.2 document holds the dated 3.1 id where its input holds the text's; the property fails."
		}
	]
})

/** A fixed method as a 3.2 additionalOperations key is left to the structure check, in every spelling. */
export const fixedMethodKeys = property.exhaust(methodKeySpace, {
	box: "every fixed method of the 3.2 Path Item Object, lowercase, uppercase and capitalized",
	needs: { digest: digestService },
	situations: ["a lowercase key", "a uppercase key", "a capitalized key"],
	check: (resources, k: Case<MethodKeyFeature>) => (key) =>
		Effect.gen(function* () {
			k.noteAll(methodKeyFeaturesOf(key))
			const digest = yield* resources.digest
			const actual = yield* methodKeyAnswerOf(key, digest)
			assert.deepEqual(actual, expectedMethodKey)
		}),
	oracle: {
		kind: "specification",
		name: "PTH-24: the text bars a fixed method as an additionalOperations key in any spelling, which the structure check refuses"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/validate/index.ts",
			original: "const groups = Arr.filter(errorGroups, (group) => !isFixedMethodKey(group))",
			replacement: "const groups = errorGroups",
			why: "The 3.2 schema's bar on an uppercase fixed method key is a refusal of its own, so the structure check's PTH-24 refusal comes with a second; the property fails."
		}
	]
})
