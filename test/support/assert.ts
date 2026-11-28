import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { assertionFailed, type Why } from "@bjornpagen/testing/assert"
import { Result, String as Str } from "effect"
import {
	type CompileError,
	type CompileReason,
	type CompileReasonTag,
	isCompileError,
	type KeyRefusal
} from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { messageOf } from "#test/support/message.ts"

/**
 * grizzle's own assertions, on the testing library's door (@bjornpagen/testing/assert, which holds `assert`, the
 * matchers, the collection checks, the narrowers and failureOf, and every reason as a trailing `...why: Why` tuple):
 * each reads a grizzle type, and fails through the door's assertionFailed, so every failed assertion reports alike.
 * - `succeeded`: a Result's success, unwrapped, a failure described by its fields (a CompileError's reason, location and
 *   capability); a Result is the engine's (core/result.ts) or Effect's, which the shell's own steps answer (AnyResult);
 * - `failed`: a Result's failure, unwrapped;
 * - `refused`: a Result's failure of one typed reason, unwrapped; the reason is a refusal's contract, its prose is not;
 * - `refusedAt`: a Result's failure whose named field holds one value of its literal union, unwrapped, for an error
 *   whose contract is a field other than `reason` (a CliError's stage, a getter of its reason);
 * - `refusalLoc` and `placeOf`: where a CompileError refused, and that location's place, its label and path, which
 *   two refusals at one place share whatever call site each was built at; `artifactRefusal`: a MalformedArtifact's
 *   reason;
 * - `throwsRefused`: the CompileError a builder throws on a malformed call, of one typed reason;
 * - `throwsDefect`: the defect a thunk raises (core/invariant.ts), a bug in grizzle and never a refusal, returning what
 *   it names;
 * - `faulted`: a Result's failure that is one fault of a string-literal fault vocabulary;
 * - `bareRecord`: a record as the row decoders deliver it, with no prototype.
 */

/**
 * A step's answer as the helpers below read it: the engine's Result (core/result.ts), which every compiler pass
 * answers, or Effect's, which the shell's own steps and Effect Schema's synchronous decoders answer.
 */
export type AnyResult<A, E> = Engine.Result<A, E> | Result.Result<A, E>

/** `result` as the engine's Result, read by its tag. */
const engineResult = <A, E>(result: AnyResult<A, E>): Engine.Result<A, E> =>
	Result.isResult(result)
		? Result.isSuccess(result)
			? Engine.ok(result.success)
			: Engine.err(result.failure)
		: result

/**
 * The success of `result`, unwrapped. A failure fails the assertion, described by message.ts messageOf: a
 * CompileError (every variant) by its reason, location and capability, any other tagged error by its fields.
 */
export function succeeded<A, E>(result: AnyResult<A, E>, ...why: Why): A {
	const read = engineResult(result)
	if (read.ok) {
		return read.value
	}
	return assertionFailed(
		why,
		read.error,
		"a success",
		"succeeded",
		`Expected a success, got a failure: ${messageOf(read.error)}`
	)
}

/**
 * The failure of `result`, unwrapped, when it satisfies `holds`: a success, or a failure that does not, fails the
 * assertion as `operator`, expecting `wanted`.
 */
const failureWhere = <E>(
	result: AnyResult<unknown, E>,
	holds: (failure: E) => boolean,
	wanted: string,
	operator: string,
	why: Why
): E => {
	const read = engineResult(result)
	if (read.ok) {
		return assertionFailed(why, read.value, wanted, operator, `Expected ${wanted}, got a success.`)
	}
	if (!holds(read.error)) {
		return assertionFailed(
			why,
			read.error,
			wanted,
			operator,
			`Expected ${wanted}, got: ${messageOf(read.error)}`
		)
	}
	return read.error
}

/** The failure of `result`, unwrapped: a success fails the assertion. */
export function failed<E>(result: AnyResult<unknown, E>, ...why: Why): E {
	return failureWhere(result, () => true, "a failure", "failed", why)
}

