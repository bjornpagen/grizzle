/**
 * A compile's law model is the whole schema's restricted to its slice (schema/reach.ts sliceOf, laws/model/model.ts
 * compileLaws): DbLayer.make, db.apply, db.compile and db.read each compile the laws their programs' slice needs, never
 * the whole schema's. Each case draws a schema of up to three levels, a login of roles over it and programs each run by
 * one role, and compares the model compiled over the programs' slice, given the whole model's foreign key cycles, with
 * the model compiled over every relation (everySlice), restricted by a slice the test computes from the draw alone:
 *
 * - the slice: the writes are every relation a program's ChangeSet writes, closed under family coupling, a family's
 *   member and its owner writing each other, however long the chain; the names are the writes and every relation a
 *   program reads, a whole entry its relation, a world entry the relation its query reads, and a derived relation
 *   itself and what its definition reads, down every level;
 * - the planned laws: every law whose violation query reads a named relation, and every contract's law, each with the
 *   whole model's plan, deferral (the whole model's cycles, which may run through relations outside the names) and
 *   immediacy;
 * - what a read relies on: the key, row-check and containment evidence of the planned laws, each containment under the
 *   whole model's validity context, the existence evidence of the containments that read a named relation, and each
 *   named relation's selection keys;
 * - the natives the planned laws plan that a write or a read relies on, each discharging the planned laws alone, the
 *   rules that read a written relation, and the written relations with their keys and unique objects;
 * - what the slice compiles: the natives of its named relations and the foreign keys into them in the whole model's
 *   order, names, laws and descriptions; every constraint a write of the slice can raise naming the whole model's laws
 *   in the witness; and each program's ChangeSet, compiled through its role as db.apply compiles it, compiling over
 *   the slice exactly when it does over the whole schema, to the same statements, certificates and requirements.
 *
 * The box: two to four relations at the root level, with ordered and counted families (chains included), keys over a
 * selection, containments between them (cycles included), row checks, and containments into a roster or a selection
 * of it; derived relations of them at the level above, and over those at a third; up to two relations at the level
 * above, containing into a relation below or into a derived relation of one (a rule over a query); one or two roles,
 * each holding every relation whole beside world entries over relations below; and one to three programs, each a query
 * or a ChangeSet with read-backs.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int } from "@grizzle/testing/gen"
import { agree, exact, set, structuralHash } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { installationWitness } from "#adapter/witness/index.ts"
import { noLevelAbove } from "#adapter/witness/keylaw.ts"
import { canonicalEquals, type EncodeOptions } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { LawId, RelationIdent } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import {
	type ChangeSetDesc,
	decodeDesc,
	type ProgramDesc,
	type QueryDesc
} from "#compiler/ir/desc.ts"
import type { LawModel, NamedNative } from "#compiler/laws/model/model.ts"
import { selectionKeysOf } from "#compiler/physical/ddl/names.ts"
import { installBasis, planBasis } from "#compiler/physical/install/plan.ts"
import { baseArtifacts, roleArtifacts, type SchemaArtifacts } from "#compiler/program/schema.ts"
import {
	fullRoleDesc,
	type OwnedLogin,
	type OwnedRole,
	ownLogin,
	rostersOf
} from "#compiler/schema/own.ts"
import { everySlice, sliceOf } from "#compiler/schema/reach.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	type AuthoredRelationDesc,
	type AuthoredStatementDesc,
	check,
	closed,
	contained,
	counted,
	decodedQuery,
	decodedSchema,
	eq,
	f,
	field,
	fin,
	key,
	literal,
	on,
	onWhere,
	ordered,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"

/** A family of the root level: its owner and its member, an earlier relation owning a later one, ordered or counted. */
interface FamilyDraw {
	readonly owner: number
	readonly member: number
	readonly ordered: boolean
}

/** A containment from one relation into another: into its key, or into its key over its selection when it has one. */
interface LinkDraw {
	readonly from: number
	readonly to: number
	readonly selected: boolean
}

/** A containment of a relation's roster field: into the roster, or from its selection into a selection of the roster. */
interface RosterDraw {
	readonly from: number
	readonly selected: boolean
}

/** A containment from a relation of the level above into a relation of the root, or into a derived relation of one. */
interface UpDraw {
	readonly from: number
	readonly to: number
}

/** A relation a program names: a whole entry of the base, or a role's world entry over a root relation. */
type Read =
	| { readonly kind: "root" | "top" | "derived" | "chained" | "world"; readonly at: number }
	| { readonly kind: "roster" }

/** A program one role runs: a query reading its reads, or a ChangeSet inserting into its writes, reading back its reads. */
interface Use {
	readonly role: number
	readonly kind: "query" | "changes"
	/** The ordinary relations it writes, by position among the root's relations and then the level above's. */
	readonly writes: ReadonlyArray<number>
	readonly reads: ReadonlyArray<Read>
}

/** A role: the ordinary relations it writes and the root relations it holds world entries over. */
interface RoleDraw {
	readonly writes: ReadonlyArray<number>
	readonly worlds: ReadonlyArray<number>
}

