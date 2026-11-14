import {
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, pipe, Record as Rec, String as Str } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { defined } from "#test/support/assert.ts"
import { valueText } from "#test/support/laws/model.ts"
import {
	inDomain,
	isInt8Domain,
	isIntegerDomain,
	pool,
	pooled,
	uuidToken
} from "#test/support/worlds/generate/domain.ts"
import { contextsRead } from "#test/support/worlds/generate/entries.ts"
import {
	type Json,
	jsonObject,
	jsonOf,
	jsonString,
	jsonText
} from "#test/support/worlds/invalid/json.ts"
import type { BoundaryArms, Variant } from "#test/support/worlds/invalid/kinds.ts"
import { patternEdges } from "#test/support/worlds/invalid/patterns.ts"
import { roleOf } from "#test/support/worlds/model/session/state.ts"
import type {
	ContextFacts,
	ContextSpec,
	FieldDomain,
	FieldSpec,
	HostFact,
	ModelState,
	Occurrence,
	Rule,
	StaleSource,
	Token,
	TokenWild,
	HostValue
} from "#test/support/worlds/model/types.ts"

/** One context's claim as drawn: its fact, or none (an absent claim object), and how an int8 field is spelled. */
interface Claim {
	readonly context: ContextSpec
	readonly fact:
		| { readonly kind: "present"; readonly values: HostFact }
		| { readonly kind: "absent" }
	/** An int8 claim as a string of digits rather than a JSON number: both are what grizzle reads. */
	readonly int8AsText: boolean
}

/** A claim's value as the payload holds it: JSON has no bigint, so an int8 is a safe number or a string of digits. */
const payloadValue = (domain: FieldDomain, value: HostValue, int8AsText: boolean): unknown =>
	isInt8Domain(domain) && int8AsText
		? valueText(value)
		: typeof value === "object"
			? valueText(value)
			: value

/** The members a claim adds to the payload: its fields, at the top level or under its claim object's key. */
const claimMembers = (claim: Claim): ReadonlyArray<readonly [string, unknown]> =>
	claim.fact.kind === "absent"
		? []
		: Arr.map(claim.context.fields, (f) => [
				f.name,
				payloadValue(
					f.domain,
					claim.fact.kind === "present" ? (claim.fact.values[f.name] ?? "") : "",
					claim.int8AsText
				)
			])

/** A payload as members before it is written: the top level's, then each claim object's under its key. */
interface Draft {
	readonly top: ReadonlyArray<readonly [string, Json]>
	readonly objects: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, Json]>]>
}

const draftOf = (claims: ReadonlyArray<Claim>): Draft => {
	const top: Array<readonly [string, Json]> = []
	const objects = new Map<string, Array<readonly [string, Json]>>()
	for (const claim of claims) {
		const members = Arr.map(claimMembers(claim), ([k, v]): readonly [string, Json] => [
			k,
			jsonOf(v)
		])
		if (claim.context.claim.kind === "top-level") {
			appendAll(top, members)
		} else if (claim.fact.kind === "present") {
			const key = claim.context.claim.key
			objects.set(key, [...(objects.get(key) ?? []), ...members])
		}
	}
	return { top, objects: [...objects] }
}

const draftJson = (draft: Draft): Json =>
	jsonObject([
		...draft.top,
		...Arr.map(draft.objects, ([key, members]): readonly [string, Json] => [
			key,
			jsonObject(members)
		])
	])

/** The payload a draft states, as `Token.payload` holds it. */
const payloadOf = (claims: ReadonlyArray<Claim>): Readonly<Record<string, unknown>> => {
	const top: Array<readonly [string, unknown]> = []
	const objects = new Map<string, Array<readonly [string, unknown]>>()
	for (const claim of claims) {
		if (claim.context.claim.kind === "top-level") {
			appendAll(top, claimMembers(claim))
		} else if (claim.fact.kind === "present") {
			const key = claim.context.claim.key
			objects.set(key, [...(objects.get(key) ?? []), ...claimMembers(claim)])
		}
	}
	return Rec.fromEntries([
		...top,
		...Arr.map([...objects], ([key, members]): readonly [string, unknown] => [
			key,
			Rec.fromEntries(members)
		])
	])
}

