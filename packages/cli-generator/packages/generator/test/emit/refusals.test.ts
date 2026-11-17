/**
 * The CLI emitter's own refusals, by planted faults. A generated document gains one operation holding exactly one
 * construct the CLI emitter cannot express, from a named family; generation keeps the rest of the package and reports
 * that operation once, at its pointer, as `EMT-1/<reason>` for the family's reason, with no command named for it, and
 * the same run under `--strict` writes nothing and is refused as strict. The families: a boolean path parameter, a
 * path array before another positional, a path parameter written by content, form content in a query parameter (each
 * `unsupported-parameter`), and an event-stream request body, alone or beside an NDJSON or a text alternative
 * (`unsupported-body`).
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Cause, Effect, Exit, Option } from "effect"
import { Digest } from "effect/crypto"
import { caseGen, type Family, generated, pointerOf } from "#test/emit/refusals.fixtures.ts"
import { digestService } from "#test/support/digest.ts"

/**
 * An operation holding one construct the CLI emitter cannot express is refused once at its pointer, and strict writes
 * nothing. Its budget is the count its suite stated before the conversion: 40 independent cases, and up to 100 steered
 * while a situation is unreached.
 */
export const emitRefusals = property.explore(caseGen, {
	needs: { dir: Scratch.dir, digest: digestService },
	situations: [
		"a boolean path parameter",
		"a path array before another positional",
		"a path parameter by content",
		"form content in a query parameter",
		"an event-stream request body",
		"an event-stream alternative beside others"
	] satisfies ReadonlyArray<Reached<Family>>,
	check:
		({ dir, digest }, k: Case<Family>) =>
		(drawnCase) =>
			Effect.gen(function* () {
				k.note(drawnCase.plant.family)
				const root = yield* dir
				const service = yield* digest
				const pointer = pointerOf(drawnCase.plant)
				const lenient = yield* Effect.provideService(
					generated(root, drawnCase, false),
					Digest.Digest,
					service
				)
				const strict = yield* Effect.provideService(
					generated(root, drawnCase, true),
					Digest.Digest,
					service
				)
				const result = yield* lenient.exit
				deepStrictEqual(
					{
						refusals: Arr.map(
							Arr.filter(result.diagnostics, (diagnostic) => diagnostic.pointer === pointer),
							(diagnostic) => diagnostic.code
						),
						commands: Arr.filter(
							result.report.commandNames,
							(command) => command.pointer === pointer
						).length,
						strict: Exit.match(strict.exit, {
							onSuccess: () => Option.none<string>(),
							onFailure: (cause) =>
								Option.map(Cause.findErrorOption(cause), (error) =>
									error._tag === "GenerateRefused" ? error.reason : error._tag
								)
						}),
						strictWrote: strict.written
					},
					{
						refusals: [`EMT-1/${drawnCase.plant.reason}`],
						commands: 0,
						strict: Option.some("strict"),
						strictWrote: false
					}
				)
			}),
	oracle: {
		kind: "specification",
		name: "each planted family's EMT-1 reason, once at its pointer, and nothing written under --strict"
	},
	kept: [],
	budget: { runs: 40, steered: 100 },
	kills: [
		{
			file: "packages/generator/src/generate.ts",
			original: "!Arr.some(named, (key) => sameKey(operation, key.method, key.path))",
			replacement: "Arr.some(named, (key) => sameKey(operation, key.method, key.path))",
			why: "Generation keeps only the operations an operation-scope refusal names and drops every other, so the package loses its commands and the refused one is emitted; the property fails (CATCH's evidence, mutant f7c533c2b1)."
		}
	]
})
