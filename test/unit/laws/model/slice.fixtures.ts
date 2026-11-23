/** What the properties of slice.test.ts read: their spaces, the slice computed from a draw, and their helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	boolean,
	type Gen,
	int,
	uniqueKeys
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { encode, type EncodeOptions, type OmitRule, sameUnder } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import {
	type ChangeSetDesc,
	decodeDesc,
	type ExprDesc,
	type GuardDesc,
	guardedExpr,
	type ProgramDesc,
	type QueryDesc
} from "#compiler/ir/desc.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { ProgramArtifacts } from "#compiler/ir/products.ts"
import type { LawModel, NamedNative } from "#compiler/laws/model/model.ts"
import { namedRole, selectionKeysOf } from "#compiler/physical/ddl/names.ts"
import { compileQuery, type QueryTemplate, querySchema } from "#compiler/program/compile.ts"
import { type SchemaInput } from "#compiler/program/input.ts"
import { roleArtifacts, type SchemaArtifacts } from "#compiler/program/schema.ts"
import { writeWorldOf } from "#compiler/program/write-world.ts"
import { fullRoleDesc, type OwnedLogin, type OwnedRole, ownLogin } from "#compiler/schema/own.ts"
import { carrierScope } from "#compiler/sql/naming.ts"
import type { RecordedLaw } from "#compiler/types/changeset/changeset.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
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
	type MatchDesc,
	on,
	onWhere,
	ordered,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { spelled } from "#test/support/fixtures/ir/scalar.ts"
import { upTo } from "#test/support/up-to.ts"

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
 * - the planned laws: every law a compile over the slice reads, one reading a written relation, one reading only named
 *   relations, and one whose foreign key references a named relation's selected side, a containment's or a rule's
 *   lowered to foreign keys, and every contract's law, each with the whole model's plan, deferral (the whole model's
 *   cycles, which may run through relations outside the names) and immediacy;
 * - what a read relies on: the key, row-check and containment evidence of the planned laws, each containment under the
 *   whole model's validity context, the existence evidence of the containments that read a written relation or only
 *   named ones, and each named relation's selection keys;
 * - the natives the planned laws plan that a write or a read relies on, each discharging the planned laws alone, the
 *   rules that read a written relation, and the written relations with their keys and unique objects;
 * - the installation's natives: every native of the slice's model is one the whole model holds, by its name and its
 *   definition apart from the laws it discharges, so a login's served compile names no constraint, column or index the
 *   installation lacks: a whole-schema decision, a fixed target's reference, is the whole schema's recorded choice,
 *   read and never recomputed; and a UNIQUE a key implies reports that key's law first, as the installation's does,
 *   whether the slice plans the key or not (keyLawsOf);
 * - what the slice compiles: the natives a write of it can raise, of its written relations and the foreign keys into
 *   them, in the whole model's order, names, laws and descriptions; every constraint a write of the slice can raise
 *   naming the whole model's laws in the witness, and every law over a written relation, which a write statement's
 *   refusal raises, described there as the whole model describes it; each program's query, compiled through its role
 *   as db.read compiles it in either context, and each program's ChangeSet, compiled through its role as db.apply
 *   compiles it, compiling over the slice exactly when it does over the whole schema, to the same statements and
 *   certificates;
 * - what a served file's refusals keep (program/schema.ts raisableOf over the whole schema's artifacts, of every relation
 *   the compiled ChangeSets write and the relations those writes change, schema/reach.ts writesOf, which are the draw's
 *   writes): every constraint, rule trigger and law it keeps the slice's model holds, and every one the slice's model
 *   holds that it drops is on no written relation, no foreign key into one, is a domain's whose columns in the whole
 *   schema are none of a written relation's, or reads no written relation, so a write of the login raises nothing the
 *   file lacks.
 *
 * The box: two to four relations at the root level, with ordered and counted families (chains included), keys over a
 * selection, containments between them (cycles included), row checks, and containments into a roster or a selection
 * of it; derived relations of them at the level above, and over those at a third; up to two
 * relations at the level
 * above, containing into a relation below or into a derived relation of one (a rule over a query, lowered to a foreign
 * key where the derived relation reads its rows by a constant, its triggers kept where by another condition); one or
 * two roles,
 * each holding every relation whole beside world entries over relations below; and one to three programs, each a query
 * or a ChangeSet with read-backs.
 *
 * A second property: ownership refuses a derived definition matching a live derived relation by its name, which stores
 * nothing to match, directly or through a nested query (README's derived tables: a query over a live derived relation
 * reads its definition).
 *
 * Features: SliceFeature, the shapes and laws each case reached; a direct and a nested match for the second.
 */

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
	/** Whether a query over a root relation first also delivers its text cast into the refinement only the level
	 * above's relations declare. */
	readonly casts: boolean
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
	const keys = s.draw(uniqueKeys(root, { min: 0, max: 2 }))
	const link: Gen<LinkDraw> = (t) => {
		const to = t.draw(root)
		return { from: t.draw(root), to, selected: keys.includes(to) && t.draw(boolean) }
	}
	const up: Gen<UpDraw> = (t) => ({ from: t.draw(int(0, tops - 1)), to: t.draw(root) })
	const crossings = tops === 0 ? [] : s.draw(array(up, { min: 0, max: 2 }))
	const rules = tops === 0 ? [] : s.draw(array(up, { min: 0, max: 2 }))
	const derived = distinct([
		...s.draw(uniqueKeys(root, { min: 0, max: 2 })),
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
		writes: t.draw(uniqueKeys(ordinary, { min: 0, max: 3 })),
		worlds: t.draw(uniqueKeys(root, { min: 0, max: 2 }))
	})
	const [firstRole, ...moreRoles] = s.draw(array(roleGen, { min: 1, max: 2 }))
	const roles: Arr.NonEmptyReadonlyArray<RoleDraw> = [defined(firstRole, "a role"), ...moreRoles]
	const readGen =
		(r: RoleDraw): Gen<Read> =>
		(t) => {
			const options: ReadonlyArray<Read> = [
				...upTo(roots, (at): Read => ({ kind: "root", at })),
				...upTo(tops, (at): Read => ({ kind: "top", at })),
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
			? Arr.map(t.draw(uniqueKeys(int(0, r.writes.length - 1), { min: 1, max: 2 })), (i) =>
					defined(r.writes[i], "a write of the role")
				)
			: []
		const reads = t.draw(array(readGen(r), { min: changes ? 0 : 1, max: 3 }))
		return { role, kind: changes ? "changes" : "query", writes, reads, casts: t.draw(boolean) }
	}
	const [firstUse, ...moreUses] = s.draw(array(useGen, { min: 1, max: 3 }))
	return {
		roots,
		tops,
		families: familiesOf(s.draw(array(family, { min: 0, max: 3 }))),
		keys,
		links: s.draw(array(link, { min: 0, max: 4 })),
		checks: s.draw(uniqueKeys(root, { min: 0, max: 2 })),
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

/**
 * A case of two relations of the level above, each with a rule into one derived relation that lowers to a foreign key,
 * and a ChangeSet writing one of them: the fixed target both rules reference, which a slice holding one of them sees
 * half of, so a choice its own closure made would differ from the whole schema's (laws/model/model.ts referenceChoice).
 */
const sharedRuleGen: Gen<SliceCase> = (s) => {
	const roots = s.draw(int(2, 4))
	const to = 2 * s.draw(int(0, Math.floor((roots - 1) / 2)))
	const written = roots + s.draw(int(0, 1))
	return {
		roots,
		tops: 2,
		families: [],
		keys: [],
		links: [],
		checks: [],
		rosters: [],
		derived: [to],
		chained: [],
		crossings: [],
		rules: [
			{ from: 0, to },
			{ from: 1, to }
		],
		roles: [{ writes: [written], worlds: [] }],
		uses: [{ role: 0, kind: "changes", writes: [written], reads: [], casts: false }]
	}
}

/**
 * The drawn cases, aimed: a case whose turn aims at two lowered rules into one relation, one reading the writes and one
 * not, is drawn as that shape (sharedRuleGen), which a drawn case seldom is.
 */
export const caseSpace: Aimed<SliceCase, SliceFeature> = aimed(caseGen, [
	["a lowered rule reading the writes beside one outside them, into one relation", sharedRuleGen]
])

/**
 * Whether two rules lowered to foreign keys read one relation, one of them reading a written relation and the other
 * none: the shape whose fixed target a slice sees half the uses of.
 */
export const sharesLoweredTarget = (
	laws: LawModel["theory"]["laws"],
	writes: ReadonlySet<string>
): boolean => {
	const lowered = Arr.filter(
		laws,
		(l) => l.detail.kind === "rule" && l.detail.lowering.kind === "foreignKeys"
	)
	const reading = (l: LawModel["theory"]["laws"][number]): boolean =>
		Arr.some(l.reads, (r) => writes.has(r))
	return Arr.some(
		lowered,
		(l) =>
			reading(l) &&
			Arr.some(lowered, (m) => !reading(m) && Arr.some(m.reads, (r) => l.reads.includes(r)))
	)
}

export const rootName = (i: number): string => `R${i}`
export const topName = (i: number): string => `T${i}`
export const derivedName = (i: number): string => `D${i}`
export const chainedName = (i: number): string => `E${i}`
const worldName = (i: number): string => `V${i}`
const roster = "Color"

/** The name of the case's i-th ordinary relation, the root's first. */
export const ordinaryName = (c: SliceCase, i: number): string =>
	i < c.roots ? rootName(i) : topName(i - c.roots)

const live = eq(field("on"), literal(true))

/** Root relation i's fields: its own, then the count of each family it owns and the group and index of each it is a
 * member of. */
/** A refinement the level above's relations declare on a field, and no root relation does: a root's bounded text cast
 * into it, under a guard that it matches, is delivered through the refinement's domain. */
const refinedPattern = "^[a-z]{1,8}$"
const refined = f.regex(refinedPattern, "u")

const rootFields = (c: SliceCase, i: number) => ({
	id: f.integer,
	t: f.regex("^.{0,8}$", "su"),
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

/**
 * A match source as the query builder writes it: a relation by its name, or, for a live derived relation, which stores
 * nothing to match, the query it is defined by.
 */
type Source =
	| { readonly kind: "relation"; readonly name: string }
	| { readonly kind: "query"; readonly query: QueryDesc }

/** A match of `source` binding its `id` to `id`, and its `on` to true when `selected`. */
const matchOf = (source: Source, id: string, selected: boolean): MatchDesc => ({
	source:
		source.kind === "relation" ? source : { kind: "query" as const, query: source.query, bind: {} },
	bindings: selected
		? { id: { kind: "var", var: id }, on: literal(true) }
		: { id: { kind: "var", var: id } }
})

/** A variable taking `source`'s id: from a relation's field, or fresh over a definition. */
const varOf = (source: Source, id: string) => ({
	id,
	origin: source.kind === "relation" ? { relation: source.name, field: "id" } : undefined
})

/** The query of the ids of `source`'s facts whose `on` holds, when `selected`, or of every fact. */
const idsOf = (source: Source, selected: boolean): QueryDesc =>
	decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [varOf(source, "id")],
				matches: [matchOf(source, "id", selected)],
				where: [],
				head: { id: { kind: "var", var: "id" } },
				interiors: [],
				attach: []
			}
		]
	})

