/**
 * A login's runtime holds the law model of its roles' writes (schema/reach.ts loginWrites, laws/model/model.ts
 * compileLaws), never the whole schema's: DbLayer.make compiles its artifacts over it (adapter/pool/registry.ts
 * artifactsUnder). Each case draws a schema of two levels and a login of roles each writing some of its ordinary
 * relations, and compares the layer's artifacts with the installation's, compiled over every ordinary relation
 * (everyWrite), restricted by a reachability read off the installation's model alone:
 *
 * - the reach: every relation a role writes, closed under what a write of one relation writes of another, each
 *   family's member and its owner and each foreign key that cascades, its target's write rewriting its source;
 * - the natives: in the installation's order, with their names and laws, each of a relation of the reach, and on every
 *   relation each a read relies on: a foreign key, a PERIOD foreign key, a CHECK into a closed relation, a roster's or a
 *   contract's domain, a selection key (physical/ddl/names.ts selectionKeysOf) and a UNIQUE that holds one; their
 *   expressions compared apart from their DAG labels, which no reader of a runtime model reads;
 * - the table constraints of those natives, the rules that read a relation of the reach, and the reach's relations
 *   with their unique objects;
 * - refusal naming: every constraint the database can raise in a write of the reach, a table constraint or a rule's
 *   trigger on one of its relations, a foreign key into one, or a domain typing one of its columns, names the
 *   installation's laws in the layer's witness (adapter/witness/keylaw.ts);
 * - everything a read relies on, whoever writes: the theory's laws and evidence, the immediate laws, the existence
 *   evidence and each relation's selection keys, equal.
 *
 * The box: two to four relations at the root level, with ordered and counted families, keys over a selection,
 * containments into a key or a selected key, row checks, containments into a roster or a selection of it; up to two at
 * the level above, containing into a relation below or into a derived relation of one (a rule over a query, held by
 * triggers on both levels); and one or two roles.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { artifactsUnder } from "#adapter/pool/registry.ts"
import { installationWitness } from "#adapter/witness/index.ts"
import { noLevelAbove } from "#adapter/witness/keylaw.ts"
import { canonicalEquals, type EncodeOptions } from "#compiler/core/canonical.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { LawId, RelationIdent } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { decodeDesc } from "#compiler/ir/desc.ts"
import type { LawModel, NamedNative } from "#compiler/laws/model/model.ts"
import { selectionKeysOf } from "#compiler/physical/ddl/names.ts"
import { installBasis } from "#compiler/physical/install/plan.ts"
import { baseArtifacts, type SchemaArtifacts } from "#compiler/program/schema.ts"
import { fullRoleDesc, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { everyWrite } from "#compiler/schema/reach.ts"
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

interface ReachCase {
	readonly roots: number
	readonly tops: number
	readonly families: ReadonlyArray<FamilyDraw>
	readonly keys: ReadonlyArray<number>
	readonly links: ReadonlyArray<LinkDraw>
	readonly checks: ReadonlyArray<number>
	readonly rosters: ReadonlyArray<RosterDraw>
	readonly crossings: ReadonlyArray<UpDraw>
	readonly rules: ReadonlyArray<UpDraw>
	/** Each role's writes, by position among the root's relations and then the level above's. */
	readonly roles: Arr.NonEmptyReadonlyArray<ReadonlyArray<number>>
}

type ReachFeature =
	| "a relation outside the reach"
	| "a family coupling widens the reach"
	| "a rule in the reach reading the level below"
	| "a selection key outside the reach"
	| "a foreign key into the reach from outside it"
	| "a closed relation's check outside the reach"

const features: Arr.NonEmptyReadonlyArray<ReachFeature> = [
	"a relation outside the reach",
	"a family coupling widens the reach",
	"a rule in the reach reading the level below",
	"a selection key outside the reach",
	"a foreign key into the reach from outside it",
	"a closed relation's check outside the reach"
]

