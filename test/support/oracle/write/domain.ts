import { Array as Arr, Formatter, pipe, Record as Rec, String as Str } from "effect"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { type RosterCodec, rosterCodec } from "#compiler/ir/codes.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { closedId, Decimal, pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import type { AnyRoster } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { type NumericTypmod, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { floatText } from "#compiler/scalar/values/float.ts"
import type { CarrierSpec } from "#compiler/scalar/values/identity.ts"
import type { ParamValue } from "#compiler/types/core/phantom.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { floatLiteralOf } from "#test/support/oracle/gen/domain.ts"
import { toastLengths, toastPair, toastText } from "#test/support/oracle/gen/toast.ts"

/** The exact decimals, one kind per typmod. */
export type NumericKind = "numeric(5, 2)" | "numeric(12, 4)" | "numeric(3, 0)"

/** The identity columns: bigserial (int8) and serial (int4). */
export type SerialKind = "bigserial" | "serial"

/**
 * The value domain of the write oracle.
 *
 * A generated write schema draws its column types from a small palette of PostgreSQL scalars, each with a handful of
 * host values, so that generated facts collide on keys and payloads often: exact repeats, a different payload at an
 * occupied key, identical puts and deletions of present and absent facts are the cases the add-wins transition and its
 * counts must get right. Every value is held in the one host form the codecs read and decode,
 * so the oracle and the database compare it by native equality: the canonical text (scalar/values/identity.ts
 * canonicalText) is equal exactly when PostgreSQL's equality is, which makes 0 and -0 one value of double precision,
 * 1.5 and 1.50 one Decimal, and NaN equal to NaN.
 *
 * The palette:
 * - integer, bigint, and identity columns of either (GENERATED ALWAYS AS IDENTITY, serial and bigserial);
 * - bounded text, `str.regex("^.{0,3}$", "su")`, whose values reach the supplementary plane and whose three-code-point
 *   bound keeps every key representable;
 * - bounded wide text, `^.{0,6}$`, which a described member may read into a three-code-point text field;
 * - unbounded text, a payload column only, whose values include TOAST-sized ones stored out of line;
 * - uuid, boolean, a roster's handle (a closed id, stored as its code), exact decimals at three typmods, numeric(5, 2), numeric(12, 4)
 *   and numeric(3, 0), and double precision (payload columns only: NaN, -0 and infinity are values, never key parts
 *   here, so that the B-tree arbiter and the payload comparison meet them only as payload).
 *
 * A ChangeSet input states a numeric value exactly at its column's typmod: one of more fractional digits is refused by
 * the parse before any SQL (scalar/values/identity.ts parseValue), and another display scale is the same Decimal. The
 * three typmods' values round onto each other's (1.4951 and 1.5000 are both 1.50 at scale 2, and 2 at scale 0), so a
 * described member that reads one typmod into another collapses distinct values into one by PostgreSQL's cast, which
 * castValue models: the value a fact of the member holds is the cast's, at its field's typmod.
 */
export type TypeKind =
	| "int4"
	| "int8"
	| SerialKind
	| "text"
	| "text6"
	| "uuid"
	| "bool"
	| "code"
	| NumericKind
	| "float8"
	| "memo"

/** The roster every write schema declares, whose handles the closed-id columns hold. */
export const rosterName = "K"
export const rosterHandles: readonly [string, ...Array<string>] = ["H0", "H1", "H2"]

/**
 * The roster's codes in every write installation: a fresh installation's (firstCodebook), each handle's code its
 * position, which the installers the write suites run (oracle/install/real.ts installRealSchema) give it.
 */
const rosterCodes: RosterCodec = (() => {
	const name = parseDeclaredName(rosterName)
	if (!name.ok) {
		throw new Error(`the write roster's name ${rosterName}: ${name.error}`)
	}
	return rosterCodec(
		name.value,
		Arr.map(rosterHandles, (handle) => ({ kind: "live", handle }) as const)
	)
})()

