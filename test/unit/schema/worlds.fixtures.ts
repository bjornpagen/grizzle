/** What the properties of worlds.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import {
	array,
	boolean,
	codePoint,
	type Gen,
	int,
	shuffled,
	string,
	subarray,
	uniqueKeys,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { LoginRule, RoleRule } from "#compiler/core/causes.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, derived, relation, schema } from "#compiler/public/schema.ts"
import {
	type OrderedValue,
	queryOver,
	type QueryValue,
	queryValueDesc,
	varsOver
} from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { admitRole } from "#compiler/schema/world.ts"
import { buildSchema } from "#test/pg/derived/oracle/gen.ts"
import { defined, nonEmpty } from "#test/support/assert.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { fieldSketchGen, pgField, type SketchedField } from "#test/unit/schema/field-sketch.ts"
import { rawClosedId, regex } from "#test/unit/schema/support.ts"

const Kind = closed.ordered("Kind", ["Draft", "Live"])

const Author = regex("^user_[a-z]{1,8}$", "u")

export const Post = relation(
	"Post",
	{ id: uuid, author: Author, kind: rawClosedId(Kind), words: pg.integer },
	["id"]
)

export const Note = relation("Note", { id: uuid, post: uuid }, ["id"])

const Doc = relation("Doc", { id: uuid, a: pg.vector(3), b: pg.vector(3) }, ["id"])

const Blog = schema("Blog", [Kind, Post, Note, Doc], [])

const Counts = derived.materialized(
	"Counts",
	query(Blog).rule((r) => {
		const { id, author } = v(Post, "post")
		return r.match(Post, { id, author }).find({ author, posts: r.count() })
	})
)

export const Reports = schema.extend(Blog, "Reports", [Counts], [])

const Stray = relation("Stray", { id: uuid }, ["id"])

export const Other = schema("Other", [Kind, Post, Stray], [])

/** The base's relations by name, and the ordinary ones a role may write, each with its fields and its key. */
const baseRelations = Reports.relations

type BaseName = keyof typeof baseRelations

const baseNames: Arr.NonEmptyReadonlyArray<BaseName> = nonEmpty(
	Rec.keys(baseRelations),
	"the base's relations"
)

const ordinaries = {
	Post: { value: Post, key: ["id"], fields: Rec.keys(Post.fields) },
	Note: { value: Note, key: ["id"], fields: Rec.keys(Note.fields) },
	Doc: { value: Doc, key: ["id"], fields: Rec.keys(Doc.fields) }
} as const

type Ordinary = keyof typeof ordinaries

const ordinaryNames: Arr.NonEmptyReadonlyArray<Ordinary> = nonEmpty(
	Rec.keys(ordinaries),
	"the base's ordinary relations"
)

const isOrdinary = (name: string): name is Ordinary => Arr.some(ordinaryNames, (n) => n === name)

const kindOfBase = (name: BaseName): "closed" | "relation" | "derived" => baseRelations[name].kind

/**
 * A role entry as a case states it: a whole relation of the base, or of another schema, under a name; a query over an
 * ordinary relation finding its fields but `omit`; a query over another schema; a query over the base reading a
 * relation the base lacks; a query reading a parameter, attaching, searching approximately, or ordered.
 */
type EntrySpec =
	| { readonly kind: "whole"; readonly relation: BaseName }
	| { readonly kind: "stray" }
	| { readonly kind: "view"; readonly relation: Ordinary; readonly omit: ReadonlyArray<string> }
	| { readonly kind: "over another"; readonly relation: "Kind" | "Post" }
	| { readonly kind: "outside" }
	| {
			readonly kind: "parameter"
			readonly relation: Ordinary
			readonly field: string
			readonly parameter: string
	  }
	| { readonly kind: "attach"; readonly relation: Ordinary }
	| { readonly kind: "nearest"; readonly take: number }
	| { readonly kind: "ordered"; readonly relation: Ordinary; readonly descending: boolean }

interface RoleSpec {
	readonly entries: ReadonlyArray<readonly [string, EntrySpec]>
	readonly write: ReadonlyArray<string>
	readonly refresh: ReadonlyArray<string>
}

/** A query over `relation` matching every field and finding all but `omit`. */
const viewOver = (relation: Ordinary, omit: ReadonlyArray<string>) => {
	const r = ordinaries[relation]
	return queryOver(Reports).rule((rule: RuleValue) => {
		const vars = varsOver(r.value, "view")
		return rule
			.match(r.value, vars)
			.find(Rec.filter(vars, (_, field) => !Arr.contains(omit, field)))
	})
}