interface SliceCase {
	readonly roots: number
	readonly tops: number
	readonly families: ReadonlyArray<FamilyDraw>
	readonly keys: ReadonlyArray<number>
	readonly links: ReadonlyArray<LinkDraw>
	readonly checks: ReadonlyArray<number>
	readonly rosters: ReadonlyArray<RosterDraw>
	/** The root relations with a derived relation of their live rows at the level above, and those with one over it. */
	readonly derived: ReadonlyArray<number>
	readonly chained: ReadonlyArray<number>
	readonly crossings: ReadonlyArray<UpDraw>
	readonly rules: ReadonlyArray<UpDraw>
	readonly roles: Arr.NonEmptyReadonlyArray<RoleDraw>
	readonly uses: Arr.NonEmptyReadonlyArray<Use>
}

/** The families of a draw, each member in at most one ordered family: a second ordered one of a member is counted. */
const familiesOf = (draws: ReadonlyArray<FamilyDraw>): ReadonlyArray<FamilyDraw> =>
	Arr.map(draws, (d, i) => ({
		...d,
		ordered: d.ordered && !Arr.some(draws.slice(0, i), (e) => e.ordered && e.member === d.member)
	}))

const distinct = <A>(xs: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(xs)]

const caseGen: Gen<SliceCase> = (s) => {
	const roots = s.draw(int(2, 4))
	const tops = s.draw(int(0, 2))
	const root = int(0, roots - 1)
	const family: Gen<FamilyDraw> = (t) => {
		const owner = t.draw(int(0, roots - 2))
		return { owner, member: t.draw(int(owner + 1, roots - 1)), ordered: t.draw(boolean) }
	}
	const keys = distinct(s.draw(array(root, { min: 0, max: 2 })))
	const link: Gen<LinkDraw> = (t) => {
		const to = t.draw(root)
		return { from: t.draw(root), to, selected: keys.includes(to) && t.draw(boolean) }
	}
	const up: Gen<UpDraw> = (t) => ({ from: t.draw(int(0, tops - 1)), to: t.draw(root) })
	const crossings = tops === 0 ? [] : s.draw(array(up, { min: 0, max: 2 }))
	const rules = tops === 0 ? [] : s.draw(array(up, { min: 0, max: 2 }))
	const derived = distinct([
		...s.draw(array(root, { min: 0, max: 2 })),
		...Arr.map(rules, (r) => r.to)
	])
	const chained = Arr.isReadonlyArrayNonEmpty(derived)
		? distinct(
				Arr.map(s.draw(array(int(0, derived.length - 1), { min: 0, max: 1 })), (i) =>
					defined(derived[i], "a derived relation")
				)
			)
		: []
	const ordinary = int(0, roots + tops - 1)
	const roleGen: Gen<RoleDraw> = (t) => ({
		writes: distinct(t.draw(array(ordinary, { min: 0, max: 3 }))),
		worlds: distinct(t.draw(array(root, { min: 0, max: 2 })))
	})
	const [firstRole, ...moreRoles] = s.draw(array(roleGen, { min: 1, max: 2 }))
	const roles: Arr.NonEmptyReadonlyArray<RoleDraw> = [defined(firstRole, "a role"), ...moreRoles]
	const readGen =
		(r: RoleDraw): Gen<Read> =>
		(t) => {
			const options: ReadonlyArray<Read> = [
				...Arr.makeBy(roots, (at): Read => ({ kind: "root", at })),
				...Arr.makeBy(tops, (at): Read => ({ kind: "top", at })),
				...Arr.map(derived, (at): Read => ({ kind: "derived", at })),
				...Arr.map(chained, (at): Read => ({ kind: "chained", at })),
				...Arr.map(r.worlds, (at): Read => ({ kind: "world", at })),
				{ kind: "roster" }
			]
			return defined(options[t.draw(int(0, options.length - 1))], "a read")
		}
	const useGen: Gen<Use> = (t) => {
		const role = t.draw(int(0, roles.length - 1))
		const r = defined(roles[role], "the use's role")
		const changes = Arr.isReadonlyArrayNonEmpty(r.writes) && t.draw(boolean)
		const writes = changes
			? distinct(
					Arr.map(t.draw(array(int(0, r.writes.length - 1), { min: 1, max: 2 })), (i) =>
						defined(r.writes[i], "a write of the role")
					)
				)
			: []
		const reads = t.draw(array(readGen(r), { min: changes ? 0 : 1, max: 3 }))
		return { role, kind: changes ? "changes" : "query", writes, reads }
	}
	const [firstUse, ...moreUses] = s.draw(array(useGen, { min: 1, max: 3 }))
	return {
		roots,
		tops,
		families: familiesOf(s.draw(array(family, { min: 0, max: 3 }))),
		keys,
		links: s.draw(array(link, { min: 0, max: 4 })),
		checks: distinct(s.draw(array(root, { min: 0, max: 2 }))),
		rosters: s.draw(
			array((t): RosterDraw => ({ from: t.draw(root), selected: t.draw(boolean) }), {
				min: 0,
				max: 2
			})
		),
		derived,
		chained,
		crossings,
		rules,
		roles,
		uses: [defined(firstUse, "a use"), ...moreUses]
	}
}