/** The values of a domain the reality holds, at any field of that domain. */
const presentValues = (state: ModelState, domain: FieldDomain): ReadonlyArray<HostValue> =>
	Arr.flatMap([...state.reality.values()], (facts) =>
		Arr.flatMap(facts, (f) => Arr.filter(Rec.values(f), (v) => inDomain(domain, v)))
	)

/** A value of the domain no fact of the reality holds: a pool value absent from it, else one past the pool. */
const absentValue = (state: ModelState, domain: FieldDomain): Gen<HostValue> => {
	const present = new Set(Arr.map(presentValues(state, domain), valueText))
	const absent = Arr.filter(pool(domain), (v) => !present.has(valueText(v)))
	const [first, ...rest] = absent
	if (first !== undefined) {
		return element([first, ...rest])
	}
	switch (domain.kind) {
		case "uuid":
			return map(int(0, 15), (n) => uuidToken(16 + n))
		case "integer":
			return map(int(0, 99), (n) => 100 + n)
		case "serial":
			return map(int(0, 99), (n) => 1000 + n)
		case "contract":
		case "text":
		case "boolean":
		case "handle":
		case "span":
			return element(pool(domain))
	}
}

/** Facts of every field of a context, each a value of its domain no fact of the reality holds. */
const absentValues =
	(state: ModelState, context: ContextSpec): Gen<HostFact> =>
	(source) =>
		Rec.fromEntries(
			Arr.map(context.fields, (f) => [f.name, source.draw(absentValue(state, f.domain))] as const)
		)

/** A claim's field: the context it belongs to, and the field. */
interface ClaimField {
	readonly context: string
	readonly field: FieldSpec
}

/** How a claim's field values are drawn: from the field domain's pool, or as a real user's (meetingValueGen). */
type ValueGen = (at: ClaimField) => Gen<HostValue>

/** A value of a claim field's domain pool. */
const poolValueGen: ValueGen = (at) => element(pool(at.field.domain))

/** A field of an occurrence a rule equates to a claim field: by a context term there, or by a variable a context match binds. */
interface ClaimedField {
	readonly field: string
	readonly context: string
	readonly claim: string
}

/** The fields of an occurrence its rule equates to claim fields. */
const claimedFields = (rule: Rule, o: Occurrence): ReadonlyArray<ClaimedField> => {
	const bound = Arr.flatMap(rule.matches, (m) => {
		const source = m.source
		return source.kind === "context"
			? Arr.flatMap(Rec.toEntries(m.fields), ([claim, t]) =>
					t.kind === "var" ? [{ variable: t.name, context: source.name, claim }] : []
				)
			: []
	})
	return Arr.flatMap(Rec.toEntries(o.fields), ([field, t]): ReadonlyArray<ClaimedField> => {
		switch (t.kind) {
			case "context":
				return [{ field, context: t.context, claim: t.field }]
			case "var":
				return Arr.map(
					Arr.filter(bound, (b) => b.variable === t.name),
					(b) => ({ field, context: b.context, claim: b.claim })
				)
			case "literal":
			case "handle":
				return []
		}
	})
}

/** One fact's values at the fields its occurrence equates to claim fields, by context and claim field. */
const userOf = (claimed: ReadonlyArray<ClaimedField>, fact: HostFact): ContextFacts =>
	Rec.fromEntries(
		Arr.map(
			Arr.dedupe(Arr.map(claimed, (c) => c.context)),
			(context) =>
				[
					context,
					Rec.fromEntries(
						Arr.flatMap(claimed, (c) => {
							const value = fact[c.field]
							return c.context === context && value !== undefined ? [[c.claim, value] as const] : []
						})
					)
				] as const
		)
	)

