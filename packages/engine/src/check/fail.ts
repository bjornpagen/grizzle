import { Refusal } from "#compiler/core/canonical.ts"
import type { RecursionRefusal } from "#compiler/core/causes.ts"
import {
	CompileError,
	type CompileReason,
	type ProseTag,
	prose,
	recursionRefused
} from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type * as Result from "#compiler/core/result.ts"

/**
 * Refusal plumbing for the checker (compilation returns a Result and never throws).
 *
 * Deep inside a check the first refusal stops the whole check, so the checker throws the kernel's Refusal, which its
 * entry points turn into the Result's failure (core/canonical.ts catchRefusal). Nothing else is caught: a JavaScript
 * error escaping a check is a defect of the checker, never a description problem, and stays a defect.
 *
 * Every refusal carries a location: the source location the builder recorded on the offending
 * description when it has one, otherwise the structural path through the description from the query's root, such as
 * `query at stage.arms[0].where[1]`.
 *
 * A function declaration, so that control flow knows a call never returns.
 */
export function fail(tag: ProseTag, loc: SourceLoc, text: string): never {
	throw new Refusal(CompileError.make(prose(tag, loc, text)))
}

/** A refusal for `reason`, a reason with facts beyond a sentence. A function declaration, as fail is. */
export function failWith(reason: CompileReason): never {
	throw new Refusal(CompileError.make(reason))
}

/**
 * A recursion refusal at `loc` (check/recursion). A function declaration, so that control flow knows a call never
 * returns.
 */
export function failRecursion(loc: SourceLoc, cause: RecursionRefusal): never {
	throw new Refusal(recursionRefused(loc, cause))
}

export const unwrap = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw new Refusal(result.error)
	}
	return result.value
}

export const rootLoc = (label: string): SourceLoc => SourceLoc(label, [])