const rootName = (i: number): string => `R${i}`
const topName = (i: number): string => `T${i}`
const derivedName = (i: number): string => `D${i}`
const chainedName = (i: number): string => `E${i}`
const worldName = (i: number): string => `V${i}`
const roster = "Color"

/** The name of the case's i-th ordinary relation, the root's first. */
const ordinaryName = (c: SliceCase, i: number): string =>
	i < c.roots ? rootName(i) : topName(i - c.roots)

const live = eq(field("on"), literal(true))

/** Root relation i's fields: its own, then the count of each family it owns and the group and index of each it is a
 * member of. */
const rootFields = (c: SliceCase, i: number) => ({
	id: f.integer,
	a: f.integer,
	on: f.boolean,
	c: f.closedId(roster),
	...Rec.fromEntries(
		Arr.flatMap(c.families, (d, k) => [
			...(d.owner === i ? [[`n${k}`, f.drawn] as const] : []),
			...(d.member === i ? [[`o${k}`, f.integer] as const] : []),
			...(d.member === i && d.ordered ? [[`i${k}`, f.drawn] as const] : [])
		])
	)
})

/** The query of the ids of `source`'s facts whose `on` holds, when `live`, or of every fact. */
const idsOf = (source: string, selected: boolean): QueryDesc =>
	decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [{ id: "id", origin: { relation: source, field: "id" } }],
				matches: [
					{
						source: { kind: "relation", name: source },
						bindings: selected
							? { id: { kind: "var", var: "id" }, on: literal(true) }
							: { id: { kind: "var", var: "id" } }
					}
				],
				where: [],
				head: { id: { kind: "var", var: "id" } },
				interiors: [],
				attach: []
			}
		]
	})

/** A derived relation of the level above, of derived level `level`, over the ids `query` reads. */
const derivedOf = (name: string, level: number, query: QueryDesc): AuthoredRelationDesc => ({
	kind: "derived",
	name,
	level,
	storage: "live",
	query
})

const rootStatements = (c: SliceCase): ReadonlyArray<AuthoredStatementDesc> => [
	...Arr.map(c.families, (d, k) =>
		d.ordered
			? ordered(on(rootName(d.member), [`o${k}`, `i${k}`]), fin(rootName(d.owner), `n${k}`))
			: counted(on(rootName(d.member), [`o${k}`]), fin(rootName(d.owner), `n${k}`))
	),
	...Arr.map(c.keys, (i) => key(onWhere(rootName(i), ["a"], live))),
	...Arr.map(c.links, (l) =>
		contained(
			on(rootName(l.from), ["a"]),
			l.selected ? onWhere(rootName(l.to), ["a"], live) : on(rootName(l.to), ["id"])
		)
	),
	...Arr.map(c.checks, (i) => check("Signed", rootName(i), eq(field("on"), field("on")))),
	...Arr.map(c.rosters, (r) =>
		r.selected
			? contained(
					onWhere(rootName(r.from), ["c"], live),
					onWhere(roster, ["id"], eq(field("id"), literal("red")))
				)
			: contained(on(rootName(r.from), ["c"]), on(roster, ["id"]))
	)
]

/** The case's schema: the root, the level above it, and a third level of the derived relations over derived ones. */
const schemaOf = (c: SliceCase): SchemaDesc => {
	const root: SchemaDesc = {
		name: "Slice",
		relations: [
			closed(roster, ["red", "green"]),
			...Arr.makeBy(c.roots, (i) => relation(rootName(i), rootFields(c, i), ["id"]))
		],
		statements: rootStatements(c),
		extends: undefined
	}
	const top: SchemaDesc = {
		name: "SliceTop",
		relations: [
			...Arr.makeBy(c.tops, (i) =>
				relation(topName(i), { id: f.integer, a: f.integer, r: f.integer }, ["id"])
			),
			...Arr.map(c.derived, (i) => derivedOf(derivedName(i), 1, idsOf(rootName(i), true)))
		],
		statements: [
			...Arr.map(c.crossings, (u) =>
				contained(on(topName(u.from), ["a"]), on(rootName(u.to), ["id"]))
			),
			...Arr.map(c.rules, (u) =>
				contained(on(topName(u.from), ["r"]), on(derivedName(u.to), ["id"]))
			)
		],
		extends: root
	}
	return Arr.isReadonlyArrayNonEmpty(c.chained)
		? {
				name: "SliceChain",
				relations: Arr.map(c.chained, (i) =>
					derivedOf(chainedName(i), 2, idsOf(derivedName(i), false))
				),
				statements: [],
				extends: top
			}
		: top
}

const loc = SourceLoc("the slice test's login", [])

const roleName = (k: number): string => `w${k}`

/** The login of the case's roles over its schema: each holds every relation whole and its world entries, and writes its
 * draw. */
