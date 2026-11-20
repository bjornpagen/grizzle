/**
 * The spec-text checks across a document set (check/structure.ts, check/grammar.ts): an element a `$ref` reaches in a
 * second document of the set is read there, so an operation's parameter held in the second document is found to repeat
 * another by name and location, and a discriminator's branch held there is found not to require the discriminator's
 * property, each exactly as when the entry document holds it.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type BranchFeature,
	branchFeatures,
	branchFindings,
	branchSpace,
	expectedBranchFindings,
	expectedParameterFindings,
	type ParameterFeature,
	parameterFeatures,
	parameterFindings,
	parameterSpace
} from "#test/check/document-set.fixtures.ts"

/** A referenced parameter repeats an operation's own by name and location, whichever document of the set holds it. */
export const parametersAcrossDocuments = property.exhaust(parameterSpace, {
	box: "a referenced parameter held by the entry or the second document; each query or header parameter named limit or Limit beside each",
	needs: {},
	situations: [
		"a parameter of the second document",
		"a parameter of the entry document",
		"a repeated parameter",
		"a header repeated in another case",
		"two distinct parameters"
	] satisfies ReadonlyArray<Reached<ParameterFeature>>,
	check: (_, k: Case<ParameterFeature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(parameterFeatures(c))
			const found = yield* parameterFindings(c)
			assert.deepEqual(found, expectedParameterFindings(c))
		}),
	oracle: {
		kind: "specification",
		name: "OpenAPI 3.1.1 section 4.8.12: parameters unique by name and location, a header's name case-insensitive"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/path-items.ts",
			original: "resolution.documents.get(target.document)",
			replacement: "resolution.documents.get(resolution.document)",
			why: "A reference's target is read in the entry document whatever document it names, so a parameter held by the second document is read as nothing and its repeat is not found; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/structure.ts",
			original: "[...fixed, ...additional]",
			replacement: "[...additional]",
			why: "No path item's fixed operations are read, so no operation's parameters are checked and no repeat is found; the property fails (TESTPOLICY2's census, mutant 5c6f6c1ce8)."
		}
	]
})

/** A discriminator's branch must require its property, whichever document of the set holds the branch. */
export const branchesAcrossDocuments = property.exhaust(branchSpace, {
	box: "a branch held by the entry or the second document, requiring nothing, the discriminator's property, or its other property",
	needs: {},
	situations: [
		"a branch of the second document",
		"a branch of the entry document",
		"a branch requiring the property",
		"a branch not requiring the property"
	] satisfies ReadonlyArray<Reached<BranchFeature>>,
	check: (_, k: Case<BranchFeature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(branchFeatures(c))
			const found = yield* branchFindings(c)
			assert.deepEqual(found, expectedBranchFindings(c))
		}),
	oracle: {
		kind: "specification",
		name: "OpenAPI 3.1.1 section 4.8.25: every branch of a discriminator requires its property"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/path-items.ts",
			original: "resolution.documents.get(target.document)",
			replacement: "resolution.documents.get(resolution.document)",
			why: "A reference's target is read in the entry document whatever document it names, so a branch held by the second document is read as nothing; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/grammar.ts",
			original: 'name === undefined || required || resolution.line === "3.2"',
			replacement: 'name === undefined || resolution.line === "3.2"',
			why: "Every branch is found not to require the discriminator's property, the branches that require it among them; the property fails."
		}
	]
})