/** The value a role entry is. */
const entryValue = (spec: EntrySpec): unknown => {
	switch (spec.kind) {
		case "whole":
			return baseRelations[spec.relation]
		case "stray":
			return Stray
		case "view":
			return viewOver(spec.relation, spec.omit)
		case "over another": {
			const read = spec.relation === "Kind" ? Kind : Post
			return queryOver(Other).rule((r: RuleValue) => {
				const vars = varsOver(read, "other")
				return r.match(read, vars).find(vars)
			})
		}
		case "outside":
			return queryOver(Reports).rule((r: RuleValue) => {
				const vars = varsOver(Stray, "stray")
				return r.match(Stray, vars).find(vars)
			})
		case "parameter": {
			const r = ordinaries[spec.relation]
			return queryOver(Reports).rule((rule: RuleValue) => {
				const vars = varsOver(r.value, "read")
				const fields: Readonly<Record<string, unknown>> = r.value.fields
				const field = defined(Option.getOrUndefined(Rec.get(fields, spec.field)))
				return rule
					.match(r.value, { ...vars, [spec.field]: rule.param(spec.parameter, field) })
					.find(Rec.filter(vars, (_, f) => f !== spec.field))
			})
		}
		case "attach": {
			const r = ordinaries[spec.relation]
			return queryOver(Reports)
				.rule((rule: RuleValue) => {
					const vars = varsOver(r.value, "parent")
					return rule.match(r.value, { id: vars["id"] }).find({ id: vars["id"] })
				})
				.attach(
					"notes",
					(parent: Readonly<Record<string, unknown>>) =>
						queryOver(Reports).rule((rule: RuleValue) => {
							const vars = varsOver(Note, "note")
							return rule
								.match(Note, { id: vars["id"], post: parent["id"] })
								.find({ id: vars["id"] })
						}),
					"array"
				)
		}
		case "nearest":
			return queryOver(Reports)
				.rule((rule: RuleValue) => {
					const vars = varsOver(Doc, "doc")
					return rule.match(Doc, vars).find({
						id: vars["id"],
						distance: computeCore.cosineDistance(vars["a"], vars["b"])
					})
				})
				.approximateNearest({ by: "distance", take: spec.take })
		case "ordered":
			return viewOver(spec.relation, []).orderBy(["id", spec.descending ? "desc" : "asc"])
	}
}

/**
 * The entry of a description, where one can state it: a whole entry is its name, so one under another name has none,
 * and a query entry is its Description, which carries no schema it was built over.
 */
const plantedLoc = SourceLoc("a planted role", [])

const entryDesc = (name: string, spec: EntrySpec): Option.Option<unknown> => {
	switch (spec.kind) {
		case "whole":
			return name === spec.relation
				? Option.some({ kind: "whole", name, loc: plantedLoc })
				: Option.none()
		case "stray":
		case "over another":
			return Option.none()
		case "view":
		case "outside":
		case "parameter":
		case "attach":
		case "nearest":
		case "ordered":
			return Option.some({
				kind: "world",
				name,
				query: queryValueDesc(entryValue(spec)),
				loc: plantedLoc
			})
	}
}

/** The healthy role: drawn whole entries, writable views of drawn ordinary relations, and what it writes and refreshes. */
const healthyGen: Gen<RoleSpec> = (source) => {
	const candidates: Arr.NonEmptyReadonlyArray<readonly [string, EntrySpec]> = [
		...Arr.map(baseNames, (relation): readonly [string, EntrySpec] => [
			relation,
			{ kind: "whole", relation }
		]),
		...Arr.map(ordinaryNames, (relation): readonly [string, EntrySpec] => [
			`${relation}View`,
			{ kind: "view", relation, omit: [] }
		])
	]
	const entries = source.draw(shuffled(candidates, { min: 1, max: candidates.length }))
	const wholes = Arr.flatMap(entries, ([, e]) => (e.kind === "whole" ? [e.relation] : []))
	const views = Arr.flatMap(entries, ([, e]) => (e.kind === "view" ? [e.relation] : []))
	const write = Arr.flatMap(ordinaryNames, (relation) => {
		const writers = [
			...(Arr.contains(wholes, relation) ? [relation] : []),
			...(Arr.contains(views, relation) ? [`${relation}View`] : [])
		]
		const at = source.draw(int(0, writers.length))
		return at === writers.length ? [] : [defined(writers[at])]
	})
	const refresh = source.draw(subarray(Arr.filter(wholes, (w) => kindOfBase(w) === "derived")))
	return { entries, write, refresh }
}

