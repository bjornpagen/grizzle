import { isAsciiDigits } from "@bjornpagen/grizzle-text/text"
import * as Arr from "effect/Array"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Predicate from "effect/Predicate"
import * as Rec from "effect/Record"
import * as Result from "effect/Result"
import * as Str from "effect/String"
import { readHost } from "#adapter/engine.ts"
import { AttestationRefused, ClaimRefused, ExpiryRefused } from "#adapter/errors/failures.ts"
import type {
	Codebook,
	ContextDesc,
	ContextFactSource,
	FieldDesc,
	ScalarType
} from "#compiler/plan/common.ts"
import type { ScalarCodec } from "#compiler/plan/read.ts"
import { defect, jsonText, scalarCodec } from "#compiler/plan/runtime.ts"

/**
 * A Db's claims: the facts of the contexts its role declares, decoded once per Db.open, each from its context's source
 * (ContextFactSource): a token's context from the payload the layer's verify returned, an attested context from the
 * facts its server attests (attestedFacts), never one from the other's; and the text of the `grizzle.claims` setting
 * each of the Db's transactions sets (wire/batch.ts Prologue), which holds both kinds of fact alike.
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
 * opened without a token has no facts of its token's contexts, and one whose server attests none no facts of its
 * attested contexts: a Db with neither has the setting `{}`.
 *
 * Claims are JSON, which has no bigint, and an instant is a bigint contract (a token's `exp` and `iat` among them), so
 * an integer claim is read as JSON states integers. An int8 claim, and a numeric(p, 0) one, whose host value is a
 * bigint, is a JSON number that is a safe integer, or a string of decimal digits with an optional leading minus, read
 * as a bigint; an int2 or int4 claim is a safe-integer number.
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
 * When a Db's token stops authorizing it, which ends each of its live reads (live/subscriptions.ts): `never`, for a Db
 * opened without a token or whose verified payload states no `exp`; or `at` the instant its `exp` states, a NumericDate
 * (seconds since the epoch, RFC 7519), in milliseconds since the epoch. The payload's `exp` is read once, with its top
 * level, and an `exp` that is no finite number is ExpiryRefused: no timer of grizzle's own ends a live read.
 */
export type Expiry =
	| { readonly kind: "never" }
	| { readonly kind: "at"; readonly epochMillis: number }

/** The expiry of a Db whose token states none, or that has no token. */
const neverExpires: Expiry = Object.freeze({ kind: "never" })

/**
 * A Db's claims: the setting's text, the contexts that hold a fact, by name, every claim of those facts, in the
 * setting's order, and the token's expiry.
 */
export interface Claims {
	readonly text: string
	readonly present: ReadonlySet<string>
	readonly values: ReadonlyArray<ClaimValue>
	readonly expiry: Expiry
}

/**
 * One context: its name, its source (a token's, with the claim object its facts are read from, none for the payload's
 * top level, or attested), and its fields in code-unit order, each typed, with its codec under the installation's
 * codes: what its facts are decoded through.
 */
export interface TypedContext {
	readonly name: string
	readonly source: ContextFactSource
	readonly fields: ReadonlyArray<{
		readonly name: string
		readonly type: ScalarType
		readonly codec: ScalarCodec
	}>
}

/** Whether `text` is decimal digits with an optional leading minus: what BigInt reads as exactly that integer. */
const isDecimalInteger = (text: string): boolean => {
	const digits = Str.startsWith("-")(text) ? Str.slice(1)(text) : text
	return digits.length > 0 && isAsciiDigits(digits, 0, digits.length)
}

/**
 * A claim's host value for its field's codec (see the header), by the carrier of its host values, the codec spec's: an
 * integer as JSON states it, a bigint's, numeric(p, 0)'s among them, as int8's; any other value as given, for the
 * encoder to admit; none for an integer claim JSON cannot state exactly.
 */
