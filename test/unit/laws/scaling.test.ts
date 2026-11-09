import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { isList, isRecord } from "#compiler/core/record.ts"
import {
	finishSnapshot,
	noWorkload,
	targetState,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	alternatives,
	type AuthoredRelationDesc,
	type AuthoredStatementDesc,
	and,
	check,
	closed,
	contained,
	counted,
	eq,
	f,
	field,
	fin,
	ge,
	le,
	literal,
	mutable,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { oracleLogin } from "#test/support/oracle/install/real.ts"
import { owning } from "#test/support/policy.ts"
import { buildInstall } from "#test/support/worlds/execute/build.ts"
import type {
	BaseSpec,
	ContextSpec,
	EntrySpec,
	FieldDomain,
	InstallSpec,
	Occurrence,
	RelationSpec,
	RoleSpec,
	Term
} from "#test/support/worlds/model/types.ts"

/**
 * No installed object, and no installation, grows faster than the schema facts it serves: a scaling relation over AST
 * node counts, the size oracle every outcome oracle lacks.
 *
 * For each scalable dimension of a schema and of its worlds, the installation at size n and at 2n of that dimension
 * alone: every installed object's statements, counted as AST nodes (as snapshot.json holds them, a structural property,
 * never printed text), the installation's total with its role defaults, revokes and comments, and the snapshot's encoded
 * size each grow by at most 2 + ε from n to 2n. A product of two dimensions, a function whose body is tables × handles,
 * a law compiled once per trigger into every table's text, a role's grants listing every other role, grows by 4 there,
 * and shows at n = 4 against 8, far below any size a clock would notice. The box is exhausted: every dimension at every
 * n from 3 to 8.
 *
 * The schema dimensions are drawn as Descriptions, installed with the full role of the oracle login; the worlds
 * dimensions (roles, whole entries per role, world views, context fields) as the worlds suites' install descriptions
 * (worlds model/types.ts InstallSpec), built through the public builders as those suites build them and installed with
 * their logins.
 */

/** The bound on growth from n to 2n: linear, with ε for the parts that do not grow. */
const linear = 2.5

type Dimension =
	| "roster handles"
	| "roster handles, one unarmed"
	| "roster handles over shared arm relations"
	| "roster handles, every relation mutable"
	| "parent key fields"
	| "participating tables"
	| "selector fields"
	| "relations"
	| "closed handles"
	| "roles"
	| "entries per role"
	| "world views"
	| "context fields"

const dimensions: Arr.NonEmptyReadonlyArray<Dimension> = [
	"roster handles",
	"roster handles, one unarmed",
	"roster handles over shared arm relations",
	"roster handles, every relation mutable",
	"parent key fields",
	"participating tables",
	"selector fields",
	"relations",
	"closed handles",
	"roles",
	"entries per role",
	"world views",
	"context fields"
]

interface Point {
	readonly dimension: Dimension
	readonly n: number
}

const pointGen: Gen<Point> = (s) => ({
	dimension: s.draw(element(dimensions)),
	n: s.draw(int(3, 8))
})

const schemaOf = (
	name: string,
	relations: ReadonlyArray<AuthoredRelationDesc>,
	statements: ReadonlyArray<AuthoredStatementDesc>
): SchemaDesc => ({ name, relations, statements, extends: undefined })

/** An alternatives law over a roster of `size` handles, keyed by `keyWidth` fields: handle i armed by arm relation
 * `armOf(i)`, or unarmed where it gives none; every relation mutable when `mutableAll`. */
const roster = (
	size: number,
	keyWidth: number,
	armOf: (i: number) => number | undefined,
	mutableAll: boolean
): SchemaDesc => {
	const key = Arr.makeBy(keyWidth, (i) => `k${i + 1}`)
	const keyFields = Rec.fromEntries(Arr.map(key, (k) => [k, f.integer] as const))
	const handles = Arr.makeBy(size, (i) => `h${i}`)
	const Roster = closed("Roster", handles)
	const Node = relation("Node", { ...keyFields, kind: f.closedId("Roster") }, key)
	const armIndexes = [
		...new Set(Arr.flatMap(Arr.makeBy(size, armOf), (j) => (j === undefined ? [] : [j])))
	]
	const arms = new Map(
		Arr.map(
			armIndexes,
			(j) => [j, relation(`Arm${j}`, { ...keyFields, amount: f.integer }, key)] as const
		)
	)
	const byHandle: Record<string, AuthoredRelationDesc & { readonly kind: "relation" }> = {}
	for (const [i, h] of handles.entries()) {
		const j = armOf(i)
		const arm = j === undefined ? undefined : arms.get(j)
		if (arm !== undefined) {
			byHandle[h] = arm
		}
	}
	const relations = [Roster, Node, ...arms.values()]
	return schemaOf("Scaled", relations, [
		alternatives(Node, "kind", Roster, byHandle),
		...(mutableAll ? Arr.map(["Node", ...Arr.map([...arms.values()], (a) => a.name)], mutable) : [])
	])
}

const uuidDomain: FieldDomain = { kind: "uuid" }
const integerDomain: FieldDomain = { kind: "integer", bits: 32 }
const variable = (name: string): Term => ({ kind: "var", name })
const literalTerm = (value: number): Term => ({ kind: "literal", value })
const whole = (relation: string): EntrySpec => ({ kind: "whole", relation })

/** The worlds dimensions' item: an id, and an integer owner a view selects or a claim fixes. */
const item: RelationSpec = {
	name: "Item",
	fields: [
		{ name: "id", domain: uuidDomain },
		{ name: "owner", domain: integerDomain }
	],
	key: ["id"],
	mutability: "immutable"
}

/** A base of `relations` and `contexts`, with no law, roster or derived relation. */
const baseOf = (
	relations: Arr.NonEmptyReadonlyArray<RelationSpec>,
	contexts: ReadonlyArray<ContextSpec>
): BaseSpec => ({ name: "Scaled", closed: [], relations, laws: [], contexts, derived: [] })

/** The worlds of `roles` over a base, every role in the one login `web`. */
const worldsOf = (base: BaseSpec, roles: Arr.NonEmptyReadonlyArray<RoleSpec>): InstallSpec => ({
	base,
	roles,
	logins: [{ name: "web", roles: Arr.map(roles, (r) => r.name) }]
})

/** A role holding `relations` whole, writing each. */
const fullOn = (name: string, relations: ReadonlyArray<RelationSpec>): RoleSpec => ({
	name,
	entries: Rec.fromEntries(Arr.map(relations, (r) => [r.name, whole(r.name)] as const)),
	write: Arr.map(relations, (r) => r.name),
	refresh: []
})

/** A world view of the items whose owner is `owner`, matching `also` beside them. */
const ownedItems = (owner: Term, also: ReadonlyArray<Occurrence>): EntrySpec => ({
	kind: "query",
	rules: [
		{
			matches: [
				{ source: { kind: "ordinary", name: item.name }, fields: { id: variable("id"), owner } },
				...also
			],
			negations: [],
			comparisons: [],
			head: { id: variable("id") }
		}
	]
})

/** One dimension's installation at one size: a schema's Description, or its worlds' description. */
type Scaled =
	| { readonly kind: "schema"; readonly desc: SchemaDesc }
	| { readonly kind: "worlds"; readonly spec: InstallSpec }

const schemaAt = (desc: SchemaDesc): Scaled => ({ kind: "schema", desc })

const worldsAt = (base: BaseSpec, roles: Arr.NonEmptyReadonlyArray<RoleSpec>): Scaled => ({
	kind: "worlds",
	spec: worldsOf(base, roles)
})

/** The installation of one dimension at size `n`. */
const scaled = ({ dimension, n }: Point): Scaled => {
	switch (dimension) {
		case "roster handles":
			return schemaAt(roster(n, 1, (i) => i, false))
		case "roster handles, one unarmed":
			return schemaAt(roster(n, 1, (i) => (i === n - 1 ? undefined : i), false))
		case "roster handles over shared arm relations":
			return schemaAt(roster(n, 1, (i) => Math.floor(i / 2), false))
		case "roster handles, every relation mutable":
			return schemaAt(roster(n, 1, (i) => i, true))
		case "parent key fields":
			return schemaAt(roster(2, n, (i) => i, true))
		case "participating tables": {
			const sources = Arr.makeBy(n, (i) =>
				relation(`Source${i}`, { id: f.integer, target: f.integer, active: f.boolean }, ["id"])
			)
			return schemaAt(
				schemaOf(
					"Scaled",
					[relation("Target", { id: f.integer }, ["id"]), ...sources],
					[
						...Arr.map(sources, (s) =>
							contained(
								onWhere(s.name, ["target"], eq(field("active"), literal(true))),
								on("Target", ["id"])
							)
						),
						...Arr.map(["Target", ...Arr.map(sources, (s) => s.name)], mutable)
					]
				)
			)
		}
		case "selector fields": {
			const selectors = Arr.makeBy(n, (i) => `s${i}`)
			return schemaAt(
				schemaOf(
					"Scaled",
					[
						relation(
							"Assignment",
							{
								id: f.integer,
								worker: f.integer,
								...Rec.fromEntries(Arr.map(selectors, (s) => [s, f.boolean] as const))
							},
							["id"]
						),
						relation("Worker", { id: f.integer }, ["id"])
					],
					[
						contained(
							onWhere("Assignment", ["worker"], {
								kind: "and",
								args: Arr.map(selectors, (s) => eq(field(s), literal(true)))
							}),
							on("Worker", ["id"])
						),
						mutable("Assignment"),
						mutable("Worker")
					]
				)
			)
		}
		case "relations": {
			/** Each team's members number 1 to its cap: a counted family over the team's drawn n, and a check of n. */
			const pairs = Arr.makeBy(n, (i) => [
				relation(`Team${i}`, { id: f.integer, cap: f.bigint, n: f.drawn }, ["id"]),
				relation(`Member${i}`, { id: f.integer, team: f.integer }, ["id"])
			])
			return schemaAt(
				schemaOf(
					"Scaled",
					Arr.flatten(pairs),
					Arr.flatMap(
						Arr.makeBy(n, (i) => i),
						(i) => [
							counted(on(`Member${i}`, ["team"]), fin(`Team${i}`, "n")),
							check(
								`MembersWithinCap${i}`,
								`Team${i}`,
								and(
									ge({ kind: "base", arg: field("n") }, literal(1n)),
									le({ kind: "base", arg: field("n") }, field("cap"))
								)
							)
						]
					)
				)
			)
		}
		case "closed handles":
			return schemaAt(
				schemaOf(
					"Scaled",
					[
						closed(
							"Color",
							Arr.makeBy(n, (i) => `c${i}`)
						),
						relation("Paint", { id: f.integer, color: f.closedId("Color") }, ["id"])
					],
					[]
				)
			)
		case "roles":
			return worldsAt(
				baseOf([item], []),
				Arr.makeBy(n, (i) => fullOn(`r${i}`, [item]))
			)
		case "entries per role": {
			const relations = Arr.makeBy(n, (i): RelationSpec => ({
				name: `E${i}`,
				fields: [{ name: "id", domain: uuidDomain }],
				key: ["id"],
				mutability: "immutable"
			}))
			return worldsAt(baseOf(relations, []), [fullOn("reader", relations)])
		}
		case "world views":
			return worldsAt(baseOf([item], []), [
				{
					name: "reader",
					entries: Rec.fromEntries(
						Arr.makeBy(n, (i) => [`View${i}`, ownedItems(literalTerm(i), [])] as const)
					),
					write: [],
					refresh: []
				}
			])
		case "context fields": {
			const claims: ContextSpec = {
				name: "Claims",
				claim: { kind: "top-level" },
				fields: Arr.makeBy(n, (i) => ({ name: `c${i}`, domain: integerDomain }))
			}
			const owner = variable("owner")
			return worldsAt(baseOf([item], [claims]), [
				{
					name: "reader",
					entries: {
						Mine: ownedItems(owner, [
							{
								source: { kind: "context", name: claims.name },
								fields: Rec.fromEntries(Arr.map(claims.fields, (c) => [c.name, owner] as const))
							}
						])
					},
					write: [],
					refresh: []
				}
			])
		}
	}
}

/**
 * A dimension's complete installation, as `grizzle generate` drafts it: a schema's with the full
 * role its login takes on, a worlds description's built through the public builders and installed
 * with its logins.
 */
const installationOf = (scaledAt: Scaled): Effect.Effect<Installation> => {
	switch (scaledAt.kind) {
		case "schema":
			return Effect.sync(() => {
				const owned = owning(scaledAt.desc)
				const login = succeeded(ownLogin(oracleLogin(owned.desc)))
				return succeeded(
					compileInstallation(
						owned,
						completeInstallOptions(
							owned,
							installationsOf(owned),
							[login],
							[],
							firstCodebook(rostersOf(owned))
						)
					)
				)
			})
		case "worlds":
			return Effect.map(
				Effect.orDie(buildInstall(scaledAt.spec, scaledAt.spec.base.name)),
				(built) => {
					const owned = owning(built.base)
					const logins = Arr.map(Rec.values(built.logins), (l) =>
						succeeded(ownLogin(defined(loginDescOf(l), "a login built by login(...)")))
					)
					const options = completeInstallOptions(
						owned,
						installationsOf(owned),
						logins,
						[],
						firstCodebook(rostersOf(owned))
					)
					return succeeded(compileInstallation(owned, options))
				}
			)
	}
}

/** The nodes of a statement as snapshot.json holds it: each object, list and scalar one, and an absent clause none. */
const nodes = (v: unknown): number =>
	v === undefined
		? 0
		: isList(v)
			? Arr.reduce(v, 1, (n, x) => n + nodes(x))
			: isRecord(v)
				? Arr.reduce(Rec.values(v), 1, (n, x) => n + nodes(x))
				: 1

/**
 * An installation's sizes in AST nodes: each object's statements, and each role default, public
 * revoke and comment, the largest of them and their total; and snapshot.json's length.
 */
const sizesOf = (installation: Installation) => {
	const manifest = installation.manifest
	const sizes = [
		...Arr.map(manifest.objects, (o) => Arr.reduce(o.ddl, 0, (n, st) => n + nodes(st))),
		...Arr.map([...manifest.roleDefaults, ...manifest.publicRevokes, ...manifest.comments], (st) =>
			nodes(st)
		)
	]
	const snapshot = succeeded(
		finishSnapshot(succeeded(targetState({ installation, workload: noWorkload })))
	)
	return {
		largest: Arr.reduce(sizes, 0, (m, x) => Math.max(m, x)),
		total: Arr.reduce(sizes, 0, (n, x) => n + x),
		snapshot: succeeded(writeSnapshot(snapshot)).length
	}
}

describe("installation size", () => {
	it.effect(
		"no object, installation or snapshot grows faster than one dimension of its schema or worlds",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/laws/scaling",
						generator: pointGen,
						literal: Formatter.format,
						limit: dimensions.length * 6,
						coverage: requiredInSpace<Dimension>(dimensions),
						caseHang
					},
					(point, c) =>
						Effect.gen(function* () {
							c.note(point.dimension)
							const smallInstallation = yield* installationOf(scaled(point))
							const small = sizesOf(smallInstallation)
							const largeInstallation = yield* installationOf(scaled({ ...point, n: 2 * point.n }))
							const large = sizesOf(largeInstallation)
							const at = `${point.dimension} at ${point.n} against ${2 * point.n}`
							assert.ok(
								large.largest <= linear * small.largest,
								`${at}: the largest object grows from ${small.largest} to ${large.largest} nodes`
							)
							assert.ok(
								large.total <= linear * small.total,
								`${at}: the installation grows from ${small.total} to ${large.total} nodes`
							)
							assert.ok(
								large.snapshot <= linear * small.snapshot,
								`${at}: snapshot.json grows from ${small.snapshot} to ${large.snapshot} characters`
							)
						})
				)
			)
	)
})
