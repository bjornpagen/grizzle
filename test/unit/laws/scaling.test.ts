/**
 * No installation, and no snapshot, grows faster than the schema facts it serves: a size relation over AST nodes, the
 * size oracle every outcome oracle lacks. A product of two dimensions, a function whose body is tables × handles, a law
 * compiled once per trigger into every table's text, a role's grants listing every other role, increments by more over
 * each later step of its dimension, at every size, far below any size a clock would notice.
 *
 * Property: for each scalable dimension of a schema and of its worlds, the installation at 2h, 4h and 6h of that
 * dimension alone, h from 2 to 4: the total of its objects' statements, role defaults, revokes and comments, counted as
 * AST nodes (as snapshot.json holds them, a structural property, never printed text), and its snapshot.json and
 * manifest.json read back and counted as JSON nodes, each increments no more from 4h to 6h than from 2h to 4h
 * (test/support/growth.ts incrementsDoNotGrow). Every size is even, so the dimension that pairs its handles up, ⌈n / 2⌉
 * arm relations for n handles, is affine there too. The largest object is no measure of its own: a size above linear
 * in one object makes the total's increments grow.
 *
 * The schema dimensions are drawn as Descriptions, installed with the full role of the oracle login; the worlds
 * dimensions (roles, whole entries per role, world views, context fields) as the worlds suites' install descriptions
 * (worlds model/types.ts InstallSpec), built through the public builders as those suites build them and installed with
 * their logins.
 *
 * Box: every dimension at every h, exhausted. Oracle: universal, the increments of a size that grows no faster than
 * linearly. Assumptions: no dimension's installation changes shape above some size of it (an object that appears only
 * past a threshold would land in one increment alone), and a key of 24 fields, the parent key at its largest, stays
 * within INDEX_MAX_KEYS beside the columns its laws add.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): scaling-reverse-per-handle-pair (an alternatives statement states a
 * reverse containment for every pair of a handle and an arm, its laws quadratic in the roster).
 *
 * Features: each dimension.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { isList, isRecord } from "#compiler/core/record.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import {
	derivedOf,
	finishSnapshot,
	noWorkload,
	targetState,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { defined, succeeded } from "#test/support/assert.ts"
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
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import { caseHang } from "#test/support/limits.ts"
import { oracleLogin } from "#test/support/oracle/install/real.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { owning } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"
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

/** A dimension, and half the least of the three sizes it is installed at: 2·half, 4·half and 6·half. */
interface Point {
	readonly dimension: Dimension
	readonly half: number
}

const pointGen: Gen<Point> = (s) => ({
	dimension: s.draw(element(dimensions)),
	half: s.draw(int(2, 4))
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
	const key = upTo(keyWidth, (i) => `k${i + 1}`)
	const keyFields = Rec.fromEntries(Arr.map(key, (k) => [k, f.integer] as const))
	const handles = upTo(size, (i) => `h${i}`)
	const Roster = closed("Roster", handles)
	const Node = relation("Node", { ...keyFields, kind: f.closedId("Roster") }, key)
	const armIndexes = [
		...new Set(Arr.flatMap(upTo(size, armOf), (j) => (j === undefined ? [] : [j])))
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

/** The installation of `dimension` at size `n`. */
const scaled = (dimension: Dimension, n: number): Scaled => {
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
			const sources = upTo(n, (i) =>
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
			const selectors = nonEmptyList(
				upTo(n, (i) => `s${i}`),
				"the selectors"
			)
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
			const pairs = upTo(n, (i) => [
				relation(`Team${i}`, { id: f.integer, cap: f.bigint, n: f.drawn }, ["id"]),
				relation(`Member${i}`, { id: f.integer, team: f.integer }, ["id"])
			])
			return schemaAt(
				schemaOf(
					"Scaled",
					Arr.flatten(pairs),
					Arr.flatMap(
						upTo(n, (i) => i),
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
							upTo(n, (i) => `c${i}`)
						),
						relation("Paint", { id: f.integer, color: f.closedId("Color") }, ["id"])
					],
					[]
				)
			)
		case "roles":
			return worldsAt(
				baseOf([item], []),
				nonEmptyList(
					upTo(n, (i) => fullOn(`r${i}`, [item])),
					"the roles"
				)
			)
		case "entries per role": {
			const relations = nonEmptyList(
				upTo(n, (i): RelationSpec => ({
					name: `E${i}`,
					fields: [{ name: "id", domain: uuidDomain }],
					key: ["id"],
					mutability: "immutable"
				})),
				"the relations"
			)
			return worldsAt(baseOf(relations, []), [fullOn("reader", relations)])
		}
		case "world views":
			return worldsAt(baseOf([item], []), [
				{
					name: "reader",
					entries: Rec.fromEntries(
						upTo(n, (i) => [`View${i}`, ownedItems(literalTerm(i), [])] as const)
					),
					write: [],
					refresh: []
				}
			])
		case "context fields": {
			const claims: ContextSpec = {
				name: "Claims",
				claim: { kind: "top-level" },
				fields: nonEmptyList(
					upTo(n, (i) => ({ name: `c${i}`, domain: integerDomain })),
					"the context fields"
				)
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
 * An installation's sizes in AST nodes: the total of each object's statements and each role default, public revoke and
 * comment; and snapshot.json's and manifest.json's, read back as the JSON values they hold.
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
		finishSnapshot(
			succeeded(
				targetState({ installation, workload: noWorkload, checks: lawChecks(installation) })
			)
		)
	)
	const files = succeeded(writeSnapshot(snapshot, derivedOf(installation)))
	return {
		total: Arr.reduce(sizes, 0, (n, x) => n + x),
		snapshot:
			nodes(trustedJson<unknown>(files.snapshot)) + nodes(trustedJson<unknown>(files.manifest))
	}
}

describe("installation size", () => {
	it.effect(
		"no installation or snapshot grows faster than one dimension of its schema or worlds",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/scaling",
						generator: pointGen,
						literal: Formatter.format,
						box: "every dimension of a schema and of its worlds, installed at 2h, 4h and 6h for every h from 2 to 4",
						oracle: {
							kind: "universal",
							name: "a size that grows no faster than linearly increments no more over its second equal step than over its first"
						},
						coverage: requiredInSpace<Dimension>(dimensions),
						caseHang,
						concurrency: 1
					},
					(point, c) =>
						Effect.gen(function* () {
							c.note(point.dimension)
							const measured = new Map<number, ReturnType<typeof sizesOf>>()
							for (const size of [2 * point.half, 4 * point.half, 6 * point.half]) {
								const installation = yield* installationOf(scaled(point.dimension, size))
								measured.set(size, sizesOf(installation))
							}
							const at = (size: number) => defined(measured.get(size), `the sizes at ${size}`)
							incrementsDoNotGrow(
								(size) => at(size).total,
								point.half,
								`${point.dimension}: the installation's AST nodes`
							)
							incrementsDoNotGrow(
								(size) => at(size).snapshot,
								point.half,
								`${point.dimension}: snapshot.json's and manifest.json's JSON nodes`
							)
						})
				)
			)
	)
})