/**
 * Real users' claims as the worlds meet them: per occurrence of a stored or derived relation in a role's rule that
 * equates fields of it to claim fields (`Administrator(account: Session.sub, school: School.id)`, `Assignment(teacher:
 * Session.sub)`), each fact of that relation's values there, by context and claim field: what one user's token carries
 * together, a school administrator's account beside the school they administer.
 */
const usersOf = (state: ModelState): ReadonlyArray<ContextFacts> =>
	Arr.flatMap(state.install.roles, (role) =>
		Arr.flatMap(Rec.values(role.entries), (entry) =>
			entry.kind === "whole"
				? []
				: Arr.flatMap(entry.rules, (rule) =>
						Arr.flatMap(rule.matches, (o) => {
							const claimed = claimedFields(rule, o)
							const facts =
								o.source.kind === "ordinary"
									? (state.reality.get(o.source.name) ?? [])
									: o.source.kind === "derived"
										? (state.derived[o.source.name] ?? [])
										: []
							return claimed.length === 0 ? [] : Arr.map(facts, (fact) => userOf(claimed, fact))
						})
					)
		)
	)

/** The values a claim field meets in the worlds: each real user's value of it (usersOf). */
const usedValues = (state: ModelState, at: ClaimField): ReadonlyArray<HostValue> =>
	Arr.flatMap(usersOf(state), (user) => {
		const value = user[at.context]?.[at.field.name]
		return value === undefined ? [] : [value]
	})

/** Distinct values, as PostgreSQL spells them, each once. */
const distinctValues = (values: ReadonlyArray<HostValue>): ReadonlyArray<HostValue> => [
	...new Map(Arr.map(values, (v) => [valueText(v), v] as const)).values()
]

/**
 * A real user's value of a claim field, evenly from what is there: one the worlds meet (usedValues: a teacher with
 * assignments, a member of an organization), one the reality holds anywhere in the field's domain, or a pool value.
 */
const meetingValueGen =
	(state: ModelState): ValueGen =>
	(at) => {
		const sources = Arr.flatMap(
			[
				distinctValues(usedValues(state, at)),
				distinctValues(presentValues(state, at.field.domain))
			],
			(values): ReadonlyArray<Gen<HostValue>> => {
				const [first, ...rest] = values
				return first === undefined ? [] : [element([first, ...rest])]
			}
		)
		return oneOf(Arr.append(sources, poolValueGen(at)))
	}

/**
 * A claim drawn live: every field a value `values` draws; an object claim absent one time in six (no fact), unless it
 * is held.
 */
const claimGen =
	(context: ContextSpec, values: ValueGen, held: boolean): Gen<Claim> =>
	(source) => {
		const fields = Arr.map(context.fields, (field) =>
			source.draw(values({ context: context.name, field }))
		)
		const absent = context.claim.kind === "object" && !held && source.draw(int(0, 5)) === 0
		const int8AsText = source.draw(boolean)
		return {
			context,
			fact: absent
				? { kind: "absent" }
				: {
						kind: "present",
						values: Rec.fromEntries(
							Arr.flatMap(context.fields, (f, i) => {
								const v = fields[i]
								return v === undefined ? [] : [[f.name, v] as const]
							})
						)
					},
			int8AsText
		}
	}

/** Every context of a role claimed, in the base's order, each field a value `values` draws, those `held` admits held. */
const claimsGen =
	(
		contexts: ReadonlyArray<ContextSpec>,
		values: ValueGen,
		held: (context: ContextSpec) => boolean
	): Gen<ReadonlyArray<Claim>> =>
	(source) =>
		Arr.map(contexts, (c) => source.draw(claimGen(c, values, held(c))))

/** No context held: every claim object absent one time in six. */
const noneHeld = (): boolean => false

/**
 * Live claims, a real user's: half the time, where the worlds meet one (usersOf), every claim field that user gives at
 * its value, its claim object held, the rest a meeting value; otherwise every field a meeting value of its own.
 */
