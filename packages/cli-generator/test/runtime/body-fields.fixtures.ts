/** What the property of body-fields.test.ts reads: the body sources and field flags it draws, and the merge model. */

import { utf8Text } from "@bjornpagen/grizzle-text/utf8"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Predicate,
	Record,
	Redacted,
	Ref,
	Schema,
	Sink,
	Stdio,
	Stream,
	String as Str
} from "effect"
import * as Input from "#runtime-src/runtime/input.ts"
import * as Output from "#runtime-src/runtime/output.ts"
import { RunCredentials, type ScrubEntry } from "#runtime-src/runtime/redact.ts"

/** A JSON value as drawn: scalars keep their source text, so a number is written exactly as it was given. */
export type Tree =
	| Readonly<{ kind: "string"; text: string }>
	| Readonly<{ kind: "boolean"; value: boolean }>
	| Readonly<{ kind: "null" }>
	| Readonly<{ kind: "number"; text: string }>
	| Readonly<{ kind: "array"; items: ReadonlyArray<Tree> }>
	| Readonly<{ kind: "object"; members: ReadonlyArray<readonly [string, Tree]> }>

/** Where a file-backed value comes from: a file in the case's directory, stdin (`-`), or a path that does not exist. */
export type From = "file" | "stdin" | "missing"

/** The request body source: none, `--body`, `--body-file` (a file, stdin or a missing path), or both flags at once. */
export type Source =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "body"; text: string }>
	| Readonly<{ kind: "bodyFile"; text: string; from: From }>
	| Readonly<{ kind: "both"; text: string }>

/** The bytes a base64 field reads: a few drawn bytes, or a patterned file past one 32 KiB read chunk. */
export type Bytes =
	| Readonly<{ kind: "small"; bytes: ReadonlyArray<number> }>
	| Readonly<{ kind: "large"; size: number; shift: number }>

/** One field flag's value: absent, a JSON value, a number given as text, a base64 file, or a secret file. */
export type FieldSketch =
	| Readonly<{ kind: "absent" }>
	| Readonly<{ kind: "value"; value: Tree }>
	| Readonly<{ kind: "jsonNumber"; text: string }>
	| Readonly<{ kind: "file"; encoding: Input.FieldEncoding; bytes: Bytes; from: From }>
	| Readonly<{ kind: "secret"; text: string; utf8: boolean; from: From }>

/** A field flag: its RFC 6901 pointer into the body, the flag name derived from it, and its value. */
export type Field = Readonly<{ segments: Arr.NonEmptyReadonlyArray<string>; sketch: FieldSketch }>

/** One merge case: the source, the field flags in order, whether the body is required, and its schema. */
export type Merge = Readonly<{
	source: Source
	fields: ReadonlyArray<Field>
	required: boolean
	schema: "unknown" | "person"
}>

const SEGMENTS = ["name", "count", "user", "avatar", "tags", "__proto__"] as const

const STRINGS = ["Ada", "a b", 'q"uote', "back\\slash", "é", "line\nbreak", "Ada Lovelace"] as const

const NUMBERS = [
	"7",
	"-3",
	"0",
	"12345678901234567890",
	"1.50",
	"1e2",
	"-0",
	"2.5E-3",
	"9007199254740993"
] as const

const leaf: Gen<Tree> = oneOf<Tree>([
	map(element(STRINGS), (text): Tree => ({ kind: "string", text })),
	map(boolean, (value): Tree => ({ kind: "boolean", value })),
	constant<Tree>({ kind: "null" }),
	map(element(NUMBERS), (text): Tree => ({ kind: "number", text }))
])

const members = (value: Gen<Tree>): Gen<ReadonlyArray<readonly [string, Tree]>> =>
	uniqueArray(element(SEGMENTS), (key) => map(value, (tree) => [key, tree] as const), {
		min: 0,
		max: 3
	})

const shallow: Gen<Tree> = weighted<Tree>([
	[4, leaf],
	[1, map(array(leaf, { min: 0, max: 2 }), (items): Tree => ({ kind: "array", items }))],
	[1, map(members(leaf), (drawn): Tree => ({ kind: "object", members: drawn }))]
])

const objectTree: Gen<Tree> = map(members(shallow), (drawn): Tree => ({
	kind: "object",
	members: drawn
}))

const hexOf = (unit: number): string => Str.padStart(4, "0")(unit.toString(16))

/** A string as JSON writes it: quote, backslash and the control characters escaped, everything else as is. */
const quoted = (text: string): string =>
	`"${Arr.join(
		Arr.map(Arr.fromIterable(text), (char) => {
			const unit = Option.getOrElse(Str.charCodeAt(0)(char), () => 0)
			if (char === '"' || char === "\\") {
				return `\\${char}`
			}
			if (char === "\n") {
				return "\\n"
			}
			return unit < 0x20 ? `\\u${hexOf(unit)}` : char
		}),
		""
	)}"`

