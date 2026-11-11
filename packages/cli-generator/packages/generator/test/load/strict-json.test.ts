/**
 * The strict JSON loader against an oracle that reads the same document from the tree it was rendered from: a generated
 * document, written with generated whitespace and escapes, loads as its own value, and when it breaks a rule the loader
 * refuses it with the code, pointer and position the oracle derives from the tree and the rendering. The rules, in the
 * loader's order: the size limit; then, in document order, the depth limit and the node budget; then JSON syntax; then,
 * in document order, a repeated key (compared after unescaping) and an unsafe number literal at a `default`, `enum` or
 * `const` site (never inside `example`/`examples`, never as a name under a name map such as `properties`).
 *
 * Plants, each applied to src/load/json.ts, seen to fail this suite and reverted: keys compared before unescaping;
 * `pointerOf` reporting the parent object instead of the member; the node budget counting keys; the depth check off by
 * one (`>=`); `valueContext` treating every key under `properties` as a keyword; `isUnsafeNumber` reading only the
 * integer part; `locate` counting UTF-16 units for the column.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { drawn, explore } from "@superstarter/testing/explore"
import { required } from "@superstarter/testing/features"
import { array, boolean, element, type Gen, int, oneOf, weighted } from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { searched } from "@superstarter/testing/vitest"
import {
	Array as Arr,
	Cause,
	Duration,
	Effect,
	Exit,
	Formatter,
	Option,
	Record,
	String as Str
} from "effect"
import { loadBytes } from "#load/index.ts"
import type { LoadLimits } from "#load/index.ts"
import { DocumentUri } from "#model/brands.ts"
import { formatPointer } from "#model/pointer.ts"
import type { Json } from "#model/pointer.ts"

/** One character of a string or key, and how the text spells it. */
type Char = Readonly<{ char: string; spelling: "raw" | "escaped" }>

/** A number literal and how `JSON.parse` reads it: exactly, as a different double, or as no finite number at all. */
type NumberLiteral = Readonly<{ text: string; safe: boolean; finite: boolean }>

type Node =
	| Readonly<{ kind: "null" }>
	| Readonly<{ kind: "boolean"; value: boolean }>
	| Readonly<{ kind: "number"; literal: NumberLiteral }>
	| Readonly<{ kind: "string"; chars: ReadonlyArray<Char> }>
	| Readonly<{ kind: "array"; items: ReadonlyArray<Node> }>
	| Readonly<{ kind: "object"; members: ReadonlyArray<Member> }>

type Member = Readonly<{ key: ReadonlyArray<Char>; value: Node }>

/** A document: its root object, the whitespace between its tokens, whether it starts with a byte order mark, whether
 * a trailing comma breaks its syntax, whether a byte no UTF-8 sequence holds follows its text, and the limits it is
 * loaded under. */
type Document = Readonly<{
	root: ReadonlyArray<Member>
	gaps: ReadonlyArray<string>
	bom: boolean
	trailingComma: boolean
	badByte: boolean
	limits: LoadLimits
}>

/** The keys the loader's site rules turn on, beside plain names and names that need escaping. */
const KEYS: Arr.NonEmptyReadonlyArray<string> = [
	"default",
	"enum",
	"const",
	"example",
	"examples",
	"properties",
	"schemas",
	"parameters",
	"type",
	"a",
	"b",
	"é",
	"𝄞",
	'"',
	"\\",
	"\u0001",
	"/~"
]

/** Characters a string draws from: plain, multi-byte, astral, and ones JSON must escape. */
const CHARS: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"z",
	" ",
	"é",
	"𝄞",
	"\n",
	'"',
	"\\",
	"\u0007",
	"/"
]

/** A character JSON text cannot hold raw. */
const mustEscape = (char: string): boolean =>
	char === '"' || char === "\\" || Option.exists(Str.codePointAt(0)(char), (point) => point < 0x20)

const charGen =
	(alphabet: Arr.NonEmptyReadonlyArray<string>): Gen<Char> =>
	(s) => {
		const char = s.draw(element(alphabet))
		return { char, spelling: mustEscape(char) ? "escaped" : s.draw(element(["raw", "escaped"])) }
	}

/** A key's characters, drawn whole from the dictionary, each spelled raw or escaped. */
const keyGen: Gen<ReadonlyArray<Char>> = (s) => {
	const name = s.draw(element(KEYS))
	return Arr.map(Arr.fromIterable(name), (char) => ({
		char,
		spelling: mustEscape(char) ? "escaped" : s.draw(element(["raw", "escaped"] as const))
	}))
}

