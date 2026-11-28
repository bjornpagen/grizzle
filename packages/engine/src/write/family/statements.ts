/**
 * A family member relation's rows as the family statements write them (write/family/additions.ts, removals.ts): its
 * row layout (`rowLayout`), the families it is a member of, an owner's end fields, and an INSERT's gate of the rows it
 * places (`candidateGate`).
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { type Family, familyOrder } from "#compiler/ir/family.ts"
import {
	type LawField,
	type NativeColumn,
	type RelationInfo,
	type ColumnKey,
	columnKey,
	columnKeyOf
} from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { LaidColumn, LaidLayout } from "#compiler/runtime/write/nesting.ts"
import type { Cte, Expr } from "#compiler/sql/ast.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"
import { fieldColumns } from "#compiler/write/defined.ts"
import type { WriteContext } from "#compiler/write/insert/statement.ts"
import {
	buildProbe,
	type Probed,
	probeGuard,
	type RelationUniques,
	type Requested
} from "#compiler/write/insert/unique.ts"

/**
 * A column of a member relation's row layout: its native column, its key, its type, and whether a redraw's update in
 * place sets it (write/family/removals.ts writesOf): every column but the key and a group field, since a move between
 * groups is a delete and an insert, a copy of an owner's count among them, which the redraw draws again.
 */
export interface RowColumn {
	readonly column: NativeColumn
	readonly key: ColumnKey
	readonly type: ScalarType
	readonly settable: boolean
}

/**
 * A member relation's rows as every family statement writes them (draw.ts Row): its key fields, in key order; then
 * every other column the host writes, its caller's, drawn and accumulated fields in its field order, and then,
 * for each family it is a member of, in their order as members (`memberFamilies`), its drawn law columns: a counted
 * index ‹i›, ‹s›, a tree's ‹ps›, and each fold's hidden accumulators, by fold and plane, the before then the after. A
 * generated field is PostgreSQL's, so none is listed.
 */
export interface RowLayout {
	readonly relation: StoredRelationName
	readonly key: NonEmptyReadonlyArray<RowColumn>
	readonly columns: ReadonlyArray<RowColumn>
}

/** A row layout as a binding holds it (`LaidLayout`), each column projected to what binding reads of it. */
export const laidLayout = (layout: LaidLayout): LaidLayout => {
	const laid = (c: LaidColumn): LaidColumn => ({
		key: c.key,
		type: c.type,
		column:
			c.column.kind === "field"
				? { kind: "field", field: { name: c.column.field.name } }
				: { kind: "law", column: c.column.column }
	})
	return {
		relation: layout.relation,
		key: mapNonEmpty(layout.key, laid),
		columns: layout.columns.map(laid)
	}
}

/**
 * The families `relation` is a member of, in their order by what they are (ir/family.ts familyOrder): the sequence that
 * nests its rows first, a relation being a member of at most one, then its counted families by key. The one spelling of
 * a member's families every reader of them goes through, so its layout (`rowLayout`) and every pick among them is the
 * same whatever order the law model states its families in.
 */
export const memberFamilies = (
	relation: string,
	families: ReadonlyArray<Family>
): ReadonlyArray<Family> => families.filter((f) => f.member.name === relation).toSorted(familyOrder)

/**
 * The row layout of `relation` over the law model's `families` (`RowLayout`): its primary key's fields, its other
 * written fields, and each law column its families draw on it, each of the type its family gives it: a counted index
 * and ‹s› the count's, a tree's ‹ps› its start's, a hidden accumulator its plane's end's.
 */
export const rowLayout = (relation: RelationInfo, families: ReadonlyArray<Family>): RowLayout => {
	const mine = memberFamilies(relation.name, families)
	const groups = new Set(mine.flatMap((f) => f.group.map((g) => columnKeyOf(g.member.name))))
	const of = (column: NativeColumn, type: ScalarType): RowColumn => {
		const key = columnKey(column)
		return { column, key, type, settable: !groups.has(key) }
	}
	const keyNames = new Set(relation.primaryFields.map((f) => f.name))
	const fields = relation.fields.flatMap((f) =>
		f.writing.kind === "generated" || keyNames.has(f.name)
			? []
			: [of({ kind: "field", field: f }, f.type)]
	)
	const law = mine.flatMap((f): ReadonlyArray<RowColumn> => [
		...(f.shape.kind === "counted" ? [of(f.shape.index, f.count.type)] : []),
		of({ kind: "law", column: f.next }, f.count.type),
		...f.folds.flatMap((fold) =>
			fold.planes.flatMap((plane) =>
				[plane.before, plane.after].flatMap((c) =>
					c.kind === "law" ? [of(c, plane.end.type)] : []
				)
			)
		)
	])
	const keyColumns = mapNonEmpty(relation.primaryFields, (f) => ({
		column: { kind: "field", field: f } as const,
		key: columnKey({ kind: "field", field: f }),
		type: f.type,
		settable: false
	}))
	return Object.freeze({ relation: relation.name, key: keyColumns, columns: [...fields, ...law] })
}