/** The compact JSON text of a drawn tree: a second writer, recursive, beside the runtime's stack walk. */
const writeTree = (tree: Tree): string => {
	switch (tree.kind) {
		case "string":
			return quoted(tree.text)
		case "boolean":
			return tree.value ? "true" : "false"
		case "null":
			return "null"
		case "number":
			return tree.text
		case "array":
			return `[${Arr.join(Arr.map(tree.items, writeTree), ",")}]`
		case "object":
			return `{${Arr.join(
				Arr.map(tree.members, ([key, member]) => `${quoted(key)}:${writeTree(member)}`),
				","
			)}}`
	}
}

const bodyText: Gen<string> = weighted<string>([
	[6, map(objectTree, writeTree)],
	[1, map(shallow, writeTree)],
	[1, element(["{not json", '{"a":}', "", "[1,", "{'a':1}"])]
])

const from: Gen<From> = weighted<From>([
	[4, constant<From>("file")],
	[2, constant<From>("stdin")],
	[1, constant<From>("missing")]
])

const source: Gen<Source> = weighted<Source>([
	[2, constant<Source>({ kind: "none" })],
	[3, map(bodyText, (text): Source => ({ kind: "body", text }))],
	[2, (drawn) => ({ kind: "bodyFile", text: bodyText(drawn), from: from(drawn) })],
	[1, map(bodyText, (text): Source => ({ kind: "both", text }))]
])

const smallBytes: Gen<Bytes> = map(array(int(0, 255), { min: 0, max: 8 }), (bytes): Bytes => ({
	kind: "small",
	bytes
}))

const largeBytes: Gen<Bytes> = (drawn) => ({
	kind: "large",
	size: element([32_769, 98_306])(drawn),
	shift: int(0, 255)(drawn)
})

const SECRETS = ['pa55"word\n', "pw\r\n", "pw\n\n", "pw", "pa55 w0rd\n", "s3cr3t-value"] as const

const fieldSketch: Gen<FieldSketch> = weighted<FieldSketch>([
	[1, constant<FieldSketch>({ kind: "absent" })],
	[3, map(shallow, (value): FieldSketch => ({ kind: "value", value }))],
	[
		1,
		map(element([...NUMBERS, "1.5x", "0x10", "1."]), (text): FieldSketch => ({
			kind: "jsonNumber",
			text
		}))
	],
	[
		2,
		(drawn) => ({
			kind: "file",
			encoding: element(["base64", "base64url"] as const)(drawn),
			bytes: weighted<Bytes>([
				[6, smallBytes],
				[1, largeBytes]
			])(drawn),
			from: from(drawn)
		})
	],
	[
		2,
		(drawn) => ({
			kind: "secret",
			text: element(SECRETS)(drawn),
			utf8: weighted<boolean>([
				[6, constant(true)],
				[1, constant(false)]
			])(drawn),
			from: from(drawn)
		})
	]
])

const pointerSegments: Gen<Arr.NonEmptyReadonlyArray<string>> = (drawn) => {
	const first = element(SEGMENTS)(drawn)
	return boolean(drawn) ? [first, element(SEGMENTS)(drawn)] : [first]
}

/** The pointer a field writes at. */
const pointerOf = (field: Field): string => `/${Arr.join(field.segments, "/")}`

/** The flag a field is given by: its segments joined with dashes, the one name a failure of it carries. */
const flagOf = (field: Field): string => Arr.join(field.segments, "-")

const fields: Gen<ReadonlyArray<Field>> = map(
	uniqueArray(
		map(pointerSegments, (segments) => Arr.join(segments, "/")),
		(joined) => map(fieldSketch, (sketch) => ({ joined, sketch })),
		{ min: 0, max: 3 }
	),
	(drawn) =>
		Arr.flatMap(drawn, ({ joined, sketch }) =>
			Option.toArray(
				Option.map(
					Arr.match(Str.split("/")(joined), { onEmpty: Option.none, onNonEmpty: Option.some }),
					(segments) => ({
						segments,
						sketch
					})
				)
			)
		)
)

/** Merge cases: every source with up to three field flags, the body required or not, under either schema. */
export const merges: Gen<Merge> = (drawn) => ({
	source: source(drawn),
	fields: fields(drawn),
	required: boolean(drawn),
	schema: weighted<"unknown" | "person">([
		[4, constant("unknown" as const)],
		[1, constant("person" as const)]
	])(drawn)
})

const withField = (field: Field): Gen<Merge> =>
	map(merges, (drawn) => ({
		...drawn,
		schema: "unknown",
		source: drawn.source.kind === "both" ? { kind: "none" } : drawn.source,
		fields: [field]
	}))

