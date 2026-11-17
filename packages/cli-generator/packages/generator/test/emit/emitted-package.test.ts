/**
 * Emitted packages against the compiler. A generated document and an author config that fits it generate a package, and
 * tsc, run as the package's own typecheck script runs it with the workspace's installed dependencies, reports nothing:
 * whatever the generator emits for a document it accepts, its domain, api, cli and entry modules type-check against the
 * runtime it ships. Every file the printer wrote is an oxfmt fixed point under the options docs/printer.md names; the
 * runtime's sources sit under src/ byte for byte as under src/runtime-src; and the root command module is lazy: it
 * imports no command module and no group's api module statically, every command module is loaded exactly once, by the
 * root's `import()` or by its parent group's import, each entry of the root's table names the group its module's
 * `Command.make` makes, and no entry module holds a top-level await or reads process.argv. Every operation command,
 * the root's untagged ones too, records the run (the error format it renders in) as a step of its own before any
 * annotation, so an error raised before the request is sent renders in the run's format.
 *
 * Required situations are read from what the package emitted: a construct counts only when an operation holding it has
 * a command. They reach every family the runtime-gate fixture reached: each parameter location (a query object by
 * deepObject and a query array among them), JSON, form, form-data, positional multipart/mixed, JSON Lines, binary and
 * text bodies, SSE, JSON-seq, NDJSON and binary responses, a problem response with Retry-After, and bearer, basic,
 * apiKey in a header, a query and a cookie, OAuth 2, OpenID Connect and mutual TLS. They also reach a child group and a
 * group whose name folds to a binding a command module holds (`Command`, `Effect`, `Groups`, `Arr`, `Client`).
 *
 * The compiler is the oracle, so it is checked to refuse: a package with a command whose root services layer has its
 * `BaseUrl.layer` entry cut fails tsc, which names `Servers`, the service the commands require and nothing provides.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect"
import { Digest } from "effect/crypto"
import {
	baseUrlLayer,
	cliModulesOf,
	commandedCaseGen,
	type Feature,
	featuresOf,
	lazyRootFindings,
	packageSpace,
	runRecordFindings,
	typecheckReport,
	unformatted,
	UNPROVIDED_SERVERS,
	unshipped
} from "#test/emit/emitted-package.fixtures.ts"
import { generateFixture } from "#test/support/cli-package.ts"
import { digestService } from "#test/support/digest.ts"
import { configOf, documentOf, textOf } from "#test/support/openapi-gen.ts"

/**
 * Every package generated from a generated document type-checks, with a lazy root, its runtime verbatim and every
 * printed file one the formatter keeps. An optional query parameter written by content with an array schema, once
 * refused by tsc (its kept case, shrunk at TEST_SEED=2432862457, which the space no longer draws), is a required
 * situation an aimed arm reaches on every run. Its budget is the count its suite stated before the conversion: 8
 * independent cases, and up to 40 steered while a situation is unreached. Its case deadline is five minutes, measured:
 * a case generates a package and runs the package's own tsc over it, and a steered case, which adds an operation for
 * every pending situation, replayed alone took 113 s of wall time for 5.7 CPU-s on cassowary at a load of 454 to 529
 * (2026-11-17, out/replay-ep.txt of lane EOCG-EMIT), past its suite's stated two-minute hang, which the run hit.
 */
