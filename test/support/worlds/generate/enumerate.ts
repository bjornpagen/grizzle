import { WILD_KINDS } from "@grizzle/testing/lsw"
import { Array as Arr, Option, Order, Record as Rec, String as Str } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { TupleMap, TupleSet } from "#compiler/core/tuple-map.ts"
import { type Atom, type ValueIdentity } from "#test/support/kernel/identity.ts"
import {
	projection,
	sortedRowsOrder,
	sortedStateRows,
	type StateRows,
	valueText,
	violations
} from "#test/support/laws/model.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { canonicalForms } from "#test/support/worlds/generate/canonical.ts"
import { invalidKindsOf } from "#test/support/worlds/generate/classify.ts"
import {
	domainKey,
	fieldsOfSource,
	inDomain,
	isIntegerDomain,
	knownNonEmpty,
	outsideContract,
	pastType,
	pool,
	sameDomain
} from "#test/support/worlds/generate/domain.ts"
import { contextsRead, headingOf } from "#test/support/worlds/generate/entries.ts"
import { plantedInstall, plantedKinds } from "#test/support/worlds/generate/install.ts"
import { applicable, namesOffered } from "#test/support/worlds/generate/offered.ts"
import { attachments, entryKey, reaches } from "#test/support/worlds/generate/reads.ts"
import { actionKinds } from "#test/support/worlds/generate/weights.ts"
import { enumeratePerturbations, worldFunctionsOf } from "#test/support/worlds/invalid/catalog.ts"
import { refusedClaimSettings } from "#test/support/worlds/invalid/claims.ts"
import { opKinds, type FactWriter } from "#test/support/worlds/invalid/facts.ts"
import { jsonObject, jsonText } from "#test/support/worlds/invalid/json.ts"
import { rosterMigrations, violatingLaws } from "#test/support/worlds/invalid/migrations.ts"
import { patternEdges } from "#test/support/worlds/invalid/patterns.ts"
import { droppedNames, nonexistentNames } from "#test/support/worlds/invalid/roles.ts"
import { nameableFacts } from "#test/support/worlds/model/draws.ts"
import { classifyEntry, uniqueFacts, entryRows, factKey } from "#test/support/worlds/model/host.ts"
import { parametersOf } from "#test/support/worlds/model/session/direct.ts"
import { draftedFrom, factsIn, samePlain } from "#test/support/worlds/model/session/state.ts"
import {
	claimFixedFields,
	serialHead,
	type Written,
	writtenAt,
	writtenNamed,
	writtenOf
} from "#test/support/worlds/model/session/writes.ts"
import { settle, step } from "#test/support/worlds/model/step.ts"
import type {
	Action,
	ActionKind,
	BaseSpec,
	ClaimsSetting,
	ContextFacts,
	ContextSpec,
	DirectSessionState,
	DirectStart,
	DirectStatement,
	EntryOp,
	EntrySpec,
	FieldDomain,
	FieldSpec,
	HostFact,
	HostSchema,
	HostState,
	InstallSpec,
	LoginSpec,
	ModelState,
	Occurrence,
	ActionOutcome,
	PageFrom,
	ReadVia,
	RelationSpec,
	RoleRef,
	RoleSpec,
	Rule,
	SmallScope,
	SnapshotRef,
	StaleSource,
	Term,
	Token,
	TokenWild,
	HostValue
} from "#test/support/worlds/model/types.ts"

/** The default exhaustive box: two relations, two rules, one context, two subjects, three facts, three actions deep. */
export const defaultScope: SmallScope = {
	relations: 2,
	rules: 2,
	contexts: 1,
	subjects: 2,
	facts: 3,
	depth: 3
}

/** Whether a domain's values are interchangeable: a uuid or a text, whose values no comparison orders. */
const symmetric = (domain: FieldDomain): boolean => domain.kind === "uuid" || domain.kind === "text"

/** A domain's values in the box: its pool cut to `subjects` values (integers to one more, serials to `facts` more). */
const boxPool = (domain: FieldDomain, scope: SmallScope): Arr.NonEmptyReadonlyArray<HostValue> => {
	const values = pool(domain)
	const cut =
		domain.kind === "integer" || domain.kind === "contract"
			? scope.subjects + 1
			: domain.kind === "serial"
				? scope.facts + 1
				: domain.kind === "boolean" || domain.kind === "handle"
					? values.length
					: Math.max(1, scope.subjects)
	return knownNonEmpty(values.slice(0, cut), "a box pool")
}

/** Every value a term holds as a literal: a literal's, a typed handle's member. */
const termLiterals = (t: Term): ReadonlyArray<HostValue> =>
	t.kind === "literal" ? [t.value] : t.kind === "handle" ? [t.member] : []

const ruleLiterals = (rule: Rule): ReadonlyArray<HostValue> => [
	...Arr.flatMap([...rule.matches, ...rule.negations.flat()], (o: Occurrence) =>
		Arr.flatMap(Rec.values(o.fields), termLiterals)
	),
	...Arr.flatMap(rule.comparisons, (c) => [...termLiterals(c.left), ...termLiterals(c.right)]),
	...Arr.flatMap(Rec.values(rule.head), termLiterals)
]

/** The literals an installation states: in its rules, its derived relations, its laws' selectors and row checks. */
const installLiterals = (install: InstallSpec): ReadonlyArray<HostValue> => {
	const base = install.base
	const lawValues = Arr.flatMap(base.laws, (law): ReadonlyArray<HostValue> => {
		switch (law.kind) {
			case "check": {
				const comparisons = (p: typeof law.predicate): ReadonlyArray<number> =>
					p.kind === "compare"
						? [p.value, p.value + 1, p.value - 1]
						: Arr.flatMap(p.parts, comparisons)
				return comparisons(law.predicate)
			}
			case "contained":
			case "covered":
				return [...Rec.values(law.source.where), ...Rec.values(law.target.where)]
			case "key":
			case "spanKey":
			case "alternatives":
				return []
		}
	})
	const rules = [
		...Arr.flatMap(base.derived, (d) => d.rules),
		...Arr.flatMap(install.roles, (r) =>
			Arr.flatMap(Rec.values(r.entries), (e) => (e.kind === "query" ? e.rules : []))
		)
	]
	const literals: ReadonlyArray<HostValue> = Arr.flatMap(rules, (r: Rule) => ruleLiterals(r))
	const ruleValues = Arr.flatMap(literals, (v: HostValue): ReadonlyArray<HostValue> =>
		typeof v === "number" ? [v, v + 1] : [v]
	)
	return [...lawValues, ...ruleValues]
}

/**
 * Every value the state holds: in the reality, the derived relations, the sessions' facts, claims and views, and the
 * installation's literals. The box's symmetry renames only values outside it: a value one of these holds (a claim a
 * direct writer set, say) behaves apart from any other.
 */
export const stateValues = (state: ModelState): ReadonlyArray<HostValue> => [
	...Arr.flatMap([...state.reality.values()].flat(), (f) => Rec.values(f)),
	...Arr.flatMap(Rec.values(state.derived).flat(), (f) => Rec.values(f)),
	...Arr.flatMap(state.sessions, (s): ReadonlyArray<HostValue> => {
		switch (s.kind) {
			case "db":
				return Arr.flatMap(Rec.values(s.facts), (f) => Rec.values(f))
			case "direct":
				return [
					...Arr.flatMap([...s.view.values()].flat(), (f) => Rec.values(f)),
					...(s.claims.kind === "set" && s.claims.setting.kind === "facts"
						? Arr.flatMap(Rec.values(s.claims.setting.facts), (f) => Rec.values(f))
						: [])
				]
			case "closed":
				return []
		}
	}),
	...installLiterals(state.install)
]

/** Values, each once by its text, first kept. */
const distinctValues = (values: ReadonlyArray<HostValue>): ReadonlyArray<HostValue> => [
	...new Map(Arr.map(values, (v) => [valueText(v), v] as const)).values()
]

/**
 * The values of a domain the box tries in a state, symmetry-reduced: of a uuid or text domain, every value the state
 * already holds and one it does not (the box pool's first unused one), since unused values are interchangeable and one
 * stands for them all; of an ordered domain, its box pool and every value the state holds, with each literal the
 * installation compares with and its successor.
 */
const valuesFor = (
	state: ModelState,
	domain: FieldDomain,
	scope: SmallScope
): Arr.NonEmptyReadonlyArray<HostValue> => {
	const held = distinctValues(Arr.filter(stateValues(state), (v) => inDomain(domain, v)))
	const box = boxPool(domain, scope)
	if (symmetric(domain)) {
		const texts = new Set(Arr.map(held, valueText))
		const unused = Arr.findFirst(box, (v) => !texts.has(valueText(v)))
		return knownNonEmpty([...held, ...Arr.fromOption(unused)], "a domain's box values")
	}
	return knownNonEmpty(distinctValues([...box, ...held]), "a domain's box values")
}

/**
 * The facts of a heading the box tries, each choice once: every field at its first value, then each field in turn at
 * each of its other values, the rest at their first: every value of every field is met, at a cost linear in them.
 */
const eachChoice = (
	heading: ReadonlyArray<FieldSpec>,
	valuesOf: (f: FieldSpec) => Arr.NonEmptyReadonlyArray<HostValue>
): ReadonlyArray<HostFact> => {
	const first: HostFact = Rec.fromEntries(Arr.map(heading, (f) => [f.name, valuesOf(f)[0]]))
	return uniqueFacts([
		first,
		...Arr.flatMap(heading, (f) =>
			Arr.map(valuesOf(f).slice(1), (v): HostFact => ({ ...first, [f.name]: v }))
		)
	])
}

/**
 * The claims stored facts state together: for each fact of the reality meeting at least two of the claim heading's
 * fields, each field at a value the fact holds in its domain, each such value in turn, a field the fact holds none of
 * at its value in `first`. A user's token claims values one row holds together, as an administrator's account beside
 * the school it administers, which varying one field at a time from the first values (eachChoice) seldom meets.
 */
