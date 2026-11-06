import { Array as Arr, Option, Schema, String as Str } from "effect"
import { array, constant, type Gen, map, oneOf } from "#gen.ts"

/** A run of code points, both ends included. */
type Run = Readonly<{ low: number; high: number }>

/**
 * A parsed pattern: a literal, a set of characters, a sequence, a choice among alternatives, or a bounded repetition. A
 * set of characters is its runs, disjoint and in the order its members are first written, never its characters one by
 * one: a class is drawn by its member's index across the runs, so its size costs nothing, and the parse that refuses a
 * pattern never builds a character.
 */
type Node =
	| Readonly<{ kind: "literal"; text: string }>
	| Readonly<{ kind: "class"; runs: Arr.NonEmptyReadonlyArray<Run> }>
	| Readonly<{ kind: "sequence"; items: ReadonlyArray<Node> }>
	| Readonly<{ kind: "choice"; options: Arr.NonEmptyReadonlyArray<Node> }>
	| Readonly<{ kind: "repeat"; node: Node; min: number; max: number }>

const run = (low: number, high: number): Run => ({ low, high })

const single = (point: number): Run => run(point, point)

/** What is left of a run once another is cut out of it, in ascending order. */
const without = (piece: Run, cut: Run): ReadonlyArray<Run> => {
	if (cut.high < piece.low || cut.low > piece.high) {
		return [piece]
	}
	return [
		...(piece.low < cut.low ? [run(piece.low, cut.low - 1)] : []),
		...(cut.high < piece.high ? [run(cut.high + 1, piece.high)] : [])
	]
}

/** The members of a run that none of `taken` holds, in ascending order. */
const minus = (piece: Run, taken: ReadonlyArray<Run>): ReadonlyArray<Run> => {
	const whole: ReadonlyArray<Run> = [piece]
	return Arr.reduce(taken, whole, (pieces, cut) =>
		Arr.flatMap(pieces, (left) => without(left, cut))
	)
}

/** Runs as written, made disjoint: each keeps only the members no earlier run holds, so a member stays where it is
 * first written, and an empty run (a range written high to low) holds none. */
const disjoint = (written: ReadonlyArray<Run>): ReadonlyArray<Run> => {
	const none: ReadonlyArray<Run> = []
	return Arr.reduce(written, none, (kept, next) =>
		next.low > next.high ? kept : [...kept, ...minus(next, kept)]
	)
}

/** The printable ASCII characters, which `.` and a negated class draw from. */
const PRINTABLE: Run = run(0x20, 0x7e)

const DIGITS: ReadonlyArray<Run> = [run(0x30, 0x39)]

const WORD: ReadonlyArray<Run> = [run(0x41, 0x5a), run(0x61, 0x7a), ...DIGITS, single(0x5f)]

const SPACE: ReadonlyArray<Run> = [single(0x20), single(0x09), single(0x0a)]

/** The runs a shorthand class names, and its complement among the printable characters. */
const SHORTHANDS: Readonly<Record<string, ReadonlyArray<Run>>> = {
	d: DIGITS,
	w: WORD,
	s: SPACE,
	D: minus(PRINTABLE, DIGITS),
	W: minus(PRINTABLE, WORD),
	S: minus(PRINTABLE, SPACE)
}

/** How many characters runs hold. */
const sizeOf = (runs: ReadonlyArray<Run>): number =>
	Arr.reduce(runs, 0, (total, { low, high }) => total + high - low + 1)

/** The code point at an index across runs, counted from the first run's low end; an index the runs before the last
 * do not hold lies in the last. */
const pointAt = (runs: Arr.NonEmptyReadonlyArray<Run>, index: number): number => {
	let rest = index
	for (const { low, high } of Arr.initNonEmpty(runs)) {
		if (rest <= high - low) {
			return low + rest
		}
		rest -= high - low + 1
	}
	return Arr.lastNonEmpty(runs).low + rest
}

/** A pattern `matching` cannot generate from, and why: it refuses what it would otherwise have to guess at. */
export class PatternRefused extends Schema.TaggedError<
	PatternRefused,
	{ readonly brand: unique symbol }
>()("PatternRefused", { message: Schema.String }) {}

const refused = (message: string) => PatternRefused.make({ message })

const isDigit = (point: string) => point >= "0" && point <= "9"

const isHex = (point: string) =>
	isDigit(point) || (point >= "a" && point <= "f") || (point >= "A" && point <= "F")