/** Merge cases aimed at the situations a plain draw reaches rarely. */
export const mergeArms = {
	large: map(int(0, 255), (shift): Merge => ({
		source: { kind: "none" },
		fields: [
			{
				segments: ["avatar"],
				sketch: {
					kind: "file",
					encoding: "base64url",
					bytes: { kind: "large", size: 32_769, shift },
					from: "file"
				}
			}
		],
		required: false,
		schema: "unknown"
	})),
	twoStdin: map(element(["base64", "base64url"] as const), (encoding): Merge => ({
		source: { kind: "bodyFile", text: "{}", from: "stdin" },
		fields: [
			{
				segments: ["avatar"],
				sketch: {
					kind: "file",
					encoding,
					bytes: { kind: "small", bytes: [251, 255] },
					from: "stdin"
				}
			}
		],
		required: false,
		schema: "unknown"
	})),
	secretStdin: map(element(SECRETS), (text): Merge => ({
		source: { kind: "body", text: '{"name":"x"}' },
		fields: [
			{ segments: ["user", "name"], sketch: { kind: "secret", text, utf8: true, from: "stdin" } }
		],
		required: false,
		schema: "unknown"
	})),
	secretNotUtf8: withField({
		segments: ["name"],
		sketch: { kind: "secret", text: "pw", utf8: false, from: "file" }
	}),
	proto: map(element(STRINGS), (text): Merge => ({
		source: { kind: "none" },
		fields: [
			{
				segments: ["__proto__", "name"],
				sketch: { kind: "value", value: { kind: "string", text } }
			}
		],
		required: false,
		schema: "unknown"
	})),
	person: map(element(STRINGS), (text): Merge => ({
		source: { kind: "body", text: '{"count":12345678901234567890}' },
		fields: [{ segments: ["name"], sketch: { kind: "value", value: { kind: "string", text } } }],
		required: true,
		schema: "person"
	})),
	nonObject: map(element(["[1]", '"x"', "3", "null"]), (text): Merge => ({
		source: { kind: "body", text },
		fields: [
			{ segments: ["name"], sketch: { kind: "value", value: { kind: "string", text: "x" } } }
		],
		required: false,
		schema: "unknown"
	})),
	invalidJson: map(element(["{not json", '{"a":}', "", "[1,"]), (text): Merge => ({
		source: { kind: "body", text },
		fields: [],
		required: false,
		schema: "unknown"
	})),
	verbatim: map(map(objectTree, writeTree), (text): Merge => ({
		source: { kind: "body", text },
		fields: [],
		required: false,
		schema: "unknown"
	})),
	fileStdin: map(element(["base64", "base64url"] as const), (encoding): Merge => ({
		source: { kind: "none" },
		fields: [
			{
				segments: ["avatar"],
				sketch: {
					kind: "file",
					encoding,
					bytes: { kind: "small", bytes: [251, 255] },
					from: "stdin"
				}
			}
		],
		required: false,
		schema: "unknown"
	})),
	badNumber: withField({ segments: ["count"], sketch: { kind: "jsonNumber", text: "1.5x" } }),
	keptNumber: map(element(["12345678901234567890", "1.50", "1e2"]), (text): Merge => ({
		source: { kind: "body", text: `{"count":${text},"name":"Ada"}` },
		fields: [
			{
				segments: ["user", "avatar"],
				sketch: { kind: "value", value: { kind: "boolean", value: true } }
			}
		],
		required: false,
		schema: "unknown"
	}))
} as const

/** A model JSON node a merge writes into: an object's members kept in insertion order by a Map. */
type Node =
	| Readonly<{ kind: "leaf"; text: string }>
	| Readonly<{ kind: "array"; items: ReadonlyArray<Node> }>
	| Readonly<{ kind: "object"; members: Map<string, Node> }>

const nodeOf = (tree: Tree): Node => {
	switch (tree.kind) {
		case "array":
			return { kind: "array", items: Arr.map(tree.items, nodeOf) }
		case "object":
			return {
				kind: "object",
				members: new Map(Arr.map(tree.members, ([key, member]) => [key, nodeOf(member)] as const))
			}
		case "string":
		case "boolean":
		case "null":
		case "number":
			return { kind: "leaf", text: writeTree(tree) }
	}
}

const writeNode = (node: Node): string => {
	switch (node.kind) {
		case "leaf":
			return node.text
		case "array":
			return `[${Arr.join(Arr.map(node.items, writeNode), ",")}]`
		case "object":
			return `{${Arr.join(
				Arr.map(
					Arr.fromIterable(node.members),
					([key, member]) => `${quoted(key)}:${writeNode(member)}`
				),
				","
			)}}`
	}
}

const isDigit = (char: string | undefined): boolean =>
	char !== undefined && char >= "0" && char <= "9"

