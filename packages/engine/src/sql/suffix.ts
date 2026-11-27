import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Expr, FromItem, Select } from "#compiler/sql/ast.ts"
import { and, binary, call, ge, lit, lt, types } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { originIn, type StoredColumns } from "#compiler/sql/stored.ts"
import { conditionsRewritten } from "#compiler/sql/transform.ts"

/**
 * The suffix key of a text, `chr(1) || reverse(text)`: what a B-tree a probe seeks a suffix through holds for a text
 * column (physical/indexes/engine.ts KeyTerm `suffix`), so a text ends with a suffix exactly where its key lies in the
 * range `[suffixLow(suffix), suffixHigh(suffix))` (`suffixRange`): its reversal begins with the suffix's reversal.
 *
 * The range is code point order, the one order grizzle compares texts in: every text it stores is collated
 * pg_catalog.pg_c_utf8 (sql/ast.ts Collation), whose order is the code points', and which PostgreSQL defines for the
 * UTF8 encoding alone, so an installation stands only in a UTF8 database, where comparing two texts' bytes is comparing
 * their code points. Its keys are collated as their column is, the probe's bounds too, so PostgreSQL reads the range as
 * an index condition of the index on the key (indxpath.c match_index_to_operand compares collations). PostgreSQL's
 * reverse() reverses a text by code points, a multibyte character kept whole (varlena.c text_reverse), so a key's
 * characters are its text's, last first.
 *
 * The leading U+0001 is a sentinel that makes the upper bound exist for every suffix: a key begins with it, no stored
 * text holds U+0000, so every key is below `chr(2)`, and the least text above every key that begins with a prefix is the
 * prefix with its last code point that is not U+10FFFF raised by one and what follows it dropped, which the sentinel
 * guarantees there is. Without it a suffix of U+10FFFF alone would bound its keys by no text. The code point after
 * U+D7FF is U+E000: the surrogates are no code points a text holds, and chr() refuses them.
 */
export const suffixKeyOf = (text: Expr): Expr =>
	binary("||", call("chr", [lit.int(1, types.integer)]), call("reverse", [text]))

/** The highest code point, U+10FFFF, which no code point follows. @formatConstant Unicode's last code point, 0x10FFFF */
const lastCodePoint = 1114111

/** The last code point before the surrogates, U+D7FF. @formatConstant the code point below U+D800 */
const beforeSurrogates = 55295

/** The first code point past the surrogates, U+E000. @formatConstant the code point above U+DFFF */
const pastSurrogates = 57344

/** The least key whose text ends with `suffix`: the suffix's own key. */
const suffixLow = (suffix: Expr): Expr => suffixKeyOf(suffix)

/**
 * The least text above every key whose text ends with `suffix`: the suffix's key with its trailing U+10FFFF dropped,
 * `q`, never empty since it begins with U+0001, and q's last code point raised by one, U+D7FF to U+E000.
 */
const suffixHigh = (suffix: Expr): Expr => {
	const q = call("rtrim", [suffixLow(suffix), call("chr", [lit.int(lastCodePoint, types.integer)])])
	const last = call("ascii", [call("right", [q, lit.int(1, types.integer)])])
	return binary(
		"||",
		call("left", [q, lit.int(-1, types.integer)]),
		call("chr", [
			{
				kind: "case",
				operand: last,
				whens: [
					{
						when: lit.int(beforeSurrogates, types.integer),
						result: lit.int(pastSurrogates, types.integer)
					}
				],
				else: binary("+", last, lit.int(1, types.integer))
			}
		])
	)
}

/**
 * `text` ends with `suffix`, as the range of its suffix key (`suffixKeyOf`): `key >= low AND key < high`, exactly where
 * `right(text, char_length(suffix)) = suffix` holds, NULL where either is NULL, as it is.
 */
export const suffixRange = (text: Expr, suffix: Expr): Expr =>
	and([ge(suffixKeyOf(text), suffixLow(suffix)), lt(suffixKeyOf(text), suffixHigh(suffix))])