/**
 * The failure of `result`, unwrapped, when its reason's tag is `tag`: a success, or a failure of another reason, fails
 * the assertion. The tag is typed by the failure's own reason (a CompileError's is CompileReasonTag), so a misspelt
 * reason is a compile error; what else the refusal states is checked on the failure's reason, never through its prose.
 */
export function refused<E extends { readonly reason: { readonly _tag: string } }>(
	result: AnyResult<unknown, E>,
	tag: NoInfer<E["reason"]["_tag"]>,
	...why: Why
): E {
	return failureWhere(
		result,
		(failure) => failure.reason._tag === tag,
		`a refusal for ${tag}`,
		"refused",
		why
	)
}

/** A CompileError's reason when it is a MalformedArtifact: what grizzle read back, and where in it; any other fails. */
export function artifactRefusal(
	error: CompileError,
	...why: Why
): Extract<CompileReason, { readonly _tag: "MalformedArtifact" }> {
	const reason = error.reason
	if (reason._tag !== "MalformedArtifact") {
		return assertionFailed(
			why,
			reason,
			"a MalformedArtifact",
			"artifactRefusal",
			`Expected a MalformedArtifact, got ${reason._tag}.`
		)
	}
	return reason
}

/**
 * Where a CompileError refused in the user's description or program: its reason's location, a refusal of several keys
 * at the first key the compile met. A MalformedArtifact or an ArtifactFormat refuses at a path inside an artifact, never
 * at a source location, so it fails the assertion.
 */
export function refusalLoc(error: CompileError, ...why: Why): SourceLoc {
	const reason = error.reason
	if (reason._tag === "MalformedArtifact" || reason._tag === "ArtifactFormat") {
		return assertionFailed(
			why,
			reason,
			"a refusal at a source location",
			"refusalLoc",
			`Expected a source location, got ${reason._tag}.`
		)
	}
	return reason._tag === "UnrepresentableKey" ? reason.keys[0].at : reason.at
}

/**
 * The keys an UnrepresentableKey refusal names, in the order the compile met them: a refusal of any other reason fails
 * the assertion.
 */
export function refusedKeys(error: CompileError, ...why: Why): NonEmptyReadonlyArray<KeyRefusal> {
	const reason = error.reason
	if (reason._tag !== "UnrepresentableKey") {
		return assertionFailed(
			why,
			reason,
			"an UnrepresentableKey",
			"refusedKeys",
			`Expected an UnrepresentableKey, got ${reason._tag}.`
		)
	}
	return reason.keys
}

/** The one key an UnrepresentableKey refusal names: a refusal of any other reason, or of several keys, fails the
 * assertion. */
export function refusedKey(error: CompileError, ...why: Why): KeyRefusal {
	const keys = refusedKeys(error, ...why)
	if (keys.length !== 1) {
		return assertionFailed(
			why,
			keys,
			"one unrepresentable key",
			"refusedKey",
			`Expected one key, got ${keys.length}.`
		)
	}
	return keys[0]
}

/**
 * Where a location is, as a refusal's domain names it: its label and its path, never its call site, which is where a
 * builder happened to run, and never its printed text (core/loc.ts formatLoc), which formats all three.
 */
export type Place = Readonly<{ label: string; path: ReadonlyArray<string | number> }>

/** The place of a location: what two locations of one place share, compared by deepEqual. */
export const placeOf = (loc: SourceLoc): Place => ({ label: loc.label, path: loc.path })

/**
 * The fields of E whose type is a union of string literals: the fields a refusal's contract can name exactly, a getter
 * included. A field of type string (a CliError's message) is none of them.
 */
export type LiteralFields<E> = {
	[K in keyof E]-?: E[K] extends string ? (string extends E[K] ? never : K) : never
}[keyof E]

/**
 * The failure of `result`, unwrapped, when its field `field` holds `value`: a success, or a failure whose field holds
 * another value, fails the assertion. For an error whose contract is a field other than `reason`, such as a CliError's
 * stage: the field must be one of LiteralFields<E> and the value one of its literals, so a wrong field or value is a
 * compile error; the rest of the refusal is checked on the failure returned.
 */
