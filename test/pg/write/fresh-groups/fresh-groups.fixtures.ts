/**
 * What the property of fresh-groups.test.ts reads: schemas of counted families over relations every ChangeSet inserts
 * at its top level, each relation mutable, an instance of each, the instance's writes by depth, and each table's rows,
 * every column, as PostgreSQL stores them.
 */
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { aimed, boolean, constant, element, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order } from "effect"
import { printObjectName } from "#compiler/sql/print.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import {
	admittedSources,
	type CopySource,
	type FillSpec,
	generationOfV,
	insertedRelations,
	instanceGen,
	type InstanceRow,
	noGeneration,
	uuidOfRow,
	verdictOf
} from "#test/support/families/fill.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A situation a case reaches. */
export type Feature =
	| "a fresh group of several members"
	| "a member of two counted families"
	| "a counted member that owns a counted family"
	| "an owner copy along a counted family"
	| "a fold over a counted family"
	| "members written out of their key order"
	| "a counted member nested in a sequence"
	| "an exact repeat of a stored owner beside an append to its group"
	| "an exact repeat of a stored immutable owner beside an append, refused"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"a fresh group of several members",
	"a member of two counted families",
	"a counted member that owns a counted family",
	"an owner copy along a counted family",
	"a fold over a counted family",
	"members written out of their key order",
	"a counted member nested in a sequence",
	"an exact repeat of a stored owner beside an append to its group",
	"an exact repeat of a stored immutable owner beside an append, refused"
]

/** Whether two copies read one source: of one kind, and of one family or one copy where the kind names one. */
const sameSource = (a: CopySource, b: CopySource): boolean => {
	const of = (x: CopySource): string => {
		switch (x.kind) {
			case "count":
			case "index":
			case "fold":
				return `${x.kind} ${String(x.family)}`
			case "copy":
				return `copy ${String(x.copy)}`
			case "caller":
			case "generated":
			case "start":
			case "end":
				return x.kind
		}
	}
	return of(a) === of(b)
}

/**
 * A copy's sources along a counted family's owner axis, each the reference admits beside the copies so far: the owner's
 * caller's `v`, its generated `g` where it holds one, and the count and the fold's end of each other counted family it
 * owns: a family's own count its members hold already, as ‹n›, which its owner axis's foreign key carries once.
 */
const ownerSources = (spec: FillSpec, f: number): ReadonlyArray<CopySource> => {
	const owner = defined(spec.families[f]).owner
	const owned = Arr.flatMap(spec.families, (family, k): ReadonlyArray<CopySource> =>
		family.owner === owner && k !== f
			? [
					{ kind: "count", family: k },
					...(family.fold === "none" ? [] : [{ kind: "fold", family: k } as const])
				]
			: []
	)
	/** Whether family `f`'s owner axis carries `source` already: an axis's foreign key references each column once. */
	const carried = (source: CopySource): boolean =>
		Arr.some(spec.copies, (copy) => copy.family === f && sameSource(copy.source, source))
	return admittedSources(
		spec,
		f,
		"owner",
		Arr.filter(
			[
				{ kind: "caller" } as const,
				...(defined(spec.relations[owner]).generated.kind !== "none"
					? [{ kind: "generated" } as const]
					: []),
				...owned
			],
			(source) => !carried(source)
		)
	)
}

/**
 * A schema of two to four relations, every one mutable, with one to three counted families, each owner declared before
 * its member, so a member's owners are written before it where the writes go by depth; half the time an ordered family
 * nesting one counted member under another relation, where the reference admits it, so a fresh group's members come
 * from the nested walk in slot order; and up to two copies along the counted families' owner axes, each a source the
 * reference admits.
 */
