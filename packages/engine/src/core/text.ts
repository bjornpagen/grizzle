import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { isWellFormedText, type WellFormedText } from "@bjornpagen/grizzle-text/utf8"
import { nominal } from "#compiler/core/brand.ts"
import type { ValueFault } from "#compiler/core/errors.ts"

/**
 * Storable text: what PostgreSQL text can hold, and the orders of texts that spell lists of them, under the fixed
 * C.UTF-8 contract whose code points and order are @bjornpagen/grizzle-text's (text.ts).
 *
 * At every input boundary NUL and unpaired UTF-16 surrogates are refused, never replaced: PostgreSQL text cannot hold
 * U+0000, and a lone surrogate is no Unicode scalar, so a UTF-8 encoder would silently substitute U+FFFD for it. A
 * declared name is storable text too (ir/desc.ts), so the rule lives below every layer that states one.
 *
 * A text value: a string with no NUL and no unpaired surrogate, so a well-formed one (grizzle-text WellFormedText).
 */
export const validateText = (value: unknown): Result.Result<WellFormedText, ValueFault> => {
	if (typeof value !== "string") {
		return Result.err("textType")
	}
	if (value.includes("\u0000")) {
		return Result.err("textNul")
	}
	if (!isWellFormedText(value)) {
		return Result.err("textSurrogate")
	}
	return Result.ok(value)
}

export const isValidText = (value: unknown): value is WellFormedText => validateText(value).ok

/**
 * A text grizzle holds, proved well-formed (grizzle-text WellFormedText) by grizzle-text's one proof of a text's form
 * (isWellFormedText) where it becomes bytes: an admitted text's parameter text, a text PostgreSQL or a file gave, or one
 * grizzle composes of those and its own (a fingerprint's frame, an identity's canonical form, a statement, a function's
 * source, a JSON body). Every such text is admitted, decoded or composed of such parts, so one that is not well-formed
 * is a defect.
 */
export const wellFormed = (text: string): WellFormedText => {
	if (!isWellFormedText(text)) {
		throw defect("a text grizzle holds is well-formed")
	}
	return text
}

/**
 * The hex digits of a JSON `\u` escape, as ECMA-262's UnicodeEscape (https://tc39.es/ecma262/#sec-unicodeescape)
 * writes them: "Let hex be the String representation of n, formatted as a lowercase hexadecimal number", then "Return
 * the string-concatenation of the code unit 0x005C (REVERSE SOLIDUS), "u", and StringPad(hex, 4, "0", start)."
 *
 * @formatConstant a JSON \u escape: four lowercase hex digits
 */
const unicodeEscapeDigits = 4

/** The JSON escape of one UTF-16 code unit inside a string literal, none for a unit JSON writes as itself. */
const escapeOf = (unit: number): string | undefined => {
	switch (unit) {
		case 0x22:
			return '\\"'
		case 0x5c:
			return "\\\\"
		case 0x08:
			return "\\b"
		case 0x09:
			return "\\t"
		case 0x0a:
			return "\\n"
		case 0x0c:
			return "\\f"
		case 0x0d:
			return "\\r"
		default:
			return unit < 0x20 ? `\\u${unit.toString(16).padStart(unicodeEscapeDigits, "0")}` : undefined
	}
}

/**
 * What a JSON string literal of `text` holds where `text` holds the unit at `i`: that unit's escape, the unit itself,
 * or, past the text's end, the literal's closing quote.
 */
const quotedAt = (text: string, i: number): string =>
	i >= text.length ? '"' : (escapeOf(text.charCodeAt(i)) ?? text.charAt(i))

/**
 * The order `units` gives two well-formed texts' JSON string literals (JSON.stringify), without spelling them: the
 * literals agree up to the first unit the texts differ at, where each holds that unit's escape, the unit itself, or
 * the closing quote past its text's end. An escape begins with a backslash, which no unescaped unit is, and two escapes
 * differ at their second character or are both `\u00XX`, so neither compared string is a prefix of the other and one
 * comparison decides. `units` is compareCodePoints for code point order, or core/order.ts compareStrings for UTF-16
 * code unit order. A well-formed text holds no lone surrogate, which JSON.stringify would escape.
 */
export const compareQuoted =
	(units: (a: string, b: string) => number) =>
	(a: string, b: string): number => {
		if (a === b) {
			return 0
		}
		const n = Math.min(a.length, b.length)
		for (let i = 0; i < n; i++) {
			if (a.charCodeAt(i) !== b.charCodeAt(i)) {
				return units(quotedAt(a, i), quotedAt(b, i))
			}
		}
		return a.length === b.length ? 0 : units(quotedAt(a, n), quotedAt(b, n))
	}

