/**
 * The manifest (write/manifest.ts, design 3.6): the writer prints its entries by path whatever order it is handed them
 * in, and a later run reads that text back as the entries it printed, refusing every other text: one that is no JSON,
 * no object of `files` alone, or an entry that is no object of exactly a non-empty `path`, a 64-digit lowercase hex
 * `sha256` and a whole number of bytes for `size`, as malformed, and a path listed twice as a duplicate naming it.
 *
 * Oracle: design 3.6's manifest, `{"files": [{path, sha256, size}]}` sorted by path.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { digestService } from "#test/support/digest.ts"
import {
	type ManifestFeature,
	manifestFeaturesOf,
	manifestSpace,
	outcomesOf
} from "#test/write/manifest.fixtures.ts"

/** A manifest prints by path and reads back as itself, and every text that departs from its shape is refused. */
export const manifestReadsBack = property.explore(manifestSpace, {
	needs: { digest: digestService },
	situations: [
		"none",
		"several files",
		"no JSON text",
		"a list for the manifest",
		"a member beside files",
		"files that are no list",
		"a member beside an entry's three",
		"an entry without its size",
		"an empty path",
		"a sha256 in capitals",
		"a sha256 a digit short",
		"a fractional size",
		"a negative size",
		"a size written as text",
		"a repeated path"
	],
	check: (resources, k: Case<ManifestFeature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(manifestFeaturesOf(c))
			const digest = yield* resources.digest
			const { actual, expected } = yield* outcomesOf(c, digest)
			assert.deepEqual(
				actual,
				expected,
				"the manifest prints by path, reads back as itself, and refuses every other text"
			)
		}),
	oracle: {
		kind: "specification",
		name: 'design 3.6\'s manifest: {"files": [{path, sha256, size}]} sorted by path'
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/write/manifest.ts",
			original: "files: Arr.map(Arr.sort(entries, byPath), (entry) => ({",
			replacement: "files: Arr.map(entries, (entry) => ({",
			why: "The manifest lists its entries in the order the writer was handed them, so two runs over one package can print two manifests; the property fails."
		},
		{
			file: "packages/cli-generator/src/write/manifest.ts",
			original: "Arr.every(Record.keys(object), (name) => Arr.contains(names, name))",
			replacement: "true",
			why: "A manifest or an entry holding a member beside its own is read as though it held none, so a file the writer never wrote this way passes for its manifest; the property fails."
		},
		{
			file: "packages/cli-generator/src/write/manifest.ts",
			original: '\t\tpath !== "" &&\n',
			replacement: "",
			why: "An entry of an empty path is read, so the stale-file sweep is handed the output directory itself to judge; the property fails."
		},
		{
			file: "packages/cli-generator/src/write/manifest.ts",
			original: "\t\tisSha256Hex(sha256) &&\n",
			replacement: "",
			why: "An entry whose sha256 is no 64-digit lowercase hex is read, so no file ever matches it and the edited-file notice is raised for a file nobody touched; the property fails."
		},
		{
			file: "packages/cli-generator/src/write/manifest.ts",
			original: "\t\tNumber.isSafeInteger(size) &&\n",
			replacement: "",
			why: "An entry whose size is a fraction is read as a byte count no file has; the property fails."
		},
		{
			file: "packages/cli-generator/src/write/manifest.ts",
			original: "\t\tsize >= 0\n",
			replacement: "\t\tsize >= -1\n",
			why: "An entry whose size is negative is read as a byte count no file has; the property fails."
		},
		{
			file: "packages/cli-generator/src/write/manifest.ts",
			original:
				'onSome: (subject) => Effect.fail(new ManifestError({ reason: "duplicate-path", subject }))',
			replacement: "onSome: () => Effect.succeed(sorted)",
			why: "A manifest listing one path twice is read, so the stale-file sweep judges that file twice; the property fails."
		}
	]
})
