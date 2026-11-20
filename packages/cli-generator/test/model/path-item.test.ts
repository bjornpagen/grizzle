/**
 * The Path Item Object's method members (model/path-item.ts): on every specification line, exactly the method fields
 * that line's specification lists, in its order, so checks walking a path item's operations in it order their
 * findings as the specification does.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { actualOf, expectedOf, type Feature, lineSpace } from "#test/model/path-item.fixtures.ts"

/** Each line's method members are its specification's method fields, in order. */
export const methodFields = property.exhaust(lineSpace, {
	box: "every specification line the generator reads: 3.0, 3.1 and 3.2",
	needs: {},
	situations: ["line 3.0", "line 3.1", "line 3.2"],
	check: (_, k: Case<Feature>) => (line) =>
		Effect.sync(() => {
			k.note(`line ${line}`)
			assert.deepEqual(actualOf(line), expectedOf(line))
		}),
	oracle: {
		kind: "specification",
		name: "the Path Item Object's fixed fields of each line's specification, in its order"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/model/path-item.ts",
			original:
				'[\n\t"get",\n\t"put",\n\t"post",\n\t"delete",\n\t"options",\n\t"head",\n\t"patch",\n\t"trace"\n]',
			replacement: '["put", "post", "delete", "options", "head", "patch", "trace"]',
			why: "The fixed methods lose `get`, so no line lists it as a Path Item Object field; the property fails (CATCH's evidence, mutant d989f70a91)."
		},
		{
			file: "packages/cli-generator/src/model/path-item.ts",
			original: 'line === "3.2" ? [...fixedMethods, queryMethod] : fixedMethods',
			replacement: 'line !== "3.2" ? [...fixedMethods, queryMethod] : fixedMethods',
			why: "Every line but 3.2 appends `query`, and 3.2 lists none; the property fails (CATCH's evidence, mutant fc28eb5b7f)."
		}
	]
})