const freshSpecGen: Gen<FillSpec> = (source) => {
	const n = source.draw(int(2, 4))
	const relations = nonEmpty(
		Array.from({ length: n }, () => ({
			generated: source.draw(boolean) ? generationOfV : noGeneration,
			mutable: true
		}))
	)
	const families = nonEmpty(
		Array.from({ length: source.draw(int(1, 3)) }, () => {
			const member = source.draw(int(1, n - 1))
			return {
				kind: "counted" as const,
				owner: source.draw(int(0, member - 1)),
				member,
				fold: source.draw(element(["none", "sum", "count"] as const))
			}
		})
	)
	let spec: FillSpec = { relations, families, copies: [], steps: [] }
	const nested = source.draw(boolean)
		? Option.flatMap(Option.some(source.draw(element(families))), (counted) => {
				const owners = new Set(
					Arr.flatMap(families, (f) => (f.member === counted.member ? [f.owner] : []))
				)
				const candidates = Arr.filter(
					Arr.map(relations, (_, r) => r),
					(r) => r !== counted.member && !owners.has(r)
				)
				return Arr.isReadonlyArrayNonEmpty(candidates)
					? Option.some({
							kind: "ordered" as const,
							owner: source.draw(element(candidates)),
							member: counted.member,
							fold: "none" as const
						})
					: Option.none()
			})
		: Option.none()
	if (Option.isSome(nested)) {
		const withNested: FillSpec = { ...spec, families: [...spec.families, nested.value] }
		spec = verdictOf(withNested).kind === "admitted" && splits(withNested) ? withNested : spec
	}
	for (let j = source.draw(int(0, 2)); j > 0; j -= 1) {
		const f = source.draw(int(0, families.length - 1))
		const sources = ownerSources(spec, f)
		if (Arr.isReadonlyArrayNonEmpty(sources)) {
			spec = {
				...spec,
				copies: [
					...spec.copies,
					{ family: f, axis: "owner", source: source.draw(element(sources)) }
				]
			}
		}
	}
	return spec
}

/** A case: its schema and an instance of it, the instance's rows in their drawn order. */
export interface FreshCase {
	readonly spec: FillSpec
	readonly rows: ReadonlyArray<InstanceRow>
}

/** A case of a schema `specs` draws, and an instance of it written in a drawn order, so members leave their key order. */
const caseOf =
	(specs: Gen<FillSpec>): Gen<FreshCase> =>
	(source) => {
		const spec = source.draw(specs)
		const rows = source.draw(instanceGen(spec))
		return { spec, rows: source.draw(shuffled(rows, { min: rows.length, max: rows.length })) }
	}

/** A case: a drawn schema (`freshSpecGen`) and an instance of it. */
export const freshCases: Gen<FreshCase> = caseOf(freshSpecGen)

/**
 * A schema whose counted member R2 is nested in R1's ordered family, R0 its counted family's owner, so the host draws
 * a fresh group's members from the nested walk, in slot order, where the scan draws them in key order.
 */
const nestedMember: FillSpec = {
	relations: [
		{ generated: noGeneration, mutable: true },
		{ generated: noGeneration, mutable: true },
		{ generated: noGeneration, mutable: true }
	],
	families: [
		{ kind: "counted", owner: 0, member: 2, fold: "sum" },
		{ kind: "ordered", owner: 1, member: 2, fold: "none" }
	],
	copies: [{ family: 0, axis: "owner", source: { kind: "caller" } }],
	steps: []
}

/**
 * An instance of `nestedMember` whose counted members' keys run against their slots: R2's rows 7, 5 and 6 at R1's
 * slots 0, 1 and 2, so the nested walk meets them out of their key order, every one in R0's one group.
 */
const nestedCase: FreshCase = {
	spec: nestedMember,
	rows: [
		{ relation: 0, id: 1, v: 1n, memberOf: [] },
		{ relation: 1, id: 2, v: 2n, memberOf: [] },
		...Arr.map([7, 5, 6], (id, slot) => ({
			relation: 2,
			id,
			v: BigInt(id),
			memberOf: [
				{ family: 0, owner: 1, slot: 0 },
				{ family: 1, owner: 2, slot }
			]
		}))
	]
}

/** The cases, each pending situation aimed at by a case constructed to reach it, never by filtering draws. */
export const freshCaseGen = aimed(freshCases, [
	["a counted member nested in a sequence", constant(nestedCase)]
] as const)

/** The relation whose top-level rows carry `r`'s: itself where a ChangeSet inserts it, else its sequence's owner's. */
const topOf = (spec: FillSpec, r: number): number =>
	insertedRelations(spec).includes(r)
		? r
		: topOf(
				spec,
				defined(
					Arr.findFirst(spec.families, (f) => f.kind !== "counted" && f.member === r).pipe(
						Option.getOrUndefined
					),
					"the sequence a nested relation is a member of"
				).owner
			)