const jointChoices = (
	state: ModelState,
	heading: ReadonlyArray<FieldSpec>,
	first: HostFact
): ReadonlyArray<HostFact> =>
	Arr.flatMap(state.install.base.relations, (relation) =>
		Arr.flatMap(factsIn(state.reality, relation.name), (fact): ReadonlyArray<HostFact> => {
			const held = Arr.map(heading, (claim) => ({
				claim,
				values: distinctValues(
					Arr.flatMap(relation.fields, (f): ReadonlyArray<HostValue> => {
						const value = fact[f.name]
						return value !== undefined && sameDomain(f.domain, claim.domain) ? [value] : []
					})
				)
			}))
			const unclaimed: ReadonlyArray<HostFact> = [{}]
			return Arr.filter(held, (h) => h.values.length > 0).length < 2
				? []
				: Arr.reduce(held, unclaimed, (partial, { claim, values }) =>
						Arr.flatMap(partial, (p) =>
							Arr.map(
								values.length > 0
									? values
									: Arr.fromOption(Option.fromUndefinedOr(first[claim.name])),
								(value): HostFact => ({ ...p, [claim.name]: value })
							)
						)
					)
		})
	)

/**
 * A role's claims in the box: each choice of its contexts' fields, varied one at a time (eachChoice) and as stored
 * facts state them together (jointChoices), and the payload stating a choice.
 */
interface ClaimsBox {
	readonly contexts: ReadonlyArray<ContextSpec>
	readonly facts: ReadonlyArray<HostFact>
	readonly payloadOf: (
		fact: HostFact,
		absent: ReadonlySet<string>
	) => Readonly<Record<string, unknown>>
}

const claimsBox = (state: ModelState, role: RoleSpec, scope: SmallScope): ClaimsBox => {
	const contexts = contextsRead(state.install.base, role).slice(0, Math.max(1, scope.contexts))
	const fields = Arr.flatMap(contexts, (c) => Arr.map(c.fields, (f) => ({ context: c, field: f })))
	const heading = Arr.map(fields, (x, i): FieldSpec => ({ name: `${i}`, domain: x.field.domain }))
	const choices = eachChoice(heading, (f) => valuesFor(state, f.domain, scope))
	const facts = uniqueFacts([
		...choices,
		...Arr.flatMap(Arr.take(choices, 1), (first) => jointChoices(state, heading, first))
	])
	const payloadOf = (
		fact: HostFact,
		absent: ReadonlySet<string>
	): Readonly<Record<string, unknown>> => {
		const top: Array<readonly [string, unknown]> = []
		const objects = new Map<string, Array<readonly [string, unknown]>>()
		for (const [i, x] of fields.entries()) {
			const v = fact[`${i}`]
			if (v === undefined || absent.has(x.context.name)) {
				continue
			}
			const member = [x.field.name, typeof v === "object" ? valueText(v) : v] as const
			const claim = x.context.claim
			if (claim.kind === "top-level") {
				top.push(member)
				continue
			}
			objects.set(claim.key, [...(objects.get(claim.key) ?? []), member])
		}
		return Rec.fromEntries([
			...top,
			...Arr.map([...objects], ([k, m]) => [k, Rec.fromEntries(m)] as const)
		])
	}
	return { contexts, facts, payloadOf }
}

/** A role's live tokens in the box: none for a role that reads no context; else each choice of its claims, an object claim also absent. */
const liveTokens = (
	state: ModelState,
	role: RoleSpec,
	scope: SmallScope
): Arr.NonEmptyReadonlyArray<Token> => {
	const box = claimsBox(state, role, scope)
	const [firstFact, ...moreFacts] = box.facts
	if (box.contexts.length === 0 || firstFact === undefined) {
		return [{ kind: "none" }]
	}
	return [
		{ kind: "live", payload: box.payloadOf(firstFact, new Set()) },
		...Arr.map(moreFacts, (f): Token => ({ kind: "live", payload: box.payloadOf(f, new Set()) })),
		...Arr.map(
			Arr.filter(box.contexts, (c) => c.claim.kind === "object"),
			(c): Token => ({ kind: "live", payload: box.payloadOf(firstFact, new Set([c.name])) })
		)
	]
}

/** One representative token per stale source and per wild kind a role's claims can carry. */
const invalidTokens = (
	state: ModelState,
	role: RoleSpec,
	scope: SmallScope
): ReadonlyArray<Token> => {
	const box = claimsBox(state, role, scope)
	const last = box.facts.at(-1)
	const payload = last === undefined ? {} : box.payloadOf(last, new Set())
	const contexts = contextsRead(state.install.base, role)
	const text = jsonText(jsonObject([]))
	const stale: ReadonlyArray<StaleSource> =
		contexts.length === 0
			? []
			: [
					"removed-user",
					...(Arr.some(contexts, (c) => c.claim.kind === "object")
						? (["deleted-organization"] as const)
						: []),
					...(contexts.length > 1 ? (["left-organization"] as const) : []),
					...(Arr.some(state.sessions, (s) => s.kind === "db" && Rec.keys(s.facts).length > 0)
						? (["previous-request"] as const)
						: [])
				]
	return [
		...Arr.map(stale, (source): Token => ({ kind: "stale", payload, source })),
		...Arr.map(tokenWildsFor(contexts), (wild): Token => ({
			kind: "wild",
			wild,
			text: wildText(wild, contexts, text)
		}))
	]
}

/** The wild kinds a role's claims can carry, as the token generators judge them. */
const tokenWildsFor = (contexts: ReadonlyArray<ContextSpec>): ReadonlyArray<TokenWild> => {
	const domains = Arr.flatMap(contexts, (c) => Arr.map(c.fields, (f) => f.domain))
	const any = contexts.length > 0
	const has = (keep: (d: FieldDomain) => boolean): boolean => Arr.some(domains, keep)
	return [
		"not-json",
		...(Arr.some(contexts, (c) => c.claim.kind === "object")
			? (["claim-object-missing", "claim-object-null", "claim-object-array"] as const)
			: []),
		...(any ? (["field-missing", "field-wrong-type"] as const) : []),
		...(has(isIntegerDomain) ? (["unsafe-integer"] as const) : []),
		...(has((d) => (d.kind === "integer" || d.kind === "contract") && d.bits === 64)
			? (["int8-not-digits"] as const)
			: []),
		...(has((d) => d.kind === "uuid" || d.kind === "text" || d.kind === "handle")
			? (["lone-surrogate", "nul-character"] as const)
			: []),
		"proto-key",
		"huge-payload",
		...(has((d) => d.kind === "text" || d.kind === "contract")
			? (["refinement-edge"] as const)
			: []),
		"extra-fields",
		"verify-throws",
		"verify-not-object"
	]
}

/** A representative text of a wild kind over a role's contexts: the simplest of the kind. */
const wildText = (wild: TokenWild, contexts: ReadonlyArray<ContextSpec>, empty: string): string => {
	const [context] = contexts
	const field = context?.fields[0]
	const key = context?.claim.kind === "object" ? context.claim.key : undefined
	const at = (json: string): string =>
		field === undefined
			? empty
			: key === undefined
				? `{"${field.name}":${json}}`
				: `{"${key}":{"${field.name}":${json}}}`
	switch (wild) {
		case "not-json":
			return "{"
		case "claim-object-missing":
			return empty
		case "claim-object-null":
			return key === undefined ? empty : `{"${key}":null}`
		case "claim-object-array":
			return key === undefined ? empty : `{"${key}":[]}`
		case "field-missing":
			return key === undefined ? empty : `{"${key}":{}}`
		case "field-wrong-type":
			return at("{}")
		case "unsafe-integer":
			return at("9007199254740993")
		case "int8-not-digits":
			return at('"1e3"')
		case "lone-surrogate":
			return at('"\\ud800"')
		case "nul-character":
			return at('"u_\\u0000"')
		case "proto-key":
			return '{"__proto__":{}}'
		case "huge-payload":
			return `{"pad":"${Str.repeat(1_048_576)("x")}"}`
		case "refinement-edge": {
			const domain = field?.domain
			return domain?.kind === "text"
				? at(jsonText({ kind: "string", value: patternEdges(domain)[0].value }))
				: domain?.kind === "contract"
					? at(String(domain.max + 1))
					: empty
		}
		case "extra-fields":
			return '{"extra":"x"}'
		case "verify-throws":
		case "verify-not-object":
			return empty
	}
}

/** A Db.open of the box. */
const open = (role: RoleRef, token: Token, snapshot: SnapshotRef): Action => ({
	kind: "open-db",
	role,
	token,
	snapshot
})

/** The open-db actions of the box: each live role and token at the current snapshot, then each invalid input alone. */
const openActions = (state: ModelState, scope: SmallScope): ReadonlyArray<Action> => {
	const install = state.install
	const [first] = install.roles
	const [firstToken] = liveTokens(state, first, scope)
	return [
		...Arr.flatMap(install.roles, (role) =>
			Arr.map(liveTokens(state, role, scope), (t) =>
				open({ kind: "own", role: role.name }, t, "current")
			)
		),
		...Arr.flatMap(install.roles, (role) =>
			Arr.map(invalidTokens(state, role, scope), (t) =>
				open({ kind: "own", role: role.name }, t, "current")
			)
		),
		...Arr.map(
			Arr.filter(install.roles, (role) => contextsRead(install.base, role).length > 0).slice(0, 1),
			(role) => open({ kind: "own", role: role.name }, { kind: "none" }, "current")
		),
		...(install.logins.length > 1
			? [open({ kind: "other-login", role: first.name }, firstToken, "current")]
			: []),
		...Arr.map(droppedNames(install).slice(0, 1), (role) =>
			open({ kind: "dropped", role }, firstToken, "current")
		),
		open({ kind: "nonexistent", name: nonexistentNames(install)[0] }, firstToken, "current"),
		open({ kind: "owner" }, firstToken, "current"),
		...Arr.map(["stale", "tampered", "foreign"] as const, (s) =>
			open({ kind: "own", role: first.name }, firstToken, s)
		),
		...Arr.flatMap(
			state.migrations.kind === "pending"
				? Arr.filter(
						install.roles,
						(r) =>
							state.migrations.kind === "pending" &&
							Arr.some(state.migrations.folders.at(-1)?.roles ?? [], (x) => x.name === r.name)
					).slice(0, 1)
				: [],
			(r) => [open({ kind: "own", role: r.name }, liveTokens(state, r, scope)[0], "drafted")]
		)
	]
}