/** A small recursive-descent JSON reader that keeps each number's text: the model's own parse of a source body. */
const parseJson = (text: string): Option.Option<Tree> => {
	let at = 0
	const space = () => {
		while (text[at] === " " || text[at] === "\n" || text[at] === "\t" || text[at] === "\r") {
			at += 1
		}
	}
	const stringAt = (): Option.Option<string> => {
		if (text[at] !== '"') {
			return Option.none()
		}
		at += 1
		let out = ""
		while (at < text.length && text[at] !== '"') {
			if (text[at] === "\\") {
				const next = text[at + 1]
				if (next === "u") {
					out += String.fromCharCode(Number.parseInt(Str.slice(at + 2, at + 6)(text), 16))
					at += 6
				} else {
					out += next === "n" ? "\n" : (next ?? "")
					at += 2
				}
			} else {
				out += text[at] ?? ""
				at += 1
			}
		}
		if (text[at] !== '"') {
			return Option.none()
		}
		at += 1
		return Option.some(out)
	}
	const valueAt = (): Option.Option<Tree> => {
		space()
		const char = text[at]
		if (char === "{") {
			at += 1
			const drawn: Array<readonly [string, Tree]> = []
			space()
			if (text[at] === "}") {
				at += 1
				return Option.some({ kind: "object", members: drawn })
			}
			for (;;) {
				space()
				const key = stringAt()
				space()
				if (Option.isNone(key) || text[at] !== ":") {
					return Option.none()
				}
				at += 1
				const member = valueAt()
				if (Option.isNone(member)) {
					return Option.none()
				}
				drawn.push([key.value, member.value])
				space()
				if (text[at] === "}") {
					at += 1
					return Option.some({ kind: "object", members: drawn })
				}
				if (text[at] !== ",") {
					return Option.none()
				}
				at += 1
			}
		}
		if (char === "[") {
			at += 1
			const items: Array<Tree> = []
			space()
			if (text[at] === "]") {
				at += 1
				return Option.some({ kind: "array", items })
			}
			for (;;) {
				const item = valueAt()
				if (Option.isNone(item)) {
					return Option.none()
				}
				items.push(item.value)
				space()
				if (text[at] === "]") {
					at += 1
					return Option.some({ kind: "array", items })
				}
				if (text[at] !== ",") {
					return Option.none()
				}
				at += 1
			}
		}
		if (char === '"') {
			return Option.map(stringAt(), (value): Tree => ({ kind: "string", text: value }))
		}
		for (const [word, tree] of [
			["true", { kind: "boolean", value: true }],
			["false", { kind: "boolean", value: false }],
			["null", { kind: "null" }]
		] as const) {
			if (Str.startsWith(word)(Str.slice(at)(text))) {
				at += word.length
				return Option.some(tree)
			}
		}
		const start = at
		while (
			at < text.length &&
			(isDigit(text[at]) || Arr.contains(["-", "+", ".", "e", "E"], text[at] ?? ""))
		) {
			at += 1
		}
		return at > start
			? Option.some({ kind: "number", text: Str.slice(start, at)(text) })
			: Option.none()
	}
	const value = valueAt()
	space()
	return Option.isSome(value) && at === text.length ? value : Option.none()
}

/** The bytes of a field's file. */
const bytesOf = (bytes: Bytes): Uint8Array =>
	bytes.kind === "small"
		? Uint8Array.from(bytes.bytes)
		: Uint8Array.from(
				{ length: bytes.size },
				(_, index) => (index * 131 + Math.floor(index / 251) * 17 + bytes.shift) % 256
			)

/** A field's encoded file, written by Node's Buffer: base64 with padding, and base64url with the same padding kept. */
const encoded = (encoding: Input.FieldEncoding, bytes: Uint8Array): string => {
	const whole = Buffer.from(bytes).toString("base64")
	return encoding === "base64" ? whole : Str.replaceAll("/", "_")(Str.replaceAll("+", "-")(whole))
}

/** One trailing `\r?\n` removed: the line end `echo value > file` writes. */
const withoutOneLineEnd = (text: string): string => {
	if (Str.endsWith("\r\n")(text)) {
		return Str.slice(0, -2)(text)
	}
	return Str.endsWith("\n")(text) ? Str.slice(0, -1)(text) : text
}

/** What a merge settles on in the model: a refusal naming a flag, no body, or the body's exact text. */
type Settled =
	| Readonly<{ kind: "refused"; flag: string; message: string }>
	| Readonly<{ kind: "empty" }>
	| Readonly<{
			kind: "text"
			text: string
			secrets: ReadonlyArray<readonly [label: string, value: string]>
	  }>

const refused = (flag: string, cause: string): Settled => ({
	kind: "refused",
	flag,
	message: `--${flag}: ${cause}`
})

