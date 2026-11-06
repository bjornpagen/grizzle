import { array, boolean, element, type Gen, map } from "@grizzle/testing/gen"
import { Array as Arr, Option, Record, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { pool } from "#test/support/worlds/generate/domain.ts"
import { contextsRead } from "#test/support/worlds/generate/entries.ts"
import type { BoundaryArms, Variant } from "#test/support/worlds/invalid/kinds.ts"
import { patternEdges } from "#test/support/worlds/invalid/patterns.ts"
import { absentFactsGen, liveFactsGen } from "#test/support/worlds/invalid/tokens.ts"
import { claimText } from "#test/support/worlds/model/session/claims.ts"
import type {
	ClaimsSetting,
	ContextSpec,
	DirectSessionState,
	FieldDomain,
	ModelState,
	HandleCodes,
	SettingScope
} from "#test/support/worlds/model/types.ts"

/**
 * Texts `grizzle.claims` may be set to that no Db sets: not JSON, not an object, a context that is no object, a field of
 * the wrong type or missing, an unknown context, an extra field, a lone surrogate escaped, a duplicate key, and a huge
 * text. A Db's setting is `{ "<Context>": { "<field>": "<text>" } }`; the model reads each as PostgreSQL does
 * (model/session/direct.ts textRead).
 */
export const malformedTexts = (
	contexts: ReadonlyArray<ContextSpec>
): Arr.NonEmptyReadonlyArray<string> => {
	const [context] = contexts
	const name = context?.name ?? "Session"
	const field = context?.fields[0].name ?? "sub"
	return [
		"",
		"{",
		"null",
		"[]",
		`{"${name}":"x"}`,
		`{"${name}":{"${field}":1}}`,
		`{"${name}":{}}`,
		`{"${name}":null}`,
		'{"Nope":{}}',
		`{"${name}":{"${field}":"u_a","extra":"x"}}`,
		`{"${name}":{"${field}":"\\ud800"}}`,
		`{"${name}":{"${field}":"a"},"${name}":{"${field}":"b"}}`,
		`{"${name}":{"${field}":"${Str.repeat(65_536)("x")}"}}`
	]
}

/** The integer types' least values past their range, as text: what an integer field's input refuses with 22003. */
const pastRange: Readonly<Record<16 | 32 | 64, string>> = {
	16: "32768",
	32: "2147483648",
	64: "9223372036854775808"
}

/**
 * Texts a field's type refuses as a context source casts a hand-set claim to it (README "Direct SQL access"), one per
 * way its cast refuses: no uuid (22P02); no integer (22P02), one past the type's range (22003); no boolean (22P02); a
 * handle's name where its code belongs (22P02), a code no live handle holds (23514), one past a smallint (22003); a
 * value past a contract's bounds (23514); a text its pattern refuses (23514), the first of its edge strings it does.
 */
const refusedTexts = (domain: FieldDomain, codes: HandleCodes): ReadonlyArray<string> => {
	switch (domain.kind) {
		case "uuid":
			return ["not-a-uuid"]
		case "text":
			return Arr.take(
				Arr.flatMap(patternEdges(domain), (edge) => (edge.admitted ? [] : [edge.value])),
				1
			)
		case "integer":
			return ["1.5", pastRange[domain.bits]]
		case "contract":
			return ["1.5", pastRange[domain.bits], String(domain.max + 1)]
		case "boolean":
			return ["maybe"]
		case "handle": {
			const handles = codes[domain.closed]
			if (handles === undefined) {
				throw new Error(`the installation holds no codes of roster ${domain.closed}`)
			}
			return [domain.members[0], String(handles.length), pastRange[16]]
		}
		case "serial":
		case "span":
			return []
	}
}

/** A claims document's member: its context, and each field's claim text. */
type Member = readonly [
	context: string,
	fields: ReadonlyArray<readonly [field: string, text: string]>
]

/** A claims document's text: each context's member, each field's claim text as a JSON string. */
const documentText = (members: ReadonlyArray<Member>): string =>
	`{${Arr.join(
		Arr.map(
			members,
			([context, fields]) =>
				`${jsonText(context)}:{${Arr.join(
					Arr.map(fields, ([field, text]) => `${jsonText(field)}:${jsonText(text)}`),
					","
				)}}`
		),
		","
	)}}`

/**
 * The claims settings a direct writer hand-sets whose one claim its field refuses, for the transaction: every context
 * of `contexts` with a member of exactly its fields, each claim the text of its domain's first pool value (a closed
 * id's its handle's code), but one field's, a text its type refuses (refusedTexts); one setting per field and refused
 * text. None for no context.
 */
export const refusedClaimSettings = (
	contexts: ReadonlyArray<ContextSpec>,
	codes: HandleCodes
): ReadonlyArray<ClaimsSetting> => {
	const valid = (domain: FieldDomain): string => claimText(domain, codes, pool(domain)[0])
	return Arr.flatMap(contexts, (target) =>
		Arr.flatMap(target.fields, (planted) =>
			Arr.map(refusedTexts(planted.domain, codes), (refused): ClaimsSetting => ({
				kind: "malformed",
				text: documentText(
					Arr.map(contexts, (c): Member => [
						c.name,
						Arr.map(c.fields, (f): readonly [string, string] => [
							f.name,
							c.name === target.name && f.name === planted.name ? refused : valid(f.domain)
						])
					])
				),
				scope: "transaction"
			}))
		)
	)
}

/** The contexts a direct writer's current role reads: none as its login, or under a role the installation lacks. */
const readBy = (state: ModelState, current: DirectCurrent): ReadonlyArray<ContextSpec> => {
	if (current.kind === "login") {
		return []
	}
	return Option.match(
		Arr.findFirst(state.install.roles, (r) => r.name === current.role),
		{ onNone: () => [], onSome: (role) => contextsRead(state.install.base, role) }
	)
}

/** Who a direct writer currently is: its login, or a role it set. */
export type DirectCurrent = DirectSessionState["current"]

const scopes: Arr.NonEmptyReadonlyArray<SettingScope> = ["transaction", "session"]

/**
 * What a direct writer under its current role (or still as its login) sets `grizzle.claims` to: live, a real user's facts
 * of its role's contexts, all or some of them, for the transaction; stale, another user's facts (values the reality does not hold) or facts set for
 * the whole session, outliving the transaction; wild, a malformed text at either scope, a claims document one of
 * whose claims its field's type refuses (refusedClaimSettings), or facts of a context the role does not read.
 */
export const claimsArms = (
	state: ModelState,
	current: DirectCurrent
): BoundaryArms<ClaimsSetting> => {
	const read = readBy(state, current)
	const unread = Arr.filter(
		state.install.base.contexts,
		(c) => !Arr.some(read, (r) => r.name === c.name)
	)
	/**
	 * A real user's facts, every context the role reads, or half the time only some of them: a writer may set any of its
	 * contexts, and a context its setting leaves out holds no fact (README "Security model").
	 */
	const live: Gen<ClaimsSetting> = (source) => {
		const facts = source.draw(liveFactsGen(state, read))
		const whole = source.draw(boolean)
		const kept = source.draw(array(boolean, { min: read.length, max: read.length }))
		return {
			kind: "facts",
			facts: whole
				? facts
				: Record.fromEntries(
						Arr.filter(Record.toEntries(facts), ([context]) =>
							Arr.some(read, (c, i) => c.name === context && kept[i] === true)
						)
					),
			scope: "transaction"
		}
	}
	const [firstText, ...moreTexts] = malformedTexts([...read, ...state.install.base.contexts])
	const stale: ReadonlyArray<Variant<ClaimsSetting>> = [
		{
			invalid: "claims:facts:session",
			gen: map(liveFactsGen(state, read), (facts): ClaimsSetting => ({
				kind: "facts",
				facts,
				scope: "session"
			}))
		},
		...(read.length === 0
			? []
			: [
					{
						invalid: "claims:facts:transaction" as const,
						gen: map(absentFactsGen(state, read), (facts): ClaimsSetting => ({
							kind: "facts",
							facts,
							scope: "transaction"
						}))
					}
				])
	]
	const [firstRefused, ...moreRefused] = refusedClaimSettings(read, state.names.codes)
	const wild: ReadonlyArray<Variant<ClaimsSetting>> = [
		...Arr.map(scopes, (scope): Variant<ClaimsSetting> => ({
			invalid: `claims:malformed:${scope}`,
			gen: map(element([firstText, ...moreTexts]), (text): ClaimsSetting => ({
				kind: "malformed",
				text,
				scope
			}))
		})),
		...(firstRefused === undefined
			? []
			: [
					{
						invalid: "claims:malformed:transaction" as const,
						gen: element([firstRefused, ...moreRefused])
					}
				]),
		...(unread.length === 0
			? []
			: [
					{
						invalid: "claims:facts:transaction" as const,
						gen: map(liveFactsGen(state, unread), (facts): ClaimsSetting => ({
							kind: "facts",
							facts,
							scope: "transaction"
						}))
					}
				])
	]
	return { live, stale, wild }
}