export const emittedPackage = property.explore(packageSpace, {
	needs: { digest: digestService },
	situations: [
		"OpenAPI 3.0",
		"OpenAPI 3.1",
		"OpenAPI 3.2",
		"a path parameter",
		"a query deepObject parameter",
		"a query array parameter",
		"a header parameter",
		"a cookie parameter",
		"a querystring parameter",
		"a content parameter",
		"an optional array parameter by content",
		"a JSON body",
		"a form body",
		"a form-data body",
		"a positional multipart/mixed body",
		"a JSON Lines body",
		"a binary body",
		"a text body",
		"several body alternatives",
		"an SSE response",
		"a JSON-seq response",
		"an NDJSON response",
		"a binary response",
		"a problem response with Retry-After",
		"a bearer scheme",
		"a basic scheme",
		"an apiKey header scheme",
		"an apiKey query scheme",
		"an apiKey cookie scheme",
		"an OAuth 2 scheme",
		"an OpenID Connect scheme",
		"a mutual TLS scheme",
		"an author-supplied scheme",
		"an alias",
		"a child group",
		"a group named like a binding",
		"a deprecated operation",
		"a webhook",
		"a non-standard switch",
		"an operation refused"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check:
		({ digest }, k: Case<Feature>) =>
		(drawnCase) =>
			Effect.gen(function* () {
				const service = yield* digest
				const generated = yield* Effect.provideService(
					generateFixture({
						spec: { path: "openapi.json", text: textOf(documentOf(drawnCase.document)) },
						config: { path: "author-config.json", text: textOf(configOf(drawnCase.config)) },
						authorFiles: []
					}),
					Digest.Digest,
					service
				)
				const modules = yield* cliModulesOf(generated.dir)
				k.noteAll(
					featuresOf(
						drawnCase,
						Arr.map(generated.result.report.commandNames, (command) => command.pointer),
						modules
					)
				)
				const kept = yield* unformatted(generated.dir)
				const shipped = yield* unshipped(generated.dir)
				const typecheck = yield* typecheckReport(generated)
				deepStrictEqual(
					{
						typecheck,
						unformatted: kept,
						unshipped: shipped,
						lazyRoot: lazyRootFindings(modules),
						runRecord: runRecordFindings(modules)
					},
					{ typecheck: "", unformatted: [], unshipped: [], lazyRoot: [], runRecord: [] }
				)
			}),
	oracle: {
		kind: "specification",
		name: "tsc over the emitted package, oxfmt's fixed point, the runtime's sources byte for byte and the lazy root's imports"
	},
	kept: [],
	budget: { runs: 8, steered: 40 },
	caseDeadline: 300_000,
	kills: [
		{
			file: "packages/generator/src/emit/cli.ts",
			original: "value: pipe(make, [recording, ...annotationsOf(command, meta, context)])",
			replacement: "value: pipe(make, [...annotationsOf(command, meta, context)])",
			why: "An operation command no longer records the run, so an error raised before its request is sent renders in the default format, not the run's; the property fails (global-settings' claim, m3-wi1a, whose CATCH evidence, a reference-hop cap, went with the caps in ca6d3cd)."
		},
		{
			file: "packages/generator/src/emit/api.ts",
			original: '\t\tif (alternative.codec !== "multipart") {',
			replacement: '\t\tif (alternative.codec === "multipart") {',
			why: "A body's encoder is chosen as if only multipart bodies were not multipart, so every builder writes the wrong encoder for its body; the property fails (CATCH's evidence, mutant 5008fe8599)."
		},
		{
			file: "packages/generator/src/emit/cli.ts",
			original:
				'\talternative.codec === "ndjson" || alternative.codec === "jsonseq" || alternative.codec === "text"',
			replacement:
				'\talternative.codec === "ndjson" || alternative.codec === "jsonseq" || alternative.codec !== "text"',
			why: "Every body alternative but text is taken for a verbatim stream, so a JSON or form body is emitted as raw bytes its builder's types refuse; the property fails (CATCH's evidence, mutant eda74e9a4e)."
		}
	]
})

/**
 * A package whose root services layer drops the Servers service its commands require is refused by tsc, which names it.
 * Its budget is the count its suite stated before the conversion: 8 independent cases, and no steered case (it requires
 * no situation). Its case deadline is its suite's stated hang, two minutes: a case generates a package and runs its tsc.
 */
export const droppedService = property.explore(commandedCaseGen, {
	needs: { digest: digestService },
	situations: [],
	check:
		({ digest }) =>
		(drawnCase) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const service = yield* digest
				const generated = yield* Effect.provideService(
					generateFixture({
						spec: { path: "openapi.json", text: textOf(documentOf(drawnCase.document)) },
						config: { path: "author-config.json", text: textOf(configOf(drawnCase.config)) },
						authorFiles: []
					}),
					Digest.Digest,
					service
				)
				const rootPath = path.join(generated.dir, "src", "cli", "root.ts")
				const root = yield* fs.readFileString(rootPath)
				const dropped = Str.replace(baseUrlLayer, "")(root)
				yield* fs.writeFileString(rootPath, dropped)
				const report = yield* typecheckReport(generated)
				deepStrictEqual(
					{ dropped: dropped !== root, unprovided: Str.includes(UNPROVIDED_SERVERS)(report) },
					{ dropped: true, unprovided: true }
				)
			}),
	oracle: {
		kind: "specification",
		name: "tsc refuses the package and names Servers, the service its commands require"
	},
	kept: [],
	budget: { runs: 8, steered: 0 },
	caseDeadline: 120_000,
	kills: [
		{
			file: "packages/generator/src/emit/domain.ts",
			original: 'expression = { _tag: "Member", name: this.next().text, object: expression }',
			replacement: "{}",
			why: "The domain module's expression parser drops every member access, so what the root's services layer reads is not what it names; the property fails (CATCH's evidence, mutant 0426fcc96b)."
		}
	]
})
