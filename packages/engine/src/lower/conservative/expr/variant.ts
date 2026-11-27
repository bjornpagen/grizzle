/**
 * The SQL of a variant's operations (ir/expr.ts ScalarExpr `variant`, ir/scalar.ts VariantType), over their arguments'
 * SQL, wherever they stand, a query's or a persistent expression's:
 *
 * - its tag: `(x)."tag"`, the composite's first attribute, its arm's code, a smallint;
 * - one field of an arm: `(x)."<attribute>"`, the attribute the arm's field is (ir/physical.ts variantAttributes), at
 *   its base type, which a conditional of the tag's equality guards, so it is read only where it is present;
 * - a value of an arm: `ROW(<tag's code>, …)::<composite>::<domain>`, the arm's fields at their attributes and every
 *   other attribute NULL, cast to the composite and then to the variant's domain, which checks the arm and each of its
 *   fields by its own type as it does every value of the variant (physical/ddl/variants.ts).
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { codecOf, codeOf } from "#compiler/ir/codes.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	type PhysicalNames,
	qualifiedType,
	variantAttributes,
	variantAttributeType,
	variantTagAttribute
} from "#compiler/ir/physical.ts"
import { baseOf, rosterOf, type ScalarType, type VariantInfo } from "#compiler/ir/scalar.ts"
import { floatImage } from "#compiler/lower/conservative/expr/ops.ts"
import { Sha256 } from "#compiler/scalar/values/sha256.ts"
import { type DigestPart, digestPartOf, handleDigest } from "#compiler/scalar/variant-digest.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { binary, call, cast, eq, lit, qualifiedCall, types } from "#compiler/sql/build.ts"

/** The variant a type is, or a defect: an operation of a variant is typed over one (scalar/compute/typing.ts). */
const variantOf = (expr: ScalarExpr): VariantInfo => {
	const base = baseOf(expr.type)
	if (base.carrier !== "variant") {
		defect("a variant operation over a variant")
	}
	return base.variant
}

/** The attribute of `variant`'s composite its arm `handle`'s field `field` is. */
const attributeOf = (
	variant: VariantInfo,
	names: PhysicalNames,
	handle: string,
	field: string
): string =>
	defined(
		variantAttributes(variant, names.codes)
			.find((arm) => arm.handle === handle)
			?.fields.find((f) => f.field.name === field),
		`the field ${field} of the arm ${handle}`
	).attribute

/**
 * How a float of `type` is told -0: its send function, float8send or a real's float4send, and the hex of -0's bytes,
 * the sign bit alone (isNegativeZero).
 */
export const negativeZeroTest = (
	type: ScalarType
): { readonly send: "float4send" | "float8send"; readonly hex: string } =>
	baseOf(type).carrier === "float4"
		? { send: "float4send", hex: "80000000" }
		: { send: "float8send", hex: "8000000000000000" }

/**
 * Whether a float `x` of `type` is -0: `float8send(x) = decode('8000000000000000', 'hex')`, float4send's for a real
 * (negativeZeroTest); false of every other float, 0, NaN and each infinity among them, so a float and its zero sign
 * together are one value of the variant's identity (ir/codes.ts FieldLayout `zero`). Every function it reads is
 * IMMUTABLE.
 */
export const isNegativeZero = (x: Expr, type: ScalarType): Expr => {
	const test = negativeZeroTest(type)
	return eq(
		call(test.send, [x]),
		call("decode", [lit.text(test.hex, types.text), lit.text("hex", types.text)])
	)
}

/**
 * A CASE's ELSE over a smallint operand, a tag or a closed id's code, whose WHENs meet every value it holds: the empty
 * bytes its image begins with, `substring(int2send(x), 1, 0)`, NULL exactly where the operand is, the one value no WHEN
 * meets, so the image is NULL where its subject is and no NULL is written (a domain admits no other code).
 */
const elseBytes = (x: Expr): Expr =>
	call("substring", [call("int2send", [x]), lit.int(1, types.integer), lit.int(0, types.integer)])

/** A digest's bytes as a literal, `decode('<hex>', 'hex')`. */
const bytesLiteral = (digest: Sha256): Expr =>
	call("decode", [lit.text(Sha256.toHex(digest), types.text), lit.text("hex", types.text)])

/** A float type's carrier, a real's or a double's. */
const floatOf = (type: ScalarType): "float4" | "float8" =>
	baseOf(type).carrier === "float4" ? "float4" : "float8"

