/**
 * A stratum's deletes of whole units as one statement. A delete of a relation that is a tree, or that owns a family and
 * is no family's member, names units: a tree by its root fields, an owner by its facts. Each unit is the named rows and
 * every row nested under them through the families: each member of a removed row's group, transitively, a tree's node
 * taking its whole tree. A unit goes whole, so no count, index, fold end or tree interval describes a partial group.
 *
 * The statement reads every doomed key first, top-down over the families, each a materialized SELECT of one snapshot,
 * and then deletes each relation's doomed rows by key, each DELETE a data-modifying CTE returning the facts it removed:
 *
 *   WITH "r1"("c1") AS (<the stated rows>),
 *   "r2"("c2") AS MATERIALIZED (SELECT "r3"."id" FROM "s"."doc" AS "r3" WHERE EXISTS (<"r1" at its fields>)),
 *   "r4"("c3", "c4") AS MATERIALIZED (SELECT "r5"."doc", "r5"."name" FROM "s"."tag" AS "r5"
 *                                     WHERE EXISTS (SELECT 1 FROM "r2" WHERE "r5"."doc" = "r2"."c2")),
 *   "r6" AS (DELETE FROM "s"."tag" AS "r7" USING "r4" WHERE ... RETURNING ...),
 *   "r8" AS (DELETE FROM "s"."doc" AS "r9" USING "r2" WHERE ... RETURNING ...)
 *   SELECT <each deletion's facts behind its tag>
 *
 * Every SELECT reads the snapshot the statement starts from, so a removed owner still finds its members, and PostgreSQL
 * checks every immediate foreign key at the statement's end, when no member of a removed group remains. The stratum's
 * schedule runs it before every other statement of its stratum (write/frontend/schedule.ts), so it reads the state
 * before the stratum, as every member does, and an insert of the stratum at a removed key meets no stored row there.
 * The outcome nets its removals against the stratum's additions by fact (runtime/write/net.ts), so a unit inserted again
 * identically is no change, and the counts are the difference of the two states.
 *
 * The chain of doomed keys over generic edges, a member's columns equal to an owner's key, is the shape of a retirement's
 * deletion of a sealed group's bodies.
 */
import { defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { rowEq, typedEq } from "#compiler/ir/compare.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { WriteParams } from "#compiler/lower/conservative/context.ts"
import type { Cte, Expr } from "#compiler/sql/ast.ts"
import {
	and,
	col,
	cte,
	cteRefAs,
	exists,
	or,
	provedCore,
	select,
	simpleSelect,
	target,
	targetAs
} from "#compiler/sql/build.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import { fieldColumns, type FieldColumns } from "#compiler/write/defined.ts"
import {
	deletedResult,
	type FamilyReturning,
	type FamilyWriteSql,
	internal,
	one,
	tableAs,
	taggedRows
} from "#compiler/write/family/written.ts"
import { readInput, type RelationInput, unproved } from "#compiler/write/insert/input.ts"
import {
	keyFirst,
	returnedColumn,
	rowType,
	type WriteContext
} from "#compiler/write/insert/statement.ts"

/** Where a unit delete's rows come from: an enumerated slot's facts, or a described source of the write DAG. */
export type UnitSource =
	| { readonly kind: "slot"; readonly input: RelationInput }
	| { readonly kind: "described"; readonly node: RelNode }

/** How a unit delete's rows name its root relation's rows: a tree's by its root fields, an owner's by its facts. */
export type UnitMatch =
	| { readonly kind: "tree"; readonly root: NonEmptyReadonlyArray<LawField> }
	| { readonly kind: "facts"; readonly fields: NonEmptyReadonlyArray<LawField> }

/**
 * A relation below a unit's root: its rows go where they are members of a removed row of the owner of one of
 * `families`, each family's owner above it in the unit; a tree's relation (`tree`, its root fields) with the whole tree
 * of each such node.
 */
export interface UnitMember {
	readonly relation: RelationInfo
	readonly families: NonEmptyReadonlyArray<Family>
	readonly tree: NonEmptyReadonlyArray<LawField> | undefined
}

/** A delete of one relation's units in a stratum: its rows by `match` from `source`, and every relation below it, each
 * after the owners of its families. */
export interface UnitDelete {
	readonly relation: RelationInfo
	readonly match: UnitMatch
	readonly source: UnitSource
	readonly below: ReadonlyArray<UnitMember>
}

/** The fields a unit delete's rows state: a tree's root fields, or an owner's compared fields. */
export const matchFields = (match: UnitMatch): NonEmptyReadonlyArray<LawField> =>
	match.kind === "tree" ? match.root : match.fields

/** A relation's doomed keys: the CTE of its primary key's values, by field. */
interface Doomed {
	readonly name: string
	readonly keys: FieldColumns<string>
}

/** The statement of a stratum's unit deletes (see the header). */
export const unitSql = (
	w: WriteContext,
	units: NonEmptyReadonlyArray<UnitDelete>
): FamilyWriteSql => {
	const supply = new NameSupply(w.start)
	const params = new WriteParams()
	w.cx.beginWriteStatement(supply, params)
	const ctes: Array<Cte> = []
	const doomed = new Map<string, Doomed>()
	const stored = (alias: string, relation: RelationInfo, field: LawField): Expr =>
		col(alias, w.names.column(relation.name, field.name))
	/** The doomed keys of `relation`, the rows of it `matched` holds of under the alias it is given, pushed as a
	 * materialized CTE; a tree's relation keeps every node of each matched node's tree. */
	const doom = (
		relation: RelationInfo,
		tree: NonEmptyReadonlyArray<LawField> | undefined,
		matched: (alias: string) => Expr
	): Doomed => {
		const t = supply.relation(internal(`doomed ${relation.name}`))
		const keys = fieldColumns(relation.primaryFields, () => supply.column(internal("doomed key")))
		const where =
			tree === undefined
				? matched(t)
				: (() => {
						const node = supply.relation(internal(`doomed tree of ${relation.name}`))
						return exists(
							simpleSelect(
								[target(one)],
								[tableAs(w, relation.name, node)],
								and([
									...mapNonEmpty(tree, (f) =>
										typedEq(rowType(f), stored(node, relation, f), stored(t, relation, f), w.names)
									),
									matched(node)
								])
							)
						)
					})()
		const name = supply.relation(internal(`doomed keys of ${relation.name}`))
		ctes.push({
			...cte(
				name,
				keys.columns,
				select(
					provedCore(
						"keyed",
						keys.pairs.map((p) => targetAs(stored(t, relation, p.field), p.column)),
						[tableAs(w, relation.name, t)],
						where
					)
				)
			),
			materialized: "MATERIALIZED"
		})
		const found: Doomed = { name, keys }
		doomed.set(relation.name, found)
		return found
	}
	for (const unit of units) {
		const fields = matchFields(unit.match)
		const scan = supply.relation(internal("unit source scan"))
		const sourceKeys = fieldColumns(fields, () => supply.column(internal("unit source column")))
		const read = readInput(
			w,
			unit.source.kind === "slot"
				? unit.source.input
				: { kind: "described", node: unit.source.node, proof: unproved },
			{ kind: "input", fields, alias: scan, keys: sourceKeys, into: { as: "compare" } },
			`delete ${unit.relation.name}`
		)
		const source = supply.relation(internal("unit source"))
		ctes.push(cte(source, sourceKeys.columns, read.select))
		doom(unit.relation, undefined, (t) => {
			const s = supply.relation(internal("unit source row"))
			return exists(
				simpleSelect(
					[target(one)],
					[cteRefAs(source, s)],
					unit.match.kind === "tree"
						? and(
								mapNonEmpty(unit.match.root, (f) =>
									typedEq(
										rowType(f),
										stored(t, unit.relation, f),
										col(s, sourceKeys.of(f)),
										w.names
									)
								)
							)
						: rowEq(
								{
									fields: unit.match.fields,
									typeOf: rowType,
									left: (f) => stored(t, unit.relation, f),
									right: (f) => col(s, sourceKeys.of(f))
								},
								w.names
							)
				)
			)
		})
		for (const member of unit.below) {
			doom(member.relation, member.tree, (t) =>
				or(
					mapNonEmpty(member.families, (family) => {
						const owner = doomedOf(doomed, family.owner.name)
						const k = supply.relation(internal(`doomed owner ${family.owner.name}`))
						return exists(
							simpleSelect(
								[target(one)],
								[cteRefAs(owner.name, k)],
								and(
									mapNonEmpty(family.group, (g) =>
										typedEq(
											rowType(g.owner),
											stored(t, member.relation, g.member),
											col(k, owner.keys.of(g.owner)),
											w.names
										)
									)
								)
							)
						)
					})
				)
			)
		}
	}
	const returnings = mapNonEmpty(unitRelations(units), (relation): FamilyReturning => {
		const found = doomedOf(doomed, relation.name)
		const t = supply.relation(internal(`unit delete ${relation.name}`))
		const k = supply.relation(internal("unit delete key"))
		const returned = keyFirst(relation).map((field) => ({
			field,
			alias: supply.column(internal("unit deleted returned"))
		}))
		const del = supply.relation(internal("unit delete"))
		ctes.push(
			cte(del, [], {
				kind: "delete",
				with: undefined,
				table: w.names.relation(relation.name),
				alias: t,
				using: [cteRefAs(found.name, k)],
				where: and(
					mapNonEmpty(relation.primaryFields, (f) =>
						typedEq(rowType(f), stored(t, relation, f), col(k, found.keys.of(f)), w.names)
					)
				),
				returning: returned.map((x) => targetAs(stored(t, relation, x.field), x.alias))
			})
		)
		return {
			cte: del,
			columns: returned.map((x) => returnedColumn(col(del, x.alias), rowType(x.field), x.alias)),
			relation: relation.name,
			result: deletedResult(relation),
			rows: "facts"
		}
	})
	return taggedRows(supply, ctes, returnings, params, [])
}

/** Every relation a stratum's unit deletes remove rows of: each root, then the relations below it, in order. */
export const unitRelations = (
	units: NonEmptyReadonlyArray<UnitDelete>
): NonEmptyReadonlyArray<RelationInfo> => {
	const [first, ...rest] = units
	return [
		first.relation,
		...first.below.map((m) => m.relation),
		...rest.flatMap((u) => [u.relation, ...u.below.map((m) => m.relation)])
	]
}

/** The doomed keys a relation above a member pushed, which the unit's order put first. */
const doomedOf = (doomed: ReadonlyMap<string, Doomed>, relation: string): Doomed =>
	defined(
		doomed.get(relation),
		`the doomed keys of ${relation}, an owner above its members in the unit`
	)
