import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { compareCodePoints, isAsciiDigits } from "@bjornpagen/grizzle-text/text"
import { isWellFormedText, jsonEscape, type WellFormedText } from "@bjornpagen/grizzle-text/utf8"
import { nominal } from "#compiler/core/brand.ts"
import type { ValueFault } from "#compiler/core/errors.ts"
import { compareStrings, inOrder } from "#compiler/core/order.ts"

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
		defect("a text grizzle holds is well-formed")
	}
	return text
}

/**
 * What a JSON string literal of `text` holds where `text` holds the unit at `i`: that unit's escape, the unit itself,
 * or, past the text's end, the literal's closing quote.
 */
const quotedAt = (text: string, i: number): string =>
	i >= text.length ? '"' : (jsonEscape(text.charCodeAt(i)) ?? text.charAt(i))

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
 * the texts themselves; their digest, FNV-1a over the list's count and every text's length and units, its 32 bits but
 * the lowest, which FNV-1a mixes least (it is the parity of the units' lowest bits), so the digest is one of V8's small
 * integers, 31 bits under pointer compression, which an object holds in its own field and a native Map keys by without
 * boxing it as a heap number; and whether every unit of them is below U+D800, where UTF-16 code unit order,
 * JavaScript's own order of strings, is code point order, both worked out in one pass. Two lists are one identity exactly when they hold the same texts, and two
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
	return mintTextsId({ texts, digest: digest >> 1, belowSurrogates })
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

/** Two lists of well-formed texts in code point order, element by element, a list before every list it begins: the
 * order of their identities (`compareTextsIds`). */
export const compareTextLists: (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => -1 | 0 | 1 =
	listOrder(compareCodePoints)

/** Two lists whose every unit is below U+D800 in code point order: JavaScript's own order of their strings. */
const compareUnitLists = listOrder(compareStrings)

/**
 * Two identities in their lists' code point order, element by element (`compareTextLists`): JavaScript's own order of
 * their texts, read natively, where every unit of both is below U+D800, as it is of almost every list; their code
 * points read off one by one otherwise.
 */
export const compareTextsIds = (a: TextsId, b: TextsId): -1 | 0 | 1 =>
	a.belowSurrogates && b.belowSurrogates
		? compareUnitLists(a.texts, b.texts)
		: compareTextLists(a.texts, b.texts)

/**
 * `entries` in the order of their identities (`compareTextsIds`), as a stable sort leaves them: `entries` themselves
 * where they already stand in it, which one pass over their identities finds, as normal facts do when they are
 * normalized again; otherwise sorted through columns, the texts at each position of every identity, one array a
 * position, so a comparison reads its two texts from one array each, where reading an identity's list through its
 * entry and its identity object is a chain of loads from memory far apart, which over a set of hundreds of thousands is
 * most of a sort's cost. JavaScript's own order of their texts where every unit of every identity is below U+D800, code
 * point order otherwise, decided once for the set; a list that ends at a position orders before one that goes on.
 * Each entry's identity is read once.
 */
export const inIdentityOrder = <E>(
	entries: ReadonlyArray<E>,
	identityOf: (entry: E) => TextsId
): ReadonlyArray<E> => {
	const identities = entries.map(identityOf)
	if (inOrder(identities, compareTextsIds)) {
		return entries
	}
	const arity = identities.reduce((most, id) => Math.max(most, id.texts.length), 0)
	const columns = Array.from({ length: arity }, (_, at) => identities.map((id) => id.texts[at]))
	const text = identities.every((id) => id.belowSurrogates) ? compareStrings : compareCodePoints
	/** Two entries by their places, their identities' texts read off the columns, position by position. */
	const byColumns = (i: number, j: number): number => {
		for (const column of columns) {
			const x = column[i]
			const y = column[j]
			if (x !== y) {
				return x === undefined ? -1 : y === undefined ? 1 : text(x, y) < 0 ? -1 : 1
			}
		}
		return 0
	}
	const places = Array.from({ length: entries.length }, (_, at) => at)
	places.sort(byColumns)
	return places.map((at) => defined(entries[at], "an entry at its place"))
}

/** Whether two identities of one digest are one: the same texts in order. */
const sameTextsId = (a: TextsId, b: TextsId): boolean => {
	if (a === b) {
		return true
	}
	const x = a.texts
	const y = b.texts
	if (x.length !== y.length) {
		return false
	}
	for (let at = 0; at < x.length; at += 1) {
		if (x[at] !== y[at]) {
			return false
		}
	}
	return true
}

/**
 * A node of a digest's ordered bucket (`TextsBucket`): a key, the keys before and after it in the order of identities
 * (compareTextsIds), and its subtree's height, an AVL tree's: every node's subtrees differ in height by at most one, so
 * a tree of k keys is at most 1.4405·log₂(k + 2) high, and a lookup compares its key with at most that many keys
 * (Adelson-Velsky and Landis, 1962; Knuth, TAOCP 3, §6.2.3).
 */
interface BucketNode {
	readonly key: TextsId
	readonly before: BucketNode | undefined
	readonly after: BucketNode | undefined
	readonly height: number
}

/** A subtree's height, none's 0. */
const heightOf = (node: BucketNode | undefined): number => (node === undefined ? 0 : node.height)

/** A node of `key` over two subtrees, its height theirs and one. */
const nodeOf = (
	key: TextsId,
	before: BucketNode | undefined,
	after: BucketNode | undefined
): BucketNode => ({ key, before, after, height: Math.max(heightOf(before), heightOf(after)) + 1 })

/** A node of `key` over two subtrees whose heights differ by at most two, rotated to differ by at most one. */
const balanced = (
	key: TextsId,
	before: BucketNode | undefined,
	after: BucketNode | undefined
): BucketNode => {
	if (before !== undefined && heightOf(before) > heightOf(after) + 1) {
		const inner = before.after
		return inner !== undefined && heightOf(inner) > heightOf(before.before)
			? nodeOf(
					inner.key,
					nodeOf(before.key, before.before, inner.before),
					nodeOf(key, inner.after, after)
				)
			: nodeOf(before.key, before.before, nodeOf(key, before.after, after))
	}
	if (after !== undefined && heightOf(after) > heightOf(before) + 1) {
		const inner = after.before
		return inner !== undefined && heightOf(inner) > heightOf(after.after)
			? nodeOf(
					inner.key,
					nodeOf(key, before, inner.before),
					nodeOf(after.key, inner.after, after.after)
				)
			: nodeOf(after.key, nodeOf(key, before, after.before), after.after)
	}
	return nodeOf(key, before, after)
}

/** The key a tree holds of `key`'s list, found by comparing `key` with one key per level. */
const foundIn = (node: BucketNode | undefined, key: TextsId): TextsId | undefined => {
	for (let at = node; at !== undefined;) {
		const order = compareTextsIds(key, at.key)
		if (order === 0) {
			return at.key
		}
		at = order < 0 ? at.before : at.after
	}
	return undefined
}

/** A tree with `key`, whose list it holds no key of, added in its place. */
const insertedIn = (node: BucketNode | undefined, key: TextsId): BucketNode => {
	if (node === undefined) {
		return nodeOf(key, undefined, undefined)
	}
	return compareTextsIds(key, node.key) < 0
		? balanced(node.key, insertedIn(node.before, key), node.after)
		: balanced(node.key, node.before, insertedIn(node.after, key))
}

/** A tree's first key and the tree without it. */
const firstOf = (
	node: BucketNode
): { readonly key: TextsId; readonly rest: BucketNode | undefined } => {
	if (node.before === undefined) {
		return { key: node.key, rest: node.after }
	}
	const first = firstOf(node.before)
	return { key: first.key, rest: balanced(node.key, first.rest, node.after) }
}

/** A tree without its key of `key`'s list, which it holds. */
const removedFrom = (node: BucketNode | undefined, key: TextsId): BucketNode | undefined => {
	if (node === undefined) {
		return undefined
	}
	const order = compareTextsIds(key, node.key)
	if (order < 0) {
		return balanced(node.key, removedFrom(node.before, key), node.after)
	}
	if (order > 0) {
		return balanced(node.key, node.before, removedFrom(node.after, key))
	}
	if (node.after === undefined) {
		return node.before
	}
	const next = firstOf(node.after)
	return balanced(next.key, node.before, next.rest)
}

/**
 * The keys of one digest in a TextsMap: its one key, which a lookup of that digest compares texts for texts; or, once
 * a second list meets it, an AVL tree of them in the order of identities (`BucketNode`), so a lookup there compares
 * its key with at most the tree's height of keys, at most 1.4405·log₂(k + 2) of the k lists that share the digest,
 * whatever lists were made to meet under FNV-1a's public start, which the engine cannot seed since it draws no
 * randomness, and however long their texts: every comparison is exact, none leans on a hash of the texts. No native
 * Map of texts would do: V8 hashes a string longer than 16,383 units by its length alone (src/objects/string.h
 * kMaxHashCalcLength), so a Map of distinct texts of one such length is one chain, each lookup comparing its key with
 * every text of the chain.
 */
type TextsBucket = TextsId | BucketNode

/** The key a bucket holds of `key`'s list, none where it holds no such list. */
const heldIn = (bucket: TextsBucket, key: TextsId): TextsId | undefined =>
	"texts" in bucket ? (sameTextsId(bucket, key) ? bucket : undefined) : foundIn(bucket, key)

/**
 * A map keyed by identities (`TextsId`), exactly: two keys are one where their lists are one, whatever objects hold
 * them. A key is found by its digest, one native lookup of a small integer, then within its digest's bucket
 * (`TextsBucket`), compared texts for texts with the one key there or, once two lists share a digest, with at most the
 * height of the AVL tree the bucket becomes, never their texts joined, and no two lists are ever one entry for sharing
 * a digest; the key found, the key of its list as first set, holds its value in a native Map by that object's own
 * identity. A lookup costs the digest, made once where its identity is, two native lookups and at most
 * 1.4405·log₂(k + 2) exact comparisons where k lists share its digest; an entry is two slots of native Maps, no object
 * of its own. Iteration is the native Map's, in insertion order, each key as it was first set, an entry set again
 * keeping its place. It holds what its readers read of a Map and no more; a Z-set's change (core/zset.ts) is one.
 */
export class TextsMap<V> {
	/** Each digest's bucket of keys, as first set. */
	readonly #buckets = new Map<number, TextsBucket>()
	/** Each value, by its list's key as first set. */
	readonly #values = new Map<TextsId, V>()

	/** The key the map holds of `key`'s list, none where it holds no such list. */
	#held(key: TextsId): TextsId | undefined {
		const bucket = this.#buckets.get(key.digest)
		return bucket === undefined ? undefined : heldIn(bucket, key)
	}

	/** The key the map holds of `key`'s list: the one it holds, or `key` itself, added to its digest's bucket. */
	#keyOf(key: TextsId): TextsId {
		const bucket = this.#buckets.get(key.digest)
		const held = bucket === undefined ? undefined : heldIn(bucket, key)
		if (held !== undefined) {
			return held
		}
		this.#buckets.set(
			key.digest,
			bucket === undefined
				? key
				: insertedIn("texts" in bucket ? nodeOf(bucket, undefined, undefined) : bucket, key)
		)
		return key
	}

	get size(): number {
		return this.#values.size
	}

	get(key: TextsId): V | undefined {
		const held = this.#held(key)
		return held === undefined ? undefined : this.#values.get(held)
	}

	has(key: TextsId): boolean {
		return this.#held(key) !== undefined
	}

	set(key: TextsId, value: V): this {
		this.#values.set(this.#keyOf(key), value)
		return this
	}

	getOrInsertComputed(key: TextsId, compute: (key: TextsId) => V): V {
		const held = this.#held(key)
		if (held !== undefined) {
			return this.#values.getOrInsertComputed(held, compute)
		}
		const value = compute(key)
		this.set(key, value)
		return value
	}

	delete(key: TextsId): boolean {
		const bucket = this.#buckets.get(key.digest)
		const held = bucket === undefined ? undefined : heldIn(bucket, key)
		if (bucket === undefined || held === undefined) {
			return false
		}
		const rest = "texts" in bucket ? undefined : removedFrom(bucket, held)
		if (rest === undefined) {
			this.#buckets.delete(key.digest)
		} else {
			this.#buckets.set(key.digest, rest)
		}
		return this.#values.delete(held)
	}

	values(): MapIterator<V> {
		return this.#values.values()
	}

	[Symbol.iterator](): MapIterator<[TextsId, V]> {
		return this.#values.entries()
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
	return isAsciiDigits(text, 0, text.length)
}

/**
 * PostgreSQL's quoted identifier of a name: double quotes around it, each `"` in it doubled, so case and reserved words
 * never matter. The one quoting of an identifier, which the SQL printer (sql/print.ts), the replication protocol's
 * commands (live/replication.ts) and every other spelling of a name read.
 */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** A standard-conforming string literal: single quotes around it, only the single quote special, each one doubled. */
export const quoteString = (value: string): string => `'${value.replaceAll("'", "''")}'`
