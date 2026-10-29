import { Array as Arr, Effect, Result, Schema, String as Str } from "effect"

import { regex } from "arkregex"
const Range = Schema.Struct({ startOffset: Schema.Int, endOffset: Schema.Int, count: Schema.Int })
const FunctionCoverage = Schema.Struct({ functionName: Schema.String, ranges: Schema.Array(Range) })
const ScriptHeader = Schema.Struct({ url: Schema.String })
const ScriptCoverage = Schema.Struct({
	url: Schema.String,
	functions: Schema.Array(FunctionCoverage)
})
const CoverageFile = Schema.fromJsonString(Schema.Struct({ result: Schema.Array(Schema.Unknown) }))

type Range = typeof Range.Type

/** The ranges of one script in one dump, as V8 reported them. */
export type ScriptRanges = ReadonlyArray<Range>

/**
 * One function of one script: its name as V8 reports it ("" when it has none) and its ranges, the first being the
 * function itself and the rest its blocks.
 */
type FunctionRanges = typeof FunctionCoverage.Type

/** One script of one dump: its path relative to the root, and its functions. */
interface ScriptDump {
	readonly path: string
	readonly functions: ReadonlyArray<FunctionRanges>
}

/**
 * Whether a path names a coverage dump as Node names one, `coverage-<pid>-<timestamp>-<sequence>.json`, so a report
 * written beside the dumps is never read as one.
 */
export const isDump = (path: string): boolean =>
	regex("(?:^|/)coverage-\\d+-\\d+-\\d+\\.json$").test(path)

/** One dump's text, the root its scripts are judged under, and the paths relative to that root to keep. */
export interface DumpInput {
	readonly text: string
	readonly root: string
	readonly wanted: ReadonlySet<string>
}

/**
 * The scripts of one dump that lie under the root and whose relative paths are wanted.
 *
 * V8's block coverage reports, per function, nested ranges with execution counts; the count at an offset is the count
 * of the innermost range holding it. Node's type stripping replaces types with whitespace, so a coverage offset is an
 * offset of the TypeScript source. A function V8 never compiled may go unreported, which makes its parent's count
 * stand for it: a mutant then selects more test files, never fewer.
 */
export const scriptsOfDump = Effect.fn("scriptsOfDump")(function* (input: DumpInput) {
	const base = Str.endsWith("/")(input.root) ? input.root : `${input.root}/`
	const dump = yield* Schema.decodeEffect(CoverageFile)(input.text)
	const scripts = yield* Effect.forEach(dump.result, (entry) =>
		Effect.gen(function* () {
			const { url } = yield* Schema.decodeUnknownEffect(ScriptHeader)(entry)
			const local = Str.startsWith("file://")(url)
				? decodeURIComponent(Str.slice("file://".length)(url))
				: ""
			const relative = Str.startsWith(base)(local) ? Str.slice(base.length)(local) : ""
			if (!input.wanted.has(relative)) {
				return Result.failVoid
			}
			const script = yield* Schema.decodeUnknownEffect(ScriptCoverage)(entry)
			return Result.succeed<ScriptDump>({ path: relative, functions: script.functions })
		})
	)
	return Arr.filterMap(scripts, (script) => script)
})

/** An offset of a script and the ranges one dump reports for it. */
export interface Probe {
	readonly ranges: ScriptRanges
	readonly offset: number
}

/**
 * Whether the offset executed in the dump: the innermost range holding it has a positive count. An offset no range
 * holds lies outside every function V8 saw, which only happens for a script that never loaded.
 */
export const covered = ({ ranges, offset }: Probe): boolean => {
	const innermost = Arr.reduce(ranges, undefined, (best: Range | undefined, r) => {
		if (r.startOffset > offset || offset >= r.endOffset) {
			return best
		}
		return best === undefined || r.endOffset - r.startOffset <= best.endOffset - best.startOffset
			? r
			: best
	})
	return innermost !== undefined && innermost.count > 0
}