/** A defect a case plants, each with its drawn target. */
type Defect =
	| { readonly kind: "none" }
	| { readonly kind: "wholeEntryName"; readonly relation: BaseName }
	| { readonly kind: "wholeEntryUndeclared" }
	| { readonly kind: "entryOverAnother"; readonly relation: "Kind" | "Post" }
	| { readonly kind: "entryOutsideBase" }
	| {
			readonly kind: "entryParameters"
			readonly relation: Ordinary
			readonly field: number
			readonly parameter: number
	  }
	| { readonly kind: "entryAttaches"; readonly relation: Ordinary }
	| { readonly kind: "entryApproximate"; readonly take: number }
	| { readonly kind: "entryOrdered"; readonly relation: Ordinary; readonly descending: boolean }
	| { readonly kind: "writeOutside"; readonly name: number }
	| { readonly kind: "writeKind"; readonly derived: boolean }
	| { readonly kind: "writeUnwritable"; readonly relation: Ordinary; readonly omit: number }
	| { readonly kind: "writeTwice"; readonly relation: Ordinary; readonly wholeFirst: boolean }
	| { readonly kind: "refreshOutside"; readonly name: number }
	| { readonly kind: "refreshKind"; readonly target: number }

const ordinaryGen: Gen<Ordinary> = (source) =>
	Arr.getUnsafe(ordinaryNames, source.draw(int(0, ordinaryNames.length - 1)))

const defectGen: Gen<Defect> = weighted<Defect>([
	[3, (): Defect => ({ kind: "none" })],
	[
		1,
		(s) => ({
			kind: "wholeEntryName",
			relation: Arr.getUnsafe(baseNames, s.draw(int(0, baseNames.length - 1)))
		})
	],
	[1, (): Defect => ({ kind: "wholeEntryUndeclared" })],
	[1, (s) => ({ kind: "entryOverAnother", relation: s.draw(boolean) ? "Post" : "Kind" })],
	[1, (): Defect => ({ kind: "entryOutsideBase" })],
	[
		1,
		(s) => ({
			kind: "entryParameters",
			relation: s.draw(ordinaryGen),
			field: s.draw(pickGen),
			parameter: s.draw(int(0, 9))
		})
	],
	[1, (s) => ({ kind: "entryAttaches", relation: s.draw(ordinaryGen) })],
	[1, (s) => ({ kind: "entryApproximate", take: s.draw(int(1, 5)) })],
	[
		1,
		(s) => ({ kind: "entryOrdered", relation: s.draw(ordinaryGen), descending: s.draw(boolean) })
	],
	[1, (s) => ({ kind: "writeOutside", name: s.draw(int(0, 9)) })],
	[1, (s) => ({ kind: "writeKind", derived: s.draw(boolean) })],
	[1, (s) => ({ kind: "writeUnwritable", relation: s.draw(ordinaryGen), omit: s.draw(int(1, 7)) })],
	[1, (s) => ({ kind: "writeTwice", relation: s.draw(ordinaryGen), wholeFirst: s.draw(boolean) })],
	[1, (s) => ({ kind: "refreshOutside", name: s.draw(int(0, 9)) })],
	[1, (s) => ({ kind: "refreshKind", target: s.draw(pickGen) })]
])

/** A rule as a case states it: an unwritable entry's reason is the writable-entry suite's, so only its entry. */
type StatedRule =
	| Exclude<RoleRule, { readonly kind: "writeUnwritable" }>
	| { readonly kind: "writeUnwritable"; readonly entry: string }

/** What a refusal states, as a case states it: a role rule, or a rule the types name too, by its refusal. */
type Stated =
	| { readonly kind: "rule"; readonly rule: StatedRule }
	| { readonly kind: "named"; readonly refusal: Refused }

/** The defects that break a rule the types name too, which role refuses as Refused. */
type NamedDefect = "wholeEntryName" | "wholeEntryUndeclared" | "entryOverAnother"

/** What a planted defect breaks: the feature it reaches, and what the refusal states. */
interface Broken {
	readonly feature: RoleRule["kind"] | NamedDefect
	readonly stated: Stated
}

/** A role case: its healthy spec, the planted spec, and what the planted defect breaks. */
interface RoleCase {
	readonly healthy: RoleSpec
	readonly planted: RoleSpec
	readonly broken: Option.Option<Broken>
}