const SAFE_LIMIT = 2 ** 53

/** Number literals by construction: their safety is known from how they were written, never computed from the text. */
const numberGen: Gen<NumberLiteral> = oneOf<NumberLiteral>([
	(s) => ({ text: String(s.draw(int(-1000, 1000))), safe: true, finite: true }),
	(s) => ({ text: String(SAFE_LIMIT - s.draw(int(0, 1000))), safe: true, finite: true }),
	(s) => ({
		text: `${String(s.draw(int(1, 9)))}e${String(s.draw(int(0, 15)))}`,
		safe: true,
		finite: true
	}),
	(s) => ({
		text: `${String(s.draw(int(0, 99)))}.${String(s.draw(int(1, 9)))}`,
		safe: true,
		finite: true
	}),
	(s) => ({
		text: String(BigInt(SAFE_LIMIT) + BigInt(s.draw(int(1, 1000)))),
		safe: false,
		finite: true
	}),
	(s) => ({
		text: `${String(s.draw(int(1, 9)))}e${String(s.draw(int(17, 30)))}`,
		safe: false,
		finite: true
	}),
	(s) => ({ text: `0.1000000000000000${String(s.draw(int(1, 9)))}1`, safe: false, finite: true }),
	(s) => ({
		text: `${String(s.draw(int(1, 9)))}e${String(s.draw(int(309, 400)))}`,
		safe: false,
		finite: false
	})
])

const leafGen: Gen<Node> = weighted<Node>([
	[1, () => ({ kind: "null" })],
	[1, (s) => ({ kind: "boolean", value: s.draw(boolean) })],
	[4, (s) => ({ kind: "number", literal: s.draw(numberGen) })],
	[2, (s) => ({ kind: "string", chars: s.draw(array(charGen(CHARS), { min: 0, max: 4 })) })]
])

const nodeGen = (depth: number): Gen<Node> =>
	depth === 0
		? leafGen
		: weighted<Node>([
				[3, leafGen],
				[
					1,
					(s) => ({ kind: "array", items: s.draw(array(nodeGen(depth - 1), { min: 0, max: 3 })) })
				],
				[2, (s) => ({ kind: "object", members: s.draw(membersGen(depth - 1)) })]
			])

const memberGen =
	(depth: number): Gen<Member> =>
	(s) => ({ key: s.draw(keyGen), value: s.draw(nodeGen(depth)) })

const membersGen = (depth: number): Gen<ReadonlyArray<Member>> =>
	array(memberGen(depth), { min: 0, max: 4 })

/** The whitespace JSON admits between tokens. */
const GAPS: Arr.NonEmptyReadonlyArray<string> = ["", "", " ", "\n", "\t", "\r\n", "  \n "]

const documentGen: Gen<Document> = (s) => ({
	root: s.draw(membersGen(3)),
	gaps: s.draw(array(element(GAPS), { min: 1, max: 6 })),
	bom: s.draw(boolean),
	trailingComma: s.draw(
		weighted([
			[9, () => false],
			[1, () => true]
		])
	),
	badByte: s.draw(
		weighted([
			[9, () => false],
			[1, () => true]
		])
	),
	limits: {
		maxBytes: s.draw(
			weighted([
				[9, () => 64 * 1024 * 1024],
				[1, (t) => t.draw(int(1, 200))]
			])
		),
		maxDepth: s.draw(
			weighted([
				[3, () => 256],
				[1, (t) => t.draw(int(1, 4))]
			])
		),
		maxNodes: s.draw(
			weighted([
				[3, () => 10_000_000],
				[1, (t) => t.draw(int(1, 20))]
			])
		)
	}
})

/** The text of a character as the document spells it. */
const spell = (c: Char): string => {
	if (c.spelling === "raw") {
		return c.char
	}
	if (c.char === '"') {
		return '\\"'
	}
	if (c.char === "\\") {
		return "\\\\"
	}
	return Arr.join(
		Arr.map(
			Arr.fromIterable(utf16(c.char)),
			(unit) => `\\u${Str.padStart(4, "0")(unit.toString(16))}`
		),
		""
	)
}

/** The UTF-16 code units of a character. */
const utf16 = (char: string): ReadonlyArray<number> =>
	Arr.getSomes(Arr.map(Arr.range(0, char.length - 1), (index) => Str.charCodeAt(index)(char)))

const textOf = (chars: ReadonlyArray<Char>): string =>
	Arr.join(
		Arr.map(chars, (c) => c.char),
		""
	)

