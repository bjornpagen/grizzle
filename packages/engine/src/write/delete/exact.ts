import type { ParamId } from "#compiler/core/ids.ts"
import { appendNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { fieldNames, type LawField, type RelationInfo } from "#compiler/ir/law.ts"
import { columnType, emptyEnv, extendEnv } from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { regionParts } from "#compiler/lower/conservative/match-region/index.ts"
import { rowEq, rowNe, typedEq } from "#compiler/lower/conservative/vector/equality.ts"
import type { Cte, Delete, Expr, FromItem } from "#compiler/sql/ast.ts"
import {
	and,
	asOperand,
	col,
	conjunction,
	core,
	cte,
	cteRef,
	select,
	setOp,
	targetAs
} from "#compiler/sql/build.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"
import { type FieldColumns, fieldColumns } from "#compiler/write/defined.ts"
import type { DeleteAnchor } from "#compiler/write/delete/anchor.ts"
import {
	inputSharing,
	readInput,
	skipWhenEmptyOf,
	type WriteInput
} from "#compiler/write/insert/input.ts"

import {
	buildStatement,
	type DeleteResult,
	keyFirst,
	type ModifyingStatement,
	ownBuild,
	type ResultColumn,
	resultText,
	rowType,
	type WriteContext
} from "#compiler/write/insert/statement.ts"

interface DeleteSpec {
	readonly relation: RelationInfo
	readonly input: WriteInput
}

/** An exact deletion's spec: also the stratum's additions to the relation, complete facts all, which it reads
 * D EXCEPT A over. */
interface ExactDeleteSpec extends DeleteSpec {
	readonly except: ReadonlyArray<WriteInput>
}

/** A put's displacing deletion's spec: also the relation's payload, which an occupant at a requested key differs in. */
interface DisplacingDeleteSpec extends DeleteSpec {
	readonly payload: NonEmptyReadonlyArray<LawField>
}

/** How a deletion matches stored facts: an exact deletion, a requested fact at every field, its stratum's additions
 * excepted; a displacing deletion, the occupant at a requested fact's key whose payload differs. */
type DeleteMode =
	| { readonly kind: "exact"; readonly except: ReadonlyArray<WriteInput> }
	| { readonly kind: "displacing"; readonly payload: NonEmptyReadonlyArray<LawField> }

/** An anchored deletion's spec: the occurrence its member is anchored on. */
interface AnchoredDeleteSpec {
	readonly relation: RelationInfo
	readonly anchor: DeleteAnchor
}

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** The DELETE's matching part and the CTEs it reads, under its target alias `r3`: the statement around it (deletion)
 * returns the complete facts it removed, which delta.removed and the netting across strata read. */
interface DeleteMatch {
	readonly leading: ReadonlyArray<Cte>
	readonly using: ReadonlyArray<FromItem>
	/** The conjuncts of its WHERE; none deletes every fact of the relation. */
	readonly where: ReadonlyArray<Expr>
}

/** The deletion statement: the DELETE of `relation` under alias `r3` as the data-modifying CTE `r2`, after the CTEs
 * it reads, returning the complete facts it removed into `returned`, and the outer SELECT of their result texts. */
const deletion = (
	w: WriteContext,
	relation: RelationInfo,
	mode: DeleteResult["mode"],
	names: { readonly r2: string; readonly r3: string; readonly returned: FieldColumns<string> },
	match: DeleteMatch,
	skipWhenEmpty: ParamId | undefined
) => {
	const { r2, r3, returned } = names
	const outFields = keyFirst(relation)
	const stored = (f: LawField): Expr => col(r3, w.names.column(relation.name, f.name))
	const del: Delete = {
		kind: "delete",
		with: undefined,
		table: w.names.relation(relation.name),
		alias: r3,
		using: match.using,
		where: conjunction(match.where),
		returning: returned.pairs.map((p) => targetAs(stored(p.field), p.column))
	}
	const columns: ReadonlyArray<ResultColumn> = outFields.map((f) => ({
		name: f.name,
		type: rowType(f)
	}))
	const outer = core(
		returned.pairs.map((p) => targetAs(resultText(col(r2, p.column), rowType(p.field)), p.column)),
		[cteRef(r2)],
		undefined
	)
	const result: DeleteResult = {
		kind: "delete",
		relation: relation.name,
		mode,
		columns,
		fields: fieldNames(outFields),
		key: relation.primaryKey
	}
	return {
		ast: {
			...select(outer),
			with: { recursive: false, ctes: appendNonEmpty(match.leading, cte(r2, [], del)) }
		},
		role: "member" as const,
		result,
		skipWhenEmpty,
		returning: { cte: r2, kind: "removed" as const, removed: { columns: returned, conditions: [] } }
	}
}

const buildDelete = (
	w: WriteContext,
	spec: DeleteSpec,
	mode: DeleteMode
): ModifyingStatement<DeleteResult> => {
	const { relation, input } = spec
	const at = `${mode.kind === "exact" ? "delete" : "put deletion"} ${relation.name}`
	const all = keyFirst(relation)
	const pk = relation.primaryFields
	const except = mode.kind === "exact" ? mode.except : []
	const sharing = inputSharing(
		w.share.deletions,
		[input, ...except],
		[relation, mode.kind, input, except.length, ...except]
	)
	return buildStatement(w, sharing, (supply) => {
		const scan = supply.relation(internal("input scan"))
		const r1 = supply.relation(internal("input"))
		const r2 = supply.relation(internal("delete"))
		const r3 = supply.relation(internal(`target ${relation.name}`))
		const inputs = fieldColumns(all, () => supply.column(internal("input column")))
		const returned = fieldColumns(all, () => supply.column(internal("returned column")))
		/** Both D and A read as the relation's facts, cast into its column types (`into`), so the exact
		 * identity, the displacing key and payload comparisons and EXCEPT compare written facts. The cast
		 * is into each column's base type with its typmod: a value outside a domain matches no stored fact. */
		const into = { as: "compare" } as const
		const read = readInput(
			w,
			input,
			{ kind: "input", fields: all, distinct: false, alias: scan, keys: inputs, into },
			at
		)
		const body = setOp("EXCEPT", [
			asOperand(read.select.body),
			...except.map((addition) =>
				asOperand(readInput(w, addition, { kind: "except", fields: all, into }, at).select.body)
			)
		])
		const inCol = (f: LawField): Expr => col(r1, inputs.of(f))
		const stored = (f: LawField): Expr => col(r3, w.names.column(relation.name, f.name))
		/** Each comparison is at its fields' types: a row holding a vector is spelled column by column through the
		 * extension's qualified operator, which a row comparison would resolve through the search_path. */
		const typeOf = rowType
		const vectorSchema = w.names.vectorSchema
		const where =
			mode.kind === "exact"
				? rowEq({ fields: all, typeOf, left: stored, right: inCol }, vectorSchema)
				: and(
						appendNonEmpty(
							pk.map((f) => typedEq(typeOf(f), stored(f), inCol(f), vectorSchema)),
							rowNe({ fields: mode.payload, typeOf, left: stored, right: inCol }, vectorSchema)
						)
					)
		return deletion(
			w,
			relation,
			mode.kind,
			{ r2, r3, returned },
			{
				leading: [cte(r1, inputs.columns, select(body))],
				using: [cteRef(r1)],
				where: [where]
			},
			skipWhenEmptyOf(input)
		)
	})
}

/** Exact deletions and the deletion a put implies.
 *
 * "A deletion is exact fact identity over every column: DELETE FROM r USING (input) AS q WHERE (r.cols) = (q.cols)
 * RETURNING r.key, where the input is the arrays, the carrier, or the described member. A duplicate input row
 * matches its fact once. `deleted` is the count of returned keys". Within a stratum additions win: when
 * the stratum also adds to the relation and the deletions or the additions are described or a carrier, the input is
 * D EXCEPT A, so a fact both added and deleted is neither deleted nor counted, and the insert protocol then finds it
 * a repeat or inserts it; the host nets two enumerated members the same way. The statement is the
 * deletion as a data-modifying CTE in one statement chain:
 *
 *   WITH "r1"("c1", "c2", "c3") AS (SELECT "r0"."c1", ... FROM (SELECT pg_catalog.unnest($1::...[]) ...) AS "r0"
 *                                   [EXCEPT SELECT ... FROM <addition>]),
 *   "r2" AS (DELETE FROM "work"."task" AS "r3" USING "r1"
 *            WHERE ("r3"."id", "r3"."account", "r3"."kind") = ("r1"."c1", "r1"."c2", "r1"."c3")
 *            RETURNING "r3"."id" AS "c4")
 *   SELECT "r2"."c4"::text AS "c4" FROM "r2"
 *
 * The deletion a put implies removes the current occupants at the members' keys whose payload differs, and the insert
 * protocol follows as a later statement, because a same-key deletion and addition cannot share one statement's
 * snapshot: DELETE FROM r USING (input) AS q WHERE (r.key) = (q.key) AND (r.payload) <>
 * (q.payload). An occupant equal to its member stays, so an identical put deletes nothing and its insert is an exact
 * repeat. A pure set has no payload, so its put displaces nothing and has no deletion.
 *
 * A deletion whose member is anchored on an occurrence of its relation, with no addition of its stratum to except, is
 * the anchored deletion instead: the DELETE's target plays that occurrence, so the relation is read once.
 *
 * Every returned row is a fact the statement made absent; the outer SELECT returns its complete fact, which
 * delta.removed and the netting across strata need. */
export const buildExactDelete = (
	w: WriteContext,
	spec: ExactDeleteSpec
): ModifyingStatement<DeleteResult> => buildDelete(w, spec, { kind: "exact", except: spec.except })

/** A displacing deletion excepts nothing: the put's own facts are what it displaces occupants for. */
export const buildDisplacingDelete = (
	w: WriteContext,
	spec: DisplacingDeleteSpec
): ModifyingStatement<DeleteResult> =>
	buildDelete(w, spec, { kind: "displacing", payload: spec.payload })

/** The anchored deletion: the DELETE's target plays the member's anchoring occurrence, so the relation is
 * read once. The rest of the region is lowered without that occurrence: its other occurrences are the USING list and
 * its conditions the WHERE, beside an equality between the target's column and the column of each variable the
 * occurrence shares with another occurrence, each of the occurrence's constants over the target's column, and the
 * Filters' predicates over the region's variables, the ones the occurrence alone binds read from the target. The
 * region's head is not read: the deleted facts are the target's own rows.
 *
 *   WITH "r1" AS (DELETE FROM "q"."wanted" AS "r0"
 *                 USING (SELECT "r2"."c1", ... FROM "__carrier_<d>_1" AS "r2") AS "r3"("c4", ...)
 *                 WHERE "r0"."key" = "r3"."c6"
 *                 RETURNING "r0"."key" AS "c1", ...)
 *   SELECT "r1"."c1"::text AS "c1", ... FROM "r1"
 *
 * Each column the occurrence binds equals its variable's value: another occurrence's column for a shared
 * variable; for a variable the occurrence alone binds, the first target column bound to it, which the variable
 * then reads. */
export const buildAnchoredDelete = (
	w: WriteContext,
	spec: AnchoredDeleteSpec
): ModifyingStatement<DeleteResult> => {
	const { relation, anchor } = spec
	return buildStatement(w, ownBuild, (supply: NameSupply) => {
		const r3 = supply.relation(internal(`target ${relation.name}`))
		const r2 = supply.relation(internal("delete"))
		const returned = fieldColumns(keyFirst(relation), () =>
			supply.column(internal("returned column"))
		)
		const { region, occurrence } = anchor
		const stored = (column: string): Expr => col(r3, w.names.column(relation.name, column))
		const others = region.occurrences.filter((o) => o.id !== occurrence.id)
		const elsewhere = new Set(others.flatMap((o) => o.bindings.map((b) => b.var)))
		/** The variables the occurrence alone binds, by name: no other occurrence gives them a value. */
		const alone = new Set(
			occurrence.bindings.flatMap((b) => (elsewhere.has(b.var) ? [] : [b.var.name]))
		)
		/** The region without the occurrence: its heading the variables that keep a value. */
		const rest = {
			...region,
			occurrences: others,
			heading: region.heading.filter((c) => !alone.has(c.name))
		}
		const parts = regionParts(rest, w.cx, emptyEnv)
		/** The region's columns as the Filters and the constants read them: the rest's from its parts, and each variable
		 * the occurrence alone binds from the stored column its first binding names. */
		const columns = new Map<string, Expr>(parts.columns.map((c) => [c.column.name, c.value]))
		const conditions: Array<Expr> = [...parts.conditions]
		for (const b of occurrence.bindings) {
			const value = columns.get(b.var.name)
			if (value === undefined) {
				columns.set(b.var.name, stored(b.column))
			} else {
				conditions.push(w.cx.equal(b.var.type, stored(b.column), value))
			}
		}
		const scope = extendEnv(emptyEnv, [
			[region.id, columns],
			...anchor.filters.map((f) => [f.id, columns] as const)
		])
		for (const c of occurrence.constants) {
			conditions.push(
				w.cx.equal(
					columnType(occurrence.source.heading, c.column),
					stored(c.column),
					lowerExpr(w.cx, c.expr, scope)
				)
			)
		}
		for (const f of anchor.filters) {
			conditions.push(lowerExpr(w.cx, f.pred, scope))
		}
		return deletion(
			w,
			relation,
			"exact",
			{ r2, r3, returned },
			{ leading: [], using: parts.occurrences.map((o) => o.item), where: conditions },
			undefined
		)
	})
}
