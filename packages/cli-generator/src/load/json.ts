import type { Json } from "@bjornpagen/grizzle-text/utf8"
import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Predicate, Result, String as Str } from "effect"
import { byteOffset } from "#load/offset.ts"
import { refuse, wholeInput } from "#load/read.ts"
import type { LoadRefusal, Position } from "#load/read.ts"
import type { DocumentUri } from "#model/brands.ts"
import { isJson } from "#model/json-tree.ts"
import { formatPointer } from "#model/pointer.ts"
import { parseJson } from "#runtime/json.ts"

const nameMapKeys: ReadonlySet<string> = new Set([
	"$defs",
	"callbacks",
	"definitions",
	"dependentSchemas",
	"encoding",
	"headers",
	"links",
	"mediaTypes",
	"parameters",
	"patternProperties",
	"pathItems",
	"properties",
	"requestBodies",
	"responses",
	"schemas",
	"securitySchemes",
	"variables"
])

const dataKeys: ReadonlySet<string> = new Set(["const", "default", "enum"])

const opaqueKeys: ReadonlySet<string> = new Set(["example", "examples"])

const largestSafeValue = 2 ** 53

/**
 * The JSON value of a text, or none where `JSON.parse` refuses it.
 */
const jsonValueOf = (text: string): Option.Option<Json> =>
	Option.filter(Result.getSuccess(parseJson(text)), isJson)

/**
 * The key a raw (still escaped) member name denotes. A key's decoding matters only once
 * `JSON.parse` has accepted the text, so every raw key is then a valid JSON string body; on
 * malformed text the raw spelling stands in.
 */
const unescapeKey = (raw: string): string =>
	Option.getOrElse(
		Option.filter(Result.getSuccess(parseJson(`"${raw}"`)), Predicate.isString),
		() => raw
	)

const numberToken = regex(
	"^-?(?<int>[0-9]+)(?:\\.(?<frac>[0-9]+))?(?:[eE](?<exp>[+-]?[0-9]+))?$",
	"u"
)

const leadingZeros = regex("^0+", "u")

const trailingZeros = regex("0+$", "u")

interface Numeric {
	readonly digits: string
	readonly exponent: number
}

/**
 * The value as `digits * 10^exponent` with no leading or trailing zeros in `digits`; sign ignored.
 */
const decimalOf = (token: string): Numeric | undefined => {
	const groups = numberToken.exec(token)?.groups

	if (groups === undefined) {
		return undefined
	}

	const fraction = groups.frac ?? ""
	const all = Str.replace(leadingZeros, "")(`${groups.int}${fraction}`)
	const digits = Str.replace(trailingZeros, "")(all)
	const exponent = Number(groups.exp ?? "0") - fraction.length + (all.length - digits.length)

	return Str.isEmpty(digits) ? { digits: "", exponent: 0 } : { digits, exponent }
}

const sameDecimal = (left: Numeric, right: Numeric): boolean =>
	left.digits === right.digits && left.exponent === right.exponent

/**
 * A number literal that does not survive `JSON.parse`: not finite, an integer beyond 2^53,
 * or a decimal whose digits differ from the shortest decimal of the double it parses to.
 */
const isUnsafeNumber = (token: string): boolean => {
	const written = decimalOf(token)

	if (written === undefined) {
		return false
	}

	const value = Math.abs(Number(token))
	const parsed = decimalOf(String(value))

	return (
		!Number.isFinite(value) ||
		value > largestSafeValue ||
		parsed === undefined ||
		!sameDecimal(written, parsed)
	)
}

interface Frame {
	readonly array: boolean
	readonly data: boolean
	readonly nameMap: boolean
	readonly opaque: boolean
	readonly keys: Set<string>
	expectKey: boolean
	index: number
	key: string
}

interface Context {
	readonly data: boolean
	readonly nameMap: boolean
	readonly opaque: boolean
}

interface Finding {
	readonly code: "DOC-14/duplicate-key" | "DOC-14/unsafe-integer"
	readonly index: number
	readonly pointer: string
}

const rootContext: Context = { data: false, nameMap: false, opaque: false }

const valueContext = (frame: Frame | undefined): Context => {
	if (frame === undefined) {
		return rootContext
	}

	if (frame.array || frame.nameMap) {
		return { data: frame.data, nameMap: false, opaque: frame.opaque }
	}

	const data = frame.data || (!frame.opaque && dataKeys.has(frame.key))
	const opaque = !data && (frame.opaque || opaqueKeys.has(frame.key))

	return { data, nameMap: !data && !opaque && nameMapKeys.has(frame.key), opaque }
}