/** Where the renderer wrote a token the oracle may report: its index in the text and the pointer of its value. */
type Site = Readonly<{ index: number; pointer: ReadonlyArray<string> }>

/** What rendering a document records beside its text: in document order, every key's site with its object's keys so
 * far, and every number's site with whether it sits at a data site. */
type Event =
	| Readonly<{ kind: "open"; depth: number }>
	| Readonly<{ kind: "scalar" }>
	| Readonly<{
			kind: "key"
			site: Site
			repeated: boolean
			respelled: boolean
			nameUnderMap: boolean
	  }>
	| Readonly<{ kind: "number"; site: Site; data: boolean; safe: boolean; finite: boolean }>

type Rendered = Readonly<{ text: string; events: ReadonlyArray<Event> }>

/** Where a value sits, as the loader's site rules read it. */
type Place = Readonly<{ data: boolean; opaque: boolean; nameMap: boolean }>

const DATA_KEYS: ReadonlyArray<string> = ["const", "default", "enum"]
const OPAQUE_KEYS: ReadonlyArray<string> = ["example", "examples"]
const NAME_MAP_KEYS: ReadonlyArray<string> = ["properties", "schemas", "parameters"]

/** The place of a member's value, from the place of its object and its key. */
const memberPlace = (object: Place, key: string): Place => {
	if (object.nameMap) {
		return { data: object.data, opaque: object.opaque, nameMap: false }
	}
	const data = object.data || (!object.opaque && Arr.contains(DATA_KEYS, key))
	const opaque = !data && (object.opaque || Arr.contains(OPAQUE_KEYS, key))
	return { data, opaque, nameMap: !data && !opaque && Arr.contains(NAME_MAP_KEYS, key) }
}

/** The place of an array item, from the place of its array. */
const itemPlace = (array: Place): Place => ({
	data: array.data,
	opaque: array.opaque,
	nameMap: false
})

/** Renders a document, recording its events in document order. */
const render = (doc: Document): Rendered => {
	const parts: Array<string> = []
	const events: Array<Event> = []
	let length = 0
	let gap = 0
	const write = (text: string) => {
		parts.push(text)
		length += text.length
	}
	const space = () => {
		write(doc.gaps[gap % doc.gaps.length] ?? "")
		gap += 1
	}
	const value = (node: Node, place: Place, pointer: ReadonlyArray<string>, depth: number): void => {
		switch (node.kind) {
			case "null":
				events.push({ kind: "scalar" })
				write("null")
				return
			case "boolean":
				events.push({ kind: "scalar" })
				write(node.value ? "true" : "false")
				return
			case "number":
				events.push({
					kind: "number",
					site: { index: length, pointer },
					data: place.data,
					safe: node.literal.safe,
					finite: node.literal.finite
				})
				write(node.literal.text)
				return
			case "string":
				events.push({ kind: "scalar" })
				write(`"${Arr.join(Arr.map(node.chars, spell), "")}"`)
				return
			case "array":
				events.push({ kind: "open", depth: depth + 1 })
				write("[")
				Arr.forEach(node.items, (item, index) => {
					if (index > 0) {
						write(",")
					}
					space()
					value(item, itemPlace(place), Arr.append(pointer, String(index)), depth + 1)
				})
				write("]")
				return
			case "object":
				events.push({ kind: "open", depth: depth + 1 })
				object(node.members, place, pointer, depth + 1, false)
				return
		}
	}
	const object = (
		members: ReadonlyArray<Member>,
		place: Place,
		pointer: ReadonlyArray<string>,
		depth: number,
		trailing: boolean
	): void => {
		write("{")
		const seen: Array<readonly [string, string]> = []
		Arr.forEach(members, (member, index) => {
			if (index > 0) {
				write(",")
			}
			space()
			const key = textOf(member.key)
			const spelled = Arr.join(Arr.map(member.key, spell), "")
			const at = Arr.append(pointer, key)
			const earlier = Arr.filter(seen, ([name]) => name === key)
			events.push({
				kind: "key",
				site: { index: length, pointer: at },
				repeated: Arr.isReadonlyArrayNonEmpty(earlier),
				respelled: Arr.some(earlier, ([, text]) => text !== spelled),
				nameUnderMap: place.nameMap && Arr.contains(DATA_KEYS, key)
			})
			seen.push([key, spelled])
			write(`"${spelled}"`)
			space()
			write(":")
			space()
			value(member.value, memberPlace(place, key), at, depth)
		})
		if (trailing && Arr.isReadonlyArrayNonEmpty(members)) {
			write(",")
		}
		space()
		write("}")
	}
	events.push({ kind: "open", depth: 1 })
	object(doc.root, { data: false, opaque: false, nameMap: false }, [], 1, doc.trailingComma)
	return { text: Arr.join(parts, ""), events }
}

