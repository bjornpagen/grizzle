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
 * of it; derived relations of them at the level above, and over those at a third, each live or materialized; up to two
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
 * Plants (~/.cache/grizzle-release/BR03/plants): slice-coupling-one-step (a slice's writes closed under family coupling
 * one step only, so a chain's far end is left out) and slice-lowered-rule-unplanned (a rule over a query lowered to
 * foreign keys into a named relation's selected side left unplanned, so the slice lacks that relation's selection key)
 * and slice-recomputes-reference-choice (a slice compile chooses each fixed target's reference over its own closure in
 * place of the whole schema's recorded choice, so it plans a native the installation lacks) for the slice; live-derived-by-name-admitted (a definition matching a live derived relation by name admitted) for
 * the second.
 *
 * Features: SliceFeature, the shapes and laws each case reached; a direct and a nested match for the second.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int } from "@grizzle/testing/gen"
import { agree, exact, set, structuralHash } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import { installationWitness } from "#adapter/served/refusals.ts"
import { noLevelAbove } from "#adapter/witness/keylaw.ts"
import { canonicalEquals, type EncodeOptions } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { LawId, RelationIdent } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { noClock } from "#compiler/ir/clock.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import {
	type ChangeSetDesc,
	type ClockedProgramDesc,
	decodeDesc,
	type QueryDesc
} from "#compiler/ir/desc.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { ProgramArtifacts } from "#compiler/ir/products.ts"
import { contractOf, type ScalarType, textOf } from "#compiler/ir/scalar.ts"
import type { LawModel, NamedNative } from "#compiler/laws/model/model.ts"
import { namedRole, selectionKeysOf } from "#compiler/physical/ddl/names.ts"
import { installBasis, unserved, planBasis } from "#compiler/physical/install/plan.ts"
import { compileQuery, type QueryTemplate, querySchema } from "#compiler/program/compile.ts"
import {
	baseArtifacts,
	parseSchemaInput,
	raisableOf,
	roleArtifacts,
	type SchemaArtifacts,
	type SchemaInput
} from "#compiler/program/schema.ts"
import {
	fullRoleDesc,
	type OwnedLogin,
	type OwnedRole,
	own,
	ownLogin,
	rostersOf
} from "#compiler/schema/own.ts"
import { everySlice, sliceOf, writesOf } from "#compiler/schema/reach.ts"
import type { OwnLaw } from "#compiler/types/changeset/changeset.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { assert, assertVariant, defined, succeeded } from "#test/support/assert.ts"
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
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"

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
	/** The derived relations stored as materialized views, which a role holds as entries and a query matches by name;
	 * the others are live, read through their definitions. */
	readonly materialized: ReadonlyArray<string>
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
	const materialized = Arr.filter(
		[...Arr.map(derived, derivedName), ...Arr.map(chained, chainedName)],
		() => s.draw(boolean)
	)
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
			? distinct(
					Arr.map(t.draw(array(int(0, r.writes.length - 1), { min: 1, max: 2 })), (i) =>
						defined(r.writes[i], "a write of the role")
					)
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
		checks: distinct(s.draw(array(root, { min: 0, max: 2 }))),
		rosters: s.draw(
			array((t): RosterDraw => ({ from: t.draw(root), selected: t.draw(boolean) }), {
				min: 0,
				max: 2
			})
		),
		derived,
		chained,
		materialized,
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

/** How a query reads a derived relation: a materialized one by its name, a live one through `definition`. */
const derivedSource = (c: SliceCase, name: string, definition: QueryDesc): Source =>
	c.materialized.includes(name) ? named(name) : { kind: "query", query: definition }

/** The definition of E_i: the ids of D_i, read as a query reads it. */
const chainedDefinition = (c: SliceCase, i: number): QueryDesc =>
	idsOf(derivedSource(c, derivedName(i), derivedDefinition(i)), false)

/** The derived level of E_i: one above D_i's where it reads D_i's view, D_i's own where it reads its definition. */
const chainedLevel = (c: SliceCase, i: number): number =>
	c.materialized.includes(derivedName(i)) ? 2 : 1

/** A derived relation of derived level `level` over the ids `query` reads, materialized or live as the case draws. */
const derivedOf = (
	c: SliceCase,
	name: string,
	level: number,
	query: QueryDesc
): AuthoredRelationDesc => ({
	kind: "derived",
	name,
	level,
	storage: c.materialized.includes(name) ? "materialized" : "live",
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
			...upTo(c.roots, (i) => relation(rootName(i), rootFields(c, i), ["id"]))
		],
		statements: rootStatements(c),
		extends: undefined
	}
	const top: SchemaDesc = {
		name: "SliceTop",
		relations: [
			...upTo(c.tops, (i) =>
				relation(topName(i), { id: f.integer, a: f.integer, r: f.integer, s: refined }, ["id"])
			),
			...Arr.map(c.derived, (i) => derivedOf(c, derivedName(i), 1, derivedDefinition(i)))
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
					derivedOf(c, chainedName(i), chainedLevel(c, i), chainedDefinition(c, i))
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
 * The source a read matches, as its role's query writes it: an entry by its name, a materialized derived relation by
 * its name, a live one through its definition.
 */
const sourceOf = (c: SliceCase, read: Read): Source => {
	switch (read.kind) {
		case "root":
			return named(rootName(read.at))
		case "top":
			return named(topName(read.at))
		case "derived":
			return derivedSource(c, derivedName(read.at), derivedDefinition(read.at))
		case "chained":
			return derivedSource(c, chainedName(read.at), chainedDefinition(c, read.at))
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
const queryOver = (
	c: SliceCase,
	reads: Arr.NonEmptyReadonlyArray<Read>,
	casts: boolean
): QueryDesc => {
	const [first] = reads
	const matches = Arr.map(reads, (r, k) => matchOf(sourceOf(c, r), `x${k}`, false))
	const vars = Arr.map(reads, (r, k) => varOf(sourceOf(c, r), `x${k}`))
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
						guard: { kind: "matches", pattern: refinedPattern },
						subject: { kind: "var", var: "text" },
						proved: { kind: "cast", to: refined, arg: { kind: "var", var: "text" } },
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
const programOf = (c: SliceCase, u: Use): ClockedProgramDesc => {
	if (u.kind === "query") {
		const [first, ...more] = u.reads
		return {
			kind: "query",
			query: queryOver(c, [defined(first, "a query's read"), ...more], u.casts)
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
				first === undefined
					? []
					: [{ name: "back", query: queryOver(c, [first, ...more], u.casts) }],
			bindings: []
		}),
		"the use's ChangeSet"
	)
	return { kind: "changeSet", changeSet }
}

/**
 * The slice of the case's programs, computed from the draw alone. Writes: each ChangeSet's targets, closed under the
 * families, a member and its owner writing each other. Names: the writes and every relation a program reads, a whole
 * entry its relation, a world entry the root relation its query reads, a materialized derived relation itself and its
 * definition's reads down every level, and a live one, which a query reads through its definition, what that reads.
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
	/** What reading derived relation `name` names: the relation and what its definition reads where it is materialized,
	 * a query matching it by name; only what its definition reads where it is live, a query matching its definition. */
	const viewOr = (name: string, definition: ReadonlyArray<string>): ReadonlyArray<string> =>
		c.materialized.includes(name) ? [name, ...definition] : definition
	const readsOf = (read: Read): ReadonlyArray<string> => {
		switch (read.kind) {
			case "root":
				return [rootName(read.at)]
			case "top":
				return [topName(read.at)]
			case "derived":
				return viewOr(derivedName(read.at), [rootName(read.at)])
			case "chained":
				return viewOr(chainedName(read.at), viewOr(derivedName(read.at), [rootName(read.at)]))
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
 * Whether a write of the slice can raise `n`: a native of a written relation, a foreign key or PERIOD foreign key into
 * one, or a contract's domain. Each such native is the whole model's in its installed name, the laws it discharges, the
 * law it is described by and its order among them, since every law it discharges reads a written relation, or is a
 * contract's, and is planned. A native of a named relation no write of the slice meets discharges the planned laws among
 * the whole model's (`heldOver`, compared apart), and a query reads of it only its name, the evidence of its planned
 * laws and its selection keys, each compared apart; a roster's domain reports grizzle's own defect, no law.
 */
const raisableOver =
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
const nativeName = (n: NamedNative): string =>
	`${n.object.kind} ${relationOf(n) ?? "-"} ${n.namespace === "constraint" || n.namespace === "column" ? identifierOf(n.named) : "-"}`

/**
 * A native as the installation holds it, by its name and its definition apart from the laws it discharges, which a
 * slice's model narrows to the ones it plans: a slice's model holds no other.
 */
const installedForm = (n: NamedNative): unknown => ({
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
const plannedOver = (
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
	described: (law: LawId) => OwnLaw
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
const heldOver = (
	whole: SchemaArtifacts,
	planned: ReadonlySet<LawId>,
	writes: ReadonlySet<string>
): ReadonlyArray<{ readonly whole: NamedNative; readonly held: NamedNative }> => {
	const laws = new Map<LawId, OwnLaw>(
		Arr.map(whole.theoryLaws, (l) => [l.law, l.described] as const)
	)
	const described = (law: LawId): OwnLaw => defined(laws.get(law), `${law} is described`)
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
	| "a lowered rule reading the writes"
	| "a contract's domain used outside the names"
	| "a ChangeSet compiled over the slice"
	| "a query compiled over the slice"
	| "a query of a derived relation compiled over the slice"
	| "a materialized derived relation over a live one"
	| "a query casting into a refinement no named relation declares"

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
	"a lowered rule reading the writes",
	"a contract's domain used outside the names",
	"a ChangeSet compiled over the slice",
	"a query compiled over the slice",
	"a query of a derived relation compiled over the slice",
	"a materialized derived relation over a live one",
	"a query casting into a refinement no named relation declares"
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
					world: world.kind === "role" ? { kind: "role", names: world.names } : { kind: "reality" },
					laws: artifacts.laws,
					derived: artifacts.derived,
					level: "serializable"
				}
			)
		}
	)

/**
 * A query compiled as a role's db.read compiles it (program/template.ts templateFor): against `base`'s artifacts read
 * through the role's views, as a Description over the schema `schema`, for `context`.
 */
const compiledQuery = (
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
				compileQuery(source, { context, artifacts, read: "rows", clock: noClock })
			)
	)

/** What an application runs of a template or a program and what it rests on: its statements and its certificates. */
const ran = <S>(p: ProgramArtifacts<S>) => ({
	optimized: p.optimized,
	certificates: p.certificates
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
		materialized: [],
		crossings: [],
		rules: [{ from: 0, to: 1 }],
		roles: [{ writes: [2], worlds: [] }],
		uses: [{ role: 0, kind: "changes", writes: [2], reads: [], casts: false }]
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
		materialized: [],
		crossings: [],
		rules: [],
		roles: [{ writes: [1], worlds: [] }],
		uses: [{ role: 0, kind: "changes", writes: [1], reads: [], casts: false }]
	},
	draws: "",
	reaches: [
		"a relation outside the names",
		"a family coupling widens the writes",
		"evidence of a containment reading a relation outside the names"
	]
}

/** A write of one relation whose foreign key closes a cycle through two it does not name, keyed one into the other. */
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
		materialized: [],
		crossings: [],
		rules: [],
		roles: [{ writes: [0], worlds: [] }],
		uses: [{ role: 0, kind: "changes", writes: [0], reads: [], casts: false }]
	},
	draws: "",
	reaches: [
		"a relation outside the names",
		"a foreign-key cycle through a key between two relations outside the names",
		"evidence of a containment reading a relation outside the names"
	]
}

/**
 * Two relations' fields contained in one roster, its domain discharging both containments, one relation named and the
 * other not: the slice's domain discharges the named one's law alone, which a query of the roster's evidence reads.
 */
const rosterShared: Kept<SliceCase, SliceFeature> = {
	note: "a roster's domain discharging a named relation's containment and an unnamed one's",
	sketch: {
		roots: 4,
		tops: 0,
		families: [],
		keys: [],
		links: [],
		checks: [],
		rosters: [
			{ from: 0, selected: false },
			{ from: 1, selected: false }
		],
		derived: [0, 1],
		chained: [0],
		materialized: [],
		crossings: [],
		rules: [],
		roles: [
			{ writes: [], worlds: [] },
			{ writes: [], worlds: [] }
		],
		uses: [
			{ role: 0, kind: "query", writes: [], reads: [{ kind: "root", at: 0 }], casts: false },
			{ role: 0, kind: "query", writes: [], reads: [{ kind: "roster" }], casts: false }
		]
	},
	draws: "",
	reaches: ["a relation outside the names", "a query compiled over the slice"]
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
					kept: [ledgerShape, memberAlone, cycleOutside, rosterShared],
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
							baseArtifacts(installed, unserved),
							"the installation's artifacts"
						)
						const whole = wholeArtifacts.laws
						const sliced = succeeded(
							Result.flatMap(
								planBasis(owned, codes, slice, installed.closed, installed.textDomains, {
									kind: "recorded",
									cycles: whole.fkCycles,
									references: whole.references
								}),
								(basis) => baseArtifacts(basis, unserved)
							),
							"the slice's artifacts, as a Db plans them from its snapshot"
						)
						const model = sliced.laws

						assert.deepEqual(model.fkCycles, whole.fkCycles, "the foreign key graph's cycles")
						const planned = plannedOver(whole, names, writes)
						const read = (from: string, to: string): boolean =>
							writes.has(from) || writes.has(to) || (names.has(from) && names.has(to))
						sameApartFromLabels(
							model.existence,
							Arr.filter(whole.existence, (e) => read(e.from.relation, e.to.relation)),
							"the existence evidence of the containments reading a written relation or only named ones"
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

						const installedForms = Arr.map(whole.natives, installedForm)
						for (const n of model.natives) {
							const form = installedForm(n)
							assert.ok(
								Arr.some(installedForms, (m) => canonicalEquals(form, m, labelFree)),
								`${nativeName(n)}, a native of the slice's model, is one the installation holds, by its name and definition`
							)
						}
						const held = heldOver(wholeArtifacts, planned, writes)
						sameNatives(
							model.natives,
							Arr.map(held, (h) => h.held)
						)
						const raisable = raisableOver(writes)
						sameApartFromLabels(
							Arr.filter(model.natives, raisable),
							Arr.flatMap(held, (h) => (raisable(h.whole) ? [h.whole] : [])),
							"the natives a write of the slice can raise, as the whole model orders, names and describes them"
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
									const raised = defined(
										witness.lawsOf(e.name, { kind: "table", name: e.owner }),
										`${e.name} on ${e.owner} names a law`
									)
									assertVariant(raised, "kind", "object", `${e.name} on ${e.owner} types no column`)
									assert.deepEqual(
										raised.laws,
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
									assertVariant(
										raised,
										"kind",
										"domain",
										`the domain ${e.owner} types stored columns`
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
								case "unstoredDomainConstraint":
									break
							}
						}

						const wholeRaised = installationWitness(wholeArtifacts, noLevelAbove).laws.raised
						for (const law of whole.theory.laws) {
							if (!Arr.some(law.reads, (r) => writes.has(r))) {
								continue
							}
							const raised = witness.raised.get(law.id)
							assert.ok(
								raised !== undefined && canonicalEquals(raised, wholeRaised.get(law.id), labelFree),
								`the law ${law.id} over a written relation, which a write statement of the slice refuses, raised as the whole model describes it`
							)
						}

						const schema = succeeded(parseSchemaInput(owned.desc), "the base as a schema input")
						const compiledWrites: Array<CompiledWrite> = []
						const refusedWrites: Array<string> = []
						for (const u of c.uses) {
							const program = programOf(c, u)
							const role = defined(roles.get(roleName(u.role)), "the use's role")
							if (program.kind === "query") {
								for (const context of ["snapshot", "transaction"] as const) {
									const overWhole = compiledQuery(
										wholeArtifacts,
										role,
										schema,
										program.query,
										context
									)
									const overSlice = compiledQuery(sliced, role, schema, program.query, context)
									assert.deepEqual(
										overSlice.ok,
										overWhole.ok,
										`the query compiles over the slice in ${context} exactly when over the whole schema`
									)
									if (!overWhole.ok || !overSlice.ok) {
										continue
									}
									sameApartFromLabels(
										ran(overSlice.value),
										ran(overWhole.value),
										`the query's ${context} template, its statements and certificates, as over the whole schema`
									)
									k.note("a query compiled over the slice")
									if (Arr.some(u.reads, (r) => r.kind === "derived" || r.kind === "chained")) {
										k.note("a query of a derived relation compiled over the slice")
									}
									if (
										u.casts &&
										u.reads[0]?.kind === "root" &&
										!Arr.some(upTo(c.tops, topName), (t) => names.has(t))
									) {
										k.note("a query casting into a refinement no named relation declares")
									}
								}
								continue
							}
							const overWhole = compiledChange(wholeArtifacts, role, program.changeSet)
							const overSlice = compiledChange(sliced, role, program.changeSet)
							assert.deepEqual(
								overSlice.ok,
								overWhole.ok,
								"the ChangeSet compiles over the slice exactly when it compiles over the whole schema"
							)
							if (overWhole.ok && overSlice.ok) {
								sameApartFromLabels(
									ran(overSlice.value),
									ran(overWhole.value),
									"the ChangeSet's statements and certificates, as over the whole schema"
								)
								k.note("a ChangeSet compiled over the slice")
								compiledWrites.push(overWhole.value)
							} else {
								refusedWrites.push(Formatter.format(u))
							}
						}

						if (refusedWrites.length === 0) {
							const changed = writesOf(
								owned,
								Arr.flatMap(compiledWrites, (w) => Arr.map(w.frontend.written, (r) => r.name))
							)
							if (Arr.isReadonlyArrayNonEmpty(compiledWrites)) {
								yield* agree(
									[
										["the relations the draw's programs write", [...writes]],
										["the relations the compiled writes change", [...changed]]
									],
									set(structuralHash, exact)
								)
							}
							const cast = Arr.flatMap(compiledWrites, (w) =>
								Arr.flatMap(w.params, (p) => (p.kind === "scalar" ? [p.type] : []))
							)
							const names = wholeArtifacts.names
							const chainOf = (t: ScalarType): ReadonlyArray<string> => {
								const contract = contractOf(t)
								return contract === undefined
									? []
									: [names.contractDomain(contract.name).name, ...chainOf(contract.base)]
							}
							const castDomains = new Set(
								Arr.flatMap(cast, (t) => {
									const text = textOf(t)
									const pattern =
										text === undefined || text.regex === "wildcard"
											? undefined
											: names.textDomain(text.regex)
									return [...chainOf(t), ...(pattern === undefined ? [] : [pattern.name])]
								})
							)
							const narrowed = raisableOf(wholeArtifacts, {
								written: changed,
								cast,
								held: new Set()
							})
							const constraintOf = (e: {
								readonly kind: string
								readonly owner: string
								readonly name: string
							}) => `${e.kind} ${e.owner} ${e.name}`
							const held = new Set(Arr.map(sliced.constraintLaws, constraintOf))
							const wholeLaws = new Map(
								Arr.map(wholeArtifacts.constraintLaws, (c) => [constraintOf(c), c] as const)
							)
							for (const e of narrowed.constraintLaws) {
								assert.ok(
									held.has(constraintOf(e)),
									`${constraintOf(e)}, which the served refusals keep, is the slice model's`
								)
							}
							const kept = new Set(Arr.map(narrowed.constraintLaws, constraintOf))
							for (const e of sliced.constraintLaws) {
								if (kept.has(constraintOf(e))) {
									continue
								}
								switch (e.kind) {
									case "constraint":
									case "trigger":
										assert.ok(
											!written(e.owner) && !intoWrites.has(`${e.owner} ${e.name}`),
											`${constraintOf(e)}, which the served refusals drop, is on no relation a write changes and no foreign key into one`
										)
										break
									case "domainConstraint": {
										const whole = defined(
											wholeLaws.get(constraintOf(e)),
											`${constraintOf(e)}, which the slice's model holds, is the whole schema's`
										)
										assert.ok(
											whole.kind === "domainConstraint" &&
												!Arr.some(whole.uses, (u) => written(u.table)) &&
												!castDomains.has(e.owner),
											`${constraintOf(e)}, which the served refusals drop, types columns of the whole schema, none a write writes, and no value a write casts`
										)
										break
									}
									case "unstoredDomainConstraint":
										assert.ok(
											!castDomains.has(e.owner),
											`${constraintOf(e)}, which the served refusals drop, types no value a write casts`
										)
										break
								}
							}
							const slicedLaws = new Set(Arr.map(sliced.theoryLaws, (l) => l.law))
							const keptLaws = new Set(Arr.map(narrowed.theoryLaws, (l) => l.law))
							for (const l of narrowed.theoryLaws) {
								assert.ok(
									slicedLaws.has(l.law),
									`${l.law}, which the served refusals keep, is the slice model's`
								)
							}
							for (const law of model.theory.laws) {
								if (!keptLaws.has(law.id)) {
									assert.ok(
										!Arr.some(law.reads, (r) => writes.has(r)),
										`${law.id}, which the served refusals drop, reads no relation a write changes`
									)
								}
							}
							for (const r of narrowed.relations) {
								assert.ok(
									writes.has(r.name),
									`${r.name}, whose heading the served refusals keep, is written`
								)
							}
						}

						if (
							Arr.some(
								c.chained,
								(i) =>
									c.materialized.includes(chainedName(i)) &&
									!c.materialized.includes(derivedName(i))
							)
						) {
							k.note("a materialized derived relation over a live one")
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
							Arr.some(
								model.theory.laws,
								(l) =>
									l.detail.kind === "rule" &&
									l.detail.lowering.kind === "foreignKeys" &&
									Arr.some(l.reads, (r) => writes.has(r))
							)
						) {
							k.note("a lowered rule reading the writes")
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

/**
 * A schema whose derived relation E_at matches the live derived relation D_at by its name, as no query builder writes a
 * match of a live derived relation: directly, or inside a query it matches, `nested`.
 */
interface ByName {
	readonly c: SliceCase
	readonly at: number
	readonly nested: boolean
}

const byNameGen: Gen<ByName> = (s) => {
	const drawn = s.draw(caseGen)
	const at = s.draw(int(0, drawn.roots - 1))
	const c: SliceCase = {
		...drawn,
		derived: distinct([...drawn.derived, at]),
		chained: distinct([...drawn.chained, at]),
		materialized: Arr.filter(drawn.materialized, (m) => m !== derivedName(at))
	}
	return { c, at, nested: s.draw(boolean) }
}

/** The case's schema with E_at's definition matching D_at by name, at the level above D_at's. */
const byNameSchema = (b: ByName): SchemaDesc => {
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

describe("a schema's ownership", () => {
	it.effect(
		"refuses a derived definition matching a live derived relation by its name, which stores nothing to match",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "README's derived tables: a query over a live derived relation reads its definition"
						},
						suite: "unit/laws/model/slice-by-name",
						draw: drawn(byNameGen),
						literal: Formatter.format,
						coverage: required<"a direct match by name" | "a match by name inside a matched query">(
							["a direct match by name", "a match by name inside a matched query"],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(b, k) =>
						Effect.sync(() => {
							const owned = own(decodedSchema(byNameSchema(b)))
							assert.ok(!owned.ok, "the schema is refused when it is owned")
							const reason = owned.error.reason
							assert.ok(
								reason._tag === "MalformedDescription" &&
									Str.includes(chainedName(b.at))(reason.what) &&
									Str.includes(derivedName(b.at))(reason.what),
								`a MalformedDescription naming ${chainedName(b.at)}'s definition and the live ${derivedName(b.at)} it matches`
							)
							k.note(b.nested ? "a match by name inside a matched query" : "a direct match by name")
						})
				)
			)
	)
})
