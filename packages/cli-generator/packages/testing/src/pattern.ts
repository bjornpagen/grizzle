import { Array as Arr, Option, Schema, String as Str } from "effect"
import { array, constant, element, type Gen, map, oneOf } from "#gen.ts"

/** A parsed pattern: a literal, a set of characters, a sequence, a choice among alternatives, or a bounded repetition. */
type Node =
	| Readonly<{ kind: "literal"; text: string }>
	| Readonly<{ kind: "class"; characters: Arr.NonEmptyReadonlyArray<string> }>
	| Readonly<{ kind: "sequence"; items: ReadonlyArray<Node> }>
	| Readonly<{ kind: "choice"; options: Arr.NonEmptyReadonlyArray<Node> }>
	| Readonly<{ kind: "repeat"; node: Node; min: number; max: number }>

/** The printable ASCII characters, which `.` and a negated class draw from. */
const PRINTABLE: ReadonlyArray<string> = Arr.map(Arr.range(0x20, 0x7e), (point) =>
	String.fromCodePoint(point)
)

const DIGITS: ReadonlyArray<string> = Arr.map(Arr.range(0x30, 0x39), (point) =>
	String.fromCodePoint(point)
)

const WORD: ReadonlyArray<string> = [
	...Arr.map(Arr.range(0x41, 0x5a), (point) => String.fromCodePoint(point)),
	...Arr.map(Arr.range(0x61, 0x7a), (point) => String.fromCodePoint(point)),
	...DIGITS,
	"_"
]

const SPACE: ReadonlyArray<string> = [" ", "\t", "\n"]

/** The characters a shorthand class names, and its complement among the printable ones. */
const SHORTHANDS: Readonly<Record<string, ReadonlyArray<string>>> = {
	d: DIGITS,
	w: WORD,
	s: SPACE,
	D: Arr.filter(PRINTABLE, (c) => !Arr.contains(DIGITS, c)),
	W: Arr.filter(PRINTABLE, (c) => !Arr.contains(WORD, c)),
	S: Arr.filter(PRINTABLE, (c) => !Arr.contains(SPACE, c))
}

/** A pattern `matching` cannot generate from, and why: it refuses what it would otherwise have to guess at. */
export class PatternRefused extends Schema.TaggedError<
	PatternRefused,
	{ readonly brand: unique symbol }
>()("PatternRefused", { message: Schema.String }) {}

const refused = (message: string) => PatternRefused.make({ message })

const isDigit = (point: string) => point >= "0" && point <= "9"

const nonEmpty = (
	characters: ReadonlyArray<string>,
	where: string
): Arr.NonEmptyReadonlyArray<string> => {
	if (!Arr.isReadonlyArrayNonEmpty(characters)) {
		throw refused(`${where} matches no character`)
	}
	return characters
}

