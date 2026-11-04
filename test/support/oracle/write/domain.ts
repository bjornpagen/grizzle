import { Array as Arr, Formatter, pipe, Record as Rec, String as Str } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { closedId, Decimal, pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import type { AnyClosed } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { type NumericTypmod, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { floatText } from "#compiler/scalar/values/float.ts"
import type { CarrierSpec } from "#compiler/scalar/values/identity.ts"
import type { ParamValue } from "#compiler/types/core/phantom.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { floatLiteralOf } from "#test/support/oracle/gen/domain.ts"
import { toastLengths, toastPair, toastText } from "#test/support/oracle/gen/toast.ts"
import { pickIndex } from "#test/support/pick.ts"

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
 * - uuid, boolean, a closed roster's handle (an enum), exact decimals at three typmods, numeric(5, 2), numeric(12, 4)
 *   and numeric(3, 0), and double precision (payload columns only: NaN, -0 and infinity are values, never key parts
 *   here, so that the B-tree arbiter and the payload comparison meet them only as payload).
 *
 * ChangeSet inputs may spell a numeric value as any decimal that coerces to it at its column's typmod: a value that
 * rounds to it (coercedSpelling); another display scale is the same Decimal already. Fact identity is decided after that coercion, so valueIdentity
 * normalizes to the column's typmod before comparing, and an exact repeat or a put spelled differently is the stored
 * fact. The three typmods' values round onto each other's (1.4951 and 1.5000 are both 1.50 at scale 2, and 2 at scale
 * 0), so a described member that reads one typmod into another collapses distinct values into one after its cast.
 */
export type TypeKind =
	| "int4"
	| "int8"
	| SerialKind
	| "text"
	| "text6"
	| "uuid"
	| "bool"
	| "enum"
	| NumericKind
	| "float8"
	| "memo"

/** The closed roster every write schema declares, whose handles the enum columns hold. */
export const rosterName = "K"
export const rosterHandles: readonly [string, ...Array<string>] = ["H0", "H1", "H2"]

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
	enum: {
		kind: "enum",
		spec: { carrier: "enum", handles: rosterHandles },
		values: rosterHandles,
		keyable: true,
		parse: (text) => text
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

/**
 * Per typmod, spellings that coerce to each stored value: other display scales, and values that round to it half away
 * from zero. An input holding one of them is the fact holding the canonical value, so an exact repeat or a put spelled
 * this way changes nothing (the canonical value comes first, so a spelling pick of 0 keeps it).
 */
const spellingsOf = (
	entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>
): ReadonlyMap<string, ReadonlyArray<Decimal>> =>
	new Map(Arr.map(entries, ([identity, spellings]) => [identity, Arr.map(spellings, decimal)]))

const coercedSpellings: Readonly<Record<NumericKind, ReadonlyMap<string, ReadonlyArray<Decimal>>>> =
	{
		"numeric(5, 2)": spellingsOf([
			["0", ["0", "0.000", "-0.004", "0.0049", "-0.00"]],
			["1.5", ["1.5", "1.500", "1.495", "1.5049"]],
			["-2.25", ["-2.250", "-2.245", "-2.2549", "-2.2451"]],
			["10", ["10", "9.995", "10.004", "10.0000"]]
		]),
		"numeric(12, 4)": spellingsOf([
			["0", ["0", "0.00000", "-0.00004"]],
			["1.5", ["1.5", "1.50004", "1.49995"]],
			["1.4951", ["1.49514", "1.495149", "1.49505"]],
			["-2.2549", ["-2.25494", "-2.254851", "-2.25485"]]
		]),
		"numeric(3, 0)": spellingsOf([
			["0", ["0.0", "-0.4", "0.49"]],
			["2", ["2.0", "1.5", "2.4999"]],
			["-2", ["-2.0", "-1.5", "-2.4"]],
			["10", ["10.0", "9.5", "10.49"]]
		])
	}

/**
 * A value of a column of `kind` as an input may spell it, chosen by a pick (test/support/pick.ts): the value itself,
 * or, for a numeric column, one of the spellings that coerce to it at the column's typmod (coercedSpellings), each as
 * likely. Every other kind has one spelling per value here. A pick shrinks toward the value itself.
 */
export const coercedSpelling = <V>(kind: TypeKind, value: V, pick: number): V | Decimal => {
	if (!isNumericKind(kind) || !(value instanceof Decimal)) {
		return value
	}
	const spellings = coercedSpellings[kind].get(value.text) ?? []
	const at = pickIndex(pick, spellings.length + 1)
	return at === 0 ? value : (spellings[at - 1] ?? value)
}

/**
 * Whether a value of a column of `kind` is a numeric spelled other than as the column's typmod stores it: an input
 * that coercion changes.
 */
export const isCoerced = (kind: TypeKind, value: unknown): boolean => {
	if (!isNumericKind(kind) || !(value instanceof Decimal)) {
		return false
	}
	const normalized = normalizeNumeric(value, numericTypmods[kind])
	return normalized.ok && normalized.value.toString() !== value.toString()
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
	"enum",
	"numeric(5, 2)",
	"numeric(12, 4)",
	"numeric(3, 0)",
	"float8",
	"memo"
]

/** The field descriptor of a column of `kind`; `roster` is the schema's closed relation for an enum column. */
export const fieldOf = (kind: TypeKind, roster: AnyClosed): FieldBase => {
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
		case "enum":
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
		case "enum":
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
		case "enum":
			return typeof value === "string" ? { kind: "enum", handle: value } : wrong()
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
 * values, a numeric of one typmod is cast into another's, rounding, and a wide text is cast into the narrow text's
 * domain, which refuses a value outside it.
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
 * Whether a value fits the domain of a field of `kind`: the `^.{0,3}$` refinement with the `s` and `u` flags counts every
 * code point once; every other kind's projected values fit (numerics are cast and rounded, never refused).
 */
export const fitsField = (kind: TypeKind, value: unknown): boolean =>
	kind !== "text" || (typeof value === "string" && Array.from(value).length <= 3)

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
