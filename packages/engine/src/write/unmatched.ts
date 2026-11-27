import { defect } from "@bjornpagen/grizzle-text/base/invariant"
/**
 * A deferred foreign key's witness query: the key of one row its table holds that the foreign key leaves unmatched,
 * which the shell reads after a COMMIT PostgreSQL refused by it (packages/grizzle/src/adapter/apply/run.ts
 * unmatchedWitness), since PostgreSQL states the row only in the refusal's DETAIL, which grizzle never parses.
 *
 * PostgreSQL reports a deferred foreign key's violation at COMMIT by its structured fields, the constraint's name, its
 * table and schema, which the classifier maps to the law the key discharges (adapter witness/keylaw.ts). The write that
 * met it changed nothing; the shell sends its statements again in a transaction that ends ROLLBACK, then this query, so
 * it reads the state the write left, and the row it names is the witness, in the one form a law's refusal names a fact
 * (write/refusal.ts lawKeyDetail): its relation and its primary key, each value its column's result text. A key the
 * database draws as the row is written, a clock's instant, is the one the statements sent again drew. A query that
 * finds no row, a state another transaction's commit changed in between, names none, and the witness is
 * `unreproduced`, never a key guessed.
 *
 *   SELECT <k[...] DETAIL of c's primary key> FROM <table> AS c
 *   WHERE num_nonnulls(c.<column>, ...) = <n>
 *     AND NOT EXISTS (SELECT 1 FROM <target> AS p WHERE p.<target column> = c.<column> AND ...)
 *   ORDER BY c.<primary key field>, ... LIMIT 1
 *
 * MATCH SIMPLE, as every foreign key grizzle installs is: a row any of whose columns is null references nothing, so only a
 * row whose every column is non-null can be unmatched. A PERIOD foreign key's row is unmatched where the target rows at
 * its scalars do not cover its span, `NOT coalesce((SELECT range_agg(p.<span>) ... WHERE ... AND p.<span> && c.<span>)
 * @> c.<span>, false)`, as PostgreSQL's PERIOD reference judges it. The least row by its primary key is named, so the
 * witness does not depend on the plan.
 *
 * The query runs as the writing role, on its table and its target alone, each of which the role reads whole
 * (program/schema.ts readsWhole): the key it names is one the role can select itself, and no target row is out of its
 * sight, so the row it names is unmatched.
 */
import { appendNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ConstraintName, RelationIdent, StoredRelationName } from "#compiler/core/ids.ts"
import type { LawField, NativeColumn, TableRelation } from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { EmittedText, Expr, Select } from "#compiler/sql/ast.ts"
import {
	and,
	asc,
	binary,
	call,
	col,
	firstNonNull,
	lit,
	not,
	notExists,
	provedCore,
	select,
	simpleSelect,
	table,
	target,
	types
} from "#compiler/sql/build.ts"
import { costChosen, emitText } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { lawKeyDetail } from "#compiler/write/refusal.ts"

/**
 * A deferred foreign key's witness query as a served file holds it: the constraint PostgreSQL reports by its name on its
 * table, the relation whose rows it reads, which decodes the key it names, and the query's text.
 */
export interface UnmatchedQuery {
	readonly constraint: ConstraintName
	readonly owner: RelationIdent
	readonly relation: StoredRelationName
	readonly sql: EmittedText
}

/** A deferred foreign key, plain or PERIOD, as the law model plans it: its table, its target and their columns. */
export type UnmatchedKey =
	| {
			readonly kind: "ForeignKey"
			readonly relation: TableRelation
			readonly columns: readonly [NativeColumn, ...Array<NativeColumn>]
			readonly target: TableRelation
			readonly targetColumns: readonly [NativeColumn, ...Array<NativeColumn>]
	  }
	| {
			readonly kind: "PeriodForeignKey"
			readonly relation: TableRelation
			readonly columns: ReadonlyArray<NativeColumn>
			readonly span: NativeColumn
			readonly target: TableRelation
			readonly targetColumns: ReadonlyArray<NativeColumn>
			readonly targetSpan: NativeColumn
	  }

/** The alias of the unmatched row and of the target rows it is matched against. */
const row = "c"
const matched = "p"

/** A native column's installed name in `relation`'s table: a field's, or a law column's own. */
const columnOf = (names: PhysicalNames, relation: string, c: NativeColumn): string =>
	c.kind === "field" ? names.column(relation, c.field.name) : c.column

/** The primary key's fields of `relation`, in key order, which every relation grizzle stores holds. */
const primaryFields = (relation: TableRelation): readonly [LawField, ...Array<LawField>] => {
	const [primary] = relation.keyNames
	if (primary === undefined) {
		defect(`the primary key of ${relation.name}`)
	}
	return primary.fields
}

/** The witness query of the deferred foreign key `key`, named `constraint` on its table (see the module's header). */
export const unmatchedQueryOf = (
	names: PhysicalNames,
	constraint: ConstraintName,
	key: UnmatchedKey
): UnmatchedQuery => {
	const from = key.relation.name
	const into = key.target.name
	const own = (c: NativeColumn): Expr => col(row, columnOf(names, from, c))
	const theirs = (c: NativeColumn): Expr => col(matched, columnOf(names, into, c))
	const pairs = key.columns.map((c, i) => {
		const t = key.targetColumns[i]
		if (t === undefined) {
			defect(`the target column ${i} of ${constraint}`)
		}
		return binary("=", theirs(t), own(c))
	})
	const referencing: readonly [Expr, ...Array<Expr>] =
		key.kind === "ForeignKey"
			? mapNonEmpty(key.columns, own)
			: appendNonEmpty(key.columns.map(own), own(key.span))
	const targetTable = names.relation(into)
	const unmatched: Expr =
		key.kind === "ForeignKey"
			? notExists(
					simpleSelect(
						[target(lit.int(1, types.integer))],
						[table(targetTable.schema, targetTable.name, matched)],
						and(appendNonEmpty(pairs.slice(1), pairs[0] ?? lit.bool(true)))
					)
				)
			: not(
					firstNonNull([
						binary(
							"@>",
							{
								kind: "subquery",
								query: simpleSelect(
									[target(call("range_agg", [theirs(key.targetSpan)]))],
									[table(targetTable.schema, targetTable.name, matched)],
									and(appendNonEmpty(pairs, binary("&&", theirs(key.targetSpan), own(key.span))))
								)
							},
							own(key.span)
						),
						lit.bool(false)
					])
				)
	const primary = mapNonEmpty(primaryFields(key.relation), (f) => ({
		field: f.name,
		expr: col(row, names.column(from, f.name)),
		type: f.type
	}))
	const detail = lawKeyDetail(from, primary)
	const source = names.relation(from)
	const query: Select = {
		...select(
			provedCore(
				"keyed",
				[target(detail)],
				[table(source.schema, source.name, row)],
				and([
					binary(
						"=",
						call("num_nonnulls", [...referencing]),
						lit.int(referencing.length, types.integer)
					),
					unmatched
				])
			)
		),
		orderBy: primary.map((f) => asc(f.expr)),
		limit: lit.int(1, types.bigint)
	}
	return {
		constraint,
		owner: key.relation.ident,
		relation: key.relation.name,
		sql: emitText(query, emptyNameMap, costChosen()).text
	}
}