/**
 * The order `units` gives two lists of well-formed texts as JSON arrays of string literals (JSON.stringify), without
 * spelling them: element by element in compareQuoted's order, and past a shared prefix the longer list first, as an
 * array that goes on (`,`) is below one that ends (`]`).
 */
export const compareQuotedTuples = (units: (a: string, b: string) => number) => {
	const quoted = compareQuoted(units)
	return (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
		for (let i = 0; i < a.length; i += 1) {
			const x = a[i]
			const y = b[i]
			if (x === undefined || y === undefined) {
				return y === undefined ? -1 : 1
			}
			const order = quoted(x, y)
			if (order !== 0) {
				return order
			}
		}
		return a.length < b.length ? 1 : 0
	}
}

/** FNV-1a's 32-bit offset basis and prime (http://www.isthe.com/chongo/tech/comp/fnv/), a digest's start and step. */
const fnvOffset = 0x811c9dc5
const fnvPrime = 0x01000193

declare const textsIdBrand: unique symbol

/**
 * A list of well-formed texts as an identity, its texts never joined into one string, so a list of any length has one:
 * the texts themselves; their digest, FNV-1a over the list's count and every text's length and units; and whether
 * every unit of them is below U+D800, where UTF-16 code unit order, JavaScript's own order of strings, is code point
 * order, both worked out in one pass. Two lists are one identity exactly when they hold the same texts, and two
 * identities are in their lists' code point order element by element, a list before every list it begins
 * (`compareTextsIds`). A map of identities (`TextsMap`) hashes a list by its digest, once, and reads its texts only
 * where two digests are one. Minted by `textsId` alone.
 */
export interface TextsId {
	readonly texts: ReadonlyArray<string>
	readonly digest: number
	readonly belowSurrogates: boolean
	readonly [textsIdBrand]: true
}

const mintTextsId = nominal<
	{
		readonly texts: ReadonlyArray<string>
		readonly digest: number
		readonly belowSurrogates: boolean
	},
	TextsId
>()

/** The identity of a list of well-formed texts (`TextsId`): its texts, their digest and their units' range, one pass. */
export const textsId = (texts: ReadonlyArray<string>): TextsId => {
	let digest = Math.imul(fnvOffset ^ texts.length, fnvPrime)
	let belowSurrogates = true
	for (const text of texts) {
		digest = Math.imul(digest ^ text.length, fnvPrime)
		for (let at = 0; at < text.length; at += 1) {
			const code = text.charCodeAt(at)
			digest = Math.imul(digest ^ code, fnvPrime)
			belowSurrogates &&= code < 0xd800
		}
	}
	return mintTextsId({ texts, digest: digest | 0, belowSurrogates })
}

/** Two lists of strings in their strings' order, element by element by `text`, a list before every list it begins. */
const listOrder =
	(text: (a: string, b: string) => number) =>
	(a: ReadonlyArray<string>, b: ReadonlyArray<string>): -1 | 0 | 1 => {
		const n = Math.min(a.length, b.length)
		for (let at = 0; at < n; at += 1) {
			const x = a[at] ?? ""
			const y = b[at] ?? ""
			if (x !== y) {
				return text(x, y) < 0 ? -1 : 1
			}
		}
		return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
	}

/** Strings in JavaScript's own order, by UTF-16 code unit. */
const byUnits = (a: string, b: string): number => (a < b ? -1 : 1)

/** Two lists of well-formed texts in code point order, element by element, a list before every list it begins: the
 * order of their identities (`compareTextsIds`). */