/** The spec with `name` entered as `entry`, replacing an entry of that name. */
const entered = (spec: RoleSpec, name: string, entry: EntrySpec): RoleSpec => ({
	...spec,
	entries: [...Arr.filter(spec.entries, ([n]) => n !== name), [name, entry]]
})

/** The base relation an entry writes, where it writes one. */
const writesRelation = (spec: RoleSpec, name: string): Option.Option<string> =>
	Option.flatMap(
		Arr.findFirst(spec.entries, ([n]) => n === name),
		([, entry]) =>
			entry.kind === "whole"
				? Option.some<string>(entry.relation)
				: entry.kind === "view"
					? Option.some<string>(entry.relation)
					: Option.none()
	)

/** The planted spec and the rule it breaks: the defect's own, with the fields the rule names. */
const plant = (healthy: RoleSpec, defect: Defect): RoleCase => {
	const of = (planted: RoleSpec, rule: StatedRule): RoleCase => ({
		healthy,
		planted,
		broken: Option.some({ feature: rule.kind, stated: { kind: "rule", rule } })
	})
	const named = (planted: RoleSpec, feature: NamedDefect, refusal: Refused): RoleCase => ({
		healthy,
		planted,
		broken: Option.some({ feature, stated: { kind: "named", refusal } })
	})
	const wholeRefusal: Refused = "a whole entry is a relation of the base under its own name"
	switch (defect.kind) {
		case "none":
			return { healthy, planted: healthy, broken: Option.none() }
		case "wholeEntryName":
			return named(
				entered(healthy, `${defect.relation}Twin`, { kind: "whole", relation: defect.relation }),
				"wholeEntryName",
				wholeRefusal
			)
		case "wholeEntryUndeclared":
			return named(
				entered(healthy, "Stray", { kind: "stray" }),
				"wholeEntryUndeclared",
				wholeRefusal
			)
		case "entryOverAnother":
			return named(
				entered(healthy, "Far", { kind: "over another", relation: defect.relation }),
				"entryOverAnother",
				"a query entry is a query over the role's base"
			)
		case "entryOutsideBase":
			return of(entered(healthy, "Far", { kind: "outside" }), {
				kind: "entryOutsideBase",
				entry: "Far",
				relation: "Stray"
			})
		case "entryParameters": {
			const fields = ordinaries[defect.relation].fields
			const field = pickFrom(nonEmpty(fields, "a relation's fields"), defect.field)
			const parameter = `p${defect.parameter}`
			return of(
				entered(healthy, "ByParameter", {
					kind: "parameter",
					relation: defect.relation,
					field,
					parameter
				}),
				{ kind: "entryParameters", entry: "ByParameter", parameters: [`parameter ${parameter}`] }
			)
		}
		case "entryAttaches":
			return of(entered(healthy, "Attached", { kind: "attach", relation: defect.relation }), {
				kind: "entryAttaches",
				entry: "Attached"
			})
		case "entryApproximate":
			return of(entered(healthy, "Near", { kind: "nearest", take: defect.take }), {
				kind: "entryApproximate",
				entry: "Near"
			})
		case "entryOrdered":
			return of(
				entered(healthy, "Top", {
					kind: "ordered",
					relation: defect.relation,
					descending: defect.descending
				}),
				{ kind: "entryOrdered", entry: "Top" }
			)
		case "writeOutside": {
			const name = `Ghost${defect.name}`
			return of({ ...healthy, write: [...healthy.write, name] }, { kind: "writeOutside", name })
		}
		case "writeKind": {
			const relation: BaseName = defect.derived ? "Counts" : "Kind"
			const withEntry = entered(healthy, relation, { kind: "whole", relation })
			return of(
				{ ...withEntry, write: [...withEntry.write, relation] },
				{ kind: "writeKind", name: relation, entryKind: defect.derived ? "derived" : "closed" }
			)
		}
		case "writeUnwritable": {
			const optional = Arr.filter(
				ordinaries[defect.relation].fields,
				(f) => !Arr.contains(ordinaries[defect.relation].key, f)
			)
			const omit = Arr.filter(optional, (_, i) => (defect.omit & (1 << i)) !== 0)
			const omitted = omit.length > 0 ? omit : optional.slice(0, 1)
			const withEntry = entered(healthy, "Partial", {
				kind: "view",
				relation: defect.relation,
				omit: omitted
			})
			return of(
				{ ...withEntry, write: [...withEntry.write, "Partial"] },
				{ kind: "writeUnwritable", entry: "Partial" }
			)
		}
		case "writeTwice": {
			const relation = defect.relation
			const withEntries = entered(
				entered(healthy, relation, { kind: "whole", relation }),
				`${relation}Twice`,
				{ kind: "view", relation, omit: [] }
			)
			const unwritten = Arr.filter(
				withEntries.write,
				(w) => Option.getOrUndefined(writesRelation(withEntries, w)) !== relation
			)
			const [first, second] = defect.wholeFirst
				? [relation, `${relation}Twice`]
				: [`${relation}Twice`, relation]
			return of(
				{ ...withEntries, write: [...unwritten, first, second] },
				{ kind: "writeTwice", relation, entries: [first, second] }
			)
		}
		case "refreshOutside": {
			const name = `Ghost${defect.name}`
			return of(
				{ ...healthy, refresh: [...healthy.refresh, name] },
				{ kind: "refreshOutside", name }
			)
		}
		case "refreshKind": {
			const candidates = nonEmpty(
				[
					...Arr.filter(baseNames, (n) => kindOfBase(n) !== "derived"),
					...Arr.map(ordinaryNames, (n) => `${n}View`)
				],
				"a non-derived entry"
			)
			const name = pickFrom(candidates, defect.target)
			const viewed = Option.getOrUndefined(Arr.findFirst(ordinaryNames, (n) => `${n}View` === name))
			const entry: EntrySpec = isOrdinary(name)
				? { kind: "whole", relation: name }
				: viewed !== undefined
					? { kind: "view", relation: viewed, omit: [] }
					: { kind: "whole", relation: "Kind" }
			const withEntry = entered(healthy, name, entry)
			return of(
				{ ...withEntry, refresh: [...withEntry.refresh, name] },
				{
					kind: "refreshKind",
					name,
					entryKind: entry.kind === "view" ? "query" : name === "Kind" ? "closed" : "relation"
				}
			)
		}
	}
}