const loginOf = (c: SliceCase): OwnedLogin => {
	const base = decodedSchema(schemaOf(c))
	const whole = succeeded(fullRoleDesc(base, "w", loc), "a role over the schema")
	const roles = Arr.map(c.roles, (r, k) => ({
		...whole,
		name: roleName(k),
		relations: [
			...whole.relations,
			...Arr.map(r.worlds, (i) => ({
				kind: "world" as const,
				name: worldName(i),
				query: idsOf(rootName(i), true),
				loc
			}))
		],
		write: distinct(Arr.map(r.writes, (i) => ordinaryName(c, i)))
	}))
	return succeeded(
		Result.flatMap(decodeDesc("login", { name: "app", base, roles, loc }), ownLogin),
		"the case's login"
	)
}

/** The entry a read names, as its role holds it. */
const entryName = (read: Read): string => {
	switch (read.kind) {
		case "root":
			return rootName(read.at)
		case "top":
			return topName(read.at)
		case "derived":
			return derivedName(read.at)
		case "chained":
			return chainedName(read.at)
		case "world":
			return worldName(read.at)
		case "roster":
			return roster
	}
}

/** A query over the entries `reads` names, each matched apart, its head the first's ids. */
const queryOver = (reads: Arr.NonEmptyReadonlyArray<Read>): QueryDesc => {
	const vars = Arr.map(reads, (r, k) => ({
		id: `x${k}`,
		origin: { relation: entryName(r), field: "id" }
	}))
	return decodedQuery({
		kind: "rules",
		arms: [
			{
				vars,
				matches: Arr.map(reads, (r, k) => ({
					source: { kind: "relation", name: entryName(r) },
					bindings: { id: { kind: "var", var: `x${k}` } }
				})),
				where: [],
				head: { id: { kind: "var", var: "x0" } },
				interiors: [],
				attach: []
			}
		]
	})
}

/** The program a use runs: its query, or its ChangeSet of an insert into each of its writes, reading back its reads. */
const programOf = (c: SliceCase, u: Use): ProgramDesc => {
	if (u.kind === "query") {
		const [first, ...more] = u.reads
		return { kind: "query", query: queryOver([defined(first, "a query's read"), ...more]) }
	}
	const [first, ...more] = u.reads
	const changeSet = succeeded(
		decodeDesc("changeSet", {
			schema: Arr.isReadonlyArrayNonEmpty(c.chained) ? "SliceChain" : "SliceTop",
			strata: [
				{
					members: Arr.map(u.writes, (i, k) => ({
						op: "insert",
						relation: ordinaryName(c, i),
						member: { kind: "array", slot: `s${k}` }
					}))
				}
			],
			reads: first === undefined ? [] : [{ name: "back", query: queryOver([first, ...more]) }],
			bindings: []
		}),
		"the use's ChangeSet"
	)
	return { kind: "changeSet", changeSet }
}

/**
 * The slice of the case's programs, computed from the draw alone. Writes: each ChangeSet's targets, closed under the
 * families, a member and its owner writing each other. Names: the writes and every relation a program reads, a whole
 * entry its relation, a world entry the root relation its query reads, and a derived relation itself and its
 * definition's reads down every level.
 */
const expectedSlice = (
	c: SliceCase
): { readonly writes: ReadonlySet<string>; readonly names: ReadonlySet<string> } => {
	const writes = new Set(Arr.flatMap(c.uses, (u) => Arr.map(u.writes, (i) => ordinaryName(c, i))))
	const coupled = Arr.flatMap(c.families, (d) => [
		[rootName(d.owner), rootName(d.member)] as const,
		[rootName(d.member), rootName(d.owner)] as const
	])
	for (let grown = true; grown;) {
		const next = Arr.filter(coupled, ([from, to]) => writes.has(from) && !writes.has(to))
		for (const [, to] of next) {
			writes.add(to)
		}
		grown = next.length > 0
	}
	const readsOf = (read: Read): ReadonlyArray<string> => {
		switch (read.kind) {
			case "root":
				return [rootName(read.at)]
			case "top":
				return [topName(read.at)]
			case "derived":
				return [derivedName(read.at), rootName(read.at)]
			case "chained":
				return [chainedName(read.at), derivedName(read.at), rootName(read.at)]
			case "world":
				return [rootName(read.at)]
			case "roster":
				return [roster]
		}
	}
	return {
		writes,
		names: new Set([...writes, ...Arr.flatMap(c.uses, (u) => Arr.flatMap(u.reads, readsOf))])
	}
}

/** The relation a native is of; none for a roster's or a contract's domain. */
const relationOf = (n: NamedNative): string | undefined => {
	switch (n.object.kind) {
		case "Domain":
		case "RosterDomain":
			return undefined
		case "PrimaryKey":
		case "Unique":
		case "WithoutOverlaps":
		case "TableCheck":
		case "ClosedCheck":
		case "ForeignKey":
		case "PeriodForeignKey":
		case "LawColumn":
		case "ReverseIndex":
			return n.object.relation.name
	}
}

/**
 * Two values equal apart from the labels a law model's DAG gives its nodes and expressions, and the canonical text of a
 * guard, which spells them and which only another guard of its own model is compared with (uniques.ts subsumes); a
 * closed side's rows are the closed relation's own, which both models hold alike; and a compiled statement's parameter
 * encoders, which are code, each slot's own.
 */
const labelFree: EncodeOptions = {
	omit: (k, value) =>
		typeof value === "function" ||
		k === "deps" ||
		((k === "id" || k === "node" || k === "canonical") && typeof value === "string") ||
		(k === "rows" && !Arr.isArray(value))
}