/** The Db role of a session, when it is an open Db's. */
const roleAt = (state: ModelState, session: number): Option.Option<FactWriter> => {
	const s = state.sessions[session]
	return s?.kind === "db"
		? Option.map(
				Arr.findFirst(state.install.roles, (r) => r.name === s.role),
				(role): FactWriter => ({ role, facts: s.facts })
			)
		: Option.none()
}

/** One entry another role holds and the given role does not: the box's representative of another world's handle. */
const otherEntry = (state: ModelState, role: RoleSpec): ReadonlyArray<string> =>
	Arr.filter(
		Arr.flatMap(
			Arr.filter(state.install.roles, (r) => r.name !== role.name),
			(r: RoleSpec) => Rec.keys(r.entries)
		),
		(name) => !Rec.has(role.entries, name)
	).slice(0, 1)

/** The first entry of the installation: what a session that is no Db names in the box. */
const firstEntryName = (state: ModelState): string =>
	Rec.keys(state.install.roles[0].entries)[0] ?? state.install.base.relations[0].name

/**
 * The reads of the box at a session: each relation of its role executed, then on its first relation every other path
 * once (compiled, `get` by a row's key, by a key no row holds and by a key of another shape, a page of no row), another
 * role's relation, and each relation's page of one row from the first page and from the last, first attachment and
 * first recursive read; a session that is no Db reads the installation's first relation.
 */
const readActions = (state: ModelState, session: number): ReadonlyArray<Action> => {
	const db = roleAt(state, session)
	if (Option.isNone(db)) {
		return [{ kind: "read", session, relation: firstEntryName(state), via: { kind: "execute" } }]
	}
	const { role, facts } = db.value
	const [first, ...rest] = Rec.keys(role.entries)
	if (first === undefined) {
		return []
	}
	const spec = role.entries[first]
	const key = spec === undefined ? [] : entryKey(state.install.base, spec)
	const rows = entryRows(state, role.name, first, facts)
	const keyOf = (fact: HostFact): HostFact =>
		Rec.fromEntries(
			Arr.flatMap(key, (f) => {
				const v = fact[f.name]
				return v === undefined ? [] : [[f.name, v] as const]
			})
		)
	const [row] = rows
	const lastOf = (f: FieldSpec): HostValue =>
		Arr.lastNonEmpty(valuesFor(state, f.domain, defaultScope))
	/** A value of a field's domain no row holds there: the last such of the box's values, else the pool's first. */
	const unrowed = (f: FieldSpec): Option.Option<HostValue> =>
		Arr.findFirst(
			[...Arr.reverse(valuesFor(state, f.domain, defaultScope)), ...pool(f.domain)],
			(v) =>
				Arr.every(rows, (r) => {
					const held = r[f.name]
					return held === undefined || valueText(held) !== valueText(v)
				})
		)
	/**
	 * The gets of the first relation besides a row's key: a key no row holds (its first field at a value no row holds
	 * there, so it never equals a row's key even when the rows hold every value the box tries, the rest at their box
	 * values' last), and a key of another shape (its first field a value of the other JavaScript type).
	 */
	const offKey = Arr.matchLeft(key, {
		onEmpty: (): ReadonlyArray<ReadVia> => [],
		onNonEmpty: (keyField, more): ReadonlyArray<ReadVia> => {
			const others = Rec.fromEntries(Arr.map(more, (f) => [f.name, lastOf(f)] as const))
			const shaped = typeof lastOf(keyField) === "string" ? 7 : "seven"
			return [
				...Arr.map(Arr.fromOption(unrowed(keyField)), (v): ReadVia => ({
					kind: "get",
					key: { [keyField.name]: v, ...others }
				})),
				{ kind: "get", key: { [keyField.name]: shaped, ...others } }
			]
		}
	})
	/** A page of `size` rows ordered by its relation's first field alone, from the first page or from the last. */
	const pageOf = (
		heading: ReadonlyArray<FieldSpec>,
		size: number,
		from: PageFrom
	): ReadonlyArray<ReadVia> =>
		Arr.map(Arr.take(heading, 1), (f): ReadVia => ({
			kind: "page",
			size,
			order: [{ field: f.name, direction: "asc" }],
			from
		}))
	/**
	 * Each relation's reads past its rows' own delivery: a page of one row from the first page and from the last, whose
	 * ties the key it is completed by breaks, its first attachment and its first recursive read.
	 */
	const paths = Arr.flatMap(Rec.toEntries(role.entries), ([relation, entry]) => {
		const heading = headingOf(state.install.base, entry)
		return Arr.map(
			[
				...pageOf(heading, 1, "first"),
				...pageOf(heading, 1, "last"),
				...Arr.take(attachments(state.install.base, role, heading), 1),
				...Arr.take(reaches(heading), 1)
			],
			(via): Action => ({ kind: "read", session, relation, via })
		)
	})
	const vias: ReadonlyArray<ReadVia> = [
		{ kind: "compile" },
		...pageOf(spec === undefined ? [] : headingOf(state.install.base, spec), 0, "first"),
		...(row === undefined ? [] : [{ kind: "get" as const, key: keyOf(row) }]),
		...offKey
	]
	return [
		...Arr.map([first, ...rest, ...otherEntry(state, role)], (relation): Action => ({
			kind: "read",
			session,
			relation,
			via: { kind: "execute" }
		})),
		...Arr.map(vias, (via): Action => ({ kind: "read", session, relation: first, via })),
		...paths
	]
}

/** The facts an op through an entry tries in the box: its rows, and each choice of its heading's values. */
const entryFacts = (
	state: ModelState,
	writer: FactWriter,
	entry: string,
	spec: EntrySpec,
	scope: SmallScope
): ReadonlyArray<HostFact> => {
	const rows = Rec.has(writer.role.entries, entry)
		? entryRows(state, writer.role.name, entry, writer.facts)
		: []
	return uniqueFacts([
		...rows,
		...eachChoice(headingOf(state.install.base, spec), (f) => valuesFor(state, f.domain, scope))
	])
}

/**
 * The generated facts an insert through an entry tries in the box: each of its facts leaving out every classed serial
 * field of the entry (serialHead), each once, so a fact of no field is one where the entry carries serial fields only;
 * none for an entry with no classed serial field.
 */
const generatedFacts = (
	base: BaseSpec,
	role: RoleSpec,
	entry: string,
	facts: ReadonlyArray<HostFact>
): ReadonlyArray<HostFact> => {
	const written = writtenNamed(base, role, entry)
	const classed = written === undefined ? [] : serialHead(base, written).classed
	return classed.length === 0
		? []
		: uniqueFacts(Arr.map(facts, (f) => Rec.filter(f, (_, field) => !classed.includes(field))))
}

/**
 * The facts of an insert through an entry leaving out serial fields as grizzle refuses, which the box tries for its
 * aims: each of its facts without the entry's first classed serial field where it classes two or more, so some are left
 * out and not all, and without the first serial field its filter reads (serialHead).
 */
const omittingFacts = (
	base: BaseSpec,
	role: RoleSpec,
	entry: string,
	facts: ReadonlyArray<HostFact>
): ReadonlyArray<HostFact> => {
	const written = writtenNamed(base, role, entry)
	const { classed, filtered } =
		written === undefined ? { classed: [], filtered: [] } : serialHead(base, written)
	const omitted = [...(classed.length > 1 ? classed.slice(0, 1) : []), ...filtered.slice(0, 1)]
	return uniqueFacts(
		Arr.flatMap(omitted, (field) =>
			Arr.map(facts, (f) => Rec.filter(f, (_, name) => name !== field))
		)
	)
}

/** A contract field of a heading and the value just past its bounds; none for a heading without a contract. */
const refusedField = (
	heading: ReadonlyArray<FieldSpec>
): Option.Option<{ readonly at: FieldSpec; readonly outside: HostValue }> =>
	Option.flatMap(
		Arr.findFirst(heading, (f) => f.domain.kind === "contract"),
		(at) => Option.map(Arr.head(outsideContract(at.domain)), (outside) => ({ at, outside }))
	)

/**
 * A 16- or 32-bit integer field of a heading and the value just past its type's range, which grizzle's encoder refuses
 * before any SQL is sent; none for a heading without one.
 */
const unencodableField = (
	heading: ReadonlyArray<FieldSpec>
): Option.Option<{ readonly at: FieldSpec; readonly outside: HostValue }> =>
	Arr.findFirst(heading, (f) =>
		Option.map(Arr.head(pastType(f.domain)), (outside) => ({ at: f, outside }))
	)

/** The fact kinds an op can aim at, each once: the box keeps the first op of its candidates that the classifier confirms. */
const factAims = [
	"fact:law-broken",
	"fact:outside-world",
	"fact:hidden-key-collision",
	"fact:hidden-reference",
	"fact:deleted-reference",
	"fact:partial-serial",
	"fact:filtered-serial-omitted"
] as const

/**
 * The box's starts (DirectStart) besides a login's bare one: as the login setting the facts of a context it does not
 * read, which every context is (directClaims' unread facts for the transaction), or malformed claims; and as each of
 * the login's roles with no claims, with each live claims setting the box gives it (directClaims, its facts for the
 * transaction), and with malformed claims for the transaction.
 */
const directStarts = (
	state: ModelState,
	roles: ReadonlyArray<string>,
	scope: SmallScope
): ReadonlyArray<DirectStart> => {
	/** A login's setting sent with its BEGIN: facts it holds of some context, or malformed claims, for the transaction. */
	const loginSends = (setting: ClaimsSetting): boolean =>
		setting.scope === "transaction" &&
		(setting.kind === "malformed" || !Rec.isEmptyRecord(setting.facts))
	return [
		...Arr.flatMap(
			directClaims(state, Option.none(), scope),
			(setting): ReadonlyArray<DirectStart> =>
				loginSends(setting)
					? [{ current: { kind: "login" }, claims: { kind: "set", setting } }]
					: []
		),
		...Arr.flatMap(roles, (role): ReadonlyArray<DirectStart> => [
			{ current: { kind: "role", role }, claims: { kind: "none" } },
			...Arr.flatMap(
				directClaims(
					state,
					Arr.findFirst(state.install.roles, (r) => r.name === role),
					scope
				),
				(setting): ReadonlyArray<DirectStart> =>
					setting.scope === "transaction"
						? [{ current: { kind: "role", role }, claims: { kind: "set", setting } }]
						: []
			)
		])
	]
}

