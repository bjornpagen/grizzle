import { Array as Arr, Option, Order, Record as Rec, Result, String as Str } from "effect"
import { readHost } from "#adapter/engine.ts"
import { ClaimRefused } from "#adapter/errors/failures.ts"
import {
	type Codebook,
	type ContextDesc,
	defect,
	type FieldDesc,
	isList,
	isRecord,
	jsonText,
	type ScalarType
} from "#compiler/plan/common.ts"
import { scalarCodec, type ScalarCodec } from "#compiler/plan/read.ts"

/**
 * A Db's claims: the facts of the contexts its role reads, decoded once per Db.open from the payload the layer's verify
 * returned, and the text of the `grizzle.claims` setting each of the Db's transactions sets (wire/batch.ts Prologue).
 *
 * The setting is a JSON object with one member per context that has a fact, `{ "<Context>": { "<field>": "<text>" } }`,
 * never the token and nothing else of the payload. Each value is the field's text form (codec/scalar.ts), a JSON string
 * the context source reads by the field's type, so a bigint claim keeps every digit and every value reaches its type's
 * input function exactly. Keys are in code-unit order (Order.String), so one payload gives one text. Each member holds
 * exactly its context's fields and no key repeats, the one shape PostgreSQL's context source admits (sql/print.ts
 * contextClaims), so a Db's setting is never refused there.
 *
 * A context reads its fields from the payload's own top level, or from the nested claim object its `claim` names. An
 * absent claim object is no fact, and its context has no member. A claim object that is present but no object, a
 * field missing from it, or a value its field's encoder refuses is refused as ClaimRefused, which quotes no claim
 * value. Reading the payload runs the verifier's value, once (core/host.ts); a read that throws refuses
 * it the same way. A Db opened without a token has no context facts: its setting is `{}`.
 *
 * Claims are JSON, which has no bigint, and an instant is a bigint contract (a token's `exp` and `iat` among them), so
 * an integer claim is read as JSON states integers. An int8 claim is a JSON number that is a safe integer, or a string
 * of decimal digits with an optional leading minus, read as a bigint; an int2 or int4 claim is a safe-integer number.
 * The field's encoder then bounds it to its type's range. A number past the safe integers lost its digits in the JSON
 * parse, so it is refused, never rounded, as are a fraction and a number spelled as a string for int2 and int4. A
 * closed id's claim is its handle, a JSON string, which the field's codec writes as the handle's code under the
 * installation's codes, so a claim of a handle the roster does not hold live is refused like any value its encoder
 * refuses.
 *
 * A field whose type is refined, by a pattern or a contract's predicate, is judged by PostgreSQL, never on the host:
 * Db.open's admission flight asks the field's domain whether it admits each such value (admission/admit.ts), and a
 * value it refuses is a ClaimRefused like the others, at stage `token`.
 *
 * One decoded claim: its context and field, the field's type, and its text form, the setting's value of it.
 */
export interface ClaimValue {
	readonly context: string
	readonly field: string
	readonly type: ScalarType
	readonly text: string
}

/**
 * A Db's claims: the setting's text, the contexts that hold a fact, by name, and every claim of those facts, in the
 * setting's order.
 */
export interface Claims {
	readonly text: string
	readonly present: ReadonlySet<string>
	readonly values: ReadonlyArray<ClaimValue>
}

/** The claims of a Db with no context facts. */
export const noClaims: Claims = Object.freeze({
	text: "{}",
	present: new Set<string>(),
	values: []
})

/**
 * One context, its fields typed, each with its codec under the installation's codes: what its claims are decoded
 * through.
 */
export interface TypedContext {
	readonly desc: ContextDesc
	readonly fields: ReadonlyArray<{
		readonly name: string
		readonly type: ScalarType
		readonly codec: ScalarCodec
	}>
}

/** Whether `text` is decimal digits with an optional leading minus: what BigInt reads as exactly that integer. */
const isDecimalInteger = (text: string): boolean => {
	const digits = Str.startsWith("-")(text) ? Str.slice(1)(text) : text
	if (digits.length === 0) {
		return false
	}
	for (const ch of digits) {
		if (ch < "0" || ch > "9") {
			return false
		}
	}
	return true
}

/**
 * A claim's host value for its field's carrier (see the header): an integer as JSON states it, any other value as
 * given, for the encoder to admit; none for an integer claim JSON cannot state exactly.
 */