/** What loading a document gives: its value, or a refusal's code with where it points. */
type Outcome =
	| Readonly<{ kind: "defect" }>
	| Readonly<{ kind: "loaded"; value: Json }>
	| Readonly<{ kind: "refused"; code: string; pointer: string; position: Option.Option<Position> }>

type Position = Readonly<{ line: number; column: number; offset: number }>

const encoder = new TextEncoder()

/** The 1-based line and column (in code points) and the input byte offset of a text index. */
const positionAt = (text: string, index: number, bom: boolean): Position => {
	const before = Str.slice(0, index)(text)
	const lines = Str.split(before, "\n")
	return {
		line: lines.length,
		column: Arr.fromIterable(Arr.lastNonEmpty(lines)).length + 1,
		offset: encoder.encode(before).length + (bom ? 3 : 0)
	}
}

const refused = (
	code: string,
	pointer: ReadonlyArray<string>,
	position: Option.Option<Position>
): Outcome => ({
	kind: "refused",
	code,
	pointer: formatPointer(pointer),
	position
})

/** The value a node denotes: the first of repeated keys never matters, since a repeat is refused. */
const jsonOf = (node: Node): Json => {
	switch (node.kind) {
		case "null":
			return null
		case "boolean":
			return node.value
		case "number":
			return Number(node.literal.text)
		case "string":
			return textOf(node.chars)
		case "array":
			return Arr.map(node.items, jsonOf)
		case "object":
			return objectOf(node.members)
	}
}

const objectOf = (members: ReadonlyArray<Member>): Json =>
	Record.fromEntries(
		Arr.map(members, (member) => [textOf(member.key), jsonOf(member.value)] as const)
	)

/** The members `JSON.parse` keeps: of a repeated key, the last. */
const kept = (members: ReadonlyArray<Member>): ReadonlyArray<Member> =>
	Arr.filter(
		members,
		(member, index) =>
			!Arr.some(Arr.drop(members, index + 1), (later) => textOf(later.key) === textOf(member.key))
	)

/** Whether every number the parsed value holds is finite: a literal a later repeat replaces never reaches it. */
const allFinite = (node: Node): boolean => {
	switch (node.kind) {
		case "number":
			return node.literal.finite
		case "array":
			return Arr.every(node.items, allFinite)
		case "object":
			return Arr.every(kept(node.members), (member) => allFinite(member.value))
		case "null":
		case "boolean":
		case "string":
			return true
	}
}

/** The oracle: the outcome the loader must give, read from the tree and the rendering. */
const expected = (doc: Document, rendered: Rendered): Outcome => {
	const bytes = encoder.encode(rendered.text).length + (doc.bom ? 3 : 0) + (doc.badByte ? 1 : 0)
	if (bytes > doc.limits.maxBytes) {
		return refused("DOC-14/too-large", [], Option.none())
	}
	if (doc.badByte) {
		return refused("DOC-14/invalid-encoding", [], Option.none())
	}
	let nodes = 0
	for (const event of rendered.events) {
		if (event.kind === "key") {
			continue
		}
		nodes += 1
		if (event.kind === "open" && event.depth > doc.limits.maxDepth) {
			return refused("DOC-14/depth-limit", [], Option.none())
		}
		if (nodes > doc.limits.maxNodes) {
			return refused("DOC-14/node-budget", [], Option.none())
		}
	}
	if (
		(doc.trailingComma && Arr.isReadonlyArrayNonEmpty(doc.root)) ||
		!Arr.every(kept(doc.root), (member) => allFinite(member.value))
	) {
		return refused("DOC-14/invalid-json", [], Option.none())
	}
	const finding = Arr.findFirst(
		rendered.events,
		(event) =>
			(event.kind === "key" && event.repeated) ||
			(event.kind === "number" && event.data && !event.safe)
	)
	return Option.match(finding, {
		onNone: (): Outcome => ({ kind: "loaded", value: objectOf(doc.root) }),
		onSome: (event): Outcome =>
			event.kind === "key"
				? refused(
						"DOC-14/duplicate-key",
						event.site.pointer,
						Option.some(positionAt(rendered.text, event.site.index, doc.bom))
					)
				: event.kind === "number"
					? refused(
							"DOC-14/unsafe-integer",
							event.site.pointer,
							Option.some(positionAt(rendered.text, event.site.index, doc.bom))
						)
					: refused("unreachable", [], Option.none())
	})
}