/**
 * The apply actions of a session in the box: each written entry's op kinds over its facts, one fact per op, one op per
 * fact kind (of its facts and of those leaving out serial fields as grizzle refuses, omittingFacts), inserts of its
 * generated facts, and inserts of a fact past a contract's bounds and past an integer type's range; and the role's
 * union and ordered writes.
 */
const applyActions = (
	state: ModelState,
	session: number,
	scope: SmallScope
): ReadonlyArray<Action> => {
	const db = roleAt(state, session)
	if (Option.isNone(db)) {
		const name = firstEntryName(state)
		return [
			{
				kind: "apply",
				session,
				strata: [[{ relation: name, kind: "delete", facts: [] }]],
				reads: []
			}
		]
	}
	const writer = db.value
	const role = writer.role
	const apply = (op: EntryOp): Action => ({ kind: "apply", session, strata: [[op]], reads: [] })
	const perEntry = Arr.flatMap(role.write, (entry) => {
		const spec = Rec.has(role.entries, entry) ? role.entries[entry] : undefined
		if (spec === undefined) {
			return []
		}
		const facts = entryFacts(state, writer, entry, spec, scope)
		const live = [
			...Arr.flatMap(facts, (f) =>
				Arr.map(["insert", "delete", "put"] as const, (kind): EntryOp => ({
					relation: entry,
					kind,
					facts: [f]
				}))
			),
			...Arr.map(generatedFacts(state.install.base, role, entry, facts), (f): EntryOp => ({
				relation: entry,
				kind: "insert",
				facts: [f]
			}))
		]
		const omitting = Arr.map(
			omittingFacts(state.install.base, role, entry, facts),
			(f): EntryOp => ({ relation: entry, kind: "insert", facts: [f] })
		)
		const aimed = Arr.flatMap(factAims, (aim) =>
			Arr.fromOption(
				Arr.findFirst(
					[...live, ...omitting],
					(op) => op.kind !== "delete" && opKinds(state, writer, [op]).includes(aim)
				)
			)
		)
		const [first] = facts
		const heading = headingOf(state.install.base, spec)
		const refused = refusedField(heading)
		const many: ReadonlyArray<EntryOp> =
			first === undefined
				? []
				: [
						{ relation: entry, kind: "insert", facts: [first, first] },
						...Arr.map(
							[...Arr.fromOption(refused), ...Arr.fromOption(unencodableField(heading))],
							({ at, outside }): EntryOp => ({
								relation: entry,
								kind: "insert",
								facts: [{ ...first, [at.name]: outside }]
							})
						)
					]
		return [...live, ...aimed, ...many]
	})
	const unwritten = Arr.map(
		Arr.filter(Rec.keys(role.entries), (e) => !role.write.includes(e)).slice(0, 1),
		(relation): EntryOp => ({ relation, kind: "insert", facts: [] })
	)
	const others = Arr.map(otherEntry(state, role), (relation): EntryOp => ({
		relation,
		kind: "insert",
		facts: []
	}))
	const singles = Arr.map(distinctOps([...perEntry, ...unwritten, ...others]), apply)
	const [firstOp] = perEntry
	const readBacks: ReadonlyArray<Action> =
		firstOp === undefined
			? []
			: [{ kind: "apply", session, strata: [[firstOp]], reads: Rec.keys(role.entries).slice(0, 2) }]
	return [
		...singles,
		...readBacks,
		...unionApplies(state, writer, session, scope),
		...orderedApplies(state, writer, session, scope)
	]
}

/** The first insert the box tries through an entry a writer's role holds: one fact of its first choices. */
const firstInsert = (
	state: ModelState,
	writer: FactWriter,
	scope: SmallScope,
	entry: string
): EntryOp | undefined => {
	const spec = Rec.has(writer.role.entries, entry) ? writer.role.entries[entry] : undefined
	const fact =
		spec === undefined
			? undefined
			: eachChoice(headingOf(state.install.base, spec), (f) => valuesFor(state, f.domain, scope))[0]
	return fact === undefined ? undefined : { relation: entry, kind: "insert", facts: [fact] }
}

/** The ordinary relations a written entry's rules read besides its own target; none for a whole entry. */
const readsBesides = (w: Written): ReadonlySet<string> =>
	new Set(
		w.kind === "whole"
			? []
			: Arr.flatMap(w.rules, (r) =>
					Arr.flatMap([...r.matches, ...r.negations.flat()], (o) =>
						o.source.kind === "ordinary" && o.source.name !== w.target ? [o.source.name] : []
					)
				)
	)

/**
 * The union of the box: the first inserts through the first two entries the role writes into different relations,
 * neither reading the other's, in one stratum, whose membership no order of the two decides; none for a role writing
 * no such pair.
 */
const unionApplies = (
	state: ModelState,
	writer: FactWriter,
	session: number,
	scope: SmallScope
): ReadonlyArray<Action> => {
	const written = writtenOf(state.install.base, writer.role)
	const pairs = Arr.flatMap(written, (a, i) =>
		Arr.flatMap(written.slice(i + 1), (b): ReadonlyArray<readonly [Written, Written]> =>
			a.target !== b.target && !readsBesides(a).has(b.target) && !readsBesides(b).has(a.target)
				? [[a, b]]
				: []
		)
	)
	return Arr.flatMap(Arr.take(pairs, 1), ([a, b]): ReadonlyArray<Action> => {
		const first = firstInsert(state, writer, scope, a.entry)
		const second = firstInsert(state, writer, scope, b.entry)
		return first === undefined || second === undefined
			? []
			: [{ kind: "apply", session, strata: [[first, second]], reads: [] }]
	})
}

/**
 * The ordered writes of the box: a query entry's insert beside an insert into a relation its filter reads, in one
 * stratum and sequenced both ways, for each such pair the role writes.
 */
const orderedApplies = (
	state: ModelState,
	writer: FactWriter,
	session: number,
	scope: SmallScope
): ReadonlyArray<Action> => {
	const written = writtenOf(state.install.base, writer.role)
	return Arr.flatMap(written, (e) => {
		if (e.kind !== "query") {
			return []
		}
		const reads = readsBesides(e)
		return Arr.flatMap(
			Arr.filter(written, (w) => w.entry !== e.entry && reads.has(w.target)),
			(w: Written): ReadonlyArray<Action> => {
				const a = firstInsert(state, writer, scope, e.entry)
				const b = firstInsert(state, writer, scope, w.entry)
				return a === undefined || b === undefined
					? []
					: [
							{ kind: "apply", session, strata: [[a, b]], reads: [] },
							{ kind: "apply", session, strata: [[a], [b]], reads: [] },
							{ kind: "apply", session, strata: [[b], [a]], reads: [] }
						]
			}
		)
	})
}

/** An op's identity in the box: its relation, kind and fact count, and its first four facts, each its atoms' count first. */
const opKey = (op: EntryOp): ValueIdentity => {
	const atoms: Array<Atom> = [op.relation, op.kind, op.facts.length]
	for (const fact of op.facts.slice(0, 4)) {
		const key = factKey(fact)
		atoms.push(key.length)
		appendAll(atoms, key)
	}
	return atoms
}

/** Ops, each once by its identity. */
const distinctOps = (ops: ReadonlyArray<EntryOp>): ReadonlyArray<EntryOp> => {
	const byKey = new TupleMap<ValueIdentity, EntryOp>()
	for (const op of ops) {
		byKey.set(opKey(op), op)
	}
	return [...byKey.values()]
}

/** The role refs a direct writer names in the box: each of its login's roles, then one of each invalid kind. */
const directRoleRefs = (state: ModelState, login: string): ReadonlyArray<RoleRef> => {
	const install = state.install
	const own = Option.getOrThrowWith(
		Arr.findFirst(install.logins, (l) => l.name === login),
		() => new Error(`the installation has no login ${login}`)
	).roles
	const other = Arr.flatMap(
		Arr.filter(install.logins, (l) => l.name !== login),
		(l: LoginSpec) => l.roles
	)
	return [
		...Arr.map(own, (role): RoleRef => ({ kind: "own", role })),
		...Arr.map(other.slice(0, 1), (role): RoleRef => ({ kind: "other-login", role })),
		...Arr.map(droppedNames(install).slice(0, 1), (role): RoleRef => ({ kind: "dropped", role })),
		{ kind: "nonexistent", name: nonexistentNames(install)[0] },
		{ kind: "owner" }
	]
}

/** A claimed field of the box, by its context, its name and its column in a choice's fact. */
interface ClaimSite {
	readonly context: string
	readonly field: string
	readonly at: string
}

/**
 * The claims settings a direct writer tries in the box, each once: each choice of its role's claims (another user's
 * among them) for the transaction, each other context its role reads alone, the first also for the session, malformed
 * claims at each scope, a claims document one of whose claims its field refuses (refusedClaimSettings, over every
 * context the role reads, past the box's scope too, so each field's refusal is a start), and a context its role does
 * not read; as its login, empty claims besides.
 */