export const compareTextLists: (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => -1 | 0 | 1 =
	listOrder(compareCodePoints)

/** Two lists whose every unit is below U+D800 in code point order: JavaScript's own order of their strings. */
const compareUnitLists = listOrder(byUnits)

/**
 * Two identities in their lists' code point order, element by element (`compareTextLists`): JavaScript's own order of
 * their texts, read natively, where every unit of both is below U+D800, as it is of almost every list; their code
 * points read off one by one otherwise.
 */
export const compareTextsIds = (a: TextsId, b: TextsId): -1 | 0 | 1 =>
	a.belowSurrogates && b.belowSurrogates
		? compareUnitLists(a.texts, b.texts)
		: compareTextLists(a.texts, b.texts)

/** Whether two identities of one digest are one: the same texts in order. */
const sameTextsId = (a: TextsId, b: TextsId): boolean =>
	a === b ||
	(a.texts.length === b.texts.length && a.texts.every((text, at) => text === b.texts[at]))

/** One entry of a TextsMap: its key as it was first set, its value, and its place in the map's order. */
interface TextsEntry<V> {
	readonly key: TextsId
	value: V
	at: number
}

/**
 * A node of a digest's ordered bucket (`TextsBucket`): an entry, the entries before and after its key in the order of
 * identities (compareTextsIds), and its subtree's height, an AVL tree's: every node's subtrees differ in height by at
 * most one, so a tree of k entries is at most 1.4405·log₂(k + 2) high, and a lookup compares its key with at most that
 * many entries' (Adelson-Velsky and Landis, 1962; Knuth, TAOCP 3, §6.2.3).
 */
interface BucketNode<V> {
	readonly entry: TextsEntry<V>
	readonly before: BucketNode<V> | undefined
	readonly after: BucketNode<V> | undefined
	readonly height: number
}

/** A subtree's height, none's 0. */
const heightOf = <V>(node: BucketNode<V> | undefined): number =>
	node === undefined ? 0 : node.height

/** A node of `entry` over two subtrees, its height theirs and one. */
const nodeOf = <V>(
	entry: TextsEntry<V>,
	before: BucketNode<V> | undefined,
	after: BucketNode<V> | undefined
): BucketNode<V> => ({
	entry,
	before,
	after,
	height: Math.max(heightOf(before), heightOf(after)) + 1
})

/** A node of `entry` over two subtrees whose heights differ by at most two, rotated to differ by at most one. */
const balanced = <V>(
	entry: TextsEntry<V>,
	before: BucketNode<V> | undefined,
	after: BucketNode<V> | undefined
): BucketNode<V> => {
	if (before !== undefined && heightOf(before) > heightOf(after) + 1) {
		const inner = before.after
		return inner !== undefined && heightOf(inner) > heightOf(before.before)
			? nodeOf(
					inner.entry,
					nodeOf(before.entry, before.before, inner.before),
					nodeOf(entry, inner.after, after)
				)
			: nodeOf(before.entry, before.before, nodeOf(entry, before.after, after))
	}
	if (after !== undefined && heightOf(after) > heightOf(before) + 1) {
		const inner = after.before
		return inner !== undefined && heightOf(inner) > heightOf(after.after)
			? nodeOf(
					inner.entry,
					nodeOf(entry, before, inner.before),
					nodeOf(after.entry, inner.after, after.after)
				)
			: nodeOf(after.entry, nodeOf(entry, before, after.before), after.after)
	}
	return nodeOf(entry, before, after)
}

/** The entry of `key` in a tree, found by comparing its key with one entry's per level. */
const foundIn = <V>(node: BucketNode<V> | undefined, key: TextsId): TextsEntry<V> | undefined => {
	for (let at = node; at !== undefined;) {
		const order = compareTextsIds(key, at.entry.key)
		if (order === 0) {
			return at.entry
		}
		at = order < 0 ? at.before : at.after
	}
	return undefined
}

/** A tree with `entry`, whose key it holds none of, added in its key's place. */
const insertedIn = <V>(node: BucketNode<V> | undefined, entry: TextsEntry<V>): BucketNode<V> => {
	if (node === undefined) {
		return nodeOf(entry, undefined, undefined)
	}
	return compareTextsIds(entry.key, node.entry.key) < 0
		? balanced(node.entry, insertedIn(node.before, entry), node.after)
		: balanced(node.entry, node.before, insertedIn(node.after, entry))
}

/** A tree's first entry and the tree without it. */
const firstOf = <V>(
	node: BucketNode<V>
): { readonly entry: TextsEntry<V>; readonly rest: BucketNode<V> | undefined } => {
	if (node.before === undefined) {
		return { entry: node.entry, rest: node.after }
	}
	const first = firstOf(node.before)
	return { entry: first.entry, rest: balanced(node.entry, first.rest, node.after) }
}

/** A tree without the entry of `key`, which it holds. */
const removedFrom = <V>(
	node: BucketNode<V> | undefined,
	key: TextsId
): BucketNode<V> | undefined => {
	if (node === undefined) {
		return undefined
	}
	const order = compareTextsIds(key, node.entry.key)
	if (order < 0) {
		return balanced(node.entry, removedFrom(node.before, key), node.after)
	}
	if (order > 0) {
		return balanced(node.entry, node.before, removedFrom(node.after, key))
	}
	if (node.after === undefined) {
		return node.before
	}
	const next = firstOf(node.after)
	return balanced(next.entry, node.before, next.rest)
}

/**
 * The entries of one digest in a TextsMap: its one entry, which a lookup of that digest compares texts for texts; or,
 * once a second list meets it, an AVL tree of them in the order of identities (`BucketNode`), so a lookup there
 * compares its key with at most the tree's height of entries, at most 1.4405·log₂(k + 2) of the k lists that share the
 * digest, whatever lists were made to meet under FNV-1a's public start, which the engine cannot seed since it draws no
 * randomness, and however long their texts: every comparison is exact, none leans on a hash of the texts. No native
 * Map of texts would do: V8 hashes a string longer than 16,383 units by its length alone (src/objects/string.h
 * kMaxHashCalcLength), so a Map of distinct texts of one such length is one chain, each lookup comparing its key with
 * every text of the chain.
 */
type TextsBucket<V> =
	| { readonly kind: "one"; readonly entry: TextsEntry<V> }
	| { readonly kind: "tree"; readonly root: BucketNode<V> }

/**
 * A map keyed by identities (`TextsId`), exactly: two keys are one where their lists are one, whatever objects hold
 * them. A key is found by its digest, one native lookup of a number, then within its digest's bucket (`TextsBucket`),
 * compared texts for texts with the one entry there or, once two lists share a digest, with at most the height of the
 * AVL tree the bucket becomes, never their texts joined, and no two lists are ever one entry for sharing a digest: a
 * lookup costs the digest, made once where its identity is, one native lookup and at most 1.4405·log₂(k + 2) exact
 * comparisons where k lists share its digest. Iteration is in insertion order, each key as it was first set, an entry
 * set again keeping its place, as a Map's does. It holds what its readers read of a Map and no more; a Z-set's change
 * (core/zset.ts) is one.
 */
export class TextsMap<V> {
	readonly #buckets = new Map<number, TextsBucket<V>>()
	/** The entries in insertion order, a deleted one's place empty until the order is compacted. */
	#order: Array<TextsEntry<V> | undefined> = []
	#size = 0

	#found(key: TextsId): TextsEntry<V> | undefined {
		const held = this.#buckets.get(key.digest)
		if (held === undefined) {
			return undefined
		}
		switch (held.kind) {
			case "one":
				return sameTextsId(held.entry.key, key) ? held.entry : undefined
			case "tree":
				return foundIn(held.root, key)
		}
	}

	get size(): number {
		return this.#size
	}

	get(key: TextsId): V | undefined {
		return this.#found(key)?.value
	}

	has(key: TextsId): boolean {
		return this.#found(key) !== undefined
	}

	set(key: TextsId, value: V): this {
		const found = this.#found(key)
		if (found !== undefined) {
			found.value = value
			return this
		}
		const entry: TextsEntry<V> = { key, value, at: this.#order.length }
		this.#order.push(entry)
		this.#size += 1
		const held = this.#buckets.get(key.digest)
		this.#buckets.set(
			key.digest,
			held === undefined
				? { kind: "one", entry }
				: {
						kind: "tree",
						root: insertedIn(
							held.kind === "one" ? nodeOf(held.entry, undefined, undefined) : held.root,
							entry
						)
					}
		)
		return this
	}

	delete(key: TextsId): boolean {
		const found = this.#found(key)
		if (found === undefined) {
			return false
		}
		const held = this.#buckets.get(key.digest)
		const rest = held?.kind === "tree" ? removedFrom(held.root, key) : undefined
		if (rest === undefined) {
			this.#buckets.delete(key.digest)
		} else {
			this.#buckets.set(key.digest, { kind: "tree", root: rest })
		}
		this.#order[found.at] = undefined
		this.#size -= 1
		if (this.#size * 2 < this.#order.length) {
			this.#order = this.#order.filter((entry) => entry !== undefined)
			for (const [at, entry] of this.#order.entries()) {
				if (entry !== undefined) {
					entry.at = at
				}
			}
		}
		return true
	}

	*entries(): MapIterator<[TextsId, V]> {
		for (const entry of this.#order) {
			if (entry !== undefined) {
				yield [entry.key, entry.value]
			}
		}
	}

	*values(): MapIterator<V> {
		for (const entry of this.#order) {
			if (entry !== undefined) {
				yield entry.value
			}
		}
	}

	[Symbol.iterator](): MapIterator<[TextsId, V]> {
		return this.entries()
	}
}

/** Whether a text spells a natural number in decimal with no leading zero ("0" itself included). */
export const isDecimal = (text: string): boolean => {
	if (text === "") {
		return false
	}
	if (text.length > 1 && text.startsWith("0")) {
		return false
	}
	for (const ch of text) {
		if (ch < "0" || ch > "9") {
			return false
		}
	}
	return true
}

/**
 * PostgreSQL's quoted identifier of a name: double quotes around it, each `"` in it doubled, so case and reserved words
 * never matter. The one quoting of an identifier, which the SQL printer (sql/print.ts), the replication protocol's
 * commands (live/replication.ts) and every other spelling of a name read.
 */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** A standard-conforming string literal: single quotes around it, only the single quote special, each one doubled. */
export const quoteString = (value: string): string => `'${value.replaceAll("'", "''")}'`
