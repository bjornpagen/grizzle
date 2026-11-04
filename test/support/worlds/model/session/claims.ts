import { Array as Arr, Option, Order, Record as Rec, String as Str } from "effect"
import { valueText } from "#test/pg/laws/families/model.ts"
import { roleContexts } from "#test/support/worlds/model/session/state.ts"
import type {
	BaseSpec,
	ContextFacts,
	ContextSpec,
	FieldDomain,
	HostFact,
	RoleSpec,
	Token,
	TokenRefuser,
	HostValue
} from "#test/support/worlds/model/types.ts"

import { regex } from "arkregex"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
/**
 * The claims rules of README "Permissions" and "Security model", restated over a verified payload: a context reads its fields
 * from the payload's own top level or from the nested claim object its `claim` names; an absent claim object is no
 * fact; a claim object that is no object, a field missing from it, or a value its field's encoder refuses is refused at
 * stage token (ClaimRefused); keys no context names are ignored. The host decides every type but a refinement: a text
 * field's regex and a contract's bounds are PostgreSQL's to judge, in Db.open's admission flight, so a value they refuse
 * is refused at stage token only once admission passed.
 */
export type TokenVerdict =
	| { readonly kind: "refused"; readonly by: TokenRefuser }
	| {
			readonly kind: "decoded"
			readonly facts: ContextFacts
			/** Whether PostgreSQL refuses a refined claim of the facts, which Db.open reports after admission. */
			readonly refinedRefused: boolean
	  }

/** What one claim's value is to its field. */
type ClaimVerdict =
	| { readonly kind: "admitted"; readonly value: HostValue }
	| { readonly kind: "host-refused" }
	| { readonly kind: "refined-refused"; readonly value: HostValue }

/** Whether a value is a non-null object, which every property of reads as some value. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null

const uuidPattern = regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i")

/** Whether a decimal text with an optional leading minus spells an integer exactly. */
const isDecimalInteger = (text: string): boolean => regex("^-?[0-9]+$").test(text)

/** The bounds of a signed integer of `bits` bits. */
const fitsBits = (value: bigint, bits: 16 | 32 | 64): boolean => {
	const half = 2n ** BigInt(bits - 1)
	return value >= -half && value < half
}

/** Whether a text is one PostgreSQL can hold: no NUL and no lone surrogate. */
const isAdmittedText = (text: string): boolean =>
	text.isWellFormed() && !Str.includes("\u0000")(text)

/**
 * One claim against its field's domain. An integer claim is read as JSON states integers: a safe-integer number, or
 * for a 64-bit field also a string of decimal digits, held as its canonical decimal text so no digit is lost.
 */
const claimOf = (domain: FieldDomain, value: unknown): ClaimVerdict => {
	switch (domain.kind) {
		case "uuid":
			return typeof value === "string" && uuidPattern.test(value)
				? { kind: "admitted", value: Str.toLowerCase(value) }
				: { kind: "host-refused" }
		case "text":
			if (typeof value !== "string" || !isAdmittedText(value)) {
				return { kind: "host-refused" }
			}
			return regex.as(domain.pattern, domain.flags).test(value)
				? { kind: "admitted", value }
				: { kind: "refined-refused", value }
		case "integer":
		case "serial": {
			if (typeof value === "number" && Number.isSafeInteger(value)) {
				return fitsBits(BigInt(value), domain.bits)
					? { kind: "admitted", value: value === 0 ? 0 : value }
					: { kind: "host-refused" }
			}
			if (domain.bits === 64 && typeof value === "string" && isDecimalInteger(value)) {
				const exact = BigInt(value)
				if (!fitsBits(exact, 64)) {
					return { kind: "host-refused" }
				}
				const safe =
					exact >= BigInt(Number.MIN_SAFE_INTEGER) && exact <= BigInt(Number.MAX_SAFE_INTEGER)
				return { kind: "admitted", value: safe ? Number(exact) : exact.toString() }
			}
			return { kind: "host-refused" }
		}
		case "contract": {
			const integer = claimOf({ kind: "integer", bits: domain.bits }, value)
			if (integer.kind !== "admitted") {
				return integer
			}
			const n = Number(integer.value)
			return n >= domain.min && n <= domain.max
				? integer
				: { kind: "refined-refused", value: integer.value }
		}
		case "boolean":
			return typeof value === "boolean" ? { kind: "admitted", value } : { kind: "host-refused" }
		case "handle":
			return typeof value === "string" && domain.members.includes(value)
				? { kind: "admitted", value }
				: { kind: "host-refused" }
		case "span":
			return { kind: "host-refused" }
	}
}

/** The claim object a context reads from a payload: absent, refused, or the object. */
type ClaimObject =
	| { readonly kind: "absent" }
	| { readonly kind: "refused" }
	| { readonly kind: "object"; readonly object: Readonly<Record<string, unknown>> }

