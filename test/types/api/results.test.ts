/**
 * The public-Result program (test/types/api/results.ts): every answer a public reader gives that can refuse with a
 * value, codecText's, rowEvaluator's and each of its items, insertPreview's and a preview's, factsDecoder's and a
 * decode's, and indexesOf's, is
 * Effect's Result of its own success and failure, and neither shape of the engine's own Result (core/result.ts Ok and
 * Err) is assignable to it, so a caller reads one Result. Each answer is a cell of the box; a batch's cells are one
 * program, checked armed. Oracle: the specification, one public Result.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { resultsBox } from "#test/types/api/results.dictionary.ts"
import { resultsProgram } from "#test/types/api/results.ts"

/** Every answer a public reader gives is Effect's Result, and no engine Ok or Err is one. */
export const results = boxAgreement(finite(word(resultsBox)), {
	box: "every answer a public reader gives that can refuse with a value: codecText's text, rowEvaluator's compile, an admission, a generated value, a check's verdict, a selection, insertPreview's compile, a preview, factsDecoder's compile, a decode and indexesOf's index map",
	situations: [],
	notes: () => [],
	checking: "armed",
	program: resultsProgram,
	oracle: { kind: "specification", name: "grizzle answers one Result, Effect's" },
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/public/host.ts",
			original:
				"): ((value: V) => Result.Result<string, CodecFault>) => codecTextOver(field, toResult)",
			replacement:
				'): ((value: V) => Result.Result<string, CodecFault> | import("#compiler/plan/common.ts").Result<string, CodecFault>) => codecTextOver(field, toResult)',
			why: "codecText's text admits the engine's own Result beside Effect's, as an export of the engine's codecText would answer it; the program fails at codecText's text."
		},
		{
			file: "packages/engine/src/types/schema/evaluation.ts",
			original: "\treadonly selected: Result.Result<boolean, Unevaluated>",
			replacement:
				'\treadonly selected: Result.Result<boolean, Unevaluated> | import("@bjornpagen/grizzle-text/base/result").Ok<boolean>',
			why: "A row's selection admits the engine's Ok; the program fails at a selection."
		},
		{
			file: "packages/engine/src/types/changeset/preview.ts",
			original: ") => Result.Result<PreviewRows<S>, PreviewRefusal>",
			replacement:
				') => Result.Result<PreviewRows<S>, PreviewRefusal> | import("@bjornpagen/grizzle-text/base/result").Err<PreviewRefusal>',
			why: "A preview admits the engine's Err; the program fails at a preview."
		},
		{
			file: "packages/engine/src/types/changeset/decode.ts",
			original: "\t) => Result.Result<InsertAllRowsOf<S>[K], FactsRefused>",
			replacement:
				'\t) => Result.Result<InsertAllRowsOf<S>[K], FactsRefused> | import("@bjornpagen/grizzle-text/base/result").Err<FactsRefused>',
			why: "A decode admits the engine's Err; the program fails at a decode."
		}
	]
})