const schemaRefused = (flag: string): Settled => ({
	kind: "refused",
	flag,
	message: `--${flag}: the request body does not match its schema`
})

const sourceFlag = (drawn: Source): string => (drawn.kind === "bodyFile" ? "body-file" : "body")

const isPerson = (tree: Tree): boolean =>
	tree.kind === "object" &&
	Arr.every(tree.members, ([key, member]) =>
		key === "name" ? member.kind === "string" : key === "count" && member.kind === "number"
	) &&
	Arr.some(tree.members, ([key]) => key === "name")

const admitted = (drawn: Merge, text: string, flag: string): Option.Option<Settled> =>
	Option.match(parseJson(text), {
		onNone: () => Option.some(refused(flag, "is not valid JSON")),
		onSome: (tree) =>
			drawn.schema === "person" && !isPerson(tree)
				? Option.some(schemaRefused(flag))
				: Option.none()
	})

const setAt = (
	root: Map<string, Node>,
	segments: Arr.NonEmptyReadonlyArray<string>,
	value: Node
): void => {
	let node = root
	for (const segment of Arr.initNonEmpty(segments)) {
		const next = node.get(segment)
		if (next?.kind === "object") {
			node = next.members
		} else {
			const fresh = new Map<string, Node>()
			node.set(segment, { kind: "object", members: fresh })
			node = fresh
		}
	}
	node.set(Arr.lastNonEmpty(segments), value)
}

const fieldValueValid = (sketch: FieldSketch): boolean =>
	sketch.kind !== "jsonNumber" || isNumberText(sketch.text)

const isNumberText = (text: string): boolean => {
	let at = Str.startsWith("-")(text) ? 1 : 0
	if (text[at] === "0") {
		at += 1
	} else if (isDigit(text[at])) {
		while (isDigit(text[at])) {
			at += 1
		}
	} else {
		return false
	}
	if (text[at] === ".") {
		at += 1
		const start = at
		while (isDigit(text[at])) {
			at += 1
		}
		if (at === start) {
			return false
		}
	}
	if (text[at] === "e" || text[at] === "E") {
		at += text[at + 1] === "+" || text[at + 1] === "-" ? 2 : 1
		const start = at
		while (isDigit(text[at])) {
			at += 1
		}
		if (at === start) {
			return false
		}
	}
	return at === text.length
}

/**
 * The model of the merge: the source's flag conflict and read first, then a body with no field flag sent verbatim (but
 * checked), then each field flag over the parsed body in order, a file-backed one read (stdin taken by the first `-`
 * consumer only), then the written text checked against the schema.
 */
const settledOf = (drawn: Merge): Settled => {
	const stdin = { holder: Option.none<string>() }
	const claim = (flag: string): Option.Option<Settled> => {
		if (Option.isSome(stdin.holder)) {
			return Option.some(refused(flag, `standard input is already read by --${stdin.holder.value}`))
		}
		stdin.holder = Option.some(flag)
		return Option.none()
	}
	const read = (flag: string, origin: From): Option.Option<Settled> => {
		switch (origin) {
			case "stdin":
				return claim(flag)
			case "missing":
				return Option.some(refused(flag, "cannot read the file or stdin"))
			case "file":
				return Option.none()
		}
	}
	const given = drawn.source
	if (given.kind === "both") {
		return refused("body", "cannot be used with --body-file")
	}
	const flag = sourceFlag(given)
	if (given.kind === "bodyFile") {
		const failed = read("body-file", given.from)
		if (Option.isSome(failed)) {
			return failed.value
		}
	}
	const overrides = Arr.filter(drawn.fields, (field) => field.sketch.kind !== "absent")
	const text = given.kind === "none" ? Option.none<string>() : Option.some(given.text)
	if (Option.isNone(text) && overrides.length === 0 && !drawn.required) {
		return { kind: "empty" }
	}
	if (Option.isSome(text) && overrides.length === 0) {
		return Option.getOrElse(admitted(drawn, text.value, flag), (): Settled => ({
			kind: "text",
			text: text.value,
			secrets: []
		}))
	}
	const base = Option.match(text, {
		onNone: () => Option.some<Tree>({ kind: "object", members: [] }),
		onSome: parseJson
	})
	if (Option.isNone(base)) {
		return refused(flag, "is not valid JSON")
	}
	const root = nodeOf(base.value)
	if (root.kind !== "object") {
		return refused(flag, "must be a JSON object to take field flags")
	}
	const secrets: Array<readonly [string, string]> = []
	for (const field of overrides) {
		const sketch = field.sketch
		const name = flagOf(field)
		if (sketch.kind === "secret" || sketch.kind === "file") {
			const failed = read(name, sketch.from)
			if (Option.isSome(failed)) {
				return failed.value
			}
		}
		switch (sketch.kind) {
			case "secret": {
				if (!sketch.utf8) {
					return refused(name, "is not valid UTF-8")
				}
				const value = withoutOneLineEnd(sketch.text)
				secrets.push([name, value])
				setAt(root.members, field.segments, { kind: "leaf", text: quoted(value) })
				break
			}
			case "file":
				setAt(root.members, field.segments, {
					kind: "leaf",
					text: quoted(encoded(sketch.encoding, bytesOf(sketch.bytes)))
				})
				break
			case "jsonNumber":
				if (!fieldValueValid(sketch)) {
					return refused(flag, "a number field is not a JSON number")
				}
				setAt(root.members, field.segments, { kind: "leaf", text: sketch.text })
				break
			case "value":
				setAt(root.members, field.segments, nodeOf(sketch.value))
				break
			case "absent":
				break
		}
	}
	const written = writeNode(root)
	return Option.getOrElse(admitted(drawn, written, flag), (): Settled => ({
		kind: "text",
		text: written,
		secrets
	}))
}