const claimObjectOf = (context: ContextSpec, payload: unknown): ClaimObject => {
	const found =
		context.claim.kind === "top-level"
			? payload
			: isRecord(payload) && Rec.has(payload, context.claim.key)
				? payload[context.claim.key]
				: undefined
	if (found === undefined && context.claim.kind === "object") {
		return { kind: "absent" }
	}
	if (!isRecord(found) || Arr.isArray(found)) {
		return { kind: "refused" }
	}
	return { kind: "object", object: found }
}

/** One context's fact from a payload: none, refused, or the fact and whether PostgreSQL refuses a refined claim of it. */
type ContextVerdict =
	| { readonly kind: "none" }
	| { readonly kind: "refused" }
	| { readonly kind: "fact"; readonly fact: HostFact; readonly refinedRefused: boolean }

const contextFactOf = (context: ContextSpec, payload: unknown): ContextVerdict => {
	const found = claimObjectOf(context, payload)
	if (found.kind !== "object") {
		return found.kind === "absent" ? { kind: "none" } : { kind: "refused" }
	}
	const fact: Record<string, HostValue> = {}
	let refinedRefused = false
	for (const field of context.fields) {
		if (!Rec.has(found.object, field.name)) {
			return { kind: "refused" }
		}
		const claim = claimOf(field.domain, found.object[field.name])
		if (claim.kind === "host-refused") {
			return { kind: "refused" }
		}
		if (claim.kind === "refined-refused") {
			refinedRefused = true
		}
		fact[field.name] = claim.value
	}
	return { kind: "fact", fact, refinedRefused }
}

/** The facts a verified payload holds for the contexts a role reads. */
export const payloadFacts = (base: BaseSpec, role: RoleSpec, payload: unknown): TokenVerdict => {
	const read = roleContexts(role)
	const facts: Record<string, HostFact> = {}
	let refinedRefused = false
	for (const context of Arr.filter(base.contexts, (c) => read.has(c.name))) {
		const verdict = contextFactOf(context, payload)
		if (verdict.kind === "refused") {
			return { kind: "refused", by: "claims" }
		}
		if (verdict.kind === "fact") {
			facts[context.name] = verdict.fact
			refinedRefused = refinedRefused || verdict.refinedRefused
		}
	}
	return { kind: "decoded", facts, refinedRefused }
}

/**
 * A wild token's text as the JSON value the world's verify parses it to (execute/token.ts worldVerify), none when it is
 * no JSON text, which verify refuses.
 */
const parsedPayload = Option.liftThrowable((text: string): unknown => trustedJson<unknown>(text))

/** What the test verify returns for a token registered `verify-not-object`: a number, whatever the token's text. */
const notAnObject = 42

/**
 * What Db.open makes of a token for a role (README "Permissions", "Security model"): none, or a login whose layer
 * has no verify (no role of the login reads a context), is no context fact; otherwise verify runs once on it, for a
 * role that reads no context too. The test verify decodes the token's JSON text, so a wild text that holds no JSON, or
 * a verify that throws, refuses the token; a verify that returns no object returns a number whatever the text holds; a
 * payload verify returns is decoded through the role's contexts.
 */
export const tokenVerdict = (
	base: BaseSpec,
	role: RoleSpec,
	token: Token,
	verifies: boolean
): TokenVerdict => {
	if (token.kind === "none" || !verifies) {
		return { kind: "decoded", facts: {}, refinedRefused: false }
	}
	switch (token.kind) {
		case "live":
		case "stale":
			return payloadFacts(base, role, token.payload)
		case "wild": {
			if (token.wild === "verify-throws") {
				return { kind: "refused", by: "verify" }
			}
			if (token.wild === "verify-not-object") {
				return payloadFacts(base, role, notAnObject)
			}
			const payload = parsedPayload(token.text)
			return Option.isSome(payload)
				? payloadFacts(base, role, payload.value)
				: { kind: "refused", by: "verify" }
		}
	}
}

/** Entries by key in code-unit order, the order the claims setting lists its members in. */
const byKey = <A>(record: Readonly<Record<string, A>>): ReadonlyArray<readonly [string, A]> =>
	Arr.sort(
		Rec.toEntries(record),
		Order.mapInput(Order.String, ([key]: readonly [string, A]) => key)
	)

/** One context's fact as the claims setting spells it: a JSON object of its fields' texts as JSON strings. */
const memberText = (fact: HostFact): string =>
	`{${Arr.join(
		Arr.map(byKey(fact), ([field, value]) => `${jsonText(field)}:${jsonText(valueText(value))}`),
		","
	)}}`

/**
 * The text of the `grizzle.claims` setting for a session's facts: a JSON object with one member per context that has a
 * fact, each a JSON object of its fields' texts as JSON strings, contexts and fields in code-unit order. The one text a
 * Db sets for its facts and a direct writer sets for a `facts` setting.
 */
export const claimsText = (facts: ContextFacts): string =>
	`{${Arr.join(
		Arr.map(byKey(facts), ([context, fact]) => `${jsonText(context)}:${memberText(fact)}`),
		","
	)}}`