const sameApartFromLabels = (a: unknown, b: unknown, why: string): void =>
	assert.ok(canonicalEquals(a, b, labelFree), why)

/**
 * Two lists of natives holding the same natives, each equal apart from DAG labels, in any order: a model orders its
 * natives by the first law that plans each, and a slice plans fewer laws.
 */
const sameNatives = (
	actual: ReadonlyArray<NamedNative>,
	expected: ReadonlyArray<NamedNative>
): void => {
	const left = [...actual]
	const missing: Array<string> = []
	for (const n of expected) {
		const at = Arr.findFirstIndex(left, (m) => canonicalEquals(m, n, labelFree))
		if (Option.isSome(at)) {
			left.splice(at.value, 1)
		} else {
			missing.push(nativeName(n))
		}
	}
	assert.deepEqual(
		{ missing, unexpected: Arr.map(left, nativeName) },
		{ missing: [], unexpected: [] },
		"the natives the slice's model holds, each as the whole model's"
	)
}

/**
 * Whether what the slice compiles and writes reads `n`: a native of a named relation, a foreign key or PERIOD foreign
 * key into one, a named roster's domain, or a contract's domain. Each such native is the whole model's in its installed
 * name, the laws it discharges, the law it is described by and its order among them; a native the slice holds on a
 * relation it does not name (a foreign key out of one, a CHECK of one into a closed relation) is read by nothing it
 * compiles or writes.
 */
const visibleOver =
	(names: ReadonlySet<string>) =>
	(n: NamedNative): boolean => {
		switch (n.object.kind) {
			case "ForeignKey":
			case "PeriodForeignKey":
				return names.has(n.object.relation.name) || names.has(n.object.target.name)
			case "RosterDomain":
				return names.has(n.object.name)
			case "Domain":
				return true
			case "PrimaryKey":
			case "Unique":
			case "WithoutOverlaps":
			case "TableCheck":
			case "ClosedCheck":
			case "LawColumn":
			case "ReverseIndex":
				return names.has(n.object.relation.name)
		}
	}

/** A native as a reader names it: its kind, its relation and its installed name where it has one. */
const nativeName = (n: NamedNative): string =>
	`${n.object.kind} ${relationOf(n) ?? "-"} ${n.namespace === "constraint" || n.namespace === "column" ? identifierOf(n.named) : "-"}`

/**
 * The laws a model over the slice plans, read off the whole model: every law whose violation query reads a named
 * relation, and every contract's law, whose domain types context fields and parameters beyond any relation. Each keeps
 * the whole model's plan, deferral and immediacy.
 */
const plannedOver = (whole: LawModel, names: ReadonlySet<string>): ReadonlySet<LawId> =>
	new Set(
		Arr.flatMap(whole.theory.laws, (law) =>
			law.shape === "contract" || Arr.some(law.reads, (r) => names.has(r)) ? [law.id] : []
		)
	)

/**
 * A native discharging only the laws of `planned`, in its order, a constraint described by the first of them, the law
 * it reports when nothing narrows it.
 */
const dischargingOnly = (
	n: NamedNative,
	planned: ReadonlySet<LawId>,
	described: (law: LawId) => Law
): NamedNative => {
	const [head, ...rest] = Arr.filter(n.object.lawIds, (l) => planned.has(l))
	const first = defined(head, "a planned law of the native")
	const lawIds: Arr.NonEmptyReadonlyArray<LawId> = [first, ...rest]
	switch (n.namespace) {
		case "constraint":
			return { ...n, object: { ...n.object, lawIds }, described: described(first) }
		case "column":
			return { ...n, object: { ...n.object, lawIds } }
		case "domain":
			return { ...n, object: { ...n.object, lawIds } }
		case "unnamed":
			return { ...n, object: { ...n.object, lawIds } }
	}
}

/**
 * The natives a model over the slice holds, read off the whole model: of the natives a planned law plans, in the whole
 * model's order and discharging only planned laws, every native of a written relation, which a write can break or read;
 * every foreign key, PERIOD foreign key, CHECK into a closed relation, roster's domain and contract's domain, which a
 * read relies on whoever writes; and each selection key's law column with the UNIQUEs that hold it, which a query's
 * probe reads.
 */
const heldOver = (
	whole: SchemaArtifacts,
	planned: ReadonlySet<LawId>,
	writes: ReadonlySet<string>
): ReadonlyArray<{ readonly whole: NamedNative; readonly held: NamedNative }> => {
	const laws = new Map<LawId, Law>(Arr.map(whole.theoryLaws, (l) => [l.law, l.described] as const))
	const described = (law: LawId): Law => defined(laws.get(law), `${law} is described`)
	const plannedNatives = Arr.flatMap(whole.laws.natives, (n) =>
		Arr.some(n.object.lawIds, (l) => planned.has(l))
			? [{ whole: n, held: dischargingOnly(n, planned, described) }]
			: []
	)
	const keys = selectionKeysOf(Arr.map(plannedNatives, (p) => p.held))
	const keyed = (relation: string, column: string): boolean =>
		Arr.some(keys.get(relation) ?? [], (k) => k.column === column)
	return Arr.filter(plannedNatives, ({ held: n }) => {
		const relation = relationOf(n)
		if (relation !== undefined && writes.has(relation)) {
			return true
		}
		switch (n.object.kind) {
			case "ForeignKey":
			case "PeriodForeignKey":
			case "ClosedCheck":
			case "RosterDomain":
			case "Domain":
				return true
			case "LawColumn":
				return keyed(n.object.relation.name, n.object.column)
			case "Unique": {
				const on = n.object.relation.name
				return Arr.some(n.object.columns, (col) => col.kind === "law" && keyed(on, col.column))
			}
			case "PrimaryKey":
			case "WithoutOverlaps":
			case "TableCheck":
			case "ReverseIndex":
				return false
		}
	})
}