/** The families of a draw, each member in at most one ordered family: a second ordered one of a member is counted. */
const familiesOf = (draws: ReadonlyArray<FamilyDraw>): ReadonlyArray<FamilyDraw> =>
	Arr.map(draws, (d, i) => ({
		...d,
		ordered: d.ordered && !Arr.some(draws.slice(0, i), (e) => e.ordered && e.member === d.member)
	}))

const caseGen: Gen<ReachCase> = (s) => {
	const roots = s.draw(int(2, 4))
	const tops = s.draw(int(0, 2))
	const root = int(0, roots - 1)
	const family: Gen<FamilyDraw> = (t) => {
		const owner = t.draw(int(0, roots - 2))
		return { owner, member: t.draw(int(owner + 1, roots - 1)), ordered: t.draw(boolean) }
	}
	const keys = [...new Set(s.draw(array(root, { min: 0, max: 2 })))]
	const link: Gen<LinkDraw> = (t) => {
		const to = t.draw(root)
		return { from: t.draw(root), to, selected: keys.includes(to) && t.draw(boolean) }
	}
	const up: Gen<UpDraw> = (t) => ({ from: t.draw(int(0, tops - 1)), to: t.draw(root) })
	const ups = tops === 0 ? [] : s.draw(array(up, { min: 0, max: 2 }))
	const rules = tops === 0 ? [] : s.draw(array(up, { min: 0, max: 2 }))
	const write = array(int(0, roots + tops - 1), { min: 0, max: 3 })
	const [first, ...more] = s.draw(array(write, { min: 1, max: 2 }))
	return {
		roots,
		tops,
		families: familiesOf(s.draw(array(family, { min: 0, max: 3 }))),
		keys,
		links: s.draw(array(link, { min: 0, max: 3 })),
		checks: [...new Set(s.draw(array(root, { min: 0, max: 2 })))],
		rosters: s.draw(
			array((t): RosterDraw => ({ from: t.draw(root), selected: t.draw(boolean) }), {
				min: 0,
				max: 2
			})
		),
		crossings: ups,
		rules,
		roles: [defined(first, "a role"), ...more]
	}
}

const rootName = (i: number): string => `R${i}`
const topName = (i: number): string => `T${i}`
const derivedName = (i: number): string => `D${i}`

/** The name of the case's i-th ordinary relation, the root's first. */
const ordinaryName = (c: ReachCase, i: number): string =>
	i < c.roots ? rootName(i) : topName(i - c.roots)

const live = eq(field("on"), literal(true))

/** Root relation i's fields: its own, then the count of each family it owns and the group and index of each it is a
 * member of. */
const rootFields = (c: ReachCase, i: number) => ({
	id: f.integer,
	a: f.integer,
	on: f.boolean,
	c: f.closedId("Color"),
	...Rec.fromEntries(
		Arr.flatMap(c.families, (d, k) => [
			...(d.owner === i ? [[`n${k}`, f.drawn] as const] : []),
			...(d.member === i ? [[`o${k}`, f.integer] as const] : []),
			...(d.member === i && d.ordered ? [[`i${k}`, f.drawn] as const] : [])
		])
	)
})

/** Root relation i's live rows as a derived relation of the level above: each id whose `on` holds. */
const derivedOver = (i: number): AuthoredRelationDesc => ({
	kind: "derived",
	name: derivedName(i),
	level: 1,
	storage: "live",
	query: decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [{ id: "id", origin: { relation: rootName(i), field: "id" } }],
				matches: [
					{
						source: { kind: "relation", name: rootName(i) },
						bindings: { id: { kind: "var", var: "id" }, on: literal(true) }
					}
				],
				where: [],
				head: { id: { kind: "var", var: "id" } },
				interiors: [],
				attach: []
			}
		]
	})
})

const rootStatements = (c: ReachCase): ReadonlyArray<AuthoredStatementDesc> => [
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
					onWhere("Color", ["id"], eq(field("id"), literal("red")))
				)
			: contained(on(rootName(r.from), ["c"]), on("Color", ["id"]))
	)
]

