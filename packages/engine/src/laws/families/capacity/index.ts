import { exactParts } from "#compiler/core/decimal.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { CapacityBound, FieldSelector, LawField } from "#compiler/ir/law.ts"
import { baseTypeRef } from "#compiler/ir/physical.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import { type CapacityCheck, capacityCheck } from "#compiler/laws/families/capacity/bounds.ts"
import type { FamilyPlugin, FamilyUnit, FamilyVariable } from "#compiler/laws/families/plugin.ts"
import {
	anchorRow,
	literalExpr,
	raiseViolation,
	readAnchor,
	recordField,
	selectedBy
} from "#compiler/laws/residual/sql.ts"
import { anyNumeric, plainType } from "#compiler/scalar/compute/types.ts"
import type { Expr, PlStatement, Select, SelectCore } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	call,
	cast,
	col,
	core,
	countStar,
	derived,
	eq,
	gt,
	lit,
	lt,
	notExists,
	objectName,
	or,
	select,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"

/** The record the anchor read binds, and the record the group aggregate binds. */
const targetVariable: FamilyVariable = "t"
const groupVariable: FamilyVariable = "g"

/** The scalar-group capacity family. `capacity(on(T, tk...), { from: on(S, sk...), weight, within })`: for each target fact, the number or the total
 * weight of the source facts whose projection sk is the target's projection tk lies within its bounds; a literal
 * selector on either side restricts the participating facts. Its anchor is the target row at the group key, and an
 * absent target bounds nothing: a target's insertion checks the sources already in its group. For one affected key, the
 * anchor key being tk's values in tk's order:
 *
 *   FOR t IN SELECT r1.<tk1> AS c1, ..., r1.<ref bound> AS cj, ..., r1.<target selector> AS ck, ...
 *     FROM <T> AS r1 WHERE r1.<tk1> = <key1> AND ... LOOP
 *     IF <the target selector over t> THEN
 *       FOR g IN SELECT r2.c1 AS c1 FROM (
 *           SELECT <count(*) | sum(r1.<w>)> AS c1 FROM <S> AS r1
 *           WHERE r1.<sk1> = t.c1 AND ... AND <the source selector over r1> GROUP BY r1.<sk1>, ...
 *         ) AS r2(c1)
 *         UNION ALL
 *         SELECT <zero of the aggregate's type> AS c1
 *         WHERE NOT EXISTS (SELECT 1 FROM <S> AS r3 WHERE r3.<sk1> = t.c1 AND ... AND <the source selector over r3>)
 *       LOOP
 *         IF g.c1 < <low> OR g.c1 > <high> THEN
 *           RAISE EXCEPTION 'law <id> violated' USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = '<id>',
 *             DETAIL = <DetailCodec of the target's key from t>;
 *         END IF;
 *       END LOOP;
 *     END IF;
 *   END LOOP;
 *
 * Step 2 reads the target row (`readAnchor`), a present anchor's obligation: its key, its `ref` bound
 * fields and its selector fields. The loop body runs once for a target that exists; one that does not, because it was
 * never there, was deleted, or moved away from the key, is no obligation, and nothing is checked. The body rechecks
 * the target's selector on the row read, because the row image that named the key is not final truth: a `mutable`
 * target may have left the selection since. Step 3 is the group aggregate. The grouped branch yields exactly one row
 * for a nonempty group and none for an empty one, the zero branch exactly one row for an empty group: the arms are
 * disjoint, the concatenation is one row, and no NULL is manufactured, so an empty group counts zero and weighs zero.
 * The comparison reads the bounds from literals or from the target row, cast to the aggregate's type (`capacityCheck`). The
 * target's projection contains a declared key of T, so the read is a probe of that key's index and names at most one
 * row; a projection containing no key is UnsupportedLawFamily at recognition. The witness is the target's
 * key: its projection when that is a key of T, otherwise, for a strict superkey, its primary key,
 * read from the target row.
 *
 * The existence variant replaces step 4 by one existence probe through the same index, and its refusal:
 *
 *     PERFORM 1 FROM <S> AS r1 WHERE r1.<sk1> = t.c1 AND ... AND <the source selector over r1> LIMIT 1;
 *     IF NOT FOUND THEN RAISE ... END IF;
 *
 * The event table: a source insertion and deletion check the target at the source's projection, dropped when the
 * bounds make them harmless for a count or a duration weight; a target insertion checks its own new row, because a
 * lower bound above zero is violated by an empty group and a `ref` bound meets the sources already present. A
 * `mutable` participant's UPDATE is its deletion of OLD and its insertion of NEW: a source's UPDATE OF its projection,
 * weight or selector checks the old target when a deletion threatens and the new one when an insertion does, a
 * target's UPDATE OF its key, `ref` bound fields or selector its new key, since its old key keeps no target. An image
 * outside the selection of the side it plays fires nothing, so an unselected source or target checks nothing. The one
 * term reads both relations, so every participant's units run the whole check. The probes are served by the law's index on S (sk...): over a selected source,
 * partial with its selection, which both probes' WHERE implies, unless an index of every
 * row of S already serves it, such as the reverse index a containment of every source into the target creates. Two
 * writers of one group read what the other writes, so SSI commits them in one order or fails one with 40001: a hot
 * target's cost, which stating its bound as seat facts avoids. */
