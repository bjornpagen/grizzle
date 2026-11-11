import * as Arr from "effect/Array"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Rec from "effect/Record"
import * as Result from "effect/Result"
import * as Str from "effect/String"
import { readHost } from "#adapter/engine.ts"
import { ClaimRefused } from "#adapter/errors/failures.ts"
import type { Codebook, ContextDesc, FieldDesc, ScalarType } from "#compiler/plan/common.ts"
import type { ScalarCodec } from "#compiler/plan/read.ts"
import { defect, isList, isRecord, jsonText, scalarCodec } from "#compiler/plan/runtime.ts"

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
 * value. Reading the payload runs the verifier's value, and each object of it is read once (PayloadRead): its top level
 * before any context decodes, and each claim object when the first context naming it reads it, every context that
 * names it then reading the same members; a read that throws refuses the context that made it the same way. A Db
 * opened without a token has no context facts: its setting is `{}`.
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
 * every statement that reads the context casts each claim to the type it is judged by, its domain included (sql/print.ts
 * contextClaims), so a value its refinement refuses fails that statement with the domain's error.
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
 * One context: its name, the claim object its facts are read from (none for the payload's top level), and its fields in
 * code-unit order, each typed, with its codec under the installation's codes: what its claims are decoded through.
 */
export interface TypedContext {
	readonly name: string
	readonly claim: string | undefined
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

/** An object's own enumerable members, each read once: a data property's value, or what its getter returns called once. */
const ownMembers = (value: Readonly<Record<string, unknown>>): ReadonlyMap<string, unknown> => {
	const own = new Map<string, unknown>()
	for (const key of Rec.keys(value)) {
		own.set(key, value[key])
	}
	return own
}

/** The refusal of a context whose claim object is no object, or whose reading throws. */
const notAnObject = (context: string): ClaimRefused =>
	new ClaimRefused({ context, fault: { kind: "notAnObject" } })

/**
 * The payload's top level, read once (ownMembers): its own enumerable members, so a key named like a prototype member
 * (`constructor`, `__proto__`) is a member like any other, or absent, never the prototype's; none for a payload that is
 * no object or a list, which holds no claim object and is no context's fact.
 */
const topLevel = (payload: unknown): Option.Option<ReadonlyMap<string, unknown>> =>
	isRecord(payload) && !isList(payload) ? Option.some(ownMembers(payload)) : Option.none()

/**
 * The payload as its contexts read it, each object of it read once: its top level (topLevel), and each claim object a
 * context names, read when the first context in order reads it and then shared by every context that names it.
 */
interface PayloadRead {
	readonly top: Option.Option<ReadonlyMap<string, unknown>>
	readonly claims: Map<string, ReadonlyMap<string, unknown> | undefined>
}

/**
 * The members a context reads, from the payload as read (PayloadRead): its top level, or the claim object its `claim`
 * names, read once into its own enumerable members; undefined when the claim object is absent, which is no fact. A top
 * level or a claim object that is no object, a list among them, and a claim object whose reading throws, refuse the
 * context.
 */
const claimObject = (
	context: Pick<TypedContext, "name" | "claim">,
	payload: PayloadRead
): Result.Result<ReadonlyMap<string, unknown> | undefined, ClaimRefused> => {
	const claim = context.claim
	if (claim === undefined) {
		return Option.isSome(payload.top)
			? Result.succeed(payload.top.value)
			: Result.fail(notAnObject(context.name))
	}
	if (payload.claims.has(claim)) {
		return Result.succeed(payload.claims.get(claim))
	}
	const found = Option.isSome(payload.top) ? payload.top.value.get(claim) : undefined
	if (found === undefined) {
		payload.claims.set(claim, undefined)
		return Result.succeed(undefined)
	}
	if (!isRecord(found) || isList(found)) {
		return Result.fail(notAnObject(context.name))
	}
	return Result.map(
		readHost(notAnObject(context.name), () => Result.succeed(ownMembers(found))),
		(members) => {
			payload.claims.set(claim, members)
			return members
		}
	)
}

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
	payload: PayloadRead
): Result.Result<Fact | undefined, ClaimRefused> =>
	Result.flatMap(claimObject(context, payload), (object) => {
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
						context: context.name,
						fault: { kind: "missing", field: field.name }
					})
				)
			}
			const host = claimHost(field.type, object.get(field.name))
			const text = Option.isSome(host) ? field.codec.encode(host.value) : undefined
			if (text === undefined || !text.ok) {
				return Result.fail(
					new ClaimRefused({
						context: context.name,
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
	const sorted = Arr.sort(
		contexts,
		Order.mapInput(Order.String, (c: TypedContext) => c.name)
	)
	if (!Arr.isReadonlyArrayNonEmpty(sorted)) {
		return Result.succeed(noClaims)
	}
	const top = readHost(notAnObject(Arr.headNonEmpty(sorted).name), () =>
		Result.succeed(topLevel(payload))
	)
	if (Result.isFailure(top)) {
		return Result.fail(top.failure)
	}
	const read: PayloadRead = { top: top.success, claims: new Map() }
	for (const context of sorted) {
		const fact = contextFact(context, read)
		if (Result.isFailure(fact)) {
			return Result.fail(fact.failure)
		}
		if (fact.success === undefined) {
			continue
		}
		members.push([
			context.name,
			objectText(Arr.map(fact.success, ({ field, text }) => [field, jsonText(text)] as const))
		])
		for (const { field, type, text } of fact.success) {
			values.push({ context: context.name, field, type, text })
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
): TypedContext =>
	contextOver(
		desc,
		Arr.map(Rec.toEntries(desc.fields), ([name, field]) => ({ name, type: typeOf(field) })),
		codes
	)

/**
 * A context over its typed fields `fields`, put in code-unit order, each with its codec under the codes `codes`: what
 * the compile types against the base, and a served file holds typed.
 */
export const contextOver = (
	context: Pick<TypedContext, "name" | "claim">,
	fields: ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>,
	codes: Codebook
): TypedContext => ({
	name: context.name,
	claim: context.claim,
	fields: Arr.map(
		Arr.sort(
			fields,
			Order.mapInput(Order.String, (field: { readonly name: string }) => field.name)
		),
		({ name, type }) => ({ name, type, codec: scalarCodec(type, codes) })
	)
})
