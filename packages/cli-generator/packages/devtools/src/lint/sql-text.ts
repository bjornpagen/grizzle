import { Array as Arr, Option, String as Str } from "effect"
import * as ts from "typescript/ast"

/** A character of a regular-expression word: an ASCII letter, a digit or an underscore. */
const isWordCharacter = (character: string): boolean =>
	(character >= "a" && character <= "z") ||
	(character >= "A" && character <= "Z") ||
	(character >= "0" && character <= "9") ||
	character === "_"

/** The end of the quoted literal or identifier opening at `start`; a doubled quote is an escaped one. An unclosed
 * quote closes at the start of its last doubled quote, or is no quote at all. */
const quoteEnd = (
	characters: ReadonlyArray<string>,
	start: number,
	quote: string
): Option.Option<number> => {
	let index = start + 1
	let lastPair = Option.none<number>()
	while (index < characters.length) {
		if (characters[index] === quote) {
			if (characters[index + 1] !== quote) {
				return Option.some(index + 1)
			}
			lastPair = Option.some(index)
			index += 2
		} else {
			index += 1
		}
	}
	return Option.map(lastPair, (pair) => pair + 1)
}

/** The end of a block comment whose body starts at `from`; an unclosed one is no comment. */
const blockCommentEnd = (characters: ReadonlyArray<string>, from: number): Option.Option<number> =>
	Option.map(
		Arr.findFirstIndex(
			Arr.drop(characters, from),
			(character, index) => character === "*" && characters[from + index + 1] === "/"
		),
		(index) => from + index + 2
	)

/** The end of a line comment whose body starts at `from`: the next line break, which stays. */
const lineCommentEnd = (characters: ReadonlyArray<string>, from: number): number =>
	Option.match(
		Arr.findFirstIndex(Arr.drop(characters, from), (character) => character === "\n"),
		{ onNone: () => characters.length, onSome: (index) => from + index }
	)

/** The end of the quoted data or comment opening at `start`, if one opens there. */
const blankedEnd = (characters: ReadonlyArray<string>, start: number): Option.Option<number> => {
	const first = characters[start]
	const second = characters[start + 1]
	if (first === "'" || first === '"') {
		return quoteEnd(characters, start, first)
	}
	if (first === "/" && second === "*") {
		return blockCommentEnd(characters, start + 2)
	}
	if (first === "-" && second === "-") {
		return Option.some(lineCommentEnd(characters, start + 2))
	}
	return Option.none()
}

/** The text with each quoted literal, quoted identifier and comment replaced by one space. */
const blankQuoted = (text: string): string => {
	const characters = Str.split("")(text)
	const kept: Array<string> = []
	let resume = 0
	for (const [index, character] of characters.entries()) {
		if (index >= resume) {
			const end = blankedEnd(characters, index)
			if (Option.isSome(end)) {
				kept.push(" ")
				resume = end.value
			} else {
				kept.push(character)
			}
		}
	}
	return Arr.join(kept, "")
}

/**
 * A SQL template's authored grammar in lower case, read without a parser: its literal parts joined with ` ? ` where
 * values interpolate, with quoted data and comments blanked. The rules read words and operators off this text only,
 * never off interpolated values, and nothing here claims to parse PostgreSQL.
 */
export const authoredSql = (template: ts.TemplateLiteral): string => {
	const parts = ts.isNoSubstitutionTemplateLiteral(template)
		? [template.text]
		: [template.head.text, ...Arr.map(template.templateSpans, (span) => span.literal.text)]
	return Str.toLowerCase(blankQuoted(Arr.join(parts, " ? ")))
}

const isSqlWordStart = (character: string): boolean =>
	(character >= "a" && character <= "z") || character === "_"

const isSqlWordPart = (character: string): boolean =>
	isSqlWordStart(character) || (character >= "0" && character <= "9") || character === "$"

/** The words of lower-case authored SQL, in order: a letter or underscore, then letters, digits, underscores and
 * dollar signs. */
const sqlWords = (authored: string): ReadonlyArray<string> => {
	const words: Array<string> = []
	let current: Array<string> = []
	for (const character of Str.split("")(authored)) {
		if (
			Arr.isReadonlyArrayNonEmpty(current) ? isSqlWordPart(character) : isSqlWordStart(character)
		) {
			current.push(character)
		} else if (Arr.isReadonlyArrayNonEmpty(current)) {
			words.push(Arr.join(current, ""))
			current = []
		}
	}
	return Arr.isReadonlyArrayNonEmpty(current) ? [...words, Arr.join(current, "")] : words
}

/** The commands a data statement or set operation starts with, wherever they appear. */
const DATA_STATEMENTS: ReadonlyArray<string> = [
	"select",
	"insert",
	"update",
	"delete",
	"merge",
	"create",
	"alter",
	"drop",
	"truncate",
	"grant",
	"revoke",
	"explain",
	"union",
	"intersect",
	"except"
]

