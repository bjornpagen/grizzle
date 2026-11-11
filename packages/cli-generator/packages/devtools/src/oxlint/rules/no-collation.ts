import { Array as Arr, Option, String as Str } from "effect"
import { type AnyNode, problem } from "#oxlint/rule.ts"

const isWordCharacter = (character: string): boolean =>
	(character >= "a" && character <= "z") ||
	(character >= "0" && character <= "9") ||
	character === "_"

/** Whether a lower-cased text holds `word` as a whole word that a clause follows: catalog identifiers such as
 * `datcollate` are not it, and neither is the bare word. */
const holdsWord = (text: string, word: string): boolean => {
	const from = (start: number): boolean =>
		Option.match(Str.indexOf(word)(Str.slice(start)(text)), {
			onNone: () => false,
			onSome: (offset) => {
				const at = start + offset
				const before = at === 0 ? "" : Str.slice(at - 1, at)(text)
				const after = Str.slice(at + word.length, at + word.length + 1)(text)
				const whole =
					!isWordCharacter(before) && Str.isNonEmpty(after) && Str.isEmpty(Str.trim(after))
				return whole || from(at + 1)
			}
		})
	return from(0)
}

/** The text a string literal or a template's quasi carries. */
const literalTexts = (node: AnyNode): ReadonlyArray<string> => {
	if (node.type === "Literal" && typeof node.value === "string") {
		return [node.value]
	}
	if (node.type === "TemplateElement") {
		return [node.value.raw]
	}
	return []
}

const MESSAGE =
	"SQL names a collation; the database's one locale is the only text order. Delete the clause: columns, indexes and comparisons already use the database's order."

/**
 * A `COLLATE` in SQL text. An app database is created with one locale, so every column, index and comparison already
 * orders text one way; a collation in a statement is a second, local answer to a question the database answers once.
 */
export const noCollation = problem((context) => {
	const check = (node: AnyNode): void => {
		if (Arr.some(literalTexts(node), (text) => holdsWord(Str.toLowerCase(text), "collate"))) {
			context.report({ node, message: MESSAGE })
		}
	}
	return { Literal: check, TemplateElement: check }
})