const named = (name: string): Source => ({ kind: "relation", name })

/**
 * The ids of root relation `relation`'s rows whose `on` is not false: its live rows, read by a condition no foreign key
 * states, so a rule into a relation so defined keeps its triggers (analysis/theory/laws.ts RuleLowering).
 */
const notFalseIdsOf = (relation: string): QueryDesc =>
	decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [
					{ id: "id", origin: { relation, field: "id" } },
					{ id: "on", origin: { relation, field: "on" } }
				],
				matches: [
					{
						source: { kind: "relation", name: relation },
						bindings: { id: { kind: "var", var: "id" }, on: { kind: "var", var: "on" } }
					}
				],
				where: [
					{ kind: "compare", op: "ne", left: { kind: "var", var: "on" }, right: literal(false) }
				],
				head: { id: { kind: "var", var: "id" } },
				interiors: [],
				attach: []
			}
		]
	})

/**
 * The definition of D_i: the ids of root relation i's live rows, read by its `on` bound to true where i is even, so a
 * rule into D_i lowers to a foreign key, and by its `on` not false where i is odd, so a rule into D_i keeps its
 * triggers.
 */
const derivedDefinition = (i: number): QueryDesc =>
	i % 2 === 0 ? idsOf(named(rootName(i)), true) : notFalseIdsOf(rootName(i))