/**
 * The depth of top-level relation `t`: 0 where no row its writes carry is a counted member whose owner another top
 * relation's writes carry, else one past the deepest such owner's; none where such owners come back to `t`, so no order
 * of writes stores every owner first (`passed` the relations on the way).
 */
const depthThrough = (
	spec: FillSpec,
	t: number,
	passed: ReadonlySet<number>
): Option.Option<number> =>
	passed.has(t)
		? Option.none()
		: Arr.reduce(spec.families, Option.some(0), (deepest, f) => {
				const owner = topOf(spec, f.owner)
				return f.kind === "counted" && topOf(spec, f.member) === t && owner !== t
					? Option.flatMap(deepest, (d) =>
							Option.map(depthThrough(spec, owner, new Set([...passed, t])), (o) =>
								Math.max(d, o + 1)
							)
						)
					: deepest
			})

/** Whether every top-level relation of `spec` has a depth, so its writes by depth store each owner first. */
const splits = (spec: FillSpec): boolean =>
	Arr.every(insertedRelations(spec), (t) => Option.isSome(depthThrough(spec, t, new Set())))

/** The depth of a top-level relation of a schema that splits (`splits`). */
const depthOf = (spec: FillSpec, t: number): number =>
	Option.getOrThrowWith(depthThrough(spec, t, new Set()), () => new Error("a schema that splits"))

/**
 * The relations an instance's writes by depth insert at their top level, each write one ChangeSet: every one of depth
 * 0, then 1, and on, so each counted member is appended where its owners are stored, its groups drawn by its family's
 * scan.
 */
export const writesByDepth = (spec: FillSpec): ReadonlyArray<ReadonlyArray<number>> => {
	const tops = insertedRelations(spec)
	const depths = Arr.map(tops, (t) => [t, depthOf(spec, t)] as const)
	const most = Arr.reduce(depths, 0, (a, [, d]) => Math.max(a, d))
	return Array.from({ length: most + 1 }, (_, d) =>
		Arr.flatMap(depths, ([t, depth]) => (depth === d ? [t] : []))
	)
}

/**
 * Every row of a relation's table in `installed`, every column, each row its JSON text (row_to_json), in code point
 * order: the stored state, its law columns among it, of one installation, comparable with another's of one schema.
 */
export const storedRows = (installed: Installed, relation: AnyRelation) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const table = printObjectName(installed.names.relation(relation.name))
		const rows = yield* s.admin.queryValues(`SELECT row_to_json(t)::text FROM ${table} AS t`, [])
		return Arr.sort(
			Arr.map(rows, (row) => String(row[0])),
			Order.String
		)
	})

/**
 * A row to append beside an exact repeat of a stored owner: in counted family `f`'s member relation, its id 0, before
 * every id of the instance (`instanceOf` counts them from 1), so its key sorts first in its group, a member of `owner`'s
 * group of `f`, and of the first stored owner's group of every other counted family its relation is a member of. The
 * scan draws it past the group's stored members, at the kept count's slot, where a draw of the group from slot 0 puts it
 * at slot 0, a stored member's. None where the instance holds no owner for one of those families.
 */
export const appendedBeside = (
	spec: FillSpec,
	rows: ReadonlyArray<InstanceRow>,
	f: number,
	owner: number
): Option.Option<InstanceRow> => {
	const member = defined(spec.families[f]).member
	const memberships = Arr.flatMap(spec.families, (family, k) =>
		family.member === member
			? [
					k === f
						? Option.some({ family: k, owner, slot: 0 })
						: Option.map(
								Arr.findFirst(rows, (row) => row.relation === family.owner),
								(named) => ({ family: k, owner: named.id, slot: 0 })
							)
				]
			: []
	)
	return Option.map(Option.all(memberships), (memberOf) => ({
		relation: member,
		id: 0,
		v: 0n,
		memberOf
	}))
}

/** Whether a relation's rows are written out of their key order, their ids' uuids (fill.ts uuidOfRow) not ascending. */
export const outOfKeyOrder = (rows: ReadonlyArray<InstanceRow>, r: number): boolean => {
	const keys = Arr.flatMap(rows, (row) => (row.relation === r ? [uuidOfRow(row.id)] : []))
	return Arr.some(keys, (key, i) => i > 0 && key < defined(keys[i - 1]))
}