const liveClaimsGen = (
	state: ModelState,
	contexts: ReadonlyArray<ContextSpec>
): Gen<ReadonlyArray<Claim>> => {
	const meeting = meetingValueGen(state)
	const independent = claimsGen(contexts, meeting, noneHeld)
	const [first, ...rest] = usersOf(state)
	return first === undefined
		? independent
		: oneOf([
				independent,
				(source) => {
					const user = source.draw(element([first, ...rest]))
					return source.draw(
						claimsGen(
							contexts,
							(at) => {
								const value = user[at.context]?.[at.field.name]
								return value === undefined ? meeting(at) : constant(value)
							},
							(c) => Rec.has(user, c.name)
						)
					)
				}
			])
}

/** The claims with every claim object present: what a wild edit of a field needs to find its field. */
const allPresent = (claims: ReadonlyArray<Claim>): ReadonlyArray<Claim> =>
	Arr.map(claims, (c) =>
		c.fact.kind === "present"
			? c
			: {
					...c,
					fact: {
						kind: "present",
						values: Rec.fromEntries(
							Arr.map(c.context.fields, (f) => [f.name, pooled(f.domain, 0)] as const)
						)
					}
				}
	)

/** A claim's facts as a direct writer's setting would hold them, or a Db's claims: the present facts by context. */
const factsOfClaims = (claims: ReadonlyArray<Claim>): ContextFacts =>
	Rec.fromEntries(
		Arr.flatMap(claims, (c): ReadonlyArray<readonly [string, HostFact]> =>
			c.fact.kind === "present" ? [[c.context.name, c.fact.values]] : []
		)
	)

/** A payload stating the given facts: what an earlier request's token held. */
const payloadOfFacts = (
	contexts: ReadonlyArray<ContextSpec>,
	facts: ContextFacts
): Readonly<Record<string, unknown>> =>
	payloadOf(
		Arr.map(contexts, (context): Claim => {
			const values = facts[context.name]
			return {
				context,
				fact: values === undefined ? { kind: "absent" } : { kind: "present", values },
				int8AsText: false
			}
		})
	)

/** A field of a claimed context as a site of the payload: where it sits, its name and domain. */
interface FieldSite {
	readonly at: { readonly kind: "top" } | { readonly kind: "object"; readonly key: string }
	readonly field: string
	readonly domain: FieldDomain
}

const sitesOf = (contexts: ReadonlyArray<ContextSpec>): ReadonlyArray<FieldSite> =>
	Arr.flatMap(contexts, (c) =>
		Arr.map(c.fields, (f): FieldSite => ({
			at: c.claim.kind === "top-level" ? { kind: "top" } : { kind: "object", key: c.claim.key },
			field: f.name,
			domain: f.domain
		}))
	)

/** A draft with one member of a site's place changed: replaced by `json`, or dropped when `json` is none. */
const editSite = (
	draft: Draft,
	site: FieldSite,
	json: { readonly kind: "drop" } | { readonly kind: "set"; readonly json: Json }
): Draft => {
	const edit = (
		members: ReadonlyArray<readonly [string, Json]>
	): ReadonlyArray<readonly [string, Json]> =>
		json.kind === "drop"
			? Arr.filter(members, ([k]) => k !== site.field)
			: Arr.map(members, ([k, v]): readonly [string, Json] => [k, k === site.field ? json.json : v])
	return site.at.kind === "top"
		? { ...draft, top: edit(draft.top) }
		: {
				...draft,
				objects: Arr.map(
					draft.objects,
					([key, members]): readonly [string, ReadonlyArray<readonly [string, Json]>] => [
						key,
						key === (site.at.kind === "object" ? site.at.key : "") ? edit(members) : members
					]
				)
			}
}

/** A draft with one claim object replaced by another JSON value. */
const editObject = (
	draft: Draft,
	key: string,
	json: { readonly kind: "drop" } | { readonly kind: "set"; readonly json: Json }
): Json =>
	jsonObject([
		...draft.top,
		...Arr.flatMap(draft.objects, ([k, members]): ReadonlyArray<readonly [string, Json]> =>
			k !== key ? [[k, jsonObject(members)]] : json.kind === "drop" ? [] : [[k, json.json]]
		)
	])