const document = DocumentUri.make("file:///suite/openapi.json")

/** What the loader gave, in the oracle's terms. */
const actual = (doc: Document, rendered: Rendered) =>
	Effect.map(
		Effect.exit(
			loadBytes(
				new Uint8Array([
					...(doc.bom ? [0xef, 0xbb, 0xbf] : []),
					...encoder.encode(rendered.text),
					...(doc.badByte ? [0xff] : [])
				]),
				{ document, limits: doc.limits }
			)
		),
		(exit): Outcome =>
			Exit.match(exit, {
				onSuccess: (loaded) => ({ kind: "loaded", value: loaded.value }),
				onFailure: (cause) =>
					Option.match(Cause.findErrorOption(cause), {
						onNone: (): Outcome => ({ kind: "defect" }),
						onSome: (refusal): Outcome => ({
							kind: "refused",
							code: refusal.diagnostic.code,
							pointer: refusal.diagnostic.pointer,
							position: Option.all({
								line: Option.fromUndefinedOr(refusal.diagnostic.line),
								column: Option.fromUndefinedOr(refusal.diagnostic.column),
								offset: Option.fromUndefinedOr(refusal.offset)
							})
						})
					})
			})
	)

type Feature =
	| "loaded"
	| "too large"
	| "deeper than the limit"
	| "past the node budget"
	| "invalid syntax"
	| "not UTF-8"
	| "a repeated key"
	| "a repeated key spelled differently"
	| "an unsafe number at a data site"
	| "an unsafe number under an example"
	| "a data key as a name under a name map"
	| "a byte order mark"
	| "a multi-byte character before a finding"

/** The feature each refusal code is. */
const REFUSALS: Readonly<Record<string, Feature>> = {
	"DOC-14/too-large": "too large",
	"DOC-14/invalid-encoding": "not UTF-8",
	"DOC-14/depth-limit": "deeper than the limit",
	"DOC-14/node-budget": "past the node budget",
	"DOC-14/invalid-json": "invalid syntax",
	"DOC-14/duplicate-key": "a repeated key",
	"DOC-14/unsafe-integer": "an unsafe number at a data site"
}

const featuresOf = (
	doc: Document,
	rendered: Rendered,
	outcome: Outcome
): ReadonlyArray<Feature> => [
	...(outcome.kind === "refused"
		? Option.toArray(Record.get(REFUSALS, outcome.code))
		: ["loaded" as const]),
	...(Arr.some(rendered.events, (event) => event.kind === "number" && !event.data && !event.safe)
		? ["an unsafe number under an example" as const]
		: []),
	...(doc.bom ? ["a byte order mark" as const] : []),
	...(Arr.some(rendered.events, (event) => event.kind === "key" && event.nameUnderMap)
		? ["a data key as a name under a name map" as const]
		: []),
	...(outcome.kind === "refused" &&
	outcome.code === "DOC-14/duplicate-key" &&
	Arr.some(rendered.events, (event) => event.kind === "key" && event.respelled)
		? ["a repeated key spelled differently" as const]
		: []),
	...(outcome.kind === "refused" &&
	Option.exists(
		outcome.position,
		(position) => position.offset - (doc.bom ? 3 : 0) !== position.column - 1 + position.line - 1
	)
		? ["a multi-byte character before a finding" as const]
		: [])
]

describe("load: strict JSON", () => {
	it.effect(
		"a generated document loads as its own value or is refused exactly as its tree says",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "strict json",
						draw: drawn(documentGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"loaded",
								"too large",
								"deeper than the limit",
								"past the node budget",
								"invalid syntax",
								"not UTF-8",
								"a repeated key",
								"an unsafe number at a data site",
								"an unsafe number under an example",
								"a byte order mark",
								"a multi-byte character before a finding"
							],
							{ cases: 2000, sense: notesOnly }
						),
						kept: [],
						runs: 600,
						shrink: { kind: "bounded", candidates: 400 },
						concurrency: 1,
						steerEvery: 200,
						caseHang: Duration.seconds(10)
					},
					(doc, k) =>
						Effect.gen(function* () {
							const rendered = render(doc)
							const want = expected(doc, rendered)
							const got = yield* actual(doc, rendered)
							k.noteAll(featuresOf(doc, rendered, want))
							deepStrictEqual(got, want)
						})
				)
			)
	)
})