type SliceFeature =
	| "a relation outside the names"
	| "a family coupling widens the writes"
	| "a family chain widens the writes"
	| "a derived relation's definition named"
	| "a world entry names its relation"
	| "a foreign-key cycle through a key between two relations outside the names"
	| "evidence of a containment reading a relation outside the names"
	| "a selection key on a named relation outside the writes"
	| "a rule reading the writes"
	| "a contract's domain used outside the names"
	| "a ChangeSet compiled over the slice"

const features: Arr.NonEmptyReadonlyArray<SliceFeature> = [
	"a relation outside the names",
	"a family coupling widens the writes",
	"a family chain widens the writes",
	"a derived relation's definition named",
	"a world entry names its relation",
	"a foreign-key cycle through a key between two relations outside the names",
	"evidence of a containment reading a relation outside the names",
	"a selection key on a named relation outside the writes",
	"a rule reading the writes",
	"a contract's domain used outside the names",
	"a ChangeSet compiled over the slice"
]

/**
 * A ChangeSet compiled as a role's db.apply compiles it (adapter/apply/compile.ts writeEntry): against `base`'s
 * artifacts read through the role's views (roleArtifacts), in the role's world, for a Db holding no context's fact.
 */
const compiledChange = (
	base: SchemaArtifacts,
	role: OwnedRole,
	changeSet: ChangeSetDesc
): Result.Result<CompiledWrite, CompileError> =>
	Result.flatMap(roleArtifacts(role, base), (artifacts) => {
		const world = artifacts.world
		return compileWrite(
			world.kind === "role" ? world.checked : artifacts.derived.schema,
			changeSet,
			{
				names: artifacts.names,
				reads: artifacts.reads,
				claims: { kind: "facts", present: new Set() },
				world: world.kind === "role" ? { kind: "role", names: world.names } : { kind: "reality" },
				laws: artifacts.laws,
				derived: artifacts.derived
			}
		)
	})

/** The ledger's shape: a relation of the level above written alone, its rule reading a family's member below. */
const ledgerShape: Kept<SliceCase, SliceFeature> = {
	note: "the level above written alone, its rule over a derived relation of a family member below",
	sketch: {
		roots: 2,
		tops: 1,
		families: [{ owner: 0, member: 1, ordered: true }],
		keys: [1],
		links: [],
		checks: [0],
		rosters: [],
		derived: [1],
		chained: [],
		crossings: [],
		rules: [{ from: 0, to: 1 }],
		roles: [{ writes: [2], worlds: [] }],
		uses: [{ role: 0, kind: "changes", writes: [2], reads: [] }]
	},
	draws: "",
	reaches: ["a relation outside the names", "a rule reading the writes"]
}

/** A member written alone: its owner, whose count it writes, is written too, and a relation outside the names holds a
 * foreign key into the writes and a closed relation's check. */
const memberAlone: Kept<SliceCase, SliceFeature> = {
	note: "a family's member written alone, its owner reached through the family",
	sketch: {
		roots: 3,
		tops: 0,
		families: [{ owner: 0, member: 1, ordered: false }],
		keys: [],
		links: [{ from: 2, to: 0, selected: false }],
		checks: [0],
		rosters: [{ from: 2, selected: true }],
		derived: [],
		chained: [],
		crossings: [],
		rules: [],
		roles: [{ writes: [1], worlds: [] }],
		uses: [{ role: 0, kind: "changes", writes: [1], reads: [] }]
	},
	draws: "",
	reaches: [
		"a relation outside the names",
		"a family coupling widens the writes",
		"evidence of a containment reading a relation outside the names"
	]
}

/** A query of one relation whose foreign key closes a cycle through two it does not name, keyed one into the other. */
const cycleOutside: Kept<SliceCase, SliceFeature> = {
	note: "a foreign key cycle through a relation the programs never name",
	sketch: {
		roots: 3,
		tops: 0,
		families: [],
		keys: [],
		links: [
			{ from: 0, to: 1, selected: false },
			{ from: 1, to: 2, selected: false },
			{ from: 2, to: 0, selected: false }
		],
		checks: [],
		rosters: [],
		derived: [],
		chained: [],
		crossings: [],
		rules: [],
		roles: [{ writes: [], worlds: [] }],
		uses: [
			{
				role: 0,
				kind: "query",
				writes: [],
				reads: [{ kind: "root", at: 0 }]
			}
		]
	},
	draws: "",
	reaches: [
		"a relation outside the names",
		"a foreign-key cycle through a key between two relations outside the names",
		"evidence of a containment reading a relation outside the names"
	]
}