/** How a query reads a derived relation: through its definition, a live derived relation storing nothing to match. */
const derivedSource = (definition: QueryDesc): Source => ({ kind: "query", query: definition })

/** The definition of E_i: the ids of D_i, read as a query reads it. */
const chainedDefinition = (i: number): QueryDesc =>
	idsOf(derivedSource(derivedDefinition(i)), false)

/** A live derived relation of derived level 1 over the ids `query` reads. */
const derivedOf = (name: string, query: QueryDesc): AuthoredRelationDesc => ({
	kind: "derived",
	name,
	level: 1,
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
			closed.ordered(roster, ["red", "green"]),
			...upTo(c.roots, (i) => relation(rootName(i), rootFields(c, i), ["id"]))
		],
		statements: rootStatements(c),
		bases: []
	}
	const top: SchemaDesc = {
		name: "SliceTop",
		relations: [
			...upTo(c.tops, (i) =>
				relation(topName(i), { id: f.integer, a: f.integer, r: f.integer, s: refined }, ["id"])
			),
			...Arr.map(c.derived, (i) => derivedOf(derivedName(i), derivedDefinition(i)))
		],
		statements: [
			...Arr.map(c.crossings, (u) =>
				contained(on(topName(u.from), ["a"]), on(rootName(u.to), ["id"]))
			),
			...Arr.map(c.rules, (u) =>
				contained(on(topName(u.from), ["r"]), on(derivedName(u.to), ["id"]))
			)
		],
		bases: [root]
	}
	return Arr.isReadonlyArrayNonEmpty(c.chained)
		? {
				name: "SliceChain",
				relations: Arr.map(c.chained, (i) => derivedOf(chainedName(i), chainedDefinition(i))),
				statements: [],
				bases: [top]
			}
		: top
}

