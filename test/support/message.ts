import { Array as Arr, Formatter, Record as Rec, String as Str } from "effect"
import { isCompileError } from "#compiler/core/errors.ts"

/**
 * What a property threw, as a report's error line, followed by the chain of errors its `cause` names, each on a line of
 * its own below the one it caused: a CompileError (every variant) by its reason, location and capability, which its
 * empty message lacks; any other Error by its message, or, when that is empty, by its tag (a Data.TaggedError) or its
 * name and its own fields, an Error among them stated the same way, so no tag or field is lost to an empty message;
 * anything else, which is no Error (an Effect.flip of a success fails with the success's value), by its value as
 * Effect's Formatter renders it, said to be no Error.
 */
export const messageOf = (thrown: unknown): string => chainOf(thrown, 0, new Set())

/** `thrown` at `depth` of a chain, and the errors below it that its `cause` names, each one once. */
const chainOf = (thrown: unknown, depth: number, above: ReadonlySet<unknown>): string => {
	const line = `${depth === 0 ? "" : `${Str.repeat(depth)("  ")}cause: `}${errorLine(thrown)}`
	const seen = new Set([...above, thrown])
	const cause = Error.isError(thrown) ? thrown.cause : undefined
	return cause === undefined || seen.has(cause)
		? line
		: `${line}\n${chainOf(cause, depth + 1, seen)}`
}

/** One error of a chain, as messageOf states it. */
const errorLine = (thrown: unknown): string => {
	if (isCompileError(thrown)) {
		return `CompileError ${thrown.message}`
	}
	if (!Error.isError(thrown)) {
		return `a value that is no Error: ${Formatter.format(thrown)}`
	}
	if (thrown.message !== "") {
		return thrown.message
	}
	return taggedText(thrown, new Set([thrown]))
}

/**
 * An Error by its tag or name and its own fields, its message among them when it is not one of them and says anything.
 */
const taggedText = (error: Error, seen: ReadonlySet<unknown>): string => {
	const label = "_tag" in error ? String(error._tag) : error.name
	const own = Arr.filter(Rec.toEntries(ownFields(error)), ([k]) => k !== "_tag")
	const fields =
		error.message === "" || Arr.some(own, ([k]) => k === "message")
			? own
			: [["message", error.message], ...own]
	return `${label} {${Arr.join(
		Arr.map(fields, ([k, v]) => `${Formatter.format(k)}:${fieldText(v, seen)}`),
		","
	)}}`
}

/**
 * A value among an error's fields: an Error as taggedText states it, each one once; an array or a record with no class
 * of its own element by element; anything else as Effect's Formatter renders it.
 */
const fieldText = (value: unknown, seen: ReadonlySet<unknown>): string => {
	if (Error.isError(value)) {
		return seen.has(value) ? "<an error above>" : taggedText(value, new Set([...seen, value]))
	}
	if (Arr.isArray(value)) {
		return `[${Arr.join(
			Arr.map(value, (v) => fieldText(v, seen)),
			","
		)}]`
	}
	if (typeof value === "object" && value !== null) {
		const proto: unknown = Object.getPrototypeOf(value)
		if (proto === Object.prototype || proto === null) {
			return `{${Arr.join(
				Arr.map(
					Rec.toEntries(ownFields(value)),
					([k, v]) => `${Formatter.format(k)}:${fieldText(v, seen)}`
				),
				","
			)}}`
		}
	}
	return Formatter.format(value)
}

/** An object's own enumerable string-keyed fields, as a record. */
const ownFields = (o: object): Readonly<Record<string, unknown>> => ({ ...o })