/** What a merge case reaches. */
export type MergeFeature =
	| "a verbatim body"
	| "no input, optional"
	| "no input, required"
	| "a field over the body"
	| "a nested pointer"
	| "__proto__ as an own key"
	| "a number kept as its text"
	| "a base64 file"
	| "a base64url file"
	| "a file past one read chunk"
	| "a file from stdin"
	| "a secret from a file"
	| "a secret from stdin"
	| "a secret's line end stripped"
	| "two stdin consumers refused"
	| "a missing file refused"
	| "a secret not UTF-8 refused"
	| "body and body-file refused"
	| "invalid JSON refused"
	| "a non-object body under fields refused"
	| "a field number refused"
	| "a schema refusal"
	| "a schema admits the merge"

/** The situations a merge case reaches, read from the sketch and the model's verdict. */
export const mergeFeatures = (drawn: Merge): ReadonlyArray<MergeFeature> => {
	const settled = settledOf(drawn)
	const text = settled.kind === "text"
	const overrides = Arr.filter(drawn.fields, (field) => field.sketch.kind !== "absent")
	const sketches = Arr.map(overrides, (field) => field.sketch)
	const message = settled.kind === "refused" ? settled.message : ""
	const facts: ReadonlyArray<readonly [boolean, MergeFeature]> = [
		[text && overrides.length === 0 && drawn.source.kind !== "none", "a verbatim body"],
		[settled.kind === "empty", "no input, optional"],
		[
			text && drawn.required && drawn.source.kind === "none" && overrides.length === 0,
			"no input, required"
		],
		[text && overrides.length > 0 && drawn.source.kind !== "none", "a field over the body"],
		[text && Arr.some(overrides, (field) => field.segments.length > 1), "a nested pointer"],
		[
			text && Arr.some(overrides, (field) => Arr.contains(field.segments, "__proto__")),
			"__proto__ as an own key"
		],
		[
			text &&
				overrides.length > 0 &&
				(drawn.source.kind === "body" || drawn.source.kind === "bodyFile") &&
				Arr.some(["12345678901234567890", "1.50", "1e2", "9007199254740993"], (number) =>
					Str.includes(number)(
						drawn.source.kind === "none" || drawn.source.kind === "both" ? "" : drawn.source.text
					)
				),
			"a number kept as its text"
		],
		[
			text &&
				Arr.some(sketches, (sketch) => sketch.kind === "file" && sketch.encoding === "base64"),
			"a base64 file"
		],
		[
			text &&
				Arr.some(sketches, (sketch) => sketch.kind === "file" && sketch.encoding === "base64url"),
			"a base64url file"
		],
		[
			text &&
				Arr.some(sketches, (sketch) => sketch.kind === "file" && sketch.bytes.kind === "large"),
			"a file past one read chunk"
		],
		[
			text && Arr.some(sketches, (sketch) => sketch.kind === "file" && sketch.from === "stdin"),
			"a file from stdin"
		],
		[
			text && Arr.some(sketches, (sketch) => sketch.kind === "secret" && sketch.from === "file"),
			"a secret from a file"
		],
		[
			text && Arr.some(sketches, (sketch) => sketch.kind === "secret" && sketch.from === "stdin"),
			"a secret from stdin"
		],
		[
			text &&
				Arr.some(sketches, (sketch) => sketch.kind === "secret" && Str.endsWith("\n")(sketch.text)),
			"a secret's line end stripped"
		],
		[Str.includes("standard input is already read")(message), "two stdin consumers refused"],
		[Str.includes("cannot read the file or stdin")(message), "a missing file refused"],
		[Str.includes("is not valid UTF-8")(message), "a secret not UTF-8 refused"],
		[Str.includes("cannot be used with")(message), "body and body-file refused"],
		[Str.includes("is not valid JSON")(message), "invalid JSON refused"],
		[Str.includes("must be a JSON object")(message), "a non-object body under fields refused"],
		[Str.includes("a number field is not")(message), "a field number refused"],
		[Str.includes("does not match its schema")(message), "a schema refusal"],
		[text && drawn.schema === "person", "a schema admits the merge"]
	]
	return Arr.flatMap(facts, ([holds, feature]) => (holds ? [feature] : []))
}