const directClaims = (
	state: ModelState,
	role: Option.Option<RoleSpec>,
	scope: SmallScope
): ReadonlyArray<ClaimsSetting> => {
	const box = Option.map(role, (r) => claimsBox(state, r, scope))
	const contexts = Option.match(box, { onNone: () => [], onSome: (b) => b.contexts })
	const sites = Arr.map(
		Arr.flatMap(contexts, (c) => Arr.map(c.fields, (f) => ({ context: c.name, field: f.name }))),
		(site, i): ClaimSite => ({ ...site, at: `${i}` })
	)
	const factsOf = (fact: HostFact): ContextFacts =>
		Rec.fromEntries(
			Arr.map(
				contexts,
				(c) =>
					[
						c.name,
						Rec.fromEntries(
							Arr.flatMap(
								Arr.filter(sites, (site) => site.context === c.name),
								(site: ClaimSite): ReadonlyArray<readonly [string, HostValue]> => {
									const v = fact[site.at]
									return v === undefined ? [] : [[site.field, v]]
								}
							)
						)
					] as const
			)
		)
	const facts = Arr.map(Option.match(box, { onNone: () => [], onSome: (b) => b.facts }), factsOf)
	/**
	 * Each context the role reads alone, at each choice of its fields' values, but the one context the box's facts
	 * already claim alone: a setting that leaves out the other contexts, as a writer may (README "Security model"), so a
	 * write entry reading a left-out context holds nothing while another entry, reading only this one, holds its facts.
	 */
	const claimedAlone = contexts.length === 1 ? contexts : []
	const alone = Option.match(role, {
		onNone: (): ReadonlyArray<ClaimsSetting> => [],
		onSome: (r) =>
			Arr.flatMap(
				Arr.filter(
					contextsRead(state.install.base, r),
					(c) => !Arr.some(claimedAlone, (b) => b.name === c.name)
				),
				(c: ContextSpec) =>
					Arr.map(
						eachChoice(c.fields, (f) => valuesFor(state, f.domain, scope)),
						(fact): ClaimsSetting => ({
							kind: "facts",
							facts: { [c.name]: fact },
							scope: "transaction"
						})
					)
			)
	})
	const [first] = facts
	/**
	 * Every context the role reads, the box's and those past its scope alike: a context outside them all is one it does
	 * not read. The box's contexts alone would name a context past its scope, which `alone` already sets.
	 */
	const read = new Set(
		Arr.map(
			Option.match(role, { onNone: () => [], onSome: (r) => contextsRead(state.install.base, r) }),
			(c) => c.name
		)
	)
	const unread = Arr.filter(state.install.base.contexts, (c) => !read.has(c.name)).slice(0, 1)
	return [
		...Arr.map(facts, (f): ClaimsSetting => ({ kind: "facts", facts: f, scope: "transaction" })),
		...alone,
		...(first === undefined
			? []
			: [{ kind: "facts" as const, facts: first, scope: "session" as const }]),
		{ kind: "malformed", text: "{", scope: "transaction" },
		{ kind: "malformed", text: "{", scope: "session" },
		...Option.match(role, {
			onNone: (): ReadonlyArray<ClaimsSetting> => [],
			onSome: (r) => refusedClaimSettings(contextsRead(state.install.base, r), state.names.codes)
		}),
		...Arr.map(unread, (c): ClaimsSetting => ({
			kind: "facts",
			facts: {
				[c.name]: Rec.fromEntries(
					Arr.map(c.fields, (f) => [f.name, valuesFor(state, f.domain, scope)[0]] as const)
				)
			},
			scope: "transaction"
		})),
		...(Option.isNone(box)
			? [{ kind: "facts" as const, facts: {}, scope: "transaction" as const }]
			: [])
	]
}

/**
 * A value a field's domain refuses at its CHECK as a statement casts it, before row security and the row's
 * constraints: one past a contract's bounds, or a text its pattern refuses; none for a domain without a CHECK.
 */
const checkRefused = (domain: FieldDomain): Option.Option<HostValue> => {
	if (domain.kind === "contract") {
		return Arr.head(outsideContract(domain))
	}
	return domain.kind === "text"
		? Option.map(
				Arr.findFirst(patternEdges(domain), (e) => !e.admitted),
				(e) => e.value
			)
		: Option.none()
}

/** The values a transaction's view holds at a field of a relation, each once. */
const heldAt = (view: ReadonlyArray<HostFact>, field: string): ReadonlyArray<HostValue> =>
	distinctValues(Arr.flatMap(view, (fact) => Option.toArray(Option.fromUndefinedOr(fact[field]))))

/**
 * The reads of a direct writer's open transaction in the box: each role's views, unfiltered, and the first entry's
 * view raising on a pool value; each table, unfiltered, and the first raising on a pool value (`listed`); and the reads
 * that raise on a value the transaction's view holds, of the first heading field of each entry of the role it acts as
 * and of each relation's first field, so a row hidden from that role holds it (`added`).
 */
const boxReads = (
	state: ModelState,
	s: DirectSessionState,
	scope: SmallScope
): {
	readonly listed: ReadonlyArray<DirectStatement>
	readonly added: ReadonlyArray<DirectStatement>
} => {
	const base = state.install.base
	const current = s.current
	const role =
		current.kind === "role"
			? Arr.findFirst(state.install.roles, (r) => r.name === current.role)
			: Option.none()
	const relations = base.relations
	const viewOf = (relation: string): ReadonlyArray<HostFact> => nameableFacts(s.view, relation)
	return {
		listed: [
			...Arr.flatMap(state.install.roles, (r) =>
				Arr.map(Rec.keys(r.entries), (relation): DirectStatement => ({
					kind: "select-view",
					role: r.name,
					relation,
					filter: { kind: "none" }
				}))
			),
			...Arr.flatMap(state.install.roles.slice(0, 1), (r) =>
				Arr.flatMap(
					Rec.toEntries(r.entries).slice(0, 1),
					([relation, spec]): ReadonlyArray<DirectStatement> =>
						Arr.map(headingOf(base, spec).slice(0, 1), (f) => ({
							kind: "select-view",
							role: r.name,
							relation,
							filter: {
								kind: "raise-on",
								field: f.name,
								value: valuesFor(state, f.domain, scope)[0]
							}
						}))
				)
			),
			...Arr.map(relations, (r): DirectStatement => ({
				kind: "select-table",
				relation: r.name,
				filter: { kind: "none" }
			})),
			...Arr.flatMap(relations.slice(0, 1), (r) => {
				const [f] = r.fields
				return [
					{
						kind: "select-table" as const,
						relation: r.name,
						filter: {
							kind: "raise-on" as const,
							field: f.name,
							value: valuesFor(state, f.domain, scope)[0]
						}
					}
				]
			})
		],
		added: [
			...Option.match(role, {
				onNone: (): ReadonlyArray<DirectStatement> => [],
				onSome: (acting) =>
					Arr.flatMap(Rec.toEntries(acting.entries), ([relation, spec]) =>
						Arr.flatMap(headingOf(base, spec).slice(0, 1), (f) =>
							Arr.map(
								distinctValues(
									Arr.flatMap(relations, (r) =>
										Arr.flatMap(r.fields, (g) =>
											sameDomain(g.domain, f.domain) ? heldAt(viewOf(r.name), g.name) : []
										)
									)
								),
								(value): DirectStatement => ({
									kind: "select-view",
									role: acting.name,
									relation,
									filter: { kind: "raise-on", field: f.name, value }
								})
							)
						)
					)
			}),
			...Arr.flatMap(relations, (r) =>
				Arr.flatMap(r.fields.slice(0, 1), (f) =>
					Arr.map(heldAt(viewOf(r.name), f.name), (value): DirectStatement => ({
						kind: "select-table",
						relation: r.name,
						filter: { kind: "raise-on", field: f.name, value }
					}))
				)
			)
		]
	}
}

/**
 * The reads of a direct writer's open transaction the box offers (boxReads), each once, as enumerateKind offers its
 * statements: what a read after the transaction's write may show, without building the rest of its statements.
 */
export const enumerateDirectReads = (
	state: ModelState,
	session: number,
	scope: SmallScope
): ReadonlyArray<Action> => {
	const s = state.sessions[session]
	if (s?.kind !== "direct" || !applicable(state, "direct")) {
		return []
	}
	const { listed, added } = boxReads(state, s, scope)
	return Arr.filter(
		Arr.map(
			[
				...listed,
				...Arr.filter(
					Arr.dedupeWith(added, samePlain),
					(x) => !Arr.some(listed, (y) => samePlain(x, y))
				)
			],
			(statement): Action => ({ kind: "direct", session, statement })
		),
		(a) => namesOffered(state, a)
	)
}

