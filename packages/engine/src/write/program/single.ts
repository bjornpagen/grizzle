import { appendAll, maxOf } from "#compiler/core/array.ts"
import {
	appendNonEmpty,
	concatNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import type {
	ArraysSource,
	Cte,
	EmittedSql,
	Expr,
	Select,
	SelectCore,
	ValuePlaceholder
} from "#compiler/sql/ast.ts"
import { col, core, cteRef, lit, select, setOp, target, types } from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { type NameMap, NameSupply } from "#compiler/sql/naming.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"
import { flatMapNonEmpty } from "#compiler/write/defined.ts"
import {
	type DeleteResult,
	type InsertResult,
	type ModifyingStatement,
	type NameStart,
	namesPast
} from "#compiler/write/insert/statement.ts"
import type { PutStatement } from "#compiler/write/put/statement.ts"

/** A sub-query several parts of a single statement read, a CTE under `name`. */
export interface SharedPart {
	readonly name: string
	readonly columns: ReadonlyArray<string>
	readonly query: Select
	readonly params: ReadonlyArray<WriteParamSlot>
	/** The generated names its query and its CTE's own name and columns define. */
	readonly nameMap: NameMap
}

/** One action's write statement as a part of a single statement, with the width of its rows. */
export interface WritePart {
	readonly statement:
		| ModifyingStatement<InsertResult>
		| ModifyingStatement<DeleteResult>
		| PutStatement
	readonly width: number
}

export interface SingleStatement {
	readonly ast: Select
	readonly sql: EmittedSql
	readonly params: ReadonlyArray<WriteParamSlot>
	/** The widest part's columns, which every row carries after its tag. */
	readonly width: number
}

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** Fresh names at `start`: `count` columns and, first, one relation; and the start past them. */
export const freshNames = (
	start: NameStart,
	count: number
): {
	readonly relation: string
	readonly columns: ReadonlyArray<string>
	readonly nameMap: NameMap
	readonly next: NameStart
} => {
	const supply = new NameSupply({ relationStart: start.relation, columnStart: start.column })
	const relation = supply.relation(internal("single statement part"))
	const columns = Array.from({ length: count }, () =>
		supply.column(internal("single statement column"))
	)
	return { relation, columns, nameMap: supply.map(), next: namesPast(supply.map()) }
}

/** `slot` numbered `offset` later. */
const moved = <P extends ValuePlaceholder>(slot: P, offset: number): P =>
	offset === 0 ? slot : { ...slot, number: slot.number + offset }

/** A relation input's arrays with each placeholder numbered `offset` later. */
const movedArrays = (source: ArraysSource, offset: number): ArraysSource =>
	source.kind === "count"
		? { kind: "count", count: moved(source.count, offset) }
		: {
				kind: "columns",
				columns: mapNonEmpty(source.columns, (c) => ({ ...c, array: moved(c.array, offset) }))
			}

/**
 * A part's query and slots with each placeholder $n renumbered $n + offset: a part's placeholders number from $1, and
 * the statement's continue past the earlier parts'.
 */
const shifted = (
	query: Select,
	params: ReadonlyArray<WriteParamSlot>,
	offset: number
): { readonly query: Select; readonly params: ReadonlyArray<WriteParamSlot> } =>
	offset === 0
		? { query, params }
		: {
				query: transformSelect(query, {
					...identityHooks,
					replaceSource: (item) =>
						item.kind === "arrays"
							? { ...item, source: movedArrays(item.source, offset) }
							: undefined,
					expr: (e) => (e.kind === "param" ? { ...e, slot: moved(e.slot, offset) } : e)
				}),
				params: params.map((slot) => moved(slot, offset))
			}

/** The single statement of the shared sub-queries `shares` and the write parts `writes`, whose generated names start at
 * `start`, past every part's: a stratum's write actions as one statement, the single-statement realization.
 * Where one snapshot suffices, the stratum's statements are writes of distinct relations whose members all read the
 * stratum's starting state, so they need not be sequential: each is a part of one statement, its CTEs siblings of the
 * others' under one WITH, every member read at the statement's snapshot, which is that starting state. Each part is
 * built as a statement of its own whose generated names start past every name an earlier part used, so no name is
 * defined twice, and whose placeholders number from $1; the statement renumbers each part's placeholders past the
 * earlier parts' and concatenates their encoders. A sub-query several parts read is one CTE of the statement, read by
 * each part in place of the carrier the sequential realization fills, and PostgreSQL evaluates a CTE that several
 * references read once.
 *
 * Each part's outer SELECT becomes a CTE of its own, and the statement's rows are each part's rows behind its tag, its
 * index among the parts, padded with empty texts to the widest part:
 *
 *   WITH "r40"("c90", ...) AS MATERIALIZED (<shared sub-query>),
 *        <part 0's CTEs>, "r50"("c100", "c101") AS (<part 0's outer SELECT>),
 *        <part 1's CTEs>, "r60"("c110", "c111", "c112") AS (<part 1's outer SELECT>)
 *   SELECT 0, "r50"."c100", "r50"."c101", ''::text FROM "r50"
 *   UNION ALL SELECT 1, "r60"."c110", "r60"."c111", "r60"."c112" FROM "r60"
 *
 * The outcome reads each part's rows as its write step's (`writeRows`). Every data-modifying CTE runs to completion
 * whether or not the outer SELECT reads it, and PostgreSQL checks the immediate foreign keys at the end of the
 * statement, after every part, which the schedule's order between the parts only ever had to keep at its own end. */
export const singleStatement = (
	shares: ReadonlyArray<SharedPart>,
	writes: NonEmptyReadonlyArray<WritePart>,
	start: NameStart
): SingleStatement => {
	const shareCtes: Array<Cte> = []
	const params: Array<WriteParamSlot> = []
	const nameMap: Array<NameMap[number]> = []
	let next = start
	for (const part of shares) {
		const shift = shifted(part.query, part.params, params.length)
		shareCtes.push({
			name: part.name,
			columns: part.columns,
			materialized: "MATERIALIZED",
			query: shift.query
		})
		appendAll(params, shift.params)
		appendAll(nameMap, part.nameMap)
	}
	const outs = mapNonEmpty(writes, (part) => {
		const statement = part.statement
		/** The statement's WITH, renumbered as its body is: transformSelect keeps a WITH it is given. */
		const { query: body, params: partParams } = shifted(
			statement.ast,
			statement.params,
			params.length
		)
		appendAll(params, partParams)
		appendAll(nameMap, statement.sql.nameMap)
		const out = freshNames(next, part.width)
		next = out.next
		appendAll(nameMap, out.nameMap)
		const own: Cte = {
			name: out.relation,
			columns: out.columns,
			materialized: undefined,
			query: { ...body, with: undefined }
		}
		return {
			name: out.relation,
			columns: out.columns,
			ctes: appendNonEmpty(body.with === undefined ? [] : body.with.ctes, own)
		}
	})
	const ctes = concatNonEmpty(
		shareCtes,
		flatMapNonEmpty(outs, (o) => o.ctes)
	)
	const width = maxOf(
		outs.map((o) => o.columns.length),
		0
	)
	const arms = mapNonEmpty(outs, (o, tag): SelectCore => {
		const padding: ReadonlyArray<Expr> = Array.from({ length: width - o.columns.length }, () =>
			lit.text("", types.text)
		)
		return core(
			[
				target(lit.int(tag, types.integer)),
				...o.columns.map((c) => target(col(o.name, c))),
				...padding.map((p) => target(p))
			],
			[cteRef(o.name)],
			undefined
		)
	})
	const ast: Select = { ...select(setOp("UNION ALL", arms)), with: { recursive: false, ctes } }
	return { ast, sql: emitText(ast, nameMap), params, width }
}