/** The image of one present field `x` of image `part` (scalar/variant-digest.ts): its fixed-width bytes. */
const fieldImage = (part: DigestPart, x: Expr, type: ScalarType, names: PhysicalNames): Expr => {
	switch (part) {
		case "bool":
			return call("boolsend", [x])
		case "int2":
			return call("int2send", [x])
		case "int4":
			return call("int4send", [x])
		case "int8":
			return call("int8send", [x])
		case "float":
			return call("int8send", [floatImage(x, floatOf(type))])
		case "text":
			return qualifiedCall(names.library("textDigest"), [x])
		case "integer":
			return qualifiedCall(names.library("textDigest"), [cast(x, types.text)])
		case "sha256":
			return x
		case "code": {
			const roster = rosterOf(type)
			if (roster === undefined) {
				defect("a closed id's field holds a roster")
			}
			const codec = codecOf(names.codes, roster)
			const [first, ...rest] = roster.handles.map((handle) => ({
				when: lit.int(codeOf(codec, handle), types.smallint),
				result: bytesLiteral(handleDigest(handle))
			}))
			if (first === undefined) {
				defect("a roster holds a live handle")
			}
			return { kind: "case", operand: x, whens: [first, ...rest], else: elseBytes(x) }
		}
	}
}

/**
 * A variant's identity image (scalar/variant-digest.ts): `sha256(CASE (x)."tag" WHEN <code> THEN <the handle's digest>
 * || <each field's image> … ELSE <elseBytes of the tag> END)`, NULL where `x` is, as no WHEN meets a NULL tag.
 */
const variantDigest = (variant: VariantInfo, x: Expr, names: PhysicalNames): Expr => {
	const layout = variantAttributes(variant, names.codes)
	const [first, ...rest] = layout.map((arm) => {
		const images = arm.fields.map((f) =>
			fieldImage(
				defined(digestPartOf(f.field.type), `the image of field ${f.field.name}`),
				{ kind: "attribute", record: x, attribute: f.attribute },
				f.field.type,
				names
			)
		)
		return {
			when: lit.int(arm.code, types.smallint),
			result: images.reduce<Expr>(
				(acc, image) => binary("||", acc, image),
				bytesLiteral(handleDigest(arm.handle))
			)
		}
	})
	if (first === undefined) {
		defect("a variant holds at least one arm")
	}
	const tag: Expr = { kind: "attribute", record: x, attribute: variantTagAttribute }
	return call("sha256", [
		{ kind: "case", operand: tag, whens: [first, ...rest], else: elseBytes(tag) }
	])
}

/**
 * The record of `variant`'s composite that holds its arm `handle` with the fields `fields`, the arm's in declared order:
 * `ROW(<the arm's code>, …)::<composite>`, each of the arm's fields at its attribute, a float's followed by whether it
 * is -0, and every other arm's attribute NULL. A made value is it cast to the variant's domain (lowerVariant `make`); an
 * empty relation's placeholder is it of the variant's first arm over its fields' placeholders, at the composite, the
 * variant's base type (lower/conservative/closed placeholderValue).
 */
export const variantRecord = (
	variant: VariantInfo,
	handle: string,
	fields: ReadonlyArray<Expr>,
	names: PhysicalNames
): Expr => {
	const layout = variantAttributes(variant, names.codes)
	const code = defined(
		layout.find((arm) => arm.handle === handle),
		`the arm ${handle}`
	).code
	let at = 0
	const items: Array<Expr> = []
	for (const arm of layout) {
		for (const f of arm.fields) {
			if (arm.handle === handle) {
				const value = defined(fields[at], `the field ${f.field.name} of the arm ${handle}`)
				items.push(value)
				if (f.zero !== undefined) {
					items.push(isNegativeZero(value, f.field.type))
				}
				at++
			} else {
				items.push({
					kind: "literal",
					value: { kind: "null" },
					type: variantAttributeType(names, f.field.type).type
				})
				if (f.zero !== undefined) {
					items.push({ kind: "literal", value: { kind: "null" }, type: types.boolean })
				}
			}
		}
	}
	return cast(
		{ kind: "row", items: [lit.int(code, types.smallint), ...items] },
		qualifiedType(names.variantRow(variant.name))
	)
}

/** The SQL of a variant's operation `expr`, of kind `variant`, over its arguments' SQL `args`. */
export const lowerVariant = (
	expr: Extract<ScalarExpr, { readonly kind: "variant" }>,
	args: ReadonlyArray<Expr>,
	names: PhysicalNames
): Expr => {
	switch (expr.op.kind) {
		case "tag":
			return {
				kind: "attribute",
				record: defined(args[0], "a tag's subject"),
				attribute: variantTagAttribute
			}
		case "digest":
			return variantDigest(
				variantOf(defined(expr.args[0], "a digest's subject")),
				defined(args[0], "a digest's subject"),
				names
			)
		case "field":
			return {
				kind: "attribute",
				record: defined(args[0], "a field's subject"),
				attribute: attributeOf(
					variantOf(defined(expr.args[0], "a field's subject")),
					names,
					expr.op.handle,
					expr.op.field
				)
			}
		case "make": {
			const variant = variantOf(expr)
			return cast(
				variantRecord(variant, expr.op.handle, args, names),
				qualifiedType(names.variantDomain(variant.name))
			)
		}
	}
}