const isString = (domain: FieldDomain): boolean =>
	domain.kind === "uuid" || domain.kind === "text" || domain.kind === "handle"

const isInteger = isIntegerDomain

/** A value of another JSON type than the field's own. */
const wrongTypes = (domain: FieldDomain): Arr.NonEmptyReadonlyArray<Json> =>
	isString(domain)
		? [
				{ kind: "number", value: 7 },
				{ kind: "boolean", value: true },
				{ kind: "null" },
				jsonObject([]),
				{ kind: "array", items: [] }
			]
		: isInteger(domain)
			? [
					jsonString("7"),
					{ kind: "number", value: 1.5 },
					{ kind: "boolean", value: false },
					{ kind: "null" },
					jsonObject([])
				]
			: domain.kind === "boolean"
				? [jsonString("true"), { kind: "number", value: 1 }, { kind: "null" }]
				: [{ kind: "number", value: 7 }, { kind: "null" }]

/** Texts no JSON reader accepts, or accepts as something other than an object. */
const notJson: Arr.NonEmptyReadonlyArray<string> = [
	"",
	"{",
	"}",
	'{"sub":',
	"{'sub':'x'}",
	'{"a":1,}',
	"null x",
	"eyJhbGciOiJIUzI1NiJ9.e30.c2ln",
	"﻿{}",
	"NaN",
	"[1,2",
	"undefined"
]

/** Integer texts JSON reads past the safe integers, or not as an integer at all. */
const unsafeIntegers: Arr.NonEmptyReadonlyArray<string> = [
	"9007199254740993",
	"-9007199254740993",
	"18446744073709551616",
	"1e400",
	"9223372036854775808"
]

/** Strings an int8 claim must refuse: not decimal digits with an optional leading minus. */
const notDigits: Arr.NonEmptyReadonlyArray<string> = [
	"12a",
	"1e3",
	"+1",
	" 1",
	"0x1f",
	"١٢",
	"",
	"-",
	"1.0",
	"1_000"
]

/** Keys a JavaScript object treats specially. */
const protoKeys: Arr.NonEmptyReadonlyArray<string> = ["__proto__", "constructor", "prototype"]

/** A huge string: past any reasonable token, small enough for one process to hold many. */
const huge = Str.repeat(1_048_576)("x")

/** One wild kind's texts from a role's live claims: which site it edits and which value of the kind are its draws. */
type WildMaker = (draft: Draft) => Gen<string>

/** What an edit does to one member: drops it, or sets it to a value. */
type Edit = { readonly kind: "drop" } | { readonly kind: "set"; readonly json: Json }

/** The sites satisfying a test, or none. */
const sitesWhere = (
	sites: ReadonlyArray<FieldSite>,
	keep: (s: FieldSite) => boolean
): ReadonlyArray<FieldSite> => Arr.filter(sites, keep)

/** A wild maker that edits one site among those `keep` admits, the edit drawn for the site; absent when there are none. */
const atSite = (
	sites: ReadonlyArray<FieldSite>,
	keep: (s: FieldSite) => boolean,
	json: (site: FieldSite) => Gen<Edit>
): Option.Option<WildMaker> => {
	const among = sitesWhere(sites, keep)
	return Arr.isReadonlyArrayNonEmpty(among)
		? Option.some((draft: Draft) => (source) => {
				const site = source.draw(element(among))
				return jsonText(draftJson(editSite(draft, site, source.draw(json(site)))))
			})
		: Option.none()
}

/**
 * The values at the edge of a claim field's refinement, which its encoder admits and PostgreSQL judges: a text's pattern
 * edges (patterns.ts patternEdges), and a contract's bounds and the integers just past them; none for a field of no
 * refinement.
 */