/** The statements of a direct writer's open transaction in the box, each write over a base relation. */
const directStatements = (
	state: ModelState,
	session: number,
	scope: SmallScope
): ReadonlyArray<DirectStatement> => {
	const s = state.sessions[session]
	if (s?.kind !== "direct") {
		return [{ kind: "reset-role" }]
	}
	const base = state.install.base
	const current = s.current
	const role =
		current.kind === "role"
			? Arr.findFirst(state.install.roles, (r) => r.name === current.role)
			: Option.none()
	const refs = directRoleRefs(state, s.login)
	const relations = base.relations
	const viewOf = (relation: string): ReadonlyArray<HostFact> => nameableFacts(s.view, relation)
	const reads = boxReads(state, s, scope)
	const listed: ReadonlyArray<DirectStatement> = [
		...Arr.map(refs, (r): DirectStatement => ({ kind: "set-role", role: r })),
		{ kind: "reset-role" },
		...Arr.map(refs.slice(0, 1), (r): DirectStatement => ({
			kind: "set-session-authorization",
			role: r
		})),
		{ kind: "set-session-authorization", role: { kind: "owner" } },
		...Arr.map(directClaims(state, role, scope), (setting): DirectStatement => ({
			kind: "set-claims",
			setting
		})),
		...reads.listed,
		...Arr.flatMap(relations, (r) => {
			const [fact] = eachChoice(r.fields, (f) => valuesFor(state, f.domain, scope))
			return fact === undefined
				? []
				: Arr.map(["nothing", "select", "update"] as const, (onConflict): DirectStatement => ({
						kind: "insert-on-conflict",
						relation: r.name,
						fact,
						onConflict
					}))
		}),
		...Arr.flatMap(relations, (r) =>
			Arr.map(viewOf(r.name).slice(0, 1), (fact): DirectStatement => ({
				kind: "merge-delete",
				relation: r.name,
				keys: [keyOf(fact, r.key)]
			}))
		),
		{ kind: "prepare", name: "p0", read: { kind: "table", relation: relations[0].name } },
		...Arr.flatMap(state.install.roles.slice(0, 1), (r) =>
			Arr.map(Rec.keys(r.entries).slice(0, 1), (relation): DirectStatement => ({
				kind: "prepare",
				name: "p1",
				read: { kind: "view", role: r.name, relation }
			}))
		),
		...Arr.map([...new Set(["p0", ...Rec.keys(s.prepared)])], (name): DirectStatement => ({
			kind: "execute-prepared",
			name
		})),
		...Arr.flatMap(relations, (r) => {
			const [fact] = eachChoice(r.fields, (f) => valuesFor(state, f.domain, scope))
			return fact === undefined
				? []
				: Arr.map(Arr.fromOption(refusedField(r.fields)), ({ at, outside }): DirectStatement => ({
						kind: "insert",
						relation: r.name,
						fact: { ...fact, [at.name]: outside }
					}))
		}),
		...Arr.flatMap(relations, (r) =>
			Arr.map(
				eachChoice(r.fields, (f) => valuesFor(state, f.domain, scope)),
				(fact): DirectStatement => ({ kind: "insert", relation: r.name, fact })
			)
		),
		...Arr.flatMap(relations, (r) =>
			Arr.map(viewOf(r.name), (fact): DirectStatement => ({
				kind: "delete",
				relation: r.name,
				key: keyOf(fact, r.key)
			}))
		),
		...Arr.flatMap(relations, (r) =>
			Arr.flatMap(viewOf(r.name), (fact): ReadonlyArray<DirectStatement> => {
				const update = Option.flatMap(
					Arr.findFirst(r.fields, (f) => !r.key.includes(f.name)),
					(other) =>
						Option.map(
							Arr.findFirst(valuesFor(state, other.domain, scope), (v) => {
								const held = fact[other.name]
								return held === undefined || valueText(v) !== valueText(held)
							}),
							(changed): DirectStatement => ({
								kind: "update",
								relation: r.name,
								key: keyOf(fact, r.key),
								set: { [other.name]: changed }
							})
						)
				)
				return Arr.fromOption(update)
			})
		),
		...Arr.flatMap(relations, (r) => {
			const fixed = Option.match(role, {
				onNone: (): ReadonlyArray<string> => [],
				onSome: (spec) => {
					const written = writtenAt(base, spec, r.name)
					return written === undefined ? [] : claimFixedFields(written)
				}
			})
			return fixed.length === 0
				? []
				: Arr.map(viewOf(r.name).slice(0, 1), (fact): DirectStatement => ({
						kind: "update",
						relation: r.name,
						key: keyOf(fact, r.key),
						set: keyOf(fact, fixed)
					}))
		}),
		...Arr.map(relations, (r): DirectStatement => ({ kind: "truncate", relation: r.name })),
		...Arr.map(worldFunctionsOf(state), (fn): DirectStatement => ({
			kind: "call",
			fn,
			args: Arr.map(parametersOf(state, fn) ?? [], (domain) => valuesFor(state, domain, scope)[0])
		})),
		...Arr.flatMap(relations, (r) =>
			Arr.flatMap(r.fields, (f): ReadonlyArray<DirectStatement> =>
				f.domain.kind === "serial"
					? [
							{ kind: "setval", relation: r.name, field: f.name, value: 1 },
							{ kind: "setval", relation: r.name, field: f.name, value: scope.facts + 2 }
						]
					: []
			)
		)
	]
	/**
	 * Reads that raise on a value the transaction's view holds, of each relation's first field and of the first heading
	 * field of each entry of the role it acts as, so a row hidden from that role holds it; and inserts at each stored
	 * fact's key with a value its domain's CHECK refuses, which PostgreSQL refuses before row security looks at the row,
	 * whatever the role sees of the fact at that key: each statement the list above does not already hold.
	 */
	const added: ReadonlyArray<DirectStatement> = [
		...reads.added,
		...Arr.flatMap(relations, (r) =>
			Arr.flatMap(
				Arr.findFirst(r.fields, (f) =>
					r.key.includes(f.name)
						? Option.none()
						: Option.map(checkRefused(f.domain), (refused) => ({ field: f.name, refused }))
				).pipe(Option.toArray),
				({ field, refused }) =>
					Arr.map(viewOf(r.name), (fact): DirectStatement => ({
						kind: "insert",
						relation: r.name,
						fact: { ...fact, [field]: refused }
					}))
			)
		)
	]
	return [
		...listed,
		...Arr.filter(
			Arr.dedupeWith(added, samePlain),
			(x) => !Arr.some(listed, (y) => samePlain(x, y))
		)
	]
}

/** A fact's key fields. */
const keyOf = (fact: HostFact, key: ReadonlyArray<string>): HostFact =>
	Rec.fromEntries(
		Arr.flatMap(key, (k) => {
			const v = fact[k]
			return v === undefined ? [] : [[k, v] as const]
		})
	)

/** The box's actions of one kind in a state, before the state's offer (applicable, namesOffered) filters them. */
type KindBox = (state: ModelState, scope: SmallScope) => ReadonlyArray<Action>

/** Every session the state holds, whatever its kind: stale and mismatched handles are in the box. */
const sessionsOf = (state: ModelState): ReadonlyArray<number> => [...state.sessions.keys()]

/** The box's actions of each kind, in the order of the vocabulary (actionKinds). */
const boxKinds: { readonly [K in ActionKind]: KindBox } = {
	"open-db": openActions,
	read: (state) => Arr.flatMap(sessionsOf(state), (session) => readActions(state, session)),
	apply: (state, scope) =>
		Arr.flatMap(sessionsOf(state), (session) => applyActions(state, session, scope)),
	refresh: (state) =>
		Arr.flatMap(sessionsOf(state), (session) => {
			const relations = Option.match(roleAt(state, session), {
				onNone: () => [firstEntryName(state)],
				onSome: ({ role }) => [
					...role.refresh,
					...Arr.filter(Rec.keys(role.entries), (e) => !role.refresh.includes(e)).slice(0, 1),
					...otherEntry(state, role)
				]
			})
			return Arr.map(relations, (relation): Action => ({ kind: "refresh", session, relation }))
		}),
	close: (state) => Arr.map(sessionsOf(state), (session): Action => ({ kind: "close", session })),
	"direct-begin": (state, scope) =>
		Arr.flatMap(state.install.logins, (l) => [
			...Arr.map(
				["serializable", "repeatable read", "read committed", "read uncommitted"] as const,
				(isolation): Action => ({
					kind: "direct-begin",
					login: l.name,
					isolation,
					start: { current: { kind: "login" }, claims: { kind: "none" } }
				})
			),
			...Arr.map(directStarts(state, l.roles, scope), (start): Action => ({
				kind: "direct-begin",
				login: l.name,
				isolation: "serializable",
				start
			}))
		]),
	direct: (state, scope) =>
		Arr.flatMap(sessionsOf(state), (session) =>
			Arr.map(directStatements(state, session, scope), (statement): Action => ({
				kind: "direct",
				session,
				statement
			}))
		),
	"direct-end": (state) =>
		Arr.flatMap(sessionsOf(state), (session) =>
			Arr.map(["commit", "rollback"] as const, (end): Action => ({
				kind: "direct-end",
				session,
				end
			}))
		),
	interrupt: (state) =>
		Arr.map(sessionsOf(state), (session): Action => ({ kind: "interrupt", session })),
	migrate: (state, scope) => migrateActions(state, scope),
	tamper: (state) =>
		Arr.map(enumeratePerturbations(state), (perturbation): Action => ({
			kind: "tamper",
			perturbation
		})),
	drift: () => [{ kind: "drift" }],
	wild: (state) => [
		...Arr.map(WILD_KINDS, (wild): Action => ({ kind: "wild", at: { kind: "open-role" }, wild })),
		...Arr.map(state.install.roles, (r): Action => ({
			kind: "wild",
			at: { kind: "open-token", role: r.name },
			wild: "null"
		})),
		...Arr.flatMap(sessionsOf(state), (session) =>
			Arr.map(["read", "apply", "refresh"] as const, (call): Action => ({
				kind: "wild",
				at: { kind: "session", session, call },
				wild: "proxy"
			}))
		)
	]
}

/**
 * The actions of the exhaustive box of one kind in a state, as enumerateActions lists them: empty where the state does
 * not offer the kind, so a caller after some kinds builds only theirs.
 */
export const enumerateKind = (
	state: ModelState,
	kind: ActionKind,
	scope: SmallScope
): ReadonlyArray<Action> =>
	applicable(state, kind)
		? Arr.filter(boxKinds[kind](state, scope), (a) => namesOffered(state, a))
		: []

/**
 * Every action of the exhaustive box in a state, symmetry-reduced and duplicate-free: each live choice once (values a
 * uuid or text domain does not yet hold stand for each other, so one of them is tried; ordered values at the box pool
 * and the installation's literals), and each invalid input alone, one representative per kind, beside live values
 * everywhere else. Every session the state holds is named, whatever its kind, so stale and mismatched handles are in
 * the box; an op holds one fact (two for a duplicate, past the limit for the limit). The serial rule (no write, refresh,
 * migration or catalog change while a direct transaction is open) is kept, a harness invariant.
 */
export const enumerateActions = (state: ModelState, scope: SmallScope): ReadonlyArray<Action> =>
	Arr.flatMap(actionKinds, (kind) => enumerateKind(state, kind, scope))

/**
 * The migrations of the box: each installation of the box applied whole, the first other than the one the new folder
 * is drafted from (draftedFrom) half-applied (that one drafts a folder with nothing to stop in), the current one
 * hand-edited, the current one with each write-list defect grizzle refuses at build planted (plantedInstall), each
 * new law the data breaks, and each roster migration (rosterMigrations): a growth, a removal of a handle a stored fact
 * holds or none does, and a reorder.
 */