describe("a compile's law model", () => {
	it.effect("is the whole schema's restricted to its slice's writes and names", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "the whole schema's law model restricted by a slice computed from the draw"
					},
					suite: "unit/laws/model/slice",
					draw: drawn(caseGen),
					literal: Formatter.format,
					coverage: required<SliceFeature>(features, { cases: 200, sense: notesOnly }),
					kept: [ledgerShape, memberAlone, cycleOutside],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(c, k) =>
					Effect.gen(function* () {
						const login = loginOf(c)
						const owned = login.base
						const roles = new Map<string, OwnedRole>(
							Arr.map(login.roles, (r) => [r.name, r] as const)
						)
						const slice = sliceOf(
							owned,
							Arr.map(c.uses, (u) => ({
								role: defined(roles.get(roleName(u.role)), "the use's role"),
								program: programOf(c, u)
							}))
						)
						const { writes, names } = expectedSlice(c)
						yield* agree(
							[
								["the relations the draw's programs write", [...writes]],
								["the slice's writes", [...slice.writes]]
							],
							set(structuralHash, exact)
						)
						yield* agree(
							[
								["the relations the draw's programs name", [...names]],
								["the slice's names", [...slice.names]]
							],
							set(structuralHash, exact)
						)

						const codes = firstCodebook(rostersOf(owned))
						const installed = succeeded(
							installBasis(owned, codes, everySlice(owned)),
							"the installation's basis"
						)
						const wholeArtifacts = succeeded(
							baseArtifacts(installed),
							"the installation's artifacts"
						)
						const whole = wholeArtifacts.laws
						const sliced = succeeded(
							Result.flatMap(
								planBasis(owned, codes, slice, installed.closed, {
									kind: "recorded",
									cycles: whole.fkCycles
								}),
								baseArtifacts
							),
							"the slice's artifacts, as a Db plans them from its snapshot"
						)
						const model = sliced.laws

						assert.deepEqual(model.fkCycles, whole.fkCycles, "the foreign key graph's cycles")
						const planned = plannedOver(whole, names)
						const touches = (from: string, to: string): boolean => names.has(from) || names.has(to)
						sameApartFromLabels(
							model.existence,
							Arr.filter(whole.existence, (e) => touches(e.from.relation, e.to.relation)),
							"the existence evidence of the containments reading a named relation"
						)
						const evidence = whole.theory.evidence
						const containments = Arr.filter(evidence.containments, (e) => planned.has(e.law))
						sameApartFromLabels(
							model.theory.evidence,
							{
								keys: Arr.filter(evidence.keys, (e) => planned.has(e.law)),
								checks: Arr.filter(evidence.checks, (e) => planned.has(e.law)),
								containments
							},
							"the evidence of the planned laws, each containment under the whole model's context"
						)
						yield* agree(
							[
								[
									"the whole model's immediate laws among the planned",
									Arr.filter([...whole.immediate], (l) => planned.has(l))
								],
								["the slice's model's immediate laws", [...model.immediate]]
							],
							set(structuralHash, exact)
						)
						const selectionKeys = selectionKeysOf(model.natives)
						const wholeKeys = selectionKeysOf(whole.natives)
						for (const name of names) {
							sameApartFromLabels(
								selectionKeys.get(name) ?? [],
								wholeKeys.get(name) ?? [],
								`${name}'s selection keys`
							)
						}

						const held = heldOver(wholeArtifacts, planned, writes)
						sameNatives(
							model.natives,
							Arr.map(held, (h) => h.held)
						)
						const visible = visibleOver(names)
						sameApartFromLabels(
							Arr.filter(model.natives, visible),
							Arr.flatMap(held, (h) => (visible(h.whole) ? [h.whole] : [])),
							"the natives of the named relations and the foreign keys into them, as the whole model orders, names and describes them"
						)
						const rules = Arr.filter(whole.rules, (r) =>
							Arr.some(r.law.reads, (read) => writes.has(read))
						)
						assert.deepEqual(
							Arr.map(model.rules, (r) => r.law.id),
							Arr.map(rules, (r) => r.law.id),
							"the rules over queries that read a written relation"
						)
						yield* agree(
							[
								[
									"the whole model's written relations",
									Arr.filter([...whole.relations.keys()], (r) => writes.has(r))
								],
								["the relations the slice's model serves", [...model.relations.keys()]]
							],
							set(structuralHash, exact)
						)
						for (const [name, laws] of model.relations) {
							sameApartFromLabels(
								laws,
								whole.relations.get(name),
								`${name}'s keys and unique objects`
							)
						}

						const tables = new Map(
							Arr.map([...whole.relations.values()], (r) => [r.relation.ident, r.relation.name])
						)
						const written = (ident: RelationIdent): boolean => {
							const name = tables.get(ident)
							return name !== undefined && writes.has(name)
						}
						const intoWrites = new Set(
							Arr.flatMap(whole.natives, (n) =>
								n.namespace === "constraint" &&
								(n.object.kind === "ForeignKey" || n.object.kind === "PeriodForeignKey") &&
								writes.has(n.object.target.name)
									? [`${n.owner} ${identifierOf(n.named)}`]
									: []
							)
						)
						const witness = installationWitness(sliced, noLevelAbove).laws
						for (const e of wholeArtifacts.constraintLaws) {
							switch (e.kind) {
								case "constraint":
								case "trigger": {
									if (!written(e.owner) && !intoWrites.has(`${e.owner} ${e.name}`)) {
										break
									}
									const raised = witness.lawsOf(e.name, { kind: "table", name: e.owner })
									assert.deepEqual(
										defined(raised, `${e.name} on ${e.owner} names a law`).laws,
										e.laws,
										`the laws ${e.name} on ${e.owner} reports, described as the whole model does`
									)
									break
								}
								case "domainConstraint": {
									const uses = Arr.filter(e.uses, (u) => written(u.table))
									if (!Arr.isReadonlyArrayNonEmpty(uses)) {
										break
									}
									const raised = defined(
										witness.lawsOf(e.name, { kind: "domain", name: e.owner }),
										`the domain ${e.owner} names its laws`
									)
									for (const u of uses) {
										assert.ok(
											Arr.some(
												raised.uses,
												(r) =>
													r.table === u.table &&
													r.column === u.column &&
													canonicalEquals(r.law, u.law, labelFree)
											),
											`the domain ${e.owner} names ${u.table}.${u.column}'s law`
										)
									}
									break
								}
							}
						}

						for (const u of c.uses) {
							const program = programOf(c, u)
							if (program.kind !== "changeSet") {
								continue
							}
							const role = defined(roles.get(roleName(u.role)), "the use's role")
							const overWhole = compiledChange(wholeArtifacts, role, program.changeSet)
							const overSlice = compiledChange(sliced, role, program.changeSet)
							assert.deepEqual(
								overSlice.ok,
								overWhole.ok,
								"the ChangeSet compiles over the slice exactly when it compiles over the whole schema"
							)
							if (overWhole.ok && overSlice.ok) {
								sameApartFromLabels(
									{
										optimized: overSlice.value.optimized,
										certificates: overSlice.value.certificates,
										requirements: overSlice.value.requirements
									},
									{
										optimized: overWhole.value.optimized,
										certificates: overWhole.value.certificates,
										requirements: overWhole.value.requirements
									},
									"the ChangeSet's statements, certificates and requirements, as over the whole schema"
								)
								k.note("a ChangeSet compiled over the slice")
							}
						}

						const all = Rec.keys(owned.relations)
						if (Arr.some(all, (r) => !names.has(r))) {
							k.note("a relation outside the names")
						}
						const seeded = new Set(
							Arr.flatMap(c.uses, (u) => Arr.map(u.writes, (i) => ordinaryName(c, i)))
						)
						if (writes.size > seeded.size) {
							k.note("a family coupling widens the writes")
						}
						if (
							Arr.some(
								[...writes],
								(w) =>
									!seeded.has(w) &&
									!Arr.some(c.families, (d) => {
										const pair = [rootName(d.owner), rootName(d.member)]
										return pair.includes(w) && Arr.some(pair, (p) => seeded.has(p))
									})
							)
						) {
							k.note("a family chain widens the writes")
						}
						if (
							Arr.some(c.uses, (u) =>
								Arr.some(u.reads, (r) => r.kind === "derived" || r.kind === "chained")
							)
						) {
							k.note("a derived relation's definition named")
						}
						if (Arr.some(c.uses, (u) => Arr.some(u.reads, (r) => r.kind === "world"))) {
							k.note("a world entry names its relation")
						}
						const cycleOf = (r: string) =>
							Arr.findFirst(whole.fkCycles, (cycle) => cycle.includes(r))
						if (
							Arr.some(whole.natives, (n) => {
								if (n.object.kind !== "ForeignKey") {
									return false
								}
								const from = n.object.relation.name
								const to = n.object.target.name
								return (
									!names.has(from) &&
									!names.has(to) &&
									Option.exists(cycleOf(from), (cycle) => cycle.includes(to))
								)
							})
						) {
							k.note("a foreign-key cycle through a key between two relations outside the names")
						}
						if (
							Arr.some(
								containments,
								(e) => !names.has(e.from.relation) || !names.has(e.to.relation)
							)
						) {
							k.note("evidence of a containment reading a relation outside the names")
						}
						if (
							Arr.some(
								[...selectionKeys.keys()],
								(r) => names.has(r) && !writes.has(r) && (selectionKeys.get(r)?.length ?? 0) > 0
							)
						) {
							k.note("a selection key on a named relation outside the writes")
						}
						if (model.rules.length > 0) {
							k.note("a rule reading the writes")
						}
						if (
							Arr.some(whole.natives, (n) => n.object.kind === "Domain") &&
							Arr.some(
								c.families,
								(d) => !names.has(rootName(d.owner)) || !names.has(rootName(d.member))
							)
						) {
							k.note("a contract's domain used outside the names")
						}
					})
			)
		)
	)
})