/** A recursive-descent parser over a pattern's code points. */
const parse = (source: string): Node => {
	const points = Array.from(source)
	let at = 0
	const peek = () => points[at]
	const next = () => {
		const point = points[at]
		at += 1
		if (point === undefined) {
			throw refused(`/${source}/ ends inside a construct`)
		}
		return point
	}
	const escaped = (inClass: boolean): ReadonlyArray<string> => {
		const point = next()
		const shorthand = SHORTHANDS[point]
		if (shorthand !== undefined) {
			return shorthand
		}
		if (
			point === "b" ||
			point === "B" ||
			(isDigit(point) && point !== "0") ||
			(!inClass && point === "k")
		) {
			throw refused(`/${source}/ uses \\${point}, which generation cannot honour`)
		}
		const controls: Readonly<Record<string, string>> = {
			n: "\n",
			t: "\t",
			r: "\r",
			f: "\f",
			v: "\v",
			"0": "\0"
		}
		return [controls[point] ?? point]
	}
	const characterClass = (): Node => {
		const negated = peek() === "^"
		if (negated) {
			at += 1
		}
		const members: Array<string> = []
		let first = true
		while (peek() !== "]" || first) {
			first = false
			const point = next()
			const start = point === "\\" ? escaped(true) : [point]
			const single = start.length === 1 ? start[0] : undefined
			if (
				single !== undefined &&
				peek() === "-" &&
				points[at + 1] !== undefined &&
				points[at + 1] !== "]"
			) {
				at += 1
				const endPoint = next()
				const end = endPoint === "\\" ? escaped(true) : [endPoint]
				const last = end.length === 1 ? end[0] : undefined
				if (last === undefined) {
					throw refused(`/${source}/ ends a range with a class`)
				}
				const low = Option.getOrElse(Str.codePointAt(0)(single), () => 0)
				const high = Option.getOrElse(Str.codePointAt(0)(last), () => 0)
				for (let code = low; code <= high; code += 1) {
					members.push(String.fromCodePoint(code))
				}
			} else {
				for (const member of start) {
					members.push(member)
				}
			}
		}
		next()
		const set = Arr.dedupe(members)
		return {
			kind: "class",
			characters: nonEmpty(
				negated ? Arr.filter(PRINTABLE, (c) => !Arr.contains(set, c)) : set,
				`/${source}/'s class`
			)
		}
	}
	const atom = (): Node => {
		const point = next()
		switch (point) {
			case "(": {
				if (peek() === "?") {
					at += 1
					if (next() !== ":") {
						throw refused(`/${source}/ uses a group generation cannot honour`)
					}
				}
				const inner = alternation()
				if (next() !== ")") {
					throw refused(`/${source}/ leaves a group open`)
				}
				return inner
			}
			case "[":
				return characterClass()
			case ".":
				return { kind: "class", characters: nonEmpty(PRINTABLE, "`.`") }
			case "\\": {
				const characters = escaped(false)
				const [only] = characters
				return characters.length === 1 && only !== undefined
					? { kind: "literal", text: only }
					: { kind: "class", characters: nonEmpty(characters, `/${source}/'s shorthand`) }
			}
			default:
				return { kind: "literal", text: point }
		}
	}
	const bound = (): number => {
		let digits = ""
		while (isDigit(peek() ?? "")) {
			digits += next()
		}
		return Number.parseInt(digits, 10)
	}
	const quantified = (node: Node): Node => {
		const point = peek()
		if (point === "*" || point === "+") {
			throw refused(`/${source}/ repeats without a bound: write {min,max}`)
		}
		if (point === "?") {
			at += 1
			return { kind: "repeat", node, min: 0, max: 1 }
		}
		if (point !== "{") {
			return node
		}
		at += 1
		const min = bound()
		let max = min
		if (peek() === ",") {
			at += 1
			if (peek() === "}") {
				throw refused(`/${source}/ repeats without a bound: write {min,max}`)
			}
			max = bound()
		}
		if (next() !== "}") {
			throw refused(`/${source}/ writes a malformed repetition`)
		}
		if (peek() === "?") {
			at += 1
		}
		return { kind: "repeat", node, min, max }
	}
	const sequence = (): Node => {
		const items: Array<Node> = []
		while (at < points.length && peek() !== "|" && peek() !== ")") {
			if (peek() === "^" || peek() === "$") {
				at += 1
				continue
			}
			items.push(quantified(atom()))
		}
		return { kind: "sequence", items }
	}
	const alternation = (): Node => {
		const first = sequence()
		const rest: Array<Node> = []
		while (peek() === "|") {
			at += 1
			rest.push(sequence())
		}
		return rest.length === 0 ? first : { kind: "choice", options: [first, ...rest] }
	}
	const tree = alternation()
	if (at !== points.length) {
		throw refused(`/${source}/ closes a group it never opened`)
	}
	return tree
}

const generatorOf = (node: Node): Gen<string> => {
	switch (node.kind) {
		case "literal":
			return constant(node.text)
		case "class":
			return element(node.characters)
		case "sequence": {
			const parts = Arr.map(node.items, generatorOf)
			return (source) =>
				Arr.join(
					Arr.map(parts, (part) => source.draw(part)),
					""
				)
		}
		case "choice":
			return oneOf(Arr.map(node.options, generatorOf))
		case "repeat":
			return map(array(generatorOf(node.node), { min: node.min, max: node.max }), Arr.join(""))
	}
}

/**
 * A string `pattern` matches, generated from the pattern itself: a class draws one of its characters, the first
 * simplest; a repetition draws its count, then each item; an alternative is one of the pattern's. Every repetition
 * states its bound (`{min,max}`, `?`), as every collection does, so `*`, `+` and `{n,}` are refused, and so is anything
 * generation cannot honour (a backreference, a lookaround, a word boundary), when the generator is built, never guessed
 * at. Anchors at a branch's ends are read as the whole string. A negated class and `.` draw from printable ASCII.
 */
export const matching = (pattern: RegExp): Gen<string> => generatorOf(parse(pattern.source))