/** The clauses that make a template a statement fragment when it opens with one. */
const STATEMENT_FRAGMENTS: ReadonlyArray<string> = [
	"from",
	"join",
	"where",
	"having",
	"limit",
	"offset",
	"returning",
	"with"
]

const JOIN_SIDES: ReadonlyArray<string> = ["inner", "left", "right"]

/** Whether authored SQL writes a statement or a statement fragment: a data command anywhere, or a clause, a sided join
 * or a grouping at its start. */
export const hasStatementGrammar = (authored: string): boolean => {
	const words = sqlWords(authored)
	const [first, second] = words
	return (
		Arr.some(words, (word) => Arr.contains(DATA_STATEMENTS, word)) ||
		(first !== undefined && Arr.contains(STATEMENT_FRAGMENTS, first)) ||
		(first !== undefined && Arr.contains(JOIN_SIDES, first) && second === "join") ||
		(first === "group" && second === "by")
	)
}

/** The positions where `word` occurs in `text` with no word character right before it. */
const wordStarts = (text: string, word: string): ReadonlyArray<number> =>
	Arr.filter(
		Arr.makeBy(text.length, (index) => index),
		(index) =>
			Str.startsWith(word, index)(text) &&
			(index === 0 || !isWordCharacter(Str.slice(index - 1, index)(text)))
	)

/** Whether `word` occurs in `text` as a whole word. */
const hasWord = (text: string, word: string): boolean =>
	Arr.some(wordStarts(text, word), (index) => {
		const after = Str.slice(index + word.length, index + word.length + 1)(text)
		return Str.isEmpty(after) || !isWordCharacter(after)
	})

/** Whether authored SQL holds a window: the word `over` followed by an opening parenthesis. */
export const hasWindowExpression = (authored: string): boolean =>
	Arr.some(wordStarts(authored, "over"), (index) =>
		Str.startsWith("(")(Str.trimStart(Str.slice(index + "over".length)(authored)))
	)

const JSON_OPERATORS: ReadonlyArray<string> = ["->", "#>"]

const JSON_FUNCTIONS: ReadonlyArray<string> = [
	"jsonb_typeof",
	"jsonb_each",
	"jsonb_array_elements",
	"jsonb_array_elements_text"
]

/** Whether authored SQL renders a JSON operator (`->`, `->>`, `#>`, `#>>`) or a jsonb expansion function. */
export const hasJsonOperator = (authored: string): boolean =>
	Arr.some(JSON_OPERATORS, (operator) => Str.includes(operator)(authored)) ||
	Arr.some(JSON_FUNCTIONS, (name) => hasWord(authored, name))

const isIdentifierStart = (character: string): boolean =>
	(character >= "a" && character <= "z") ||
	(character >= "A" && character <= "Z") ||
	character === "_"

/** Whether a template part opens with an array cast, `::name[]`, after any whitespace. */
export const opensWithArrayCast = (text: string): boolean => {
	const trimmed = Str.trimStart(text)
	if (!Str.startsWith("::")(trimmed)) {
		return false
	}
	const characters = Str.split("")(Str.slice(2)(trimmed))
	if (!Option.exists(Arr.head(characters), isIdentifierStart)) {
		return false
	}
	const rest = Arr.dropWhile(Arr.drop(characters, 1), isWordCharacter)
	return Str.startsWith("[]")(Arr.join(rest, ""))
}

/** Whether a template part ends, before any whitespace, with one of the words, in any case. */
export const closesWithWord = (text: string, words: ReadonlyArray<string>): boolean => {
	const trimmed = Str.toLowerCase(Str.trimEnd(text))
	return Arr.some(words, (word) => {
		if (!Str.endsWith(word)(trimmed)) {
			return false
		}
		const start = trimmed.length - word.length
		return start === 0 || !isWordCharacter(Str.slice(start - 1, start)(trimmed))
	})
}

/** Whether a template part opens, after any whitespace, with one of the words or with nothing at all, in any case. */
export const opensWithWordOrEnd = (text: string, words: ReadonlyArray<string>): boolean => {
	const trimmed = Str.toLowerCase(Str.trimStart(text))
	return (
		Str.isEmpty(trimmed) ||
		Arr.some(words, (word) => {
			const after = Str.slice(word.length, word.length + 1)(trimmed)
			return Str.startsWith(word)(trimmed) && (Str.isEmpty(after) || !isWordCharacter(after))
		})
	)
}

/** The text with every run of whitespace written as one space, and none at either end. */
export const collapseWhitespace = (text: string): string => {
	const kept: Array<string> = []
	for (const character of Str.split("")(text)) {
		if (Str.isNonEmpty(Str.trim(character))) {
			kept.push(character)
		} else if (Option.exists(Arr.last(kept), (last) => last !== " ")) {
			kept.push(" ")
		}
	}
	return Str.trim(Arr.join(kept, ""))
}