export const roleCaseGen: Gen<RoleCase> = (source) =>
	plant(source.draw(healthyGen), source.draw(defectGen))

/** What a role's refusal states, as a case states it: its rule, or the refusal the types name too. */
export const statedOf = (e: CompileError): Stated | undefined =>
	e.reason._tag === "RoleRefused"
		? { kind: "rule", rule: stated(e.reason.rule) }
		: e.reason._tag === "Refused"
			? { kind: "named", refusal: e.reason.refusal }
			: undefined

/** The reason a refusal stating `s` is of. */
export const tagOf = (s: Stated): "RoleRefused" | "Refused" =>
	s.kind === "rule" ? "RoleRefused" : "Refused"

/** A refusal's rule as a case states it. */
const stated = (rule: RoleRule): StatedRule =>
	rule.kind === "writeUnwritable" ? { kind: rule.kind, entry: rule.entry } : rule

/** The role a spec states, through the builder's admission core, as a JavaScript caller reaches it. */
export const admitted = (name: string, spec: RoleSpec) =>
	admitRole(
		Reports,
		name,
		Rec.fromEntries(Arr.map(spec.entries, ([n, entry]) => [n, entryValue(entry)] as const)),
		{ write: spec.write, refresh: spec.refresh },
		[]
	)

/** The description of the planted spec, built on the healthy role's own: none where no description states it. */
export const describedOf = (c: RoleCase): Option.Option<unknown> => {
	const healthy = admitted("described", c.healthy).desc
	const added = Arr.filter(
		c.planted.entries,
		([name, entry]) => !Arr.some(c.healthy.entries, ([n, e]) => n === name && e === entry)
	)
	const descs = Arr.map(added, ([name, entry]) => entryDesc(name, entry))
	if (!Arr.every(descs, Option.isSome)) {
		return Option.none()
	}
	const replaced = new Set(Arr.map(added, ([name]) => name))
	return Option.some({
		...healthy,
		relations: [
			...Arr.filter(healthy.relations, (e) => !replaced.has(e.name)),
			...Arr.flatMap(descs, Option.toArray)
		],
		write: c.planted.write,
		refresh: c.planted.refresh
	})
}

export type RoleFeature = Broken["feature"] | "none" | "described"

/** A context's field: its name and its drawn type. */
interface ContextField {
	readonly name: string
	readonly type: SketchedField
}

interface ContextCase {
	readonly rosters: Arr.NonEmptyReadonlyArray<number>
	readonly fields: Arr.NonEmptyReadonlyArray<ContextField>
	readonly claim: boolean
}