const migrateActions = (state: ModelState, scope: SmallScope): ReadonlyArray<Action> => {
	const installs = enumerateInstalls(state.install.base, scope)
	return [
		...Arr.map(installs, (to): Action => ({ kind: "migrate", to, how: "complete" })),
		...Arr.map(
			Arr.fromOption(Arr.findFirst(installs, (to) => !samePlain(to, draftedFrom(state)))),
			(to): Action => ({
				kind: "migrate",
				to,
				how: "half-applied"
			})
		),
		{ kind: "migrate", to: state.install, how: "hand-edited" },
		...Arr.map(plantedKinds, (kind): Action => ({
			kind: "migrate",
			to: plantedInstall(state.install, kind),
			how: "complete"
		})),
		...Arr.map(violatingLaws(state).slice(0, 2), (law): Action => ({
			kind: "migrate",
			to: {
				...state.install,
				base: { ...state.install.base, laws: [...state.install.base.laws, law] }
			},
			how: "complete"
		})),
		...Arr.map(rosterMigrations(state), (m): Action => ({ kind: "migrate", to: m.to, how: m.how }))
	]
}

/** Every combination of `size` items of a list, in the list's order. */
const combinations = <A>(
	items: ReadonlyArray<A>,
	size: number
): ReadonlyArray<ReadonlyArray<A>> => {
	if (size === 0) {
		return [[]]
	}
	return Arr.flatMap(items, (item, i) =>
		Arr.map(combinations(items.slice(i + 1), size - 1), (rest) => [item, ...rest])
	)
}

/** Every fact of a relation over the box pools of its fields. */
const boxFacts = (fields: ReadonlyArray<FieldSpec>, scope: SmallScope): ReadonlyArray<HostFact> =>
	Arr.reduce(fields, [{}], (facts: ReadonlyArray<HostFact>, f) =>
		Arr.flatMap(facts, (fact) =>
			Arr.map(boxPool(f.domain, scope), (v): HostFact => ({ ...fact, [f.name]: v }))
		)
	)

/** The literals a base states in its laws' selectors and its derived relations' rules: values no renaming may move. */
const baseLiterals = (base: BaseSpec): ReadonlySet<string> =>
	new Set(
		Arr.map(
			[
				...Arr.flatMap(base.laws, (law): ReadonlyArray<HostValue> => {
					switch (law.kind) {
						case "contained":
						case "covered":
							return [...Rec.values(law.source.where), ...Rec.values(law.target.where)]
						case "key":
						case "spanKey":
						case "check":
						case "alternatives":
							return []
					}
				}),
				...Arr.flatMap(base.derived, (d) => Arr.flatMap(d.rules, ruleLiterals))
			],
			valueText
		)
	)

/** One domain's renaming: its box values, and the values each moves to. */
interface Renaming {
	readonly domain: FieldDomain
	readonly from: ReadonlyArray<HostValue>
	readonly to: ReadonlyArray<HostValue>
}

/** Every permutation of a list. */
const permutations = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
	items.length <= 1
		? [items]
		: Arr.flatMap(items, (item, i) =>
				Arr.map(permutations([...items.slice(0, i), ...items.slice(i + 1)]), (rest) => [
					item,
					...rest
				])
			)

/**
 * The renamings of the base's interchangeable values in the box: per uuid or text domain whose box values the base
 * never states as a literal, every permutation of them; each renaming maps a field's value through its domain's.
 */
const renamings = (
	base: BaseSpec,
	scope: SmallScope
): ReadonlyArray<(domain: FieldDomain, v: HostValue) => HostValue> => {
	const literals = baseLiterals(base)
	const domains = [
		...new Map(
			Arr.map(
				Arr.filter(
					Arr.filter(
						Arr.flatMap(base.relations, (r) => Arr.map(r.fields, (f) => f.domain)),
						symmetric
					),
					(d) => Arr.every(boxPool(d, scope), (v) => !literals.has(valueText(v)))
				),
				(d) => [domainKey(d), d] as const
			)
		).values()
	]
	const perDomain = Arr.map(domains, (d) => {
		const box = boxPool(d, scope)
		return Arr.map(permutations(box), (perm) => ({ domain: d, from: box, to: perm }))
	})
	const none: ReadonlyArray<ReadonlyArray<Renaming>> = [[]]
	const choices = Arr.reduce(perDomain, none, (acc, options) =>
		Arr.flatMap(acc, (chosen) => Arr.map(options, (o): ReadonlyArray<Renaming> => [...chosen, o]))
	)
	return Arr.map(choices, (chosen) => (domain: FieldDomain, v: HostValue): HostValue => {
		const moved = Option.flatMap(
			Arr.findFirst(chosen, (c) => sameDomain(c.domain, domain)),
			(m) =>
				Option.flatMap(
					Arr.findFirstIndex(m.from, (x) => valueText(x) === valueText(v)),
					(at) => Arr.get(m.to, at)
				)
		)
		return Option.getOrElse(moved, () => v)
	})
}

/** Whether chosen facts hold one fact per primary key of each relation. */
const keyed = (
	chosen: ReadonlyArray<{ readonly relation: RelationSpec; readonly fact: HostFact }>
): boolean => {
	const keys = Arr.map(
		chosen,
		(c) => `${c.relation.name}\u0000${projection(c.fact, c.relation.key)}`
	)
	return new Set(keys).size === keys.length
}

/**
 * Every lawful reality of the box: at most `scope.facts` facts over the box pools (uuids and texts cut to
 * `scope.subjects` values), one per primary key, each kept when the host law model finds no law violated, and each
 * once up to a renaming of interchangeable values (the canonical form is the least of the renamings' sorted rows).
 */
export const enumerateRealities = (
	base: BaseSpec,
	host: HostSchema,
	scope: SmallScope
): ReadonlyArray<HostState> => {
	const relations = Arr.flatMap(host.relations, (h) =>
		Arr.fromOption(Arr.findFirst(base.relations, (r) => r.name === h.name))
	)
	const candidates = Arr.flatMap(relations, (r) =>
		Arr.map(boxFacts(r.fields, scope), (fact) => ({ relation: r, fact }))
	)
	const renames = renamings(base, scope)
	const stateOf = (
		chosen: ReadonlyArray<{ readonly relation: RelationSpec; readonly fact: HostFact }>
	): HostState =>
		new Map(
			Arr.map(host.relations, (h) => [
				h.name,
				Arr.map(
					Arr.filter(chosen, (c) => c.relation.name === h.name),
					(c) => c.fact
				)
			])
		)
	const subsets: ReadonlyArray<
		ReadonlyArray<{ readonly relation: RelationSpec; readonly fact: HostFact }>
	> = Arr.flatMap(Arr.range(0, scope.facts), (size: number) => combinations(candidates, size))
	const states: ReadonlyArray<HostState> = Arr.map(Arr.filter(subsets, keyed), stateOf)
	const lawful = Arr.filter(states, (state: HostState) => violations(host, state).length === 0)
	const domainOf = (relation: string, field: string): Option.Option<FieldDomain> =>
		Option.flatMap(
			Arr.findFirst(relations, (r) => r.name === relation),
			(spec) =>
				Option.map(
					Arr.findFirst(spec.fields, (x) => x.name === field),
					(x) => x.domain
				)
		)
	const renamed = (
		state: HostState,
		rename: (domain: FieldDomain, v: HostValue) => HostValue
	): StateRows =>
		sortedStateRows(
			host,
			new Map(
				Arr.map(host.relations, (h) => [
					h.name,
					Arr.map(state.get(h.name) ?? [], (f): HostFact =>
						Rec.fromEntries(
							Arr.map(
								Rec.toEntries(f),
								([k, v]) =>
									[
										k,
										Option.match(domainOf(h.name, k), {
											onNone: () => v,
											onSome: (d) => rename(d, v)
										})
									] as const
							)
						)
					)
				])
			)
		)
	const canonical = (state: HostState): StateRows =>
		Arr.reduce(
			Arr.map(renames, (rename) => renamed(state, rename)),
			sortedStateRows(host, state),
			Order.min(sortedRowsOrder)
		)
	const canonicals: ReadonlyArray<{ readonly state: HostState; readonly rows: StateRows }> =
		Arr.map(lawful, (state) => ({ state, rows: canonical(state) }))
	return Arr.map(
		Arr.dedupeWith(canonicals, (a, b) => sortedRowsOrder(a.rows, b.rows) === 0),
		(x) => x.state
	)
}

/** A shape's variable for a field. */
const v = (f: string): Term => ({ kind: "var", name: `v_${f}` })

/** A rule of a shape: its matches, head and negations, no comparison. */
const rule = (
	matches: Arr.NonEmptyReadonlyArray<Occurrence>,
	head: Readonly<Record<string, Term>>,
	negations: Rule["negations"]
): Rule => ({
	matches,
	negations,
	comparisons: [],
	head
})

/** A whole entry over a relation, under its name. */
const whole = (r: string): readonly [string, EntrySpec] => [r, { kind: "whole", relation: r }]

/** A query entry's shape in the box. */
type Shape = "whole" | "claimed" | "fixed" | "exists" | "union" | "negated"