const loc = SourceLoc("the slice test's login", [])

export const roleName = (k: number): string => `w${k}`

/** The login of the case's roles over its schema: each holds every relation whole and its world entries, and writes its
 * draw. */
export const loginOf = (c: SliceCase): OwnedLogin => {
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
				query: idsOf(named(rootName(i)), true),
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

/**
 * The source a read matches, as its role's query writes it: an entry by its name, a derived relation through its
 * definition.
 */
const sourceOf = (read: Read): Source => {
	switch (read.kind) {
		case "root":
			return named(rootName(read.at))
		case "top":
			return named(topName(read.at))
		case "derived":
			return derivedSource(derivedDefinition(read.at))
		case "chained":
			return derivedSource(chainedDefinition(read.at))
		case "world":
			return named(worldName(read.at))
		case "roster":
			return named(roster)
	}
}

/**
 * A query over the sources `reads` names, each matched apart, its head the first's ids; and, when `casts` and the first
 * is a root relation, the first's text cast into `refined`, which only its pattern's domain admits.
 */
const queryOver = (reads: Arr.NonEmptyReadonlyArray<Read>, casts: boolean): QueryDesc => {
	const [first] = reads
	const matches = Arr.map(reads, (r, k) => matchOf(sourceOf(r), `x${k}`, false))
	const vars = Arr.map(reads, (r, k) => varOf(sourceOf(r), `x${k}`))
	if (!casts || first.kind !== "root") {
		return decodedQuery({
			kind: "rules",
			arms: [
				{
					vars,
					matches,
					where: [],
					head: { id: { kind: "var", var: "x0" } },
					interiors: [],
					attach: []
				}
			]
		})
	}
	const [head, ...rest] = matches
	const refinedMatch: GuardDesc = { kind: "matches", pattern: spelled(refinedPattern) }
	const text: ExprDesc = { kind: "var", var: "text" }
	return decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [...vars, { id: "text", origin: { relation: rootName(first.at), field: "t" } }],
				matches: [
					{ ...head, bindings: { ...head.bindings, t: { kind: "var", var: "text" } } },
					...rest
				],
				where: [],
				head: {
					id: { kind: "var", var: "x0" },
					refined: {
						kind: "when",
						guard: refinedMatch,
						subject: text,
						proved: { kind: "cast", to: refined, arg: guardedExpr(refinedMatch, text) },
						otherwise: { kind: "literal", value: "a", type: refined }
					}
				},
				interiors: [],
				attach: []
			}
		]
	})
}

