import { array, boolean, element, type Gen, map } from "@grizzle/testing/gen"
import { Array as Arr, Option, Record, String as Str } from "effect"
import { contextsRead } from "#test/support/worlds/generate/entries.ts"
import type { BoundaryArms, Variant } from "#test/support/worlds/invalid/kinds.ts"
import { absentFactsGen, liveFactsGen } from "#test/support/worlds/invalid/tokens.ts"
import type {
	ClaimsSetting,
	ContextSpec,
	DirectSessionState,
	ModelState,
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
 * the whole session, outliving the transaction; wild, a malformed text at either scope, or facts of a context the role
 * does not read.
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
	const wild: ReadonlyArray<Variant<ClaimsSetting>> = [
		...Arr.map(scopes, (scope): Variant<ClaimsSetting> => ({
			invalid: `claims:malformed:${scope}`,
			gen: map(element([firstText, ...moreTexts]), (text): ClaimsSetting => ({
				kind: "malformed",
				text,
				scope
			}))
		})),
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