const notUtf8 = Uint8Array.from([0xff, 0xfe])

const encoder = new TextEncoder()

/** The bytes a file-backed value holds. */
const contentOf = (sketch: FieldSketch): Uint8Array => {
	switch (sketch.kind) {
		case "file":
			return bytesOf(sketch.bytes)
		case "secret":
			return sketch.utf8 ? encoder.encode(sketch.text) : notUtf8
		case "absent":
		case "value":
		case "jsonNumber":
			return new Uint8Array()
	}
}

/** The stdin the case's first `-` consumer reads: the body file's bytes, or the first stdin field's. */
const stdinOf = (drawn: Merge): Uint8Array => {
	if (drawn.source.kind === "bodyFile" && drawn.source.from === "stdin") {
		return encoder.encode(drawn.source.text)
	}
	return Option.match(
		Arr.findFirst(
			drawn.fields,
			(field) =>
				(field.sketch.kind === "file" || field.sketch.kind === "secret") &&
				field.sketch.from === "stdin"
		),
		{ onNone: () => new Uint8Array(), onSome: (field) => contentOf(field.sketch) }
	)
}

const pathFor = (dir: ScratchDir, name: string, origin: From): string => {
	switch (origin) {
		case "stdin":
			return "-"
		case "missing":
			return `${dir}/missing-${name}`
		case "file":
			return `${dir}/${name}`
	}
}

/** The runtime's field flags for a case, with each file-backed value written into the case's directory first. */
const fieldsIn = (dir: ScratchDir, drawn: Merge) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const entries: Array<
			readonly [string, Option.Option<Input.FieldValue | Input.FileField | Input.SecretField>]
		> = []
		for (const field of drawn.fields) {
			const sketch = field.sketch
			const name = flagOf(field)
			switch (sketch.kind) {
				case "absent":
					entries.push([pointerOf(field), Option.none()])
					break
				case "value":
					entries.push([pointerOf(field), Option.some(fieldValueOf(sketch.value))])
					break
				case "jsonNumber":
					entries.push([pointerOf(field), Option.some(new Input.JsonNumber(sketch.text))])
					break
				case "file":
				case "secret": {
					const path = pathFor(dir, name, sketch.from)
					if (sketch.from === "file") {
						yield* fs.writeFile(path, contentOf(sketch))
					}
					entries.push([
						pointerOf(field),
						Option.some(
							sketch.kind === "file"
								? new Input.FileField({ encoding: sketch.encoding, flag: name, path })
								: new Input.SecretField({ flag: name, path })
						)
					])
				}
			}
		}
		const fieldRecord: Input.Fields = Record.fromEntries(entries)
		return fieldRecord
	})

const fieldValueOf = (tree: Tree): Input.FieldValue => {
	switch (tree.kind) {
		case "string":
			return tree.text
		case "boolean":
			return tree.value
		case "null":
			return Input.jsonNull
		case "number":
			return new Input.JsonNumber(tree.text)
		case "array":
			return Arr.map(tree.items, fieldValueOf)
		case "object":
			return Record.fromEntries(
				Arr.map(tree.members, ([key, member]) => [key, fieldValueOf(member)])
			)
	}
}

const Person = Schema.Struct({ count: Schema.optionalKey(Schema.Finite), name: Schema.String })

const claimOf = Effect.map(Layer.build(Input.stdinClaimLayer), Context.get(Input.StdinClaim))

/** What the runtime settled on through one entry point, its body text and the secrets the run recorded, or its error. */
export type Observed =
	| Readonly<{ kind: "refused"; flag: string; message: string; tag: string }>
	| Readonly<{ kind: "empty" }>
	| Readonly<{
			kind: "text"
			text: string
			secrets: ReadonlyArray<readonly [label: string, value: string]>
			echoes: ReadonlyArray<string>
	  }>

const secretsIn = (entries: ReadonlyArray<ScrubEntry>): ReadonlyArray<readonly [string, string]> =>
	Arr.flatMap(entries, (entry) =>
		"kind" in entry ? [[entry.label, Redacted.value(entry.value)] as const] : []
	)