/** The case's schema: the root and the level above it. */
const schemaOf = (c: ReachCase): SchemaDesc => {
	const root: SchemaDesc = {
		name: "Reach",
		relations: [
			closed("Color", ["red", "green"]),
			...Arr.makeBy(c.roots, (i) => relation(rootName(i), rootFields(c, i), ["id"]))
		],
		statements: rootStatements(c),
		extends: undefined
	}
	return {
		name: "ReachTop",
		relations: [
			...Arr.makeBy(c.tops, (i) =>
				relation(topName(i), { id: f.integer, a: f.integer, r: f.integer }, ["id"])
			),
			...Arr.map([...new Set(Arr.map(c.rules, (r) => r.to))], derivedOver)
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
}

const loc = SourceLoc("the reach test's login", [])

/** The login of the case's roles over its schema, each holding every relation whole and writing its draw. */
const loginOf = (c: ReachCase) => {
	const base = decodedSchema(schemaOf(c))
	const whole = succeeded(fullRoleDesc(base, "w", loc), "a role over the schema")
	const roles = Arr.map(c.roles, (writes, k) => ({
		...whole,
		name: `w${k}`,
		write: [...new Set(Arr.map(writes, (i) => ordinaryName(c, i)))]
	}))
	return succeeded(
		Result.flatMap(decodeDesc("login", { name: "app", base, roles, loc }), ownLogin),
		"the case's login"
	)
}

/**
 * Every relation a write of `seed` writes, read off the installation's model: each family's member and owner write
 * each other, and a cascading foreign key's target writes its source.
 */
const reachOf = (whole: LawModel, seed: ReadonlySet<string>): ReadonlySet<string> => {
	const writes: ReadonlyArray<readonly [string, string]> = [
		...Arr.flatMap(whole.families, (d) => [
			[d.member.name, d.owner.name] as const,
			[d.owner.name, d.member.name] as const
		]),
		...Arr.flatMap(whole.natives, (n) =>
			n.object.kind === "ForeignKey" && n.object.onUpdate === "cascade"
				? [[n.object.target.name, n.object.relation.name] as const]
				: []
		)
	]
	const reach = new Set(seed)
	const grow = (): boolean => {
		const next = Arr.filter(writes, ([from, to]) => reach.has(from) && !reach.has(to))
		for (const [, to] of next) {
			reach.add(to)
		}
		return next.length > 0
	}
	while (grow()) {
		continue
	}
	return reach
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

/** Whether a read relies on a native, whoever writes (see the header), by the installation's selection keys. */
const reliedOn =
	(whole: LawModel) =>
	(n: NamedNative): boolean => {
		const keys = selectionKeysOf(whole.natives)
		const keyed = (relation: string, column: string): boolean =>
			Arr.some(keys.get(relation) ?? [], (k) => k.column === column)
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
				const relation = n.object.relation.name
				return Arr.some(
					n.object.columns,
					(col) => col.kind === "law" && keyed(relation, col.column)
				)
			}
			case "PrimaryKey":
			case "WithoutOverlaps":
			case "TableCheck":
			case "ReverseIndex":
				return false
		}
	}

/**
 * Two values equal apart from the labels a law model's DAG gives its nodes and expressions, and the canonical text of a
 * guard, which spells them and which only another guard of its own model is compared with (uniques.ts subsumes); a
 * closed side's rows are the closed relation's own, which both models hold alike.
 */
const labelFree: EncodeOptions = {
	omit: (k, value) =>
		k === "deps" ||
		((k === "id" || k === "node" || k === "canonical") && typeof value === "string") ||
		(k === "rows" && !Arr.isArray(value))
}

const sameApartFromLabels = (a: unknown, b: unknown, why: string): void =>
	assert.ok(canonicalEquals(a, b, labelFree), why)

/** A native as a reader names it: its kind, its relation and its installed name where it has one. */
const nativeName = (n: NamedNative): string =>
	`${n.object.kind} ${relationOf(n) ?? "-"} ${n.namespace === "constraint" || n.namespace === "column" ? identifierOf(n.named) : "-"}`

/** The installation's artifacts of the login's base, over every ordinary relation. */
const installed = (base: SchemaArtifacts["owned"], codes: ReturnType<typeof firstCodebook>) =>
	succeeded(
		Result.flatMap(installBasis(base, codes, everyWrite(base)), baseArtifacts),
		"the installation's artifacts"
	)

/** The ledger's shape: a relation of the level above written alone, its rule reading a family's member below. */
const ledgerShape: Kept<ReachCase, ReachFeature> = {
	note: "the level above written alone, its rule over a derived relation of a family member below",
	sketch: {
		roots: 2,
		tops: 1,
		families: [{ owner: 0, member: 1, ordered: true }],
		keys: [1],
		links: [],
		checks: [0],
		rosters: [],
		crossings: [],
		rules: [{ from: 0, to: 1 }],
		roles: [[2]]
	},
	draws: "",
	reaches: [
		"a relation outside the reach",
		"a rule in the reach reading the level below",
		"a selection key outside the reach"
	]
}

/** A member written alone: its owner, whose count it writes, is in the reach, and the owner's natives with it. */
const memberAlone: Kept<ReachCase, ReachFeature> = {
	note: "a family's member written alone, its owner reached through the family",
	sketch: {
		roots: 3,
		tops: 0,
		families: [{ owner: 0, member: 1, ordered: false }],
		keys: [],
		links: [{ from: 2, to: 0, selected: false }],
		checks: [0],
		rosters: [{ from: 2, selected: true }],
		crossings: [],
		rules: [],
		roles: [[1]]
	},
	draws: "",
	reaches: [
		"a relation outside the reach",
		"a family coupling widens the reach",
		"a foreign key into the reach from outside it",
		"a closed relation's check outside the reach"
	]
}

describe("a login's runtime law model", () => {
	it.effect(
		"is the installation's restricted to what its roles' writes and every read reach",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the installation's law model restricted by a reachability read off it"
						},
						suite: "unit/laws/model/reach",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<ReachFeature>(features, { cases: 200, sense: notesOnly }),
						kept: [ledgerShape, memberAlone],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const login = loginOf(c)
							const codes = firstCodebook(rostersOf(login.base))
							const runtime = succeeded(artifactsUnder(login, codes), "the layer's artifacts")
							const whole = installed(login.base, codes)
							const seed = new Set(
								Arr.flatMap(c.roles, (writes) => Arr.map(writes, (i) => ordinaryName(c, i)))
							)
							const reach = reachOf(whole.laws, seed)
							const relied = reliedOn(whole.laws)
							const held = Arr.filter(whole.laws.natives, (n) => {
								const relation = relationOf(n)
								return relied(n) || (relation !== undefined && reach.has(relation))
							})
							assert.deepEqual(
								Arr.map(runtime.laws.natives, nativeName),
								Arr.map(held, nativeName),
								"the natives the runtime holds"
							)
							sameApartFromLabels(runtime.laws.natives, held, "each native, as the installation's")

							const rules = Arr.filter(whole.laws.rules, (r) =>
								Arr.some(r.law.reads, (read) => reach.has(read))
							)
							assert.deepEqual(
								Arr.map(runtime.laws.rules, (r) => r.law.id),
								Arr.map(rules, (r) => r.law.id),
								"the rules over queries the runtime holds"
							)
							const named = new Set(
								Arr.flatMap(held, (n) =>
									n.namespace === "constraint" ? [`${n.owner} ${identifierOf(n.named)}`] : []
								)
							)
							const ruled = new Set<LawId>(Arr.map(rules, (r) => r.law.id))
							sameApartFromLabels(
								runtime.laws.constraints,
								Arr.filter(whole.laws.constraints, (e) =>
									e.kind === "trigger"
										? ruled.has(e.laws[0].law)
										: named.has(`${e.owner} ${e.name}`)
								),
								"the table constraints and rule triggers the runtime names"
							)
							const ordinary = [...whole.laws.relations.keys()]
							assert.deepEqual(
								[...runtime.laws.relations.keys()],
								Arr.filter(ordinary, (r) => reach.has(r)),
								"the relations whose writes the runtime serves"
							)
							for (const [name, laws] of runtime.laws.relations) {
								sameApartFromLabels(
									laws,
									whole.laws.relations.get(name),
									`${name}'s keys and unique objects`
								)
							}

							const tables = new Map(
								Arr.map([...whole.laws.relations.values()], (r) => [
									r.relation.ident,
									r.relation.name
								])
							)
							const inReach = (ident: RelationIdent): boolean => {
								const name = tables.get(ident)
								return name !== undefined && reach.has(name)
							}
							const intoReach = new Set(
								Arr.flatMap(whole.laws.natives, (n) =>
									n.namespace === "constraint" &&
									(n.object.kind === "ForeignKey" || n.object.kind === "PeriodForeignKey") &&
									reach.has(n.object.target.name)
										? [`${n.owner} ${identifierOf(n.named)}`]
										: []
								)
							)
							const witness = installationWitness(runtime, noLevelAbove).laws
							for (const e of whole.constraintLaws) {
								switch (e.kind) {
									case "constraint":
									case "trigger": {
										if (!inReach(e.owner) && !intoReach.has(`${e.owner} ${e.name}`)) {
											break
										}
										const raised = witness.lawsOf(e.name, { kind: "table", name: e.owner })
										assert.deepEqual(
											Arr.map(
												defined(raised, `${e.name} on ${e.owner} names a law`).laws,
												(l) => l.law
											),
											Arr.map(e.laws, (l) => l.law),
											`the laws ${e.name} on ${e.owner} reports`
										)
										break
									}
									case "domainConstraint": {
										const uses = Arr.filter(e.uses, (u) => inReach(u.table))
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
														r.table === u.table && r.column === u.column && r.law.law === u.law.law
												),
												`the domain ${e.owner} names ${u.table}.${u.column}'s law`
											)
										}
										break
									}
								}
							}

							sameApartFromLabels(
								runtime.laws.theory.laws,
								whole.laws.theory.laws,
								"the theory's laws"
							)
							sameApartFromLabels(
								runtime.laws.theory.evidence,
								whole.laws.theory.evidence,
								"the theory's evidence"
							)
							assert.deepEqual(
								[...runtime.laws.immediate],
								[...whole.laws.immediate],
								"the immediate laws"
							)
							sameApartFromLabels(
								runtime.laws.existence,
								whole.laws.existence,
								"the existence evidence"
							)
							sameApartFromLabels(runtime.views, whole.views, "the views' keys")
							for (const name of ordinary) {
								sameApartFromLabels(
									runtime.names.selectionKeys(name),
									whole.names.selectionKeys(name),
									`${name}'s selection keys`
								)
							}

							if (Arr.some(ordinary, (r) => !reach.has(r))) {
								k.note("a relation outside the reach")
							}
							if (reach.size > seed.size) {
								k.note("a family coupling widens the reach")
							}
							if (runtime.laws.rules.length > 0) {
								k.note("a rule in the reach reading the level below")
							}
							const outside = (n: NamedNative): boolean => {
								const relation = relationOf(n)
								return relation !== undefined && !reach.has(relation)
							}
							if (
								Arr.some(runtime.laws.natives, (n) => n.object.kind === "LawColumn" && outside(n))
							) {
								k.note("a selection key outside the reach")
							}
							if (
								Arr.some(
									runtime.laws.natives,
									(n) =>
										n.object.kind === "ForeignKey" && outside(n) && reach.has(n.object.target.name)
								)
							) {
								k.note("a foreign key into the reach from outside it")
							}
							if (
								Arr.some(runtime.laws.natives, (n) => n.object.kind === "ClosedCheck" && outside(n))
							) {
								k.note("a closed relation's check outside the reach")
							}
						})
				)
			)
	)
})