export const contextCaseGen: Gen<ContextCase> = (source) => {
	const rosters = nonEmpty(source.draw(array(int(1, 3), { min: 1, max: 2 })), "the rosters")
	const names = source.draw(
		uniqueKeys(string(codePoint(0x61, 0x66), { min: 1, max: 2 }), { min: 1, max: 3 })
	)
	return {
		rosters,
		fields: nonEmpty(
			Arr.map(names, (name, i) => ({
				name,
				type: source.draw(fieldSketchGen(rosters.length, (s) => `Claim${i}${s.draw(int(0, 1))}`))
			})),
			"the context's fields"
		),
		claim: source.draw(boolean)
	}
}

/** The SQL types a claim may be read as. */
const claimTypes: ReadonlySet<string> = new Set([
	"smallint",
	"integer",
	"bigint",
	"boolean",
	"uuid"
])

/** Whether a field type is a claim's: the claim rule over the type. */
export const claimDescribed = (t: SketchedField): boolean => {
	switch (t.kind) {
		case "pg":
			return claimTypes.has(pgField(t.member).sql)
		case "uuid":
		case "text":
		case "closedId":
			return true
		case "contract":
			return claimDescribed(t.base)
		case "numeric":
		case "span":
		case "bits":
		case "vector":
			return false
	}
}

export type ContextFeature =
	| "admitted"
	| "refused"
	| "a contract over a claim"
	| "a later field refused"

/** Whether a rebuilt query value is a Query, not an Ordered: a Query has `rule`. */
export const isQuery = (value: QueryValue | OrderedValue): value is QueryValue => "rule" in value

/** A definition of the derived oracle, as a role's query entry. */
export interface EntryCase {
	readonly gen: ReturnType<typeof buildSchema>
	readonly at: number
}

export type EntryFeature =
	| "a union"
	| "a take"
	| "an aggregate"
	| "a negation"
	| "over a derived relation"

/** A login program: logins over a pool of roles, each role over a drawn base under a drawn name. */
interface LoginProgram {
	readonly roles: Arr.NonEmptyReadonlyArray<{ readonly name: number; readonly other: boolean }>
	readonly logins: Arr.NonEmptyReadonlyArray<{
		readonly name: number
		readonly roles: Arr.NonEmptyReadonlyArray<number>
	}>
}

export const loginProgramGen: Gen<LoginProgram> = (source) => {
	const roles = nonEmpty(
		source.draw(
			array((s) => ({ name: s.draw(int(0, 3)), other: s.draw(int(0, 4)) === 0 }), {
				min: 1,
				max: 4
			})
		),
		"the roles"
	)
	const logins = nonEmpty(
		source.draw(
			array(
				(s) => ({
					name: s.draw(int(0, 3)),
					roles: nonEmpty(
						s.draw(shuffled(indices(roles.length), { min: 1, max: roles.length })),
						"a login's roles"
					)
				}),
				{ min: 1, max: 3 }
			)
		),
		"the logins"
	)
	return { roles, logins }
}

export const roleName = (n: number): string => `r${n}`

/** Login names share role names' spelling, so a login may be named as one of its roles. */
export const loginName = (n: number): string => `r${n}`

/** What each login of a program meets: refused by a rule, refused as malformed (two roles of one name), or admitted. */
type LoginOutcome =
	| { readonly kind: "refused"; readonly rule: LoginRule }
	| { readonly kind: "malformed" }
	| { readonly kind: "admitted" }

export const loginOutcomes = (p: LoginProgram): ReadonlyArray<LoginOutcome> => {
	const holder = new Map<number, string>()
	return Arr.map(p.logins, (l) => {
		const name = loginName(l.name)
		for (const at of l.roles) {
			const r = defined(p.roles[at], `role ${at}`)
			if (r.other) {
				return {
					kind: "refused",
					rule: { kind: "roleBase", role: roleName(r.name), base: "Reports" }
				}
			}
			if (roleName(r.name) === name) {
				return { kind: "refused", rule: { kind: "roleName", role: roleName(r.name) } }
			}
			const prior = holder.get(at)
			if (prior !== undefined) {
				return {
					kind: "refused",
					rule: { kind: "roleTwice", role: roleName(r.name), login: prior }
				}
			}
		}
		const names = Arr.map(l.roles, (at) => defined(p.roles[at]).name)
		if (Arr.dedupe(names).length < names.length) {
			return { kind: "malformed" }
		}
		for (const at of l.roles) {
			holder.set(at, name)
		}
		return { kind: "admitted" }
	})
}

export type LoginFeature = LoginRule["kind"] | "admitted" | "malformed"
