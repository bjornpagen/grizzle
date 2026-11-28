import * as Result from "@bjornpagen/grizzle-text/base/result"
import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import type { ValueFault } from "#compiler/core/errors.ts"
import { validateText } from "#compiler/core/text.ts"
import {
	searchLexemeMaxBytes,
	searchPositionMax,
	searchPositionsMax,
	textSearchStringMaxBytes
} from "#compiler/scalar/values/fault.ts"

/** A weight's letter as tsvectorout prints it after a position: A, B and C; D, every position's default, none. */
const weightLetters: ReadonlySet<number> = new Set([0x41, 0x42, 0x43])

const quote = 0x27
const backslash = 0x5c
const colon = 0x3a
const comma = 0x2c
const space = 0x20
const zero = 0x30
const nine = 0x39

const isDigit = (unit: number): boolean => unit >= zero && unit <= nine

/**
 * The bytes tsvectorin holds of a document's lexemes and positions (uniqueentry's buflen): each lexeme's UTF-8 bytes,
 * and after a lexeme of positions, the count's 2 bytes and each position's 2, from an even offset (SHORTALIGN), which
 * textSearchStringMaxBytes bounds.
 */
const heldAfter = (held: number, lexemeBytes: number, positions: number): number => {
	const lexemes = held + lexemeBytes
	return positions === 0 ? lexemes : lexemes + (lexemes % 2) + 2 + 2 * positions
}

/** Where a lexeme's quoted text ends and what it spells, or none where it is not tsvectorout's quoting. */
const quotedLexeme = (
	text: string,
	from: number
): { readonly lexeme: string; readonly end: number } | undefined => {
	if (text.charCodeAt(from) !== quote) {
		return undefined
	}
	let lexeme = ""
	let start = from + 1
	let at = start
	while (at < text.length) {
		const unit = text.charCodeAt(at)
		if (unit === quote && text.charCodeAt(at + 1) !== quote) {
			return { lexeme: lexeme + text.slice(start, at), end: at + 1 }
		}
		if (unit === quote || unit === backslash) {
			if (text.charCodeAt(at + 1) !== unit) {
				return undefined
			}
			lexeme += text.slice(start, at + 1)
			at += 2
			start = at
		} else {
			at += 1
		}
	}
	return undefined
}

/**
 * Where a lexeme's positions end and how many it holds, from `from` just past its colon, or the fault of a list that is
 * not tsvectorout's: each position a decimal of no leading zero above the one before it, within searchPositionMax,
 * followed by its weight's letter where it has one (weightLetters), the positions joined by commas, at most
 * searchPositionsMax of them.
 */
const positionsAt = (
	text: string,
	from: number
): Result.Result<{ readonly end: number; readonly count: number }, ValueFault> => {
	let at = from
	let count = 0
	let last = 0
	for (;;) {
		const start = at
		while (isDigit(text.charCodeAt(at))) {
			at += 1
		}
		if (at === start || text.charCodeAt(start) === zero) {
			return Result.err("searchDocumentForm")
		}
		const position = Number(text.slice(start, at))
		if (position <= last || position > searchPositionMax) {
			return Result.err("searchDocumentForm")
		}
		last = position
		count += 1
		if (weightLetters.has(text.charCodeAt(at))) {
			at += 1
		}
		if (text.charCodeAt(at) !== comma) {
			return count > searchPositionsMax
				? Result.err("searchDocumentForm")
				: Result.ok({ end: at, count })
		}
		at += 1
	}
}

/**
 * A search document's host value, admitted exactly: the text PostgreSQL prints for a tsvector (tsvectorout), which a
 * read of one delivers and a write of a stored one (tsvector) sends back as it is. tsvectorin reads more texts than
 * tsvectorout prints, and stores each as the one document it prints: it sorts and merges the lexemes, sorts the
 * positions, keeps a repeated one's greatest weight, cuts a position past searchPositionMax and a lexeme's positions
 * past searchPositionsMax. So the one text admitted for a document is the one it prints, and every other is refused
 * (searchDocumentForm), never sent to be stored as another document than it spells:
 *
 * - "" for the empty document, else its lexemes joined by one space, each between single quotes, a quote and a
 *   backslash within it doubled, nonempty, in strictly ascending order of their UTF-8 bytes, which is their code
 *   points' order (tsCompareString's memcmp);
 * - after a lexeme, where it has positions, a colon and its positions (positionsAt).
 *
 * A document tsvectorin would refuse is refused here too (searchDocumentSize): a lexeme past searchLexemeMaxBytes, or
 * lexemes and positions past textSearchStringMaxBytes as tsvectorin counts them (heldAfter).
 */
export const parseSearchDocument = (value: unknown): Result.Result<string, ValueFault> => {
	const admitted = validateText(value)
	if (!admitted.ok) {
		return admitted
	}
	const text = admitted.value
	let at = 0
	let held = 0
	let previous: string | undefined
	while (at < text.length) {
		if (previous !== undefined) {
			if (text.charCodeAt(at) !== space) {
				return Result.err("searchDocumentForm")
			}
			at += 1
		}
		const quoted = quotedLexeme(text, at)
		if (
			quoted === undefined ||
			quoted.lexeme === "" ||
			(previous !== undefined && compareCodePoints(previous, quoted.lexeme) >= 0)
		) {
			return Result.err("searchDocumentForm")
		}
		const bytes = utf8Length(quoted.lexeme)
		if (bytes > searchLexemeMaxBytes) {
			return Result.err("searchDocumentSize")
		}
		at = quoted.end
		previous = quoted.lexeme
		if (text.charCodeAt(at) === colon) {
			const positions = positionsAt(text, at + 1)
			if (!positions.ok) {
				return positions
			}
			at = positions.value.end
			held = heldAfter(held, bytes, positions.value.count)
		} else {
			held = heldAfter(held, bytes, 0)
		}
	}
	return held > textSearchStringMaxBytes ? Result.err("searchDocumentSize") : Result.ok(text)
}
