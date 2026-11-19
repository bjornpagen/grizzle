/**
 * A generated CLI writes each multipart part under the content type its Encoding Object names, the one the operator
 * chose when it names several, with the part's declared headers in its head, and refuses before any connection a part
 * flag that cannot be honoured.
 *
 * - Parts: an upload whose file part may be `image/png` or `image/jpeg` (chosen with `--file-content-type`), and a
 *   document whose `image/png` file part declares a required `X-Checksum` header and an optional `X-Trace` one; each
 *   with its required title, and the file part sent or not. Oracle: the parts as the reference reader in multipart.ts
 *   reads them: the title's bytes; the file part's name, file name, content type essence, declared headers and bytes;
 *   and no file part when none was sent.
 * - Faults, planted one per run: a choice part without its content type, a content type without its part, a content
 *   type the part does not list, a part without its required header, a header flag without its part, and a header
 *   value with a line break. Oracle: exit 2 and no connection.
 *
 * A case draws a focus, a feature or none, and the run aimed at it; while a required feature is still pending, a case
 * aimed at it draws the run made to reach it (multipart-parts.fixtures.ts parts), so each is reached on every run seed.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, FileSystem, Path } from "effect"
import {
	done,
	expectedOf,
	FEATURES,
	FILE_NAME,
	invocationOf,
	type Outcome,
	type PartFeature,
	parts,
	partsFixture,
	partsSent,
	runFeatures
} from "#test/generated/multipart-parts.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"

/**
 * Each part carries its chosen or declared content type and declared headers, and a bad part flag sends nothing. Its
 * budget is the count its suite stated before the conversion: 12 independent cases, and up to 30 steered while a
 * situation is unreached.
 */
export const multipartParts = property.explore(parts, {
	needs: { fixture: partsFixture, scratch: Scratch.dir, checkout: Checkout.dir },
	situations: FEATURES,
	check:
		({ fixture, scratch: scratchDir }, k: Case<PartFeature>) =>
		(r) =>
			Effect.gen(function* () {
				const { server, built, commands } = yield* fixture
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const scratch = yield* scratchDir
				const file = path.join(scratch, FILE_NAME)
				k.noteAll(runFeatures(r))
				const invoked = invocationOf(r, file)
				yield* fs.writeFile(file, invoked.file)
				const observed = yield* server.observe(
					() => done,
					runBin(built, {
						args: Arr.flatten([
							commands[invoked.operation],
							["--base-url", server.origins["127.0.0.1"]],
							invoked.args
						]),
						env: {},
						stdin: new Uint8Array(0)
					})
				)
				assert.deepEqual<Outcome>(
					{
						exitCode: observed.result.exitCode,
						connections: observed.connections.length,
						parts: Arr.map(observed.requests, partsSent)
					},
					expectedOf(r),
					"each part carries its chosen or declared content type and headers, and a bad part flag sends nothing"
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "the reference multipart reader (multipart.ts), and exit 2 with no connection for a planted fault"
	},
	kept: [],
	budget: { runs: 12, steered: 30 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/multipart.ts",
			original: `\t\thead += \`Content-Type: \${contentType}\\r\\n\``,
			replacement: "\t\thead += ``",
			why: "A part is written with no Content-Type line, so its chosen or declared type never reaches the server; the property fails."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/multipart.ts",
			original: `\t\thead += \`\${name}: \${value}\\r\\n\``,
			replacement: "\t\thead += ``",
			why: "A part's declared headers are left out of its head; the property fails."
		}
	]
})