/**
 * The owner's end fields a family's recount sets beside its count: every accumulated field of the owner its family's
 * last axis carries, a fold's ends among them, in the order the axis carries them.
 */
export const endColumns = (family: Family): ReadonlyArray<LawField> => {
	const out: Array<LawField> = []
	for (const pair of family.axes.last) {
		const from = pair.from
		if (
			from.kind === "field" &&
			from.field.writing.kind === "accumulated" &&
			!out.some((f) => f.name === from.field.name)
		) {
			out.push(from.field)
		}
	}
	return out
}

/** A member relation's rows as a CTE of each column of its row layout, key first, in layout order (`RowLayout`). */
export interface LaidRows {
	readonly name: string
	readonly columns: NonEmptyReadonlyArray<string>
}

/**
 * What a member relation's INSERT arbitrates (write/family/additions.ts memberArbiter): every unique and exclusion object,
 * ON CONFLICT DO NOTHING with no target, at which it meets an exact repeat, its key's conflict and a slot key's member of
 * a stored group, each classified in its statement (`every`); or none, a plain INSERT of rows no stored row repeats,
 * each stored repeat and conflict read by a probe (`none`).
 *
 * `every` is SERIALIZABLE's: there a row the INSERT meets that its snapshot cannot see raises 40001, so every met row
 * is a stored row the statement reads (sql/ast.ts FromSource `met`) and its class is read from it. READ COMMITTED's is
 * `none`, by construction rather than by cost: its probes find every stored repeat and conflict and its groups are drawn
 * past their stored members (scan.ts GroupState `stored`), so the only row its INSERT can meet is a racer's, committed
 * after the statement's snapshot, which the snapshot cannot see. Under DO NOTHING PostgreSQL would wait for that racer
 * and skip the row, and neither the met-row read nor a family's probe would find its occupant, so the classification
 * would name a primary key's race a slot's law, or a defect; the plain INSERT's 23505 names the object and the key the
 * racer took, which its classifier reads (adapter/witness/classify.ts), exactly.
 */
export type Arbiter = "every" | "none"

/** A member relation's INSERT as its gate reads it: its relation, its row layout, its unique objects, and the key it
 * arbitrates (`Arbiter`). */
interface GatedInsert {
	readonly relation: RelationInfo
	readonly layout: RowLayout
	readonly uniques: RelationUniques
	readonly arbiter: Arbiter
}

/**
 * The gate of a member relation's INSERT of `candidates`: the probe (write/insert/unique.ts buildProbe) of the
 * candidates under the statement's snapshot at every unique object the INSERT does not arbitrate, every other one where
 * it arbitrates its primary key, for a candidate whose key no stored row holds (Requested `complete`), and every one,
 * the primary key first, where it arbitrates none (Requested `none`); and the refusal guard that raises the probe's
 * refusal (probeGuard), none where it probes nothing, built anew for each INSERT it gates (Guarded). As every insert of the insert protocol probes each unique object
 * besides its arbiter, a stated row that meets one, a stored occupant or another candidate, is refused by the object's
 * law, its witness the row's values at the object's fields (witnessFields), never by PostgreSQL's 23505, which names no
 * row. The candidates are drawn on the host and in the statement (a tree's starts, a sequence's indexes), which no host
 * check of a pair within an input reads, so a pair is the statement's at every object. A 23505 or 23P01 the INSERT still
 * raises at a probed object is an occupant its snapshot did not see; one at an object over a drawn law column, which no
 * field names and the scans draw apart, is no stated row's.
 */
export const candidateGate = (
	w: WriteContext,
	supply: NameSupply,
	insert: GatedInsert,
	candidates: LaidRows
): { readonly ctes: ReadonlyArray<Cte>; readonly guards: () => ReadonlyArray<Expr> } => {
	const { relation, layout, uniques } = insert
	const columns = [...layout.key, ...layout.columns]
	const fields = relation.fields.filter((f) => f.writing.kind !== "generated")
	const inputs = fieldColumns(fields, (f) =>
		defined(
			candidates.columns[
				columns.findIndex((c) => c.column.kind === "field" && c.column.field.name === f.name)
			],
			`the candidate column of ${relation.name}.${f.name}`
		)
	)
	const probed = ((): { readonly requested: Requested; readonly checks: ReadonlyArray<Probed> } => {
		switch (insert.arbiter) {
			case "every":
				return { requested: { kind: "complete", arbiter: uniques.arbiter }, checks: uniques.checks }
			case "none":
				return {
					requested: { kind: "none", fields },
					checks: [
						{ object: uniques.arbiter, pairs: "statement", witness: "every" },
						...uniques.checks
					]
				}
		}
	})()
	const probe = buildProbe(w, supply, {
		relation,
		...probed,
		input: candidates.name,
		inputs,
		normalized: false,
		rows: "rows",
		occupants: "probed"
	})
	if (probe === undefined) {
		return { ctes: [], guards: () => [] }
	}
	const guarded = probeGuard(w, supply, relation.name, probe)
	return { ctes: [...probe.ctes, guarded.cte], guards: () => [guarded.guard()] }
}