/** The query entry of a shape over an ordinary relation, or none when the relation offers the shape nothing. */
const shaped = (
	base: BaseSpec,
	relation: string,
	shape: Exclude<Shape, "whole">,
	scope: SmallScope
): EntrySpec | undefined => {
	const fields = fieldsOfSource(base, relation)
	const spec = Arr.findFirst(base.relations, (r) => r.name === relation)
	const all = Rec.fromEntries(Arr.map(fields, (f) => [f.name, v(f.name)] as const))
	const occurrence = (fieldsOf: Readonly<Record<string, Term>>): Occurrence => ({
		source: { kind: "ordinary", name: relation },
		fields: fieldsOf
	})
	const link = Arr.flatMap(
		Arr.filter(base.relations, (r) => r.name !== relation),
		(r: RelationSpec) =>
			Arr.flatMap(r.fields, (g: FieldSpec) =>
				Arr.map(
					Arr.filter(fields, (f) => sameDomain(f.domain, g.domain)),
					(f: FieldSpec) => ({ from: f.name, relation: r.name, to: g.name })
				)
			)
	).at(0)
	switch (shape) {
		case "claimed": {
			const contexts = base.contexts.slice(0, Math.max(1, scope.contexts))
			const claims = Arr.flatMap(fields, (f) => {
				const site = Arr.flatMap(contexts, (c) =>
					Arr.map(
						Arr.filter(c.fields, (g) => sameDomain(g.domain, f.domain)),
						(g) => ({ context: c.name, field: g.name })
					)
				).at(0)
				return site === undefined ? [] : [{ field: f.name, site }]
			})
			const [claim] = claims
			if (claim === undefined) {
				return undefined
			}
			const head = Rec.fromEntries(
				Arr.map(
					Arr.filter(fields, (f) => f.name !== claim.field),
					(f) => [f.name, v(f.name)] as const
				)
			)
			const headOrClaimed = Rec.keys(head).length > 0 ? head : { [claim.field]: v(claim.field) }
			return {
				kind: "query",
				rules: [
					rule(
						[
							occurrence(all),
							{
								source: { kind: "context", name: claim.site.context },
								fields: { [claim.site.field]: v(claim.field) }
							}
						],
						headOrClaimed,
						[]
					)
				]
			}
		}
		case "fixed": {
			const found = Option.flatMap(spec, (sp) =>
				Arr.findFirst(fields, (f) => !sp.key.includes(f.name))
			)
			if (Option.isNone(found)) {
				return undefined
			}
			const free = found.value
			const fixedFields = {
				...all,
				[free.name]: { kind: "literal" as const, value: valuesForBase(free.domain, scope) }
			}
			return {
				kind: "query",
				rules: [
					rule(
						[occurrence(fixedFields)],
						Rec.fromEntries(
							Arr.map(
								Arr.filter(fields, (f) => f.name !== free.name),
								(f) => [f.name, v(f.name)] as const
							)
						),
						[]
					)
				]
			}
		}
		case "exists":
		case "union":
		case "negated": {
			if (link === undefined) {
				return undefined
			}
			const other: Occurrence = {
				source: { kind: "ordinary", name: link.relation },
				fields: { [link.to]: v(link.from) }
			}
			if (shape === "negated") {
				return { kind: "query", rules: [rule([occurrence(all)], all, [[other]])] }
			}
			const filtered = rule([occurrence(all), other], all, [])
			if (shape === "exists") {
				return { kind: "query", rules: [filtered] }
			}
			return scope.rules < 2
				? undefined
				: { kind: "query", rules: [filtered, rule([occurrence(all)], all, [])] }
		}
	}
}

/** The first box value of a domain, a literal a fixed field takes. */
const valuesForBase = (domain: FieldDomain, scope: SmallScope): HostValue =>
	boxPool(domain, scope)[0]

/** A role holding entries, writing each writable one (the first per relation). */
const roleWith = (
	base: BaseSpec,
	name: string,
	entries: ReadonlyArray<readonly [string, EntrySpec]>
): RoleSpec => {
	const targets = new Set<string>()
	const write = Arr.flatMap(entries, ([entry, spec]) => {
		const c = classifyEntry(base, spec)
		if (c.kind !== "writable" || targets.has(c.target)) {
			return []
		}
		targets.add(c.target)
		return [entry]
	})
	return { name, entries: Rec.fromEntries(entries), write, refresh: [] }
}

/**
 * The installations of the box, each choice once: the first `scope.relations` relations held whole by one role that
 * writes them all; then each relation in turn absent or as each query shape the box knows (a claimed field, a field
 * fixed to a literal, a match of a linked relation, a union of two rules, a negation), the rest whole; and the whole
 * role joined by a second, full role in the same login or in a second one.
 */
export const enumerateInstalls = (
	base: BaseSpec,
	scope: SmallScope
): ReadonlyArray<InstallSpec> => {
	const relations = Arr.map(base.relations.slice(0, Math.max(1, scope.relations)), (r) => r.name)
	const shapes: ReadonlyArray<Exclude<Shape, "whole">> = [
		"claimed",
		"fixed",
		"exists",
		"union",
		"negated"
	]
	const single = (
		entries: ReadonlyArray<readonly [string, EntrySpec]>
	): InstallSpec | undefined => {
		const [first, ...rest] = entries
		if (first === undefined) {
			return undefined
		}
		const role = roleWith(base, "alpha", [first, ...rest])
		return { base, roles: [role], logins: [{ name: "web", roles: [role.name] }] }
	}
	const variants = Arr.flatMap(relations, (r) => [
		Arr.map(
			Arr.filter(relations, (x) => x !== r),
			whole
		),
		...Arr.flatMap(shapes, (shape) => {
			const entry = shaped(base, r, shape, scope)
			return entry === undefined
				? []
				: [
						[
							...Arr.map(
								Arr.filter(relations, (x) => x !== r),
								whole
							),
							[`View${shape}`, entry] as const
						]
					]
		})
	])
	const allWhole = Arr.map(relations, whole)
	const full = roleWith(
		base,
		"beta",
		Arr.map(base.relations, (r) => whole(r.name))
	)
	const alpha = roleWith(base, "alpha", allWhole)
	return [
		...Arr.flatMap([allWhole, ...variants], (entries) => {
			const install = single(entries)
			return install === undefined ? [] : [install]
		}),
		{ base, roles: [alpha, full], logins: [{ name: "web", roles: [alpha.name, full.name] }] },
		{
			base,
			roles: [alpha, full],
			logins: [
				{ name: "web", roles: [alpha.name] },
				{ name: "ops", roles: [full.name] }
			]
		}
	]
}

/** One step of a trail the box replays: an action, and the index of the branch of it the model took. */
export interface BoxStep {
	readonly action: Action
	readonly branch: number
}

/** A transition of the box: the start it is reached from, the trail that first reached its state, and its action. */
export interface BoxTransition {
	readonly start: number
	readonly trail: ReadonlyArray<BoxStep>
	readonly action: Action
}

/** The box within its room, or past it: past it nothing is kept, so the box is never built whole. */
export type Box =
	| { readonly kind: "within"; readonly transitions: ReadonlyArray<BoxTransition> }
	| { readonly kind: "past" }

/**
 * What the model tells apart of one action's outcome: its observation's kind, refined by what names a refusal (a stage,
 * a SQLSTATE, a law and whether its witness shows, a reason, a relation), whether rows or drift are empty, and an
 * apply's verdict.
 */
const outcomeClass = (o: ActionOutcome): string => {
	switch (o.kind) {
		case "open-refused":
			return `${o.kind} ${o.stage} ${o.verifyCalls}`
		case "opened":
			return `${o.kind} ${o.verifyCalls}`
		case "rows":
			return `${o.kind} ${o.rows.length === 0 ? "none" : "some"}`
		case "applied":
			return `${o.kind} ${o.outcome}`
		case "invariant-rejected":
			return `${o.kind} ${o.law} ${o.witness.kind}`
		case "law-refused":
			return `${o.kind} ${o.sqlstate} ${o.law} ${o.witness.kind}`
		case "refused":
			return `${o.kind} ${o.sqlstate}`
		case "migration-refused":
			return `${o.kind} ${o.stage}`
		case "stale-snapshot":
			return `${o.kind} ${o.reason}`
		case "transient":
			return `${o.kind} ${o.reason}`
		case "outside-world":
			return `${o.kind} ${o.relation}`
		case "drift":
			return `${o.kind} ${o.objects.length === 0 ? "none" : "some"}`
		case "encoding-refused":
		case "compile-refused":
		case "resource-bound":
		case "commit-unknown":
		case "interrupted":
		case "handle-refused":
		case "ok":
			return o.kind
	}
}

/**
 * Every transition of the exhaustive box from its starts, one per equivalence class (the small-scope hypothesis): a
 * breadth-first search over the model's `step`, each state (by its canonical form) once from the shortest trail that
 * reached it, a state at depth d offering its actions while d < scope.depth. An action's class is its kind, the invalid
 * kinds it carries (invalidKindsOf), and, over every branch the model allows it, what the model tells apart of its
 * outcome (outcomeClass) and the features `situation` reads of it (the suite's feature map): two actions alike in all
 * of these are one class, wherever they are taken, so the first is the class's representative transition and the
 * search goes on only from its successors. Every class the search meets is checked once. The search stops the moment it
 * passes `room` transitions.
 */
export const exploreBox = (
	starts: ReadonlyArray<ModelState>,
	scope: SmallScope,
	room: number,
	situation: (
		state: ModelState,
		action: Action,
		observation: ActionOutcome
	) => ReadonlyArray<string>
): Box => {
	const classes = new Set<string>()
	const transitions: Array<BoxTransition> = []
	const canonicalOf = canonicalForms()
	for (const [start, state] of starts.entries()) {
		const seen = new TupleSet<ValueIdentity>().add(canonicalOf(state))
		let frontier: ReadonlyArray<{
			readonly state: ModelState
			readonly trail: ReadonlyArray<BoxStep>
		}> = [{ state, trail: [] }]
		for (let depth = 0; depth < scope.depth; depth++) {
			const next: Array<{ readonly state: ModelState; readonly trail: ReadonlyArray<BoxStep> }> = []
			for (const node of frontier) {
				for (const action of enumerateActions(node.state, scope)) {
					const branches = step(node.state, action)
					const traits = new Set(
						Arr.flatMap(branches, (b) => [
							outcomeClass(b.observation),
							...situation(node.state, action, b.observation)
						])
					)
					const key = Arr.join(
						[
							action.kind,
							...Arr.sort(invalidKindsOf(node.state, action), Order.String),
							"|",
							...Arr.sort([...traits], Order.String)
						],
						"\u0000"
					)
					if (classes.has(key)) {
						continue
					}
					classes.add(key)
					if (transitions.length === room) {
						return { kind: "past" }
					}
					transitions.push({ start, trail: node.trail, action })
					if (depth + 1 < scope.depth) {
						for (const [branch, s] of branches.entries()) {
							/** A landing completes under the compiler's names for its installation: the box runs no executor. */
							const b = settle(s, installedNames)
							const at = canonicalOf(b.next)
							if (!seen.has(at)) {
								seen.add(at)
								next.push({ state: b.next, trail: [...node.trail, { action, branch }] })
							}
						}
					}
				}
			}
			frontier = next
		}
	}
	return { kind: "within", transitions }
}