const refinementEdges = (domain: FieldDomain): ReadonlyArray<Json> => {
	switch (domain.kind) {
		case "text":
			return Arr.map(patternEdges(domain), (edge) => jsonString(edge.value))
		case "contract":
			return Arr.map([domain.min - 1, domain.min, domain.max, domain.max + 1], (value): Json => ({
				kind: "number",
				value
			}))
		case "uuid":
		case "integer":
		case "serial":
		case "boolean":
		case "handle":
		case "span":
			return []
	}
}

/** A wild maker over one claim object, the edit drawn; absent when the role reads none. */
const atObject = (sites: ReadonlyArray<FieldSite>, json: Gen<Edit>): Option.Option<WildMaker> => {
	const keys = [...new Set(Arr.flatMap(sites, (s) => (s.at.kind === "object" ? [s.at.key] : [])))]
	return Arr.isReadonlyArrayNonEmpty(keys)
		? Option.some((draft: Draft) => (source) => {
				const key = source.draw(element(keys))
				return jsonText(editObject(draft, key, source.draw(json)))
			})
		: Option.none()
}

/** Each wild kind's maker for a role's claim sites; a kind the sites cannot carry has none. */
const wildMakers = (
	sites: ReadonlyArray<FieldSite>
): ReadonlyArray<readonly [TokenWild, WildMaker]> => {
	const makers: ReadonlyArray<readonly [TokenWild, Option.Option<WildMaker>]> = [
		[
			"not-json",
			Option.some((draft: Draft) => {
				const live = jsonText(draftJson(draft))
				return weighted([
					[
						1,
						map(int(0, 2), (cut) => pipe(live, Str.slice(0, Math.max(0, live.length - 1 - cut))))
					],
					[2, element(notJson)]
				])
			})
		],
		["claim-object-missing", atObject(sites, constant({ kind: "drop" }))],
		["claim-object-null", atObject(sites, constant({ kind: "set", json: { kind: "null" } }))],
		[
			"claim-object-array",
			atObject(
				sites,
				map(boolean, (holding): Edit => ({
					kind: "set",
					json: { kind: "array", items: holding ? [jsonString("x")] : [] }
				}))
			)
		],
		[
			"field-missing",
			atSite(
				sites,
				() => true,
				() => constant({ kind: "drop" })
			)
		],
		[
			"field-wrong-type",
			atSite(
				sites,
				() => true,
				(site) => map(element(wrongTypes(site.domain)), (json): Edit => ({ kind: "set", json }))
			)
		],
		[
			"unsafe-integer",
			atSite(
				sites,
				(s) => isInteger(s.domain),
				() =>
					map(element(unsafeIntegers), (text): Edit => ({
						kind: "set",
						json: { kind: "raw", text }
					}))
			)
		],
		[
			"int8-not-digits",
			atSite(
				sites,
				(s) => isInt8Domain(s.domain),
				() => map(element(notDigits), (text): Edit => ({ kind: "set", json: jsonString(text) }))
			)
		],
		[
			"lone-surrogate",
			atSite(
				sites,
				(s) => isString(s.domain),
				() =>
					map(int(0, 0x7ff), (unit): Edit => ({
						kind: "set",
						json: jsonString(`u${String.fromCharCode(0xd800 + unit)}`)
					}))
			)
		],
		[
			"nul-character",
			atSite(
				sites,
				(s) => isString(s.domain),
				() => constant({ kind: "set", json: jsonString("u_\u0000x") })
			)
		],
		[
			"proto-key",
			Option.some((draft: Draft) =>
				map(element(protoKeys), (key) =>
					jsonText(jsonObject([[key, draftJson(draft)], ...draft.top, ...draftJsonMembers(draft)]))
				)
			)
		],
		[
			"huge-payload",
			Option.some((draft: Draft) => {
				const padded = constant(
					jsonText(
						jsonObject([...draft.top, ...draftJsonMembers(draft), ["pad", jsonString(huge)]])
					)
				)
				const strings = sitesWhere(sites, (s) => isString(s.domain))
				return Arr.isReadonlyArrayNonEmpty(strings)
					? oneOf([
							padded,
							map(element(strings), (site) =>
								jsonText(draftJson(editSite(draft, site, { kind: "set", json: jsonString(huge) })))
							)
						])
					: padded
			})
		],
		[
			"refinement-edge",
			atSite(
				sites,
				(s) => Arr.isReadonlyArrayNonEmpty(refinementEdges(s.domain)),
				(site) =>
					Arr.match(refinementEdges(site.domain), {
						onEmpty: () => constant<Edit>({ kind: "drop" }),
						onNonEmpty: (edges) => map(element(edges), (json): Edit => ({ kind: "set", json }))
					})
			)
		],
		[
			"extra-fields",
			Option.some((draft: Draft) => {
				const extra: ReadonlyArray<readonly [string, Json]> = [
					["extra", jsonString("x")],
					["role", jsonString("owner")]
				]
				const added = constant(
					jsonText(
						jsonObject([
							...draft.top,
							...extra,
							...Arr.map(draft.objects, ([key, members]): readonly [string, Json] => [
								key,
								jsonObject([...members, ...(sites.length > 0 ? extra : [])])
							])
						])
					)
				)
				const [first] = draft.top
				return first === undefined
					? added
					: weighted([
							[
								1,
								constant(jsonText(jsonObject([...draft.top, first, ...draftJsonMembers(draft)])))
							],
							[2, added]
						])
			})
		],
		["verify-throws", Option.some((draft: Draft) => constant(jsonText(draftJson(draft))))],
		["verify-not-object", Option.some((draft: Draft) => constant(jsonText(draftJson(draft))))]
	]
	return Arr.flatMap(makers, ([wild, maker]) =>
		Arr.map(Arr.fromOption(maker), (m) => [wild, m] as const)
	)
}