/** The program a use runs: its query, or its ChangeSet of an insert into each of its writes, reading back its reads. */
export const programOf = (
	c: SliceCase,
	u: Use
): Extract<ProgramDesc, { readonly kind: "query" | "changeSet" }> => {
	if (u.kind === "query") {
		const [first, ...more] = u.reads
		return {
			kind: "query",
			query: queryOver([defined(first, "a query's read"), ...more], u.casts)
		}
	}
	const [first, ...more] = u.reads
	const changeSet = succeeded(
		decodeDesc("changeSet", {
			strata: [
				{
					members: Arr.map(u.writes, (i, k) => ({
						op: "insert",
						relation: ordinaryName(c, i),
						member: { kind: "array", slot: `s${k}` }
					}))
				}
			],
			reads:
				first === undefined ? [] : [{ name: "back", query: queryOver([first, ...more], u.casts) }],
			bindings: [],
			boundRows: {}
		}),
		"the use's ChangeSet"
	)
	return { kind: "changeSet", changeSet }
}

/**
 * The slice of the case's programs, computed from the draw alone. Writes: each ChangeSet's targets, closed under the
 * families, a member and its owner writing each other. Names: the writes and every relation a program reads, a whole
 * entry its relation, a world entry the root relation its query reads, and a derived relation, which a query reads
 * through its definition, what that reads down every level.
 */
