/**
 * A borrow's lock (README "Units"): one PostgreSQL advisory lock, transaction-scoped, of the int8 its
 * unit's name and its key's values name, `lockId`, the one spelling every lock grizzle takes reads: a call's borrow
 * statement (write/borrow/statement.ts), a judge's borrows at COMMIT, and a series' lock, a unit of no key.
 *
 * Its id is the unit kind's rank in its top byte, the certifier's (core/certificate.ts), and the first 56 bits of the
 * SHA-256 of the canonical text of the unit's name and its key's images below it, so a call that takes its locks in
 * id order takes every kind of a lower rank first, whatever the keys. The text is each part in turn, its length in
 * characters, a colon and the part, so no two lists of parts spell one text. A key value's image is its text under
 * equality's own reading of it, so two equal values give one id: a numeric's without the trailing zeros its scale
 * keeps (1.0 and 1.00 are one value), a display scale the text reads (scalar/compute/registry.ts OperandReading); a
 * value of a type whose equality is no identity, a float, its canonical form's (lower/conservative/expr/ops.ts
 * canonicalForm, -0 written 0); every other value's text, which its equality reads whole. Nothing is stored: two units whose ids meet share one lock, which makes their writers wait
 * on each other and changes no outcome, and ids stay totally ordered.
 */
import { baseOf, nonIdentityCarrierOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { canonicalForm } from "#compiler/lower/conservative/expr/ops.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { binary, call, cast, lit, types } from "#compiler/sql/build.ts"

/** A key value a lock is taken at, and the type its column holds it as. */
export interface LockKey {
	readonly expr: Expr
	readonly type: ScalarType
}

/**
 * The bits of a lock id below its rank: 56, the first seven bytes of the SHA-256, so a rank of 0 to 127 in the byte
 * above keeps every id non-negative and ordered by rank first.
 *
 * @formatConstant the lock id's layout: one byte of rank above 56 bits of digest, in PostgreSQL's int8
 */
const digestBits = 56

/** A key value's image under equality (see the module's header), as text. */
const keyImage = (key: LockKey): Expr => {
	const text = (e: Expr): Expr => cast(e, types.text)
	if (baseOf(key.type).carrier === "numeric") {
		return text(call("trim_scale", [key.expr]))
	}
	const carrier = nonIdentityCarrierOf(key.type)
	return text(carrier === undefined ? key.expr : canonicalForm(key.expr, carrier))
}

/** A part of a lock's canonical text, its length first: `<length>:<part>`. */
const lengthPrefixed = (part: Expr): Expr =>
	binary(
		"||",
		binary("||", cast(call("char_length", [part]), types.text), lit.text(":", types.text)),
		part
	)

/**
 * The lock id of unit `unit` at the key `keys`, its fields' values in the unit's key order, under the rank `rank`, the
 * position the certifier gives the unit's kind (core/certificate.ts LockOrder), which its statement binds (see the
 * module's header): `(rank << 56) | ('x' || encode(substring(sha256(
 * convert_to(<text>, 'UTF8')) from 1 for 7), 'hex'))::bit(56)::int8`. A series' lock is its relation's name with no key.
 */
export const lockId = (rank: Expr, unit: string, keys: ReadonlyArray<LockKey>): Expr => {
	const named = `${unit.length}:${unit}`
	const text = keys.reduce<Expr>(
		(acc, key) => binary("||", acc, lengthPrefixed(keyImage(key))),
		lit.text(named, types.text)
	)
	const digest = call("sha256", [call("convert_to", [text, lit.text("UTF8", types.text)])])
	const bytes = call("substring", [
		digest,
		lit.int(1, types.integer),
		lit.int(digestBits / 8, types.integer)
	])
	const bits = cast(
		cast(
			binary("||", lit.text("x", types.text), call("encode", [bytes, lit.text("hex", types.text)])),
			types.bit(digestBits)
		),
		types.bigint
	)
	return binary(
		"|",
		binary("<<", cast(rank, types.bigint), lit.int(digestBits, types.integer)),
		bits
	)
}
