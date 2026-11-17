/**
 * Canonical order (design 3.7): a generated package is a function of the document's value and its semantic orders.
 * The member order of `paths`, of each path item, of `components.schemas` and of a JSON media schema's `properties` is
 * not semantic, so a document and its twin with those orders reversed generate the same files, byte for byte.
 *
 * Oracle: the twin of each generated document (metamorphic), generated beside it into the case's own directory.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import {
	type CanonicalFeature,
	canonicalFeatures,
	canonicalSpace,
	packageOf,
	renderedOf,
	twinOf
} from "#test/normalize/canonical-order.fixtures.ts"
import { digestService } from "#test/support/digest.ts"

/**
 * A document and its member-reversed twin generate the same package. Its budget replaces the one example case of the
 * suite it converts (a fixture and its twin), on two drawn documents, each a whole generation twice.
 */
export const canonicalOrder = property.explore(canonicalSpace, {
	needs: { scratch: Scratch.dir, digest: digestService },
	situations: ["a document generated with no diagnostic"] satisfies ReadonlyArray<
		Reached<CanonicalFeature>
	>,
	check: (resources, c: Case<CanonicalFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(canonicalFeatures(sketch))
			const scratch = yield* resources.scratch
			const digest = yield* resources.digest
			const document = renderedOf(sketch)
			const written = yield* packageOf(scratch, digest, "fixture", document, sketch.config)
			const twin = yield* packageOf(scratch, digest, "twin", twinOf(document), sketch.config)
			c.noteAll(written.diagnostics.length === 0 ? ["a document generated with no diagnostic"] : [])
			deepStrictEqual(twin.files, written.files)
		}),
	oracle: {
		kind: "universal",
		name: "a document and its member-reversed twin generate the same package"
	},
	kept: [],
	budget: { runs: 2, steered: 8 },
	kills: [
		{
			file: "packages/generator/src/generate.ts",
			original: "\t\tif (Arr.some(diagnostics, isDocumentRefusal)) {",
			replacement: "\t\tif (Arr.every(diagnostics, isDocumentRefusal)) {",
			why: "Generation is refused when every diagnostic refuses the document, which a document with no diagnostic satisfies, so a document the generator accepts writes no package; the property fails (CATCH's evidence, mutant fd1b756ea3)."
		}
	]
})
