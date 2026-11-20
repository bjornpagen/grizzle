/** What the property of path-item.test.ts reads: the specification lines, and each line's Path Item Object fields. */

import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite, type FiniteSpace } from "@bjornpagen/testing/gen"
import { methodMembers } from "#model/path-item.ts"
import { SpecLine } from "#model/spec-section.ts"

/** Every line the generator reads: the specification's own list. */
export const lineSpace: FiniteSpace<SpecLine> = finite(word(dictionary(SpecLine.literals)))

export type Feature = `line ${SpecLine}`

/**
 * The method fields of the Path Item Object, in the order each line's specification lists them: OpenAPI 3.0.4 and
 * 3.1.1 section 4.8.9.1 (get, put, post, delete, options, head, patch, trace), and 3.2.0's, which adds `query` after
 * `trace`.
 */
const fieldsOf: Readonly<Record<SpecLine, ReadonlyArray<string>>> = {
	"3.0": ["get", "put", "post", "delete", "options", "head", "patch", "trace"],
	"3.1": ["get", "put", "post", "delete", "options", "head", "patch", "trace"],
	"3.2": ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"]
}

export const actualOf = (line: SpecLine): ReadonlyArray<string> => methodMembers(line)

export const expectedOf = (line: SpecLine): ReadonlyArray<string> => fieldsOf[line]