const claimHost = (codec: ScalarCodec, value: unknown): Option.Option<unknown> => {
	switch (codec.spec.carrier) {
		case "int8":
		case "exactInteger":
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
		case "inet":
		case "cidr":
		case "text":
		case "code":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "exactMoney":
			return Option.some(value)
		case "bits":
		case "bytes":
		case "sha256":
		case "tsvector":
		case "variant":
			defect(
				`a context's field is no ${codec.spec.carrier} field: a context admits none (ir/desc.ts contextFieldAdmits)`
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
	Predicate.isObject(payload) ? Option.some(ownMembers(payload)) : Option.none()

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
	context: { readonly name: string; readonly claim: string | undefined },
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
	if (!Predicate.isObject(found)) {
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
	claim: string | undefined,
	payload: PayloadRead
): Result.Result<Fact | undefined, ClaimRefused> =>
	Result.flatMap(claimObject({ name: context.name, claim }, payload), (object) => {
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
			const host = claimHost(field.codec, object.get(field.name))
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

/**
 * The expiry the payload's top level states (Expiry): none for a payload that is no object or holds no `exp`, the
 * instant of a finite `exp`, and ExpiryRefused for any other `exp`.
 */
const expiryOf = (
	top: Option.Option<ReadonlyMap<string, unknown>>
): Result.Result<Expiry, ExpiryRefused> => {
	const exp = Option.isSome(top) ? top.value.get("exp") : undefined
	if (exp === undefined) {
		return Result.succeed(neverExpires)
	}
	return typeof exp === "number" && Number.isFinite(exp)
		? Result.succeed({ kind: "at", epochMillis: exp * 1000 })
		: Result.fail(new ExpiryRefused())
}

/** The facts a source gives a Db, each context's member of the setting in its fact's order of fields, and each claim. */
export interface SourceFacts {
	readonly members: ReadonlyArray<readonly [string, ReadonlyArray<ClaimValue>]>
}

/** No facts: a Db opened without a token, or whose server attests none. */
export const noFacts: SourceFacts = Object.freeze({ members: [] })

/** The token contexts among a role's, each with the claim object its facts are read from. */
const tokenContexts = (
	contexts: ReadonlyArray<TypedContext>
): ReadonlyArray<{ readonly context: TypedContext; readonly claim: string | undefined }> =>
	Arr.flatMap(contexts, (context) =>
		context.source.kind === "token" ? [{ context, claim: context.source.claim }] : []
	)

/**
 * The facts `payload` holds of the token contexts among `contexts`, and its expiry (see the header). Its top level is
 * read once, before any context decodes: a read that throws refuses the first token context in order, or the expiry
 * when no context reads the payload. An attested context reads nothing of the payload.
 */
export const tokenFacts = (
	contexts: ReadonlyArray<TypedContext>,
	payload: unknown
): Result.Result<
	{ readonly facts: SourceFacts; readonly expiry: Expiry },
	ClaimRefused | ExpiryRefused
> => {
	const sorted = Arr.sort(
		tokenContexts(contexts),
		Order.mapInput(Order.String, (c: { readonly context: TypedContext }) => c.context.name)
	)
	const unreadable: ClaimRefused | ExpiryRefused = Arr.isReadonlyArrayNonEmpty(sorted)
		? notAnObject(Arr.headNonEmpty(sorted).context.name)
		: new ExpiryRefused()
	return Result.gen(function* () {
		const top = yield* readHost(unreadable, () => Result.succeed(topLevel(payload)))
		const read: PayloadRead = { top, claims: new Map() }
		const members: Array<readonly [string, ReadonlyArray<ClaimValue>]> = []
		for (const { context, claim } of sorted) {
			const fact = yield* contextFact(context, claim, read)
			if (fact !== undefined) {
				members.push([
					context.name,
					Arr.map(fact, ({ field, type, text }) => ({ context: context.name, field, type, text }))
				])
			}
		}
		const expiry = yield* expiryOf(top)
		return { facts: { members }, expiry }
	})
}

/**
 * The facts a server attests for a Db (Db.open's `attested`, an HTTP handler's `attest`), decoded through the attested
 * contexts among `contexts`: `attested` is a record whose every member names one of them, each a fact of exactly its
 * context's fields, each a host value its field's codec admits, or no record at all, where the server attests none. A
 * context it leaves out has no fact. A member naming any other context, a token's among them, or a fact of other
 * fields, is AttestationRefused: a token's context is read from the token alone, so no attested value stands for one.
 */
export const attestedFacts = (
	contexts: ReadonlyArray<TypedContext>,
	attested: Option.Option<Readonly<Record<string, unknown>>>
): Result.Result<SourceFacts, AttestationRefused> => {
	if (Option.isNone(attested)) {
		return Result.succeed(noFacts)
	}
	const byName = new Map(
		Arr.flatMap(contexts, (c) => (c.source.kind === "attested" ? [[c.name, c] as const] : []))
	)
	const refused = (context: string, fault: AttestationRefused["fault"]): AttestationRefused =>
		new AttestationRefused({ context, fault })
	return Result.gen(function* () {
		const members: Array<readonly [string, ReadonlyArray<ClaimValue>]> = []
		for (const name of Arr.sort(Rec.keys(attested.value), Order.String)) {
			const context = byName.get(name)
			if (context === undefined) {
				return yield* Result.fail(refused(name, { kind: "undeclared" }))
			}
			const fact = attested.value[name]
			if (fact === undefined) {
				continue
			}
			if (!Predicate.isObject(fact)) {
				return yield* Result.fail(refused(name, { kind: "notAnObject" }))
			}
			const own = ownMembers(fact)
			const unknownField = Arr.findFirst(
				Arr.fromIterable(own.keys()),
				(key) => !Arr.some(context.fields, (f) => f.name === key)
			)
			if (Option.isSome(unknownField)) {
				return yield* Result.fail(
					refused(name, { kind: "unknownField", field: unknownField.value })
				)
			}
			const values: Array<ClaimValue> = []
			for (const field of context.fields) {
				if (!own.has(field.name)) {
					return yield* Result.fail(refused(name, { kind: "missing", field: field.name }))
				}
				const text = field.codec.encode(own.get(field.name))
				if (!text.ok) {
					return yield* Result.fail(refused(name, { kind: "refused", field: field.name }))
				}
				values.push({ context: name, field: field.name, type: field.type, text: text.value })
			}
			members.push([name, values])
		}
		return { members }
	})
}

/**
 * A Db's claims from its token's facts and its server's attested facts, which name no context twice, since each
 * context is of one source: the setting's members in code-unit order of their contexts' names, so one set of facts
 * gives one text, and the token's expiry.
 */
export const claimsOf = (token: SourceFacts, attested: SourceFacts, expiry: Expiry): Claims => {
	const members = Arr.sort(
		[...token.members, ...attested.members],
		Order.mapInput(Order.String, ([name]: readonly [string, unknown]) => name)
	)
	return {
		text: objectText(
			Arr.map(
				members,
				([name, values]) =>
					[
						name,
						objectText(Arr.map(values, ({ field, text }) => [field, jsonText(text)] as const))
					] as const
			)
		),
		present: new Set(Arr.map(members, ([name]) => name)),
		values: Arr.flatMap(members, ([, values]) => values),
		expiry
	}
}

/** The expiry of a Db whose token states none, or that has no token. */
export const noExpiry: Expiry = neverExpires

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
	context: Pick<TypedContext, "name" | "source">,
	fields: ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>,
	codes: Codebook
): TypedContext => ({
	name: context.name,
	source: context.source,
	fields: Arr.map(
		Arr.sort(
			fields,
			Order.mapInput(Order.String, (field: { readonly name: string }) => field.name)
		),
		({ name, type }) => ({ name, type, codec: scalarCodec(type, codes) })
	)
})