/** The claim objects of a draft as members, each object written. */
const draftJsonMembers = (draft: Draft): ReadonlyArray<readonly [string, Json]> =>
	Arr.map(draft.objects, ([key, members]): readonly [string, Json] => [key, jsonObject(members)])

/** A stale token variant: the payloads of one source, valid once but from another state. */
const stale = (
	source: StaleSource,
	payloads: Gen<Readonly<Record<string, unknown>>>
): Variant<Token> => ({
	invalid: `token:stale:${source}`,
	gen: map(payloads, (payload): Token => ({ kind: "stale", payload, source }))
})

/** A draw's stale payload: each source's way to make a token valid once but from another state. */
const staleVariants = (
	state: ModelState,
	contexts: ReadonlyArray<ContextSpec>
): ReadonlyArray<Variant<Token>> => {
	const [anyContext] = contexts
	if (anyContext === undefined) {
		return []
	}
	const topLevel = Option.getOrElse(
		Arr.findFirst(contexts, (c) => c.claim.kind === "top-level"),
		() => anyContext
	)
	const objectClaim = Arr.findFirst(contexts, (c) => c.claim.kind === "object")
	/** The live claims with one context's fields all values the reality does not hold. */
	const withAbsent =
		(target: ContextSpec): Gen<Readonly<Record<string, unknown>>> =>
		(source) =>
			payloadOf(
				Arr.map(allPresent(source.draw(claimsGen(contexts, poolValueGen, noneHeld))), (c): Claim =>
					c.context.name === target.name
						? {
								...c,
								fact: { kind: "present", values: source.draw(absentValues(state, c.context)) }
							}
						: c
				)
			)
	const previous = Arr.flatMap(state.sessions, (s) =>
		s.kind === "db" && Rec.keys(s.facts).length > 0 ? [s.facts] : []
	)
	const [firstPrevious, ...morePrevious] = previous
	return [
		stale("removed-user", withAbsent(topLevel)),
		...Option.match(objectClaim, {
			onNone: (): ReadonlyArray<Variant<Token>> => [],
			onSome: (c) => [stale("deleted-organization", withAbsent(c))]
		}),
		...(contexts.length < 2
			? []
			: [
					stale("left-organization", (source) =>
						payloadOf(
							source.draw(
								leftOrganization(
									state,
									allPresent(source.draw(claimsGen(contexts, poolValueGen, noneHeld)))
								)
							)
						)
					)
				]),
		...(firstPrevious === undefined
			? []
			: [
					stale(
						"previous-request",
						map(element([firstPrevious, ...morePrevious]), (facts) =>
							payloadOfFacts(contexts, facts)
						)
					)
				])
	]
}