export const expectedSlice = (
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
			case "chained":
				return [rootName(read.at)]
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
const labelMembers: OmitRule = (k, value) =>
	typeof value === "function" ||
	k === "deps" ||
	((k === "id" || k === "node" || k === "canonical") && typeof value === "string") ||
	(k === "rows" && !Arr.isArray(value))

const labelFree: EncodeOptions = { omit: labelMembers }

/** Whether two values are equal apart from DAG labels (labelFree), walked as canonicalEquals walks them. */
export const sameLabelFree: (a: unknown, b: unknown) => boolean = sameUnder(labelMembers)

export const sameApartFromLabels = (a: unknown, b: unknown, why: string): void =>
	assert.ok(sameLabelFree(a, b), why)

/** A value's canonical text apart from DAG labels (labelFree), none for a value that has none. */
export const labelFreeText = (value: unknown): Option.Option<string> => {
	const text = encode(value, labelFree)
	return text.ok ? Option.some(text.value) : Option.none()
}

/**
 * Two lists of natives holding the same natives, each equal apart from DAG labels, in any order: a model orders its
 * natives by the first law that plans each, and a slice plans fewer laws. Each native is encoded once and matched by
 * its text, so a native that has no text matches none.
 */
export const sameNatives = (
	actual: ReadonlyArray<NamedNative>,
	expected: ReadonlyArray<NamedNative>
): void => {
	const left = [...actual]
	const leftTexts = Arr.map(left, labelFreeText)
	const missing: Array<string> = []
	for (const n of expected) {
		const text = labelFreeText(n)
		const at = Arr.findFirstIndex(
			leftTexts,
			(m) => Option.isSome(m) && Option.isSome(text) && m.value === text.value
		)
		if (Option.isSome(at)) {
			left.splice(at.value, 1)
			leftTexts.splice(at.value, 1)
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
 * Whether a write of the slice can raise `n`: a native of a written relation, a foreign key or PERIOD foreign key into
 * one, or a contract's domain. Each such native is the whole model's in its installed name, the laws it discharges, the
 * law it is described by and its order among them, since every law it discharges reads a written relation, or is a
 * contract's, and is planned. A native of a named relation no write of the slice meets discharges the planned laws among
 * the whole model's (`heldOver`, compared apart), and a query reads of it only its name, the evidence of its planned
 * laws and its selection keys, each compared apart; a roster's domain reports grizzle's own defect, no law.
 */
export const raisableOver =
	(writes: ReadonlySet<string>) =>
	(n: NamedNative): boolean => {
		switch (n.object.kind) {
			case "ForeignKey":
			case "PeriodForeignKey":
				return writes.has(n.object.relation.name) || writes.has(n.object.target.name)
			case "RosterDomain":
				return false
			case "Domain":
				return true
			case "PrimaryKey":
			case "Unique":
			case "WithoutOverlaps":
			case "TableCheck":
			case "ClosedCheck":
			case "LawColumn":
			case "ReverseIndex":
				return writes.has(n.object.relation.name)
		}
	}

/** A native as a reader names it: its kind, its relation and its installed name where it has one. */
export const nativeName = (n: NamedNative): string =>
	`${n.object.kind} ${relationOf(n) ?? "-"} ${n.namespace === "constraint" || n.namespace === "column" ? identifierOf(n.named) : "-"}`

/**
 * A native as the installation holds it, by its name and its definition apart from the laws it discharges, which a
 * slice's model narrows to the ones it plans: a slice's model holds no other.
 */
export const installedForm = (n: NamedNative): unknown => ({
	name: nativeName(n),
	object: { ...n.object, lawIds: [] }
})

/**
 * The laws a model over the slice plans, read off the whole model: each law a compile over the slice reads, and every
 * contract's law, whose domain types context fields and parameters beyond any relation. A law reading a written
 * relation, whose natives a write can break, is ordered by or refuses by; a law reading only named relations, whose
 * evidence a query over them relies on; and a containment into a selected side of a named relation, whose UNIQUE over
 * the side's law columns is a selection key a probe of that relation reads. A law joining a named relation to one the
 * slice neither names nor writes is none of them: no write meets its natives, and no query reads the relation its
 * evidence joins to. Each keeps the whole model's plan, deferral and immediacy.
 */
export const plannedOver = (
	whole: LawModel,
	names: ReadonlySet<string>,
	writes: ReadonlySet<string>
): ReadonlySet<LawId> =>
	new Set(
		Arr.flatMap(whole.theory.laws, (law) =>
			law.shape === "contract" ||
			Arr.some(law.reads, (r) => writes.has(r)) ||
			Arr.every(law.reads, (r) => names.has(r)) ||
			Arr.some(
				law.detail.kind === "containment"
					? [law.detail.to]
					: law.detail.kind === "rule" && law.detail.lowering.kind === "foreignKeys"
						? Arr.map(law.detail.lowering.parts, (part) => part.to)
						: [],
				(to) => names.has(to.relation) && Arr.isReadonlyArrayNonEmpty(to.selection.conjuncts)
			)
				? [law.id]
				: []
		)
	)

/**
 * Each key law of a law model by the relation it keys: every primary key, declared key and key over a projected side,
 * the keys a generated UNIQUE may imply (laws/model/model.ts #implyingKey).
 */
const keyLawsOf = (model: LawModel): ReadonlyMap<LawId, string> =>
	new Map([
		...Arr.map(model.theory.primaryKeys, (pk) => [pk.law.id, pk.relation.name] as const),
		...Arr.flatMap(model.theory.laws, (law): ReadonlyArray<readonly [LawId, string]> =>
			law.detail.kind === "key"
				? [[law.id, law.detail.relation]]
				: law.detail.kind === "projectedKey"
					? [[law.id, law.detail.side.relation]]
					: []
		)
	])

/**
 * A native discharging only the laws of `planned`, in its order, a constraint described by the first of them, the law
 * it reports when nothing narrows it; but a UNIQUE whose first law is a key of its own relation, a key that implies it,
 * which the slice's model places first whether it plans that key or not, so its constraint reports the key's law as the
 * installation's does.
 */
const dischargingOnly = (
	n: NamedNative,
	planned: ReadonlySet<LawId>,
	keyLaws: ReadonlyMap<LawId, string>,
	described: (law: LawId) => RecordedLaw
): NamedNative => {
	const [reported] = n.object.lawIds
	const implying =
		n.object.kind === "Unique" && keyLaws.get(reported) === n.object.relation.name ? [reported] : []
	const [head, ...rest] = Arr.dedupe([
		...implying,
		...Arr.filter(n.object.lawIds, (l) => planned.has(l))
	])
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
export const heldOver = (
	whole: SchemaArtifacts,
	planned: ReadonlySet<LawId>,
	writes: ReadonlySet<string>
): ReadonlyArray<{ readonly whole: NamedNative; readonly held: NamedNative }> => {
	const laws = new Map<LawId, RecordedLaw>(
		Arr.map(whole.theoryLaws, (l) => [l.law, l.described] as const)
	)
	const described = (law: LawId): RecordedLaw => defined(laws.get(law), `${law} is described`)
	const keyLaws = keyLawsOf(whole.laws)
	const plannedNatives = Arr.flatMap(whole.laws.natives, (n) =>
		Arr.some(n.object.lawIds, (l) => planned.has(l))
			? [{ whole: n, held: dischargingOnly(n, planned, keyLaws, described) }]
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

export type SliceFeature =
	| "a relation outside the names"
	| "a family coupling widens the writes"
	| "a family chain widens the writes"
	| "a derived relation's definition named"
	| "a world entry names its relation"
	| "a foreign-key cycle through a key between two relations outside the names"
	| "evidence of a containment reading a relation outside the names"
	| "a selection key on a named relation outside the writes"
	| "a rule reading the writes"
	| "a lowered rule reading the writes"
	| "a lowered rule reading the writes beside one outside them, into one relation"
	| "a contract's domain used outside the names"
	| "a ChangeSet compiled over the slice"
	| "a query compiled over the slice"
	| "a query of a derived relation compiled over the slice"
	| "a query casting into a refinement no named relation declares"

export const features: Arr.NonEmptyReadonlyArray<SliceFeature> = [
	"a relation outside the names",
	"a family coupling widens the writes",
	"a family chain widens the writes",
	"a derived relation's definition named",
	"a world entry names its relation",
	"a foreign-key cycle through a key between two relations outside the names",
	"evidence of a containment reading a relation outside the names",
	"a selection key on a named relation outside the writes",
	"a rule reading the writes",
	"a lowered rule reading the writes",
	"a lowered rule reading the writes beside one outside them, into one relation",
	"a contract's domain used outside the names",
	"a ChangeSet compiled over the slice",
	"a query compiled over the slice",
	"a query of a derived relation compiled over the slice",
	"a query casting into a refinement no named relation declares"
]

/**
 * A ChangeSet compiled as a role's db.apply compiles it (adapter/apply/compile.ts writeEntry): against `base`'s
 * artifacts read through the role's views (roleArtifacts), in the role's world, for a Db holding no context's fact.
 */
export const compiledChange = (
	base: SchemaArtifacts,
	role: OwnedRole,
	changeSet: ChangeSetDesc
): Result.Result<CompiledWrite, CompileError> =>
	Result.flatMap(
		Result.flatMap(namedRole(role, base.names.levels), (named) => roleArtifacts(named, base)),
		(artifacts) => {
			const world = artifacts.world
			return compileWrite(
				world.kind === "role" ? world.checked : artifacts.derived.schema,
				changeSet,
				{
					names: artifacts.names,
					reads: artifacts.reads,
					claims: { kind: "facts", present: new Set() },
					world: writeWorldOf(world, artifacts.laws),
					laws: artifacts.laws,
					derived: artifacts.derived,
					level: "serializable",
					clock: noClock,
					source: transactionClock,
					carrierScope: carrierScope(world.kind === "role" ? world.role.name : undefined)
				}
			)
		}
	)

/**
 * A query compiled as a role's db.read compiles it (program/template.ts templateFor): against `base`'s artifacts read
 * through the role's views, as a Description over the schema `schema`, for `context`.
 */
export const compiledQuery = (
	base: SchemaArtifacts,
	role: OwnedRole,
	schema: SchemaInput,
	query: QueryDesc,
	context: TemplateContext
): Result.Result<QueryTemplate, CompileError> =>
	Result.flatMap(
		Result.flatMap(namedRole(role, base.names.levels), (named) => roleArtifacts(named, base)),
		(artifacts) =>
			Result.flatMap(querySchema({ kind: "described", desc: query }, schema), (source) =>
				compileQuery(source, {
					context,
					artifacts,
					read: "rows",
					clock: noClock,
					source: transactionClock
				})
			)
	)

/** What an application runs of a template or a program and what it rests on: its statements and its certificates. */
export const ran = <S>(p: ProgramArtifacts<S>) => ({
	optimized: p.optimized,
	certificates: p.certificates
})

/**
 * A schema whose derived relation E_at matches the live derived relation D_at by its name, as no query builder writes a
 * match of a live derived relation: directly, or inside a query it matches, `nested`.
 */
interface ByName {
	readonly c: SliceCase
	readonly at: number
	readonly nested: boolean
}

export const byNameGen: Gen<ByName> = (s) => {
	const drawn = s.draw(caseGen)
	const at = s.draw(int(0, drawn.roots - 1))
	const c: SliceCase = {
		...drawn,
		derived: distinct([...drawn.derived, at]),
		chained: distinct([...drawn.chained, at])
	}
	return { c, at, nested: s.draw(boolean) }
}

/** The case's schema with E_at's definition matching D_at by name, at the level above D_at's. */
export const byNameSchema = (b: ByName): SchemaDesc => {
	const whole = schemaOf(b.c)
	const direct = idsOf(named(derivedName(b.at)), false)
	const definition = b.nested ? idsOf({ kind: "query", query: direct }, false) : direct
	return {
		...whole,
		relations: Arr.map(whole.relations, (r) =>
			r.kind === "derived" && r.name === chainedName(b.at)
				? { ...r, level: 2, query: definition }
				: r
		)
	}
}

/** What the by-name property notes: a direct match of a live derived relation by its name, or one nested in a query. */
export type ByNameFeature = "a direct match by name" | "a match by name inside a matched query"