const pointerOf = (frames: readonly Frame[]): string =>
	formatPointer(Arr.map(frames, (frame) => (frame.array ? `${frame.index}` : frame.key)))

const stringEnd = (text: string, start: number): number => {
	let end = start + 1

	while (end < text.length && text[end] !== '"') {
		end += text[end] === "\\" ? 2 : 1
	}

	return end
}

const tokenEnd = (text: string, start: number): number => {
	let end = start

	while (end < text.length && !Str.includes(text[end] ?? "")(",:{}[] \t\n\r")) {
		end += 1
	}

	return Math.max(end, start + 1)
}

interface State {
	readonly frames: Frame[]
	readonly text: string
	cursor: number
	finding: Finding | undefined
}

const record = (state: State, code: Finding["code"], index: number): void => {
	state.finding ??= { code, index, pointer: pointerOf(state.frames) }
}

const open = (state: State, char: string): void => {
	state.frames.push({
		...valueContext(state.frames.at(-1)),
		array: char === "[",
		expectKey: char === "{",
		index: 0,
		key: "",
		keys: new Set()
	})
	state.cursor += 1
}

const separator = (state: State, char: string): void => {
	const top = state.frames.at(-1)

	if (top !== undefined && char === ":") {
		top.expectKey = false
	} else if (top?.array === true) {
		top.index += 1
	} else if (top !== undefined) {
		top.expectKey = true
	}

	state.cursor += 1
}

const string = (state: State): void => {
	const top = state.frames.at(-1)
	const end = stringEnd(state.text, state.cursor)

	if (top !== undefined && !top.array && top.expectKey) {
		const raw = Str.slice(state.cursor + 1, end)(state.text)

		top.key = Str.includes("\\")(raw) ? unescapeKey(raw) : raw

		if (top.keys.has(top.key)) {
			record(state, "DOC-14/duplicate-key", state.cursor)
		}

		top.keys.add(top.key)
	}

	state.cursor = end + 1
}

const token = (state: State): void => {
	const end = tokenEnd(state.text, state.cursor)

	if (
		valueContext(state.frames.at(-1)).data &&
		isUnsafeNumber(Str.slice(state.cursor, end)(state.text))
	) {
		record(state, "DOC-14/unsafe-integer", state.cursor)
	}

	state.cursor = end
}

/**
 * One iterative pass over the text, its own stack of open objects and arrays standing in for recursion, so no nesting
 * the text holds overflows it: the first repeated key, or unsafe integer at a `default`/`enum`/`const` site. It
 * tolerates malformed input; `JSON.parse` judges syntax.
 */
const scan = (text: string): Finding | undefined => {
	const state: State = {
		cursor: 0,
		finding: undefined,
		frames: [],
		text
	}

	while (state.cursor < text.length) {
		const char = text[state.cursor] ?? ""

		if (char === "{" || char === "[") {
			open(state, char)
		} else if (char === "}" || char === "]") {
			state.frames.pop()
			state.cursor += 1
		} else if (char === "," || char === ":") {
			separator(state, char)
		} else if (char === '"') {
			string(state)
		} else if (Str.includes(char)(" \t\n\r")) {
			state.cursor += 1
		} else {
			token(state)
		}
	}

	return state.finding
}

const codePointCount = (text: string): number => Arr.fromIterable(text).length

const locate = (text: string, index: number, byteBase: number): Position => {
	const lines = Str.split(Str.slice(0, index)(text), "\n")

	return {
		column: codePointCount(Arr.lastNonEmpty(lines)) + 1,
		line: lines.length,
		offset: byteOffset(text, index, byteBase)
	}
}

/**
 * `JSON.parse` plus a duplicate-key scan over the same text. `byteBase` is the number of bytes
 * before `text` in the input (a byte order mark), so reported offsets are input offsets.
 */
export const parseStrictJson: (
	text: string,
	document: DocumentUri,
	byteBase: number
) => Effect.Effect<Json, LoadRefusal> = Effect.fnUntraced(function* strictJson(
	text: string,
	document: DocumentUri,
	byteBase: number
) {
	const value = yield* Option.match(jsonValueOf(text), {
		onNone: () => refuse(document, "DOC-14/invalid-json", wholeInput),
		onSome: Effect.succeed
	})
	const finding = scan(text)

	if (finding !== undefined) {
		return yield* refuse(document, finding.code, {
			pointer: finding.pointer,
			position: Option.some(locate(text, finding.index, byteBase))
		})
	}

	return value
})