const claimHost = (type: ScalarType, value: unknown): Option.Option<unknown> => {
	switch (type.carrier) {
		case "int8":
			if (typeof value === "number") {
				return Number.isSafeInteger(value) ? Option.some(BigInt(value)) : Option.none()
			}
			return typeof value === "string" && isDecimalInteger(value)
				? Option.some(BigInt(value))
				: Option.none()
		case "int2":
		case "int4":
			return typeof value === "number" && Number.isSafeInteger(value)
				? Option.some(value)
				: Option.none()
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "code":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return Option.some(value)
		case "bits":
		case "bytes":
			throw defect(
				`a context's field is no ${type.carrier} field: a context admits none (ir/desc.ts contextFieldAdmits)`
			)
	}
}

/**
 * The claim object a context reads, read once into a map of its own enumerable members: undefined when absent, which is
 * no fact. Only own properties are read, the payload's claim among them, so a key named like a prototype member
 * (`constructor`, `__proto__`) is a member like any other, or absent, never the prototype's.
 */
const claimObject = (
	context: ContextDesc,
	payload: unknown
): Result.Result<ReadonlyMap<string, unknown> | undefined, ClaimRefused> =>
	readHost(new ClaimRefused({ context: context.name, fault: { kind: "notAnObject" } }), () => {
		const claim = context.claim
		const found =
			claim === undefined
				? payload
				: isRecord(payload) && Rec.has(payload, claim)
					? payload[claim]
					: undefined
		if (found === undefined && claim !== undefined) {
			return Result.succeed(undefined)
		}
		if (!isRecord(found) || isList(found)) {
			return Result.fail(
				new ClaimRefused({ context: context.name, fault: { kind: "notAnObject" } })
			)
		}
		const own = new Map<string, unknown>()
		for (const key of Rec.keys(found)) {
			own.set(key, found[key])
		}
		return Result.succeed(own)
	})

/**
 * One context's fact as the setting's member: each field with its type and its text form, in the context's field
 * order; undefined for no fact.
 */
type Fact = ReadonlyArray<{
	readonly field: string
	readonly type: ScalarType
	readonly text: string
}>

const contextFact = (
	context: TypedContext,
	payload: unknown
): Result.Result<Fact | undefined, ClaimRefused> =>
	Result.flatMap(claimObject(context.desc, payload), (object) => {
		if (object === undefined) {
			return Result.succeed(undefined)
		}
		const fact: Array<{
			readonly field: string
			readonly type: ScalarType
			readonly text: string
		}> = []
		for (const field of context.fields) {
			if (!object.has(field.name)) {
				return Result.fail(
					new ClaimRefused({
						context: context.desc.name,
						fault: { kind: "missing", field: field.name }
					})
				)
			}
			const host = claimHost(field.type, object.get(field.name))
			const text = Option.isSome(host) ? field.codec.encode(host.value) : undefined
			if (text === undefined || !text.ok) {
				return Result.fail(
					new ClaimRefused({
						context: context.desc.name,
						fault: { kind: "refused", field: field.name }
					})
				)
			}
			fact.push({ field: field.name, type: field.type, text: text.value })
		}
		return Result.succeed(fact)
	})

/** A JSON object of string members, in the order given. */
const objectText = (members: ReadonlyArray<readonly [string, string]>): string =>
	`{${Arr.join(
		Arr.map(members, ([key, json]) => `${jsonText(key)}:${json}`),
		","
	)}}`

/** The claims `payload` holds for `contexts` (see the header). */
export const claimsOf = (
	contexts: ReadonlyArray<TypedContext>,
	payload: unknown
): Result.Result<Claims, ClaimRefused> => {
	const members: Array<readonly [string, string]> = []
	const values: Array<ClaimValue> = []
	for (const context of Arr.sort(
		contexts,
		Order.mapInput(Order.String, (c: TypedContext) => c.desc.name)
	)) {
		const fact = contextFact(context, payload)
		if (Result.isFailure(fact)) {
			return Result.fail(fact.failure)
		}
		if (fact.success === undefined) {
			continue
		}
		members.push([
			context.desc.name,
			objectText(Arr.map(fact.success, ({ field, text }) => [field, jsonText(text)] as const))
		])
		for (const { field, type, text } of fact.success) {
			values.push({ context: context.desc.name, field, type, text })
		}
	}
	return Result.succeed({
		text: objectText(members),
		present: new Set(Arr.map(members, ([name]) => name)),
		values
	})
}

/** The typed fields of a context, by `typeOf`, in code-unit order, each with its codec under the codes `codes`. */
export const typedContext = (
	desc: ContextDesc,
	typeOf: (field: FieldDesc) => ScalarType,
	codes: Codebook
): TypedContext => ({
	desc,
	fields: Arr.map(
		Arr.sort(
			Rec.toEntries(desc.fields),
			Order.mapInput(Order.String, ([name]: readonly [string, FieldDesc]) => name)
		),
		([name, field]) => {
			const type = typeOf(field)
			return { name, type, codec: scalarCodec(type, codes) }
		}
	)
})