const uuidOf = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe((0x7700 + n).toString(16), Str.padStart(12, "0"))}`

const decimal = (text: string): Decimal => Decimal.of(text)

const numericTypmods: Readonly<Record<NumericKind, NumericTypmod>> = {
	"numeric(5, 2)": { precision: 5, scale: 2 },
	"numeric(12, 4)": { precision: 12, scale: 4 },
	"numeric(3, 0)": { precision: 3, scale: 0 }
}

/** The kinds numericTypmods holds a typmod for. */
const numericKinds: ReadonlySet<TypeKind> = new Set(Rec.keys(numericTypmods))

export const isNumericKind = (kind: TypeKind): kind is NumericKind => numericKinds.has(kind)

/**
 * The value Compute.cast gives a Decimal read into a numeric kind: PostgreSQL's coercion to the kind's numeric(p, s),
 * rounded half away from zero to its scale (scalar/values/decimal.ts normalizeNumeric). A cast reads only values
 * within the kind's range (typmodRange), so a value the coercion refuses is a defect of its caller.
 */
export const castValue = (kind: NumericKind, value: Decimal): Decimal => {
	const cast = normalizeNumeric(value, numericTypmods[kind])
	if (!cast.ok) {
		throw new RangeError(`a ${kind} cast of ${value.toString()} past its range (${cast.error})`)
	}
	return cast.value
}

/**
 * The least and greatest values a numeric kind's numeric(p, s) holds: every one of its p - s integer and s fraction
 * digits a nine, negated and not. A Compute.within over them proves a cast into the kind fits (changeset.ts HeadTerm
 * cast).
 */
export const typmodRange = (kind: NumericKind): readonly [Decimal, Decimal] => {
	const { precision, scale } = numericTypmods[kind]
	const integer = Str.repeat(precision - scale)("9")
	const fraction = Str.repeat(scale)("9")
	const greatest = fraction === "" ? integer : `${integer}.${fraction}`
	return [decimal(`-${greatest}`), decimal(greatest)]
}

export const isSerialKind = (kind: TypeKind): kind is SerialKind =>
	kind === "bigserial" || kind === "serial"

interface TypeInfo {
	readonly kind: TypeKind
	/** The carrier the host values and the oracle's identity use. */
	readonly spec: CarrierSpec
	/** The host values a generated fact draws from, each in its canonical spelling. */
	readonly values: ReadonlyArray<ParamValue>
	/** Whether a key may contain the column. */
	readonly keyable: boolean
	/**
	 * The SQL text form PostgreSQL's output function gives a value, for the owner's typed-literal loader and the raw
	 * state reader (state.ts).
	 */
	readonly parse: (text: string) => unknown
}

const integerParse = (text: string): unknown => Number.parseInt(text, 10)
const bigintParse = (text: string): unknown => BigInt(text)

const floatParse = (text: string): unknown => {
	if (text === "NaN") {
		return Number.NaN
	}
	if (text === "Infinity") {
		return Number.POSITIVE_INFINITY
	}
	if (text === "-Infinity") {
		return Number.NEGATIVE_INFINITY
	}
	return Number(text)
}

const numericInfo = (kind: NumericKind, values: ReadonlyArray<string>): TypeInfo => ({
	kind,
	spec: { carrier: "numeric", typmod: numericTypmods[kind] },
	values: Arr.map(values, decimal),
	keyable: true,
	parse: (text) => decimal(text)
})

export const typeInfo: Readonly<Record<TypeKind, TypeInfo>> = {
	int4: {
		kind: "int4",
		spec: { carrier: "int4" },
		values: [0, 1, 2, 3],
		keyable: true,
		parse: integerParse
	},
	int8: {
		kind: "int8",
		spec: { carrier: "int8" },
		values: [0n, 1n, 2n, 3n],
		keyable: true,
		parse: bigintParse
	},
	bigserial: {
		kind: "bigserial",
		spec: { carrier: "int8" },
		values: [1n, 2n, 3n, 4n],
		keyable: true,
		parse: bigintParse
	},
	serial: {
		kind: "serial",
		spec: { carrier: "int4" },
		values: [1, 2, 3, 4],
		keyable: true,
		parse: integerParse
	},
	text: {
		kind: "text",
		spec: { carrier: "text" },
		values: ["", "a", "é", "\u{1F600}"],
		keyable: true,
		parse: (text) => text
	},
	text6: {
		kind: "text6",
		spec: { carrier: "text" },
		values: ["", "a", "abcd", "\u00e9\u{1F600}cde"],
		keyable: true,
		parse: (text) => text
	},
	uuid: {
		kind: "uuid",
		spec: { carrier: "uuid" },
		values: [uuidOf(1), uuidOf(2), uuidOf(3), uuidOf(4)],
		keyable: true,
		parse: (text) => text
	},
	bool: {
		kind: "bool",
		spec: { carrier: "bool" },
		values: [false, true],
		keyable: true,
		parse: (text) => text === "true"
	},
	code: {
		kind: "code",
		spec: { carrier: "code", roster: rosterCodes },
		values: rosterHandles,
		keyable: true,
		/** A stored closed id's text is its code's, smallint's: the handle the roster's names give it. */
		parse: (text) => {
			const name = rosterCodes.names[Number(text)]
			if (name === undefined || name === "") {
				throw new Error(`a stored code ${text} that names no live handle of roster ${rosterName}`)
			}
			return name
		}
	},
	"numeric(5, 2)": numericInfo("numeric(5, 2)", ["0.00", "1.50", "-2.25", "10.00"]),
	"numeric(12, 4)": numericInfo("numeric(12, 4)", ["0.0000", "1.5000", "1.4951", "-2.2549"]),
	"numeric(3, 0)": numericInfo("numeric(3, 0)", ["0", "2", "-2", "10"]),
	/**
	 * Unbounded text, a payload only (no bound proves a key representable): empty, short, and TOAST-sized values that
	 * PostgreSQL stores out of line, two of which share all but their last code point, so the insert protocol's
	 * payload comparison and a put's change test must read past every TOAST chunk to tell them apart.
	 */
	memo: {
		kind: "memo",
		spec: { carrier: "text" },
		values: [
			"",
			"x",
			toastText(11, toastLengths[0] ?? 2_100),
			...toastPair(12, toastLengths[1] ?? 6_000)
		],
		keyable: false,
		parse: (text) => text
	},
	float8: {
		kind: "float8",
		spec: { carrier: "float8" },
		values: [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -0],
		keyable: false,
		parse: floatParse
	}
}

/** Whether a value is text long enough to be stored out of line. */
export const isToastSized = (value: unknown): boolean =>
	typeof value === "string" && value.length >= 2_000

/** The kinds a generated column draws, besides the identity columns a relation places itself. */
export const typeKinds: ReadonlyArray<TypeKind> = [
	"int4",
	"int8",
	"text",
	"text6",
	"uuid",
	"bool",
	"code",
	"numeric(5, 2)",
	"numeric(12, 4)",
	"numeric(3, 0)",
	"float8",
	"memo"
]

/** The field descriptor of a column of `kind`; `roster` is the schema's roster for a closed-id column. */
export const fieldOf = (kind: TypeKind, roster: AnyRoster): FieldBase => {
	switch (kind) {
		case "int4":
			return pg.integer
		case "int8":
			return pg.bigint
		case "bigserial":
			return pg.bigserial
		case "serial":
			return pg.serial
		case "text":
			return str.regex("^.{0,3}$", "su")
		case "text6":
			return str.regex("^.{0,6}$", "su")
		case "uuid":
			return uuid
		case "bool":
			return pg.boolean
		case "code":
			return closedId(roster)
		case "numeric(5, 2)":
			return pg.numeric(5, 2)
		case "numeric(12, 4)":
			return pg.numeric(12, 4)
		case "numeric(3, 0)":
			return pg.numeric(3, 0)
		case "float8":
			return pg.float8
		case "memo":
			return str.regex("^.*$", "su")
	}
}

/**
 * The identity of one value of a column of `kind`: equal exactly under PostgreSQL's equality. A value of the kind's
 * host type has its canonical text (scalar/values canonicalText). A case also holds values outside it, a generated
 * addition's omitted serial field among them, and compares their keys as that text spells them: an integer or
 * boolean carrier as String does, a float carrier likewise, a text carrier as the value itself (as String spells
 * another value, an omitted field's undefined among them).
 */
export const valueIdentity = (kind: TypeKind, value: unknown): string => {
	switch (kind) {
		case "int4":
		case "int8":
		case "bigserial":
		case "serial":
		case "bool":
			return String(value)
		case "float8":
			return typeof value === "number" ? floatText(value) : String(value)
		case "numeric(5, 2)":
		case "numeric(12, 4)":
		case "numeric(3, 0)": {
			if (!(value instanceof Decimal)) {
				throw new TypeError(`a numeric value that is no Decimal: ${String(value)}`)
			}
			/**
			 * Fact identity is decided after coercion to the column's numeric(p, s): 1.495 and 1.5 are the stored
			 * 1.50 of a numeric(5, 2) column, so a fact holding either is the fact holding 1.50.
			 */
			const normalized = normalizeNumeric(value, numericTypmods[kind])
			if (!normalized.ok) {
				throw new TypeError(
					`a numeric value ${kind} refuses: ${value.toString()} (${normalized.error})`
				)
			}
			return normalized.value.text
		}
		case "text":
		case "text6":
		case "memo":
		case "uuid":
		case "code":
			return typeof value === "string" ? value : String(value)
	}
}

/**
 * A host value of a column of `kind` as the IR's literal, which the twin table reads (gen/domain.ts carrierTwins): a
 * value of another host type is a defect of the case.
 */
export const literalOfKind = (kind: TypeKind, value: unknown): TypedLiteral => {
	const wrong = (): never => {
		throw new TypeError(`a ${kind} value of another host type: ${printValue(value)}`)
	}
	switch (kind) {
		case "int4":
		case "serial":
			return typeof value === "number" && Number.isSafeInteger(value)
				? { kind: "int", value: BigInt(value) }
				: wrong()
		case "int8":
		case "bigserial":
			return typeof value === "bigint" ? { kind: "int", value } : wrong()
		case "text":
		case "text6":
		case "memo":
			return typeof value === "string" ? { kind: "text", value } : wrong()
		case "uuid":
			return typeof value === "string" ? { kind: "uuid", value } : wrong()
		case "bool":
			return typeof value === "boolean" ? { kind: "bool", value } : wrong()
		case "code":
			return typeof value === "string" ? { kind: "handle", handle: value } : wrong()
		case "numeric(5, 2)":
		case "numeric(12, 4)":
		case "numeric(3, 0)":
			return value instanceof Decimal ? { kind: "numeric", value } : wrong()
		case "float8":
			return typeof value === "number" ? floatLiteralOf(value) : wrong()
	}
}

/**
 * The base a column's values compare in: an identity column's integer, every typmod's numeric, both bounded texts' text.
 */
const baseOf = (kind: TypeKind): string =>
	kind === "bigserial"
		? "int8"
		: kind === "serial"
			? "int4"
			: isNumericKind(kind)
				? "numeric"
				: kind === "text6"
					? "text"
					: kind

/**
 * Two types whose columns a described member may connect: the same base carrier. A bigserial column holds bigint
 * values, a numeric of one typmod is read into another's by Compute.cast, rounding (changeset.ts HeadTerm cast), and a
 * wide text is cast into the narrow text's domain, which refuses a value outside it.
 */
export const sameBase = (a: TypeKind, b: TypeKind): boolean => baseOf(a) === baseOf(b)

/**
 * Two types a key of one may reference a key of the other through: the same type, or an identity column's base integer
 * and the integer itself, so a referenced value is the referencing one exactly. A numeric of another typmod and the
 * other bounded text are refused.
 */
export const referable = (a: TypeKind, b: TypeKind): boolean =>
	sameBase(a, b) && (a === b || baseOf(a) === "int4" || baseOf(a) === "int8")

/**
 * Whether a field of `kind` is of the narrow text, the `^.{0,3}$` refinement: the one domain a projected value can fall
 * outside, a wider text read into it. Every field of that kind is of its one domain.
 */
export const narrowText = (kind: TypeKind): boolean => kind === "text"

/**
 * Whether a value fits the domain of a field of `kind`: the narrow text's refinement, with the `s` and `u` flags,
 * counts every code point once; every other kind's projected values fit (numerics are cast and rounded, never refused).
 */
export const fitsField = (kind: TypeKind, value: unknown): boolean =>
	!narrowText(kind) || (typeof value === "string" && Array.from(value).length <= 3)

/**
 * A printable spelling of a host value, for failure reports.
 *
 * A TOAST-sized text by its length and its ends, which tell the generated ones apart.
 */
export const printValue = (value: unknown): string => {
	if (typeof value === "bigint") {
		return `${value}n`
	}
	if (typeof value === "number") {
		return Object.is(value, -0) ? "-0" : String(value)
	}
	if (value instanceof Decimal) {
		return `Decimal(${value.toString()})`
	}
	if (typeof value === "string" && value.length > 64) {
		return `${Formatter.format(Str.slice(0, 12)(value))}...${Formatter.format(Str.slice(-12)(value))} (${value.length} code units)`
	}
	return Formatter.format(value)
}