const isLetter = (point: string) => (point >= "a" && point <= "z") || (point >= "A" && point <= "Z")

const nonEmpty = (runs: ReadonlyArray<Run>, where: string): Arr.NonEmptyReadonlyArray<Run> => {
	if (!Arr.isReadonlyArrayNonEmpty(runs)) {
		throw refused(`${where} matches no character`)
	}
	return runs
}

/** The one character runs hold, when they hold exactly one. */
const onlyOf = (runs: ReadonlyArray<Run>): Option.Option<number> => {
	const [first] = runs
	return runs.length === 1 && first !== undefined && first.low === first.high
		? Option.some(first.low)
		: Option.none()
}

const pointOf = (character: string): number =>
	Option.getOrElse(Str.codePointAt(0)(character), () => 0)

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
	const hexDigit = (): string => {
		const digit = next()
		if (!isHex(digit)) {
			throw refused(`/${source}/ writes a malformed hexadecimal escape`)
		}
		return digit
	}
	/** The code point `count` hexadecimal digits name, as `\xHH` and `\uHHHH` write it. */
	const hexOf = (count: number): number =>
		Number.parseInt(Arr.join(Arr.makeBy(count, hexDigit), ""), 16)
	/** The code point `\u{H…}` names, between its braces. */
	const bracedHex = (): number => {
		at += 1
		let digits = hexDigit()
		while (peek() !== "}") {
			digits += hexDigit()
		}
		next()
		return Number.parseInt(digits, 16)
	}
	const escaped = (inClass: boolean): ReadonlyArray<Run> => {
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
		if (point === "x") {
			return [single(hexOf(2))]
		}
		if (point === "u") {
			return [single(peek() === "{" ? bracedHex() : hexOf(4))]
		}
		const controls: Readonly<Record<string, string>> = {
			n: "\n",
			t: "\t",
			r: "\r",
			f: "\f",
			v: "\v",
			"0": "\0"
		}
		const control = controls[point]
		if (control !== undefined) {
			return [single(pointOf(control))]
		}
		if (isLetter(point)) {
			throw refused(`/${source}/ uses \\${point}, which generation cannot honour`)
		}
		return [single(pointOf(point))]
	}
	const characterClass = (): Node => {
		const negated = peek() === "^"
		if (negated) {
			at += 1
		}
		const members: Array<Run> = []
		let first = true
		while (peek() !== "]" || first) {
			first = false
			const point = next()
			const start = point === "\\" ? escaped(true) : [single(pointOf(point))]
			const low = onlyOf(start)
			if (
				Option.isSome(low) &&
				peek() === "-" &&
				points[at + 1] !== undefined &&
				points[at + 1] !== "]"
			) {
				at += 1
				const endPoint = next()
				const high = onlyOf(endPoint === "\\" ? escaped(true) : [single(pointOf(endPoint))])
				if (Option.isNone(high)) {
					throw refused(`/${source}/ ends a range with a class`)
				}
				members.push(run(low.value, high.value))
			} else {
				for (const member of start) {
					members.push(member)
				}
			}
		}
		next()
		const set = disjoint(members)
		return {
			kind: "class",
			runs: nonEmpty(negated ? minus(PRINTABLE, set) : set, `/${source}/'s class`)
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
				return { kind: "class", runs: [PRINTABLE] }
			case "\\": {
				const runs = escaped(false)
				return Option.match(onlyOf(runs), {
					onSome: (only): Node => ({ kind: "literal", text: String.fromCodePoint(only) }),
					onNone: (): Node => ({
						kind: "class",
						runs: nonEmpty(disjoint(runs), `/${source}/'s shorthand`)
					})
				})
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
		case "class": {
			const { runs } = node
			const last = sizeOf(runs) - 1
			return (source) => String.fromCodePoint(pointAt(runs, source.pick(0, last)))
		}
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
 * generation cannot honour (a backreference, a lookaround, a word boundary, a property or control escape, a letter
 * escape with no meaning), when the generator is built, never guessed at. `\xHH`, `\uHHHH` and `\u{H…}` name their
 * code point. Anchors at a branch's ends are read as the whole string. A negated class and `.` draw from printable ASCII. A
 * class is drawn by its member's index, as `element` draws from the class written out, so a class of a million code
 * points costs what a class of two does, and a refused pattern is refused before any class is drawn from.
 */
export const matching = (pattern: RegExp): Gen<string> => generatorOf(parse(pattern.source))