export function refusedAt<E, K extends LiteralFields<E>>(
	result: AnyResult<unknown, E>,
	field: K,
	value: NoInfer<E[K]>,
	...why: Why
): E {
	return failureWhere(
		result,
		(failure) => failure[field] === value,
		`a refusal with ${String(field)} ${String(value)}`,
		"refusedAt",
		why
	)
}

/**
 * The CompileError `thunk` throws, when its reason's tag is `tag`: for a builder that throws on a malformed call rather
 * than returning a Result. A thunk that returns, throws anything but a CompileError, or throws one of another reason
 * fails the assertion. The tag is a CompileReasonTag, so a misspelt reason is a compile error; what else the refusal
 * states is checked on its reason, never through its prose.
 */
export function throwsRefused(
	thunk: () => unknown,
	tag: CompileReasonTag,
	...why: Why
): CompileError {
	const wanted = `a CompileError for ${tag}`
	const outcome = Result.try(thunk)
	if (Result.isSuccess(outcome)) {
		return assertionFailed(
			why,
			outcome.success,
			wanted,
			"throwsRefused",
			`Expected ${wanted}, got a return.`
		)
	}
	const thrown = outcome.failure
	if (!isCompileError(thrown) || thrown.reason._tag !== tag) {
		return assertionFailed(
			why,
			thrown,
			wanted,
			"throwsRefused",
			`Expected ${wanted}, got: ${messageOf(thrown)}`
		)
	}
	return thrown
}

/** The prefix of every defect's message (core/invariant.ts defect). */
const defectPrefix = "grizzle internal invariant: "

/**
 * The defect `thunk` raises (core/invariant.ts defect): an Error whose message is an internal invariant's, what it names
 * returned, the text after the prefix. A thunk that returns, or throws anything else (a CompileError included), fails
 * the assertion: a defect is a bug in grizzle, never a refusal of anyone's input.
 */
export function throwsDefect(thunk: () => unknown, ...why: Why): string {
	const wanted = "a defect"
	const outcome = Result.try(thunk)
	if (Result.isSuccess(outcome)) {
		return assertionFailed(
			why,
			outcome.success,
			wanted,
			"throwsDefect",
			`Expected ${wanted}, got a return.`
		)
	}
	const thrown = outcome.failure
	if (!(thrown instanceof Error) || !Str.startsWith(defectPrefix)(thrown.message)) {
		return assertionFailed(
			why,
			thrown,
			wanted,
			"throwsDefect",
			`Expected ${wanted}, got: ${messageOf(thrown)}`
		)
	}
	return Str.slice(defectPrefix.length)(thrown.message)
}

/**
 * The failure of `result` when it is the fault `fault`: a success, or another fault, fails the assertion, described as
 * `refused` describes one. For the readers and converters whose failure is a string literal of a fault vocabulary
 * (core/errors.ts ValueFault, kernel/strict.ts StrictFault), the fault is typed by it, so a misspelt fault is a compile
 * error.
 */
export function faulted<E extends string>(
	result: AnyResult<unknown, E>,
	fault: NoInfer<E>,
	...why: Why
): void {
	const read = engineResult(result)
	if (read.ok) {
		assertionFailed(
			why,
			read.value,
			fault,
			"faulted",
			`Expected the fault ${fault}, got a success.`
		)
	} else if (read.error !== fault) {
		assertionFailed(
			why,
			read.error,
			fault,
			"faulted",
			`Expected the fault ${fault}, got: ${read.error}`
		)
	}
}

/**
 * A record as grizzle's row decoders deliver it: an object with no prototype, so that a field named like a member of
 * Object.prototype is an ordinary field (packages/engine/src/codec/row.ts). deepEqual compares prototypes, so an expected
 * decoded record is built with this.
 */
export const bareRecord = <T extends object>(fields: T): T =>
	Object.assign({ __proto__: null }, fields)