/** The text whose suffix key an expression is (`suffixKeyOf`), when it is one: what it reverses, printed back alike. */
export const suffixKeyText = (e: Expr): Expr | undefined => {
	if (e.kind !== "binary" || e.op !== "||" || e.right.kind !== "call") {
		return undefined
	}
	const [text] = e.right.args
	return text !== undefined && printExpr(e) === printExpr(suffixKeyOf(text)) ? text : undefined
}

/**
 * The column of the table an index is on whose suffix key an index key's expression is, when it is one: an expression
 * that is the suffix key of the unqualified column it reads (`suffixKeyText`).
 */
export const suffixedColumnOf = (e: Expr): string | undefined => {
	const text = suffixKeyText(e)
	return text?.kind === "column" && text.table === undefined ? text.column : undefined
}

/**
 * The text and suffix of a suffix test as the lowering prints it (lower/conservative/expr/ops.ts textSuffix),
 * `right(text, char_length(suffix)) = suffix`, when `e` is one.
 */
const suffixTestOf = (e: Expr): { readonly text: Expr; readonly suffix: Expr } | undefined => {
	if (e.kind !== "binary" || e.op !== "=" || e.schema !== undefined || e.left.kind !== "call") {
		return undefined
	}
	const [text, length] = e.left.args
	if (text === undefined || length?.kind !== "call") {
		return undefined
	}
	const [suffix] = length.args
	return suffix !== undefined &&
		printExpr(e) ===
			printExpr(binary("=", call("right", [text, call("char_length", [suffix])]), suffix))
		? { text, suffix }
		: undefined
}

/**
 * What a condition holds true: `x` of `x = TRUE`, which a condition reads as `x` (PostgreSQL's
 * simplify_boolean_equality); any other condition itself. A suffix test the lowering states held equal to true
 * (Logic.eq(Text.endsWith(t, s), true)) is the test, so its range stands as the condition's conjuncts, each a bound of
 * the key the binding ranges (sql/bind.ts), never one operand of an equality.
 */
const heldTrue = (e: Expr): Expr =>
	e.kind === "binary" &&
	e.op === "=" &&
	e.schema === undefined &&
	e.right.kind === "literal" &&
	e.right.value.kind === "bool" &&
	e.right.value.value
		? e.left
		: e

/**
 * `e` with every suffix test over a column of `from` that a B-tree holds the suffix key of (`suffixed`) read as that
 * key's range (`suffixRange`), at any depth: the test's value on every row, so PostgreSQL reads the range as an index
 * condition where the suffix is fixed beside the row, a parameter or an outer row's value, and as a filter elsewhere.
 */
const seekingIn = (e: Expr, from: ReadonlyArray<FromItem>, suffixed: StoredColumns): Expr => {
	const test = suffixTestOf(heldTrue(e))
	if (test !== undefined) {
		const origin = originIn(from, test.text)
		return origin !== undefined && suffixed.has(origin) ? suffixRange(test.text, test.suffix) : e
	}
	if (e.kind === "and" || e.kind === "or") {
		const args = mapNonEmpty(e.args, (a) => seekingIn(a, from, suffixed))
		return args.every((a, i) => a === e.args[i]) ? e : { ...e, args }
	}
	if (e.kind === "binary") {
		const left = seekingIn(e.left, from, suffixed)
		const right = seekingIn(e.right, from, suffixed)
		return left === e.left && right === e.right ? e : { ...e, left, right }
	}
	if (e.kind === "not") {
		const expr = seekingIn(e.expr, from, suffixed)
		return expr === e.expr ? e : { ...e, expr }
	}
	return e
}

/**
 * A query whose every core reads each suffix test over one of `suffixed`, a column a B-tree holds the suffix key of, by
 * that key's range (`suffixRange`), so PostgreSQL seeks the B-tree where the suffix is the probe's bound value. A query
 * that tests no such column is the query itself.
 */
export const seekingSuffixes = (query: Select, suffixed: StoredColumns): Select =>
	conditionsRewritten(query, (condition, from) => seekingIn(condition, from, suffixed))
