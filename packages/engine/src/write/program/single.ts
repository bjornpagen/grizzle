import { appendAll, maxOf } from "#compiler/core/array.ts"
import {
	appendNonEmpty,
	concatNonEmpty,
	extendNonEmpty,
	flatMapNonEmpty,
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
	SetCore,
	ValuePlaceholder
} from "#compiler/sql/ast.ts"
import {
	col,
	cteRef,
	lit,
	provedCore,
	select,
	target,
	types,
	unionAll
} from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { type NameMap, NameSupply, type NameSupplyStart, namesPast } from "#compiler/sql/naming.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"
import {
	type DeleteResult,
	type InsertResult,
	type ModifyingStatement,
	ownStatement
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

/**
 * A sent statement of a read-back riding a single statement, a part of it: its executable query, whose WITH, recursive
 * or not, stays its own inside the part, its placeholders, every one a declared parameter's, the generated names it
 * defines, all past every name the statement's writes and deltas define, and the width of its rows, a numbered part's
 * row number among them (write/program/artifact.ts RidingPart).
 */
export interface ReadBackPart {
	readonly query: Select
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly nameMap: NameMap
	readonly width: number
}

/** What rides a single statement: the CTEs holding the deltas its riding read-backs read, over its writes' RETURNING
 * (write/readback/deltas.ts deltaCte), with the names they define, and each riding read-back's sent statements, in
 * order. */
export interface Riding {
	readonly deltas: ReadonlyArray<Cte>
	readonly nameMap: NameMap
	readonly parts: ReadonlyArray<ReadBackPart>
}

/** A single statement no read-back rides. */
export const noRiding: Riding = Object.freeze({ deltas: [], nameMap: [], parts: [] })

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
	start: NameSupplyStart,
	count: number
): {
	readonly relation: string
	readonly columns: ReadonlyArray<string>
	readonly nameMap: NameMap
	readonly next: NameSupplyStart
} => {
	const supply = new NameSupply(start)
	const relation = supply.relation(internal("single statement part"))
	const columns = Array.from({ length: count }, () =>
		supply.column(internal("single statement column"))
	)
	return { relation, columns, nameMap: supply.map(), next: namesPast(supply.map(), ownStatement) }
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
				columns: mapNonEmpty(source.columns, (c) => ({ ...c, array: moved(c.array, offset) })),
				ordinal: source.ordinal
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
 * statement, after every part, which the schedule's order between the parts only ever had to keep at its own end.
 *
 * A read-back rides the statement (`riding`) where the statement writes every delta it reads and nothing at or after
 * it changes what it reads (write/schedule/plan.ts placeReadBacks). Its deltas are CTEs over the writes' RETURNING,
 * after the writes' parts, and each of its sent statements is a part after them, its own query whole as one CTE, its
 * rows behind its tag after the writes' tags, padded as theirs are; the runtime reads them as that read-back's
 * statements' rows. No arm orders its rows: an ordered part's rows carry their row number in the part's order, which
 * the runtime reads them back in (write/program/artifact.ts RidingPart). */
export const singleStatement = (
	shares: ReadonlyArray<SharedPart>,
	writes: NonEmptyReadonlyArray<WritePart>,
	riding: Riding,
	start: NameSupplyStart
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
	appendAll(nameMap, riding.nameMap)
	const ridden = riding.parts.map((part) => {
		const shift = shifted(part.query, part.params, params.length)
		appendAll(params, shift.params)
		appendAll(nameMap, part.nameMap)
		return { query: shift.query, width: part.width }
	})
	next = namesPast(nameMap, next)
	const rides = ridden.map((part) => {
		const out = freshNames(next, part.width)
		next = out.next
		appendAll(nameMap, out.nameMap)
		const own: Cte = {
			name: out.relation,
			columns: out.columns,
			materialized: undefined,
			query: part.query
		}
		const ctes: NonEmptyReadonlyArray<Cte> = [own]
		return { name: out.relation, columns: out.columns, ctes }
	})
	const ctes = concatNonEmpty(
		shareCtes,
		extendNonEmpty(
			flatMapNonEmpty(outs, (o) => o.ctes),
			[...riding.deltas, ...rides.flatMap((r) => r.ctes)]
		)
	)
	const parts = extendNonEmpty(outs, rides)
	const width = maxOf(
		parts.map((o) => o.columns.length),
		0
	)
	const arms = mapNonEmpty(parts, (o, tag): SetCore => {
		const padding: ReadonlyArray<Expr> = Array.from({ length: width - o.columns.length }, () =>
			lit.text("", types.text)
		)
		return provedCore(
			"keyed",
			[
				target(lit.int(tag, types.integer)),
				...o.columns.map((c) => target(col(o.name, c))),
				...padding.map((p) => target(p))
			],
			[cteRef(o.name)],
			undefined
		)
	})
	const ast: Select = { ...select(unionAll("disjoint", arms)), with: { recursive: false, ctes } }
	return { ast, sql: emitText(ast, nameMap), params, width }
}