export const capacityFamily: FamilyPlugin<"scalarCapacity"> = ({ law, schema, names, shown }) => {
	const lawId: LawId = law.lawId
	const { anchor, source, detail } = law
	const what = capacityCheck(law)
	const sourceTable = objectName(schema, source.relation.ident)
	const weighed = (field: LawField): Expr => col("r1", field.column)
	/** A side's selectors over one row, or undefined for an unselected side. */
	const selectors = (selection: ReadonlyArray<FieldSelector>, column: (field: LawField) => Expr) =>
		isNonEmpty(selection) ? selectedBy(lawId, names, selection, column) : undefined
	const refs = law.bounds.flatMap((b) => (b.value.kind === "ref" ? [b.value.field] : []))
	/** The fields the anchor read returns, each once, in this order: the target's projection, the rest of its DETAIL key,
	 * its `ref` bounds, its selector fields; `targetField` is a field of the target row read. */
	const row = anchorRow(
		targetVariable,
		[...anchor.key, ...detail.keys, ...refs, ...law.selection.map((s) => s.field)],
		(targetField): ReadonlyArray<PlStatement> => {
			/** The source facts of the target's group, read under `alias`: each source field equal to the target row's
			 * value of the anchor key field it meets. */
			const group = (alias: string): Expr => {
				const selected = selectors(source.selection, (f) => col(alias, f.column))
				return and([
					...mapNonEmpty(source.pairs, (p) =>
						eq(col(alias, p.field.column), targetField(p.anchor))
					),
					...(selected === undefined ? [] : [selected])
				])
			}
			const raise = raiseViolation(lawId, detail, targetField, shown(detail.relation.name))
			/** The group aggregate with its zero branch, then the comparison with the bounds (see `capacityFamily`). */
			const aggregateCheck = (
				aggregated: Extract<CapacityCheck, { readonly kind: "aggregate" }>
			): ReadonlyArray<PlStatement> => {
				const weight = aggregated.weight
				const aggregate: Expr =
					weight.kind === "count"
						? countStar()
						: weight.kind === "field"
							? call("sum", [weighed(weight.field)])
							: call("sum", [
									binary(
										"-",
										cast(call("upper", [weighed(weight.field)]), types.numeric),
										cast(call("lower", [weighed(weight.field)]), types.numeric)
									)
								])
				const grouped: Select = select({
					...core(
						[targetAs(aggregate, "c1")],
						[{ kind: "table", table: sourceTable, alias: "r1" }],
						group("r1")
					),
					groupBy: source.pairs.map((p) => col("r1", p.field.column))
				})
				const nonempty: SelectCore = core(
					[targetAs(col("r2", "c1"), "c1")],
					[derived(grouped, "r2", ["c1"], false)],
					undefined
				)
				const empty: SelectCore = core(
					[targetAs(zeroOf(aggregated), "c1")],
					[],
					notExists(
						select(
							core(
								[target(lit.int(1, types.integer))],
								[{ kind: "table", table: sourceTable, alias: "r3" }],
								group("r3")
							)
						)
					)
				)
				const total = recordField(groupVariable, "c1")
				/** One side of the comparison: the aggregate against a literal of its type, or against a cast `ref` bound. */
				const outside = (bound: CapacityBound, op: "<" | ">"): Expr => {
					if (bound.kind === "literal") {
						const value = literalExpr(bound.literal, aggregated.type, names, lawId)
						return op === "<" ? lt(total, value) : gt(total, value)
					}
					const at =
						bound.carrier === baseOf(aggregated.type).carrier
							? aggregated.type
							: bound.carrier === "numeric"
								? anyNumeric
								: plainType(bound.carrier)
					const atRef = baseTypeRef(names, at)
					const left = at === aggregated.type ? total : cast(total, atRef)
					const right = cast(targetField(bound.field), atRef)
					return op === "<" ? lt(left, right) : gt(left, right)
				}
				const sides = mapNonEmpty(aggregated.bounds, (b) =>
					outside(b.value, b.side === "low" ? "<" : ">")
				)
				return [
					{
						kind: "forQuery",
						variable: groupVariable,
						query: select({ kind: "setOp", op: "UNION ALL", arms: [nonempty, empty] }),
						body: [{ kind: "if", branches: [{ condition: or(sides), body: [raise] }], else: [] }]
					}
				]
			}
			const probe: ReadonlyArray<PlStatement> =
				what.kind === "existence"
					? [
							{
								kind: "whenAbsent",
								probe: {
									body: core(
										[target(lit.int(1, types.integer))],
										[{ kind: "table", table: sourceTable, alias: "r1" }],
										group("r1")
									),
									orderBy: [],
									limit: lit.int(1, types.integer),
									offset: undefined
								},
								body: [raise]
							}
						]
					: aggregateCheck(what)
			const selected = selectors(law.selection, targetField)
			return selected === undefined
				? probe
				: [{ kind: "if", branches: [{ condition: selected, body: probe }], else: [] }]
		}
	)
	const unit: FamilyUnit = {
		declare: [
			{ name: targetVariable, type: types.record },
			...(what.kind === "aggregate" ? [{ name: groupVariable, type: types.record }] : [])
		],
		check: (key) =>
			readAnchor({ schema, relation: anchor.relation, key, obligation: { when: "present", row } })
	}
	return () => unit
}

/** The zero an empty group counts or weighs, typed as the aggregate. */
const zeroOf = (what: Extract<CapacityCheck, { readonly kind: "aggregate" }>): Expr => {
	switch (what.carrier) {
		case "int8":
			return lit.int(0n, types.bigint)
		case "numeric":
			return lit.decimal(exactParts(0n, 0), types.numeric)
	}
}