/**
 * Claims whose contexts each hold values the reality holds, but never together in one fact: a subject still present and
 * an organization still present that no fact relates to it, as when the subject left it.
 */
const leftOrganization = (
	state: ModelState,
	claims: ReadonlyArray<Claim>
): Gen<ReadonlyArray<Claim>> => {
	const [first, ...rest] = claims
	if (first === undefined || first.fact.kind === "absent") {
		return constant(claims)
	}
	const held = new Set(Arr.map(Rec.values(first.fact.values), valueText))
	const facts = [...state.reality.values()].flat()
	const together = (v: HostValue): boolean =>
		Arr.some(facts, (f) => {
			const texts = Arr.map(Rec.values(f), valueText)
			return texts.includes(valueText(v)) && Arr.some(texts, (t) => held.has(t))
		})
	const apartValue = (domain: FieldDomain): Gen<HostValue> => {
		const [a, ...more] = Arr.filter(presentValues(state, domain), (v) => !together(v))
		return a === undefined ? absentValue(state, domain) : element([a, ...more])
	}
	return (source) => [
		first,
		...Arr.map(rest, (c): Claim => ({
			...c,
			fact: {
				kind: "present",
				values: Rec.fromEntries(
					Arr.map(c.context.fields, (f) => [f.name, source.draw(apartValue(f.domain))] as const)
				)
			}
		}))
	]
}

/**
 * The tokens `Db.open` may be handed for a role: live, a payload of its contexts' claims, a real user's (liveClaimsGen;
 * no token for a role that reads none); stale, from a removed user, a left or deleted organization, or an earlier request; and wild,
 * every TokenWild the role's contexts can carry, from the text level (not JSON, a prototype key, a huge payload, extra
 * fields, a verify that throws or returns no object) to a field's (missing, wrongly typed, an unsafe integer, int8 not
 * digits, a lone surrogate, a NUL, a string at its pattern's edge).
 */
export const tokenArms = (state: ModelState, role: string): BoundaryArms<Token> => {
	const contexts = contextsRead(
		state.install.base,
		defined(roleOf(state.install, role), `the installation's role ${role}`)
	)
	const live: Gen<Token> =
		contexts.length === 0
			? constant<Token>({ kind: "none" })
			: map(liveClaimsGen(state, contexts), (claims): Token => ({
					kind: "live",
					payload: payloadOf(claims)
				}))
	const sites = sitesOf(contexts)
	const wilds = Arr.map(wildMakers(sites), ([kind, make]): Variant<Token> => ({
		invalid: `token:${kind}`,
		gen: (source) => {
			const claims = source.draw(claimsGen(contexts, poolValueGen, noneHeld))
			return { kind: "wild", wild: kind, text: source.draw(make(draftOf(allPresent(claims)))) }
		}
	}))
	return { live, stale: staleVariants(state, contexts), wild: wilds }
}

/** The live claims of a role's contexts as facts, a real user's: what a direct writer that copies one's claims sets. */
export const liveFactsGen = (
	state: ModelState,
	contexts: ReadonlyArray<ContextSpec>
): Gen<ContextFacts> => map(liveClaimsGen(state, contexts), factsOfClaims)

/** Claims of the role's contexts holding values no fact of the reality holds: another, unknown user's facts. */
export const absentFactsGen =
	(state: ModelState, contexts: ReadonlyArray<ContextSpec>): Gen<ContextFacts> =>
	(source) =>
		factsOfClaims(
			Arr.map(allPresent(source.draw(claimsGen(contexts, poolValueGen, noneHeld))), (c): Claim => ({
				...c,
				fact: { kind: "present", values: source.draw(absentValues(state, c.context)) }
			}))
		)