/** One run of `mergeBody` or `structuredBody` over the case, each with its own stdin, stdin claim and run record. */
export const observed = (dir: ScratchDir, drawn: Merge, entry: "merge" | "structured") =>
	Effect.gen(function* () {
		const fieldRecord = yield* fieldsIn(dir, drawn)
		const fs = yield* FileSystem.FileSystem
		const given = drawn.source
		const bodyFile =
			given.kind === "bodyFile" || given.kind === "both"
				? Option.some(
						given.kind === "both" ? `${dir}/body.json` : pathFor(dir, "body.json", given.from)
					)
				: Option.none<string>()
		if (given.kind === "bodyFile" && given.from === "file") {
			yield* fs.writeFileString(`${dir}/body.json`, given.text)
		}
		const options = {
			constants: {},
			body:
				given.kind === "body" || given.kind === "both"
					? Option.some(given.text)
					: Option.none<string>(),
			bodyFile,
			fields: fieldRecord,
			required: drawn.required,
			schema: drawn.schema === "person" ? Person : Schema.Unknown
		}
		const recorded = yield* Ref.make<ReadonlyArray<ScrubEntry>>([])
		const read =
			entry === "merge"
				? Effect.flatMap(Input.mergeBody(options), (body) =>
						body._tag === "Uint8Array"
							? Effect.map(Effect.fromNullishOr(utf8Text(body.body)), Option.some<string>)
							: Effect.succeed(Option.none<string>())
					)
				: Effect.map(Input.structuredBody(options), (value) =>
						Option.map(Option.fromNullishOr(value), Input.jsonText)
					)
		const exit = yield* read.pipe(
			Effect.provideService(
				Stdio.Stdio,
				Stdio.make({
					args: Effect.succeed([]),
					stdin: Stream.make(stdinOf(drawn)),
					stdout: () => Sink.drain,
					stderr: () => Sink.drain
				})
			),
			Effect.provideServiceEffect(Input.StdinClaim, claimOf),
			Effect.provideService(RunCredentials, recorded),
			Effect.exit
		)
		const entries = yield* Ref.get(recorded)
		const lines = Arr.map(echoesOf(drawn), ([line]) => line)
		return Exit.match(exit, {
			onFailure: (cause): Observed => {
				const failure = Cause.squash(cause)
				return {
					kind: "refused",
					flag:
						Predicate.hasProperty(failure, "flag") && Predicate.isString(failure.flag)
							? failure.flag
							: "",
					message:
						Predicate.hasProperty(failure, "message") && Predicate.isString(failure.message)
							? failure.message
							: "",
					tag:
						Predicate.hasProperty(failure, "_tag") && Predicate.isString(failure._tag)
							? failure._tag
							: ""
				}
			},
			onSuccess: (text): Observed =>
				Option.match(text, {
					onNone: (): Observed => ({ kind: "empty" }),
					onSome: (body): Observed => ({
						kind: "text",
						text: body,
						secrets: secretsIn(entries),
						echoes: Arr.map(lines, (line) => Output.scrubbedAndSanitized(line, entries))
					})
				})
		})
	})

/**
 * The echoes a server could make of each secret value the model records, as given, JSON-escaped, percent-encoded and
 * form-encoded, each inside a line, with the line each must scrub to: the value's placeholder in its place. Two
 * secrets holding one value are one value to the scrub, whose echo takes the placeholder of the first recorded.
 */
const echoesOf = (drawn: Merge): ReadonlyArray<readonly [string, string]> => {
	const settled = settledOf(drawn)
	const secrets: ReadonlyArray<readonly [string, string]> =
		settled.kind === "text"
			? Arr.dedupeWith(settled.secrets, ([, left], [, right]) => left === right)
			: []
	return Arr.flatMap(secrets, ([label, value]): ReadonlyArray<readonly [string, string]> =>
		value.length > 1
			? Arr.map(
					Arr.dedupe([
						value,
						Str.slice(1, -1)(quoted(value)),
						encodeURIComponent(value),
						Str.replaceAll("%20", "+")(encodeURIComponent(value))
					]),
					(form) => [`echo=${form};`, `echo=<redacted:${label}>;`] as const
				)
			: []
	)
}

/** The observation the model expects of either entry point. */
export const expectedObserved = (drawn: Merge): Observed => {
	const settled = settledOf(drawn)
	switch (settled.kind) {
		case "refused":
			return { ...settled, tag: "UsageError" }
		case "empty":
			return settled
		case "text":
			return { ...settled, echoes: Arr.map(echoesOf(drawn), ([, line]) => line) }
	}
}

/** An observation as the model states it: a schema refusal's message cut where the model's stops. */
export const comparable = (seen: Observed): Observed =>
	seen.kind === "refused" && Str.includes("does not match its schema")(seen.message)
		? { ...seen, message: `--${seen.flag}: the request body does not match its schema` }
		: seen

/** Whether a merge left `Object.prototype` as it found it: no drawn member name became an inherited property. */
export const prototypeClean = (): boolean =>
	Arr.every(SEGMENTS, (segment) => segment === "__proto__" || !Predicate.hasProperty({}, segment))
