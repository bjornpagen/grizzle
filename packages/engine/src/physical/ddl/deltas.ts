/**
 * The rule judge's session deltas (physical/ddl/rules.ts addRules): for each side of each table a rule over a query
 * reads, the table of pg_temp a capture writes the rows a statement wrote into, how a judge's part nets, stands up and
 * empties it, and how a judged statement reads it. physical/ddl/rules.ts holds the captures' triggers, the sentinel
 * that arms the judge, the parts and the judge.
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { ProbeSide } from "#compiler/analysis/theory/query.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { type Identity, identity } from "#compiler/core/identity.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { temporarySchema } from "#compiler/core/temporary.ts"
import { weightOf } from "#compiler/core/zset.ts"
import type { LawField, TheoryTable } from "#compiler/ir/law.ts"
import { sessionTypeRef } from "#compiler/ir/physical.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import { heapTupleMaxBytes } from "#compiler/laws/model/model.ts"
import { inlineColumn, type RowColumn, rowBytes } from "#compiler/laws/model/rows.ts"
import { withLeading } from "#compiler/lower/conservative/context.ts"
import type { DeltaRelation } from "#compiler/lower/conservative/types.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { byLanguage } from "#compiler/physical/ddl/row-functions.ts"
import type { Node } from "#compiler/physical/obligations/graph.ts"
import {
	btreeEntryBytes,
	btreeMaxItemSize,
	datumBound,
	typlens
} from "#compiler/schema/representability.ts"
import type {
	ColumnDefinition,
	Cte,
	Expr,
	FromSource,
	Insert,
	ObjectName,
	OperandSelect,
	PlFunction,
	PlStatement,
	Revoke,
	SessionTableStorage,
	TransitionTable,
	TypeRef
} from "#compiler/sql/ast.ts"
import { transitionTables } from "#compiler/sql/ast.ts"
import {
	and,
	call,
	col,
	cUtf8Collation,
	derived,
	desc,
	eq,
	exists,
	gt,
	le,
	lit,
	namedType,
	notExists,
	objectName,
	or,
	provedSelect,
	qualifiedCall,
	simpleSelect,
	targetAs,
	types,
	windowOf
} from "#compiler/sql/build.ts"
import { printExpr, sessionReaderRows, sessionTableEmptied } from "#compiler/sql/print.ts"
import { identityHooks, inertVisitor, Transform, visitSelect } from "#compiler/sql/transform.ts"
import { installationTypes } from "#compiler/sql/type-schemas.ts"

/**
 * The stem of the name of a session's delta of each side (identity.ruleDelta), which its table of pg_temp is named by:
 * the side of what a transaction adds is `news` and of what it removes `olds`, as every installed judge and capture
 * names them.
 */
const deltaStem = { added: "news", removed: "olds" } as const satisfies Record<ProbeSide, string>

/**
 * A session's delta of one side of a table (`addRules`): the name of its table of pg_temp, its columns, its relation's
 * heading in the canonical order a query reads it in, a Delta node's (check/checker.ts), each of its field's base type,
 * so no session's table depends on a domain a migration alters or drops (PostgreSQL refuses ALTER DOMAIN ... ADD
 * CONSTRAINT over another session's temporary table, and DROP DOMAIN while one names it), and the table's own columns:
 * the heading's, then, on the side of news, the count of each image (`countColumn`).
 */
export interface SessionDelta {
	readonly ident: Identity<"ruleDelta">
	/** The row type of the rows its readers return (`addReaders`). */
	readonly row: Identity<"ruleDeltaRow">
	readonly name: string
	readonly columns: NonEmptyReadonlyArray<ColumnDefinition>
	readonly table: NonEmptyReadonlyArray<ColumnDefinition>
	/** How its table stores its values (`deltaStorage`). */
	readonly storage: SessionTableStorage
}

/**
 * How a delta of a relation of `heading` stores its values (sql/ast.ts SessionTableStorage): inline where every field's
 * datum has a bound (laws/model/rows.ts inlineColumn) and its widest row, each column NULL-able as a delta's are, with
 * the side of news's count (`counted`), fits one heap tuple, MaxHeapTupleSize (laws/model/model.ts heapTupleMaxBytes),
 * its header, null bitmap and alignment included (rowBytes); toasted otherwise, a field of no bound, a learner's
 * response among them, or a row of bounded fields wider than a tuple, which only out-of-line values let PostgreSQL
 * store. A delta's row is its relation's heading, each value the stored column's, within the bound its field's
 * descriptor states, so an inline delta takes every row a capture writes.
 */
const deltaStorage = (
	heading: NonEmptyReadonlyArray<LawField>,
	counted: boolean
): SessionTableStorage => {
	const columns: Array<RowColumn> = []
	for (const f of heading) {
		const column = inlineColumn(f.desc, true)
		if (column === undefined) {
			return "toasted"
		}
		columns.push(column)
	}
	const count: ReadonlyArray<RowColumn> = counted
		? [{ bytes: typlens.int2, align: typlens.int2, nullable: true }]
		: []
	return rowBytes([...columns, ...count]) <= heapTupleMaxBytes ? "inline" : "toasted"
}

/**
 * The column a side of news counts each image it holds in (`addRules`): the image's weight in the transaction's change,
 * a Z-set (core/zset.ts weightOf), 1 for an image a statement put and -1 for one it removed. No heading column is so
 * named: a declared field's column never starts with `__`, and a law column's name carries its digest after its stem.
 */
export const countColumn = "__count"

/**
 * One side of a table the judge holds: its delta, and the columns a statement's UPDATE of a row must change for the
 * row to stand in it, the key and every column a rule reads on that side (analysis/theory/query.ts Touches), none
 * where no rule's facts on that side read a column the UPDATE can change. A row's image is its value in those columns.
 */
export interface JudgedSide {
	readonly side: ProbeSide
	readonly delta: SessionDelta
	readonly read: ReadonlyArray<string>
}

/**
 * The delta of `relation`'s side `side` (`SessionDelta`): its columns, its relation's heading's, each of its field's
 * session type (ir/physical.ts sessionTypeRef: never an installation's domain, a set's bits too; a text column collated
 * C.UTF-8 as every stored text column is), its table's, its storage, its name and its readers' row type.
 */
export const sessionDeltaOf = (
	b: InstallBuilder,
	relation: TheoryTable,
	side: ProbeSide
): SessionDelta => {
	const columns = mapNonEmpty(relation.heading, (f): ColumnDefinition => {
		const type = sessionTypeRef(b.names, f.type)
		return {
			name: f.column,
			type,
			collation: type.kind === "builtin" && type.name === "text" ? cUtf8Collation : undefined
		}
	})
	const table =
		side === "added"
			? appendNonEmpty(columns, {
					name: countColumn,
					type: types.smallint,
					collation: undefined
				})
			: columns
	const storage = deltaStorage(relation.heading, side === "added")
	const ident = identity.ruleDelta(
		headNonEmpty(b.names.levels),
		relation.name,
		deltaStem[side],
		canonicalTextOf({ table, storage })
	)
	return {
		ident,
		row: identity.ruleDeltaRow(relation.name, deltaStem[side], ident),
		name: b.name(ident),
		columns,
		table,
		storage
	}
}

/**
 * `delta` of `relation` as a Delta node reads it (lower/conservative/types.ts DeltaRelation): a CTE of the delta's name,
 * which no statement holds, each field of its relation's heading in the column of its place, c<n>: `headed` reads each
 * read of it through the reader of the selection the statement reads it under, its columns those.
 */
export const deltaRelation = (relation: TheoryTable, delta: SessionDelta): DeltaRelation => ({
	kind: "cte",
	cte: delta.name,
	columns: relation.heading.map((f, at) => ({ field: f.name, column: `c${at + 1}` }))
})

/** The table of pg_temp named `name`. */
export const sessionTable = (name: string): ObjectName => objectName(temporarySchema, name)

/** That the session's table named `name`, which stands, holds a row, read under `alias`. */
export const holding = (name: string, alias: string): Expr =>
	exists(simpleSelect([], [{ kind: "table", table: sessionTable(name), alias }], undefined))

/**
 * The refusal of a session table some other role made under the judge's name, the table's name `table`: a login that
 * creates one first could empty it before COMMIT, so the judge never reads a table its definer did not create.
 */
export const foreignOf = (table: Expr): PlStatement => ({
	kind: "raise",
	message: "a session table of the rule judge that the judge's definer does not own",
	using: [
		{ option: "ERRCODE", value: lit.text("insufficient_privilege", types.text) },
		{ option: "SCHEMA", value: lit.text(temporarySchema, types.text) },
		{ option: "TABLE", value: table }
	]
})

/**
 * The delta's table made in the session, where the session holds none (physical/ddl/rules.ts standing, which refuses a
 * table some other role made under its name).
 */
export const deltaTable = (delta: SessionDelta): PlStatement => ({
	kind: "createSessionTable",
	name: delta.name,
	columns: delta.table,
	notNull: false,
	primaryKey: undefined,
	storage: delta.storage
})

/** A row's image on a side (`JudgedSide`): its primary key's columns, then every other column the side reads. */
const imageOf = (relation: TheoryTable, side: JudgedSide): NonEmptyReadonlyArray<string> => {
	const [first, ...rest] = mapNonEmpty(relation.primaryFields, (f): string => f.column)
	return [first, ...rest, ...side.read.filter((c) => c !== first && !rest.includes(c))]
}

/**
 * The rows of one side a statement wrote into its delta: every row of the transition table `rows`, or, for an UPDATE,
 * each row the other transition table holds no row of with the same image (`imageOf`), so an UPDATE of columns no rule
 * reads there captures nothing. Every row stands once in a transition table, and its key with it, so the rows are a
 * set. The side of olds takes the rows a statement found as they are. The side of news counts each image by its
 * weight (core/zset.ts weightOf): 1 for a row the statement put (`news`), -1 for one it removed (`olds`), which the
 * judge nets (`netted`). A removal is counted only once the delta holds a row: before any image the transaction put
 * stands there it cancels none, and an image it removed that the transaction puts again is then judged as any it put,
 * so a write that only removes rows logs none.
 */
export const captured = (
	relation: TheoryTable,
	side: JudgedSide,
	rows: TransitionTable,
	other: TransitionTable | undefined
): PlStatement => {
	const columns = mapNonEmpty(side.delta.columns, (c) => c.name)
	const unchanged =
		other === undefined
			? []
			: [
					notExists(
						simpleSelect(
							[],
							[{ kind: "transition", table: other, alias: "r2" }],
							and(mapNonEmpty(imageOf(relation, side), (c) => eq(col("r2", c), col("r1", c))))
						)
					)
				]
	const counted = side.side === "added"
	const removed = rows === transitionTables.olds
	const where = [...unchanged, ...(counted && removed ? [holding(side.delta.name, "r3")] : [])]
	const insert: Insert = {
		kind: "insert",
		with: undefined,
		table: sessionTable(side.delta.name),
		alias: undefined,
		onConflict: undefined,
		returning: [],
		columns: counted ? [...columns, countColumn] : columns,
		source: {
			kind: "query",
			query: provedSelect(
				"keyed",
				[
					...columns.map((c) => ({ expr: col("r1", c), alias: undefined })),
					...(counted
						? [
								{
									expr: lit.int(weightOf[removed ? "removed" : "added"], types.smallint),
									alias: undefined
								}
							]
						: [])
				],
				[{ kind: "transition", table: rows, alias: "r1" }],
				isNonEmpty(where) ? and(where) : undefined
			)
		}
	}
	return { kind: "modify", statement: insert }
}

/**
 * The side of news a delta nets (`addRules`'s judge): it deletes every row of an image whose counts sum to 0 or less,
 * and every row but one of each other image, which stands at COMMIT and stood nowhere before the transaction, so the
 * delta holds delta.added of its relation's images, each once: the relation's rows as the transaction leaves them minus
 * those it found (check/checker.ts Delta). That is the Z-set's one netting rule (core/zset.ts): an image's sum is its
 * weights, its puts less its removals, whatever order a statement's captures ran in, 1 where the transaction put it and
 * it stands, -1 where it removed one it found, 0 otherwise; and it stands added where its sum is positive (sideOf). An
 * image of sum -1 goes too: a removal is counted only to cancel a put, and one the transaction puts again is judged as
 * any it put. A later statement's captures count on from what the delta holds, so the judge at SET CONSTRAINTS ALL
 * IMMEDIATE nets it again from there.
 */
export const netted = (relation: TheoryTable, side: JudgedSide): PlStatement => {
	const image = mapNonEmpty(imageOf(relation, side), (c) => col("r2", c))
	const counts = simpleSelect(
		[
			targetAs(col("r2", "ctid"), "c1"),
			targetAs(
				{
					...call("sum", [col("r2", countColumn)]),
					over: windowOf(image, [])
				},
				"c2"
			),
			targetAs(
				{ ...call("row_number", []), over: windowOf(image, [desc(col("r2", countColumn))]) },
				"c3"
			)
		],
		[{ kind: "table", table: sessionTable(side.delta.name), alias: "r2" }],
		undefined
	)
	return {
		kind: "modify",
		statement: {
			kind: "delete",
			with: undefined,
			table: sessionTable(side.delta.name),
			alias: "r1",
			using: [],
			where: {
				kind: "inQuery",
				expr: col("r1", "ctid"),
				query: simpleSelect(
					[{ expr: col("r3", "c1"), alias: undefined }],
					[derived(counts, "r3", ["c1", "c2", "c3"], false)],
					or([
						le(col("r3", "c2"), lit.int(0, types.bigint)),
						gt(col("r3", "c3"), lit.int(1, types.bigint))
					])
				),
				not: false
			},
			returning: []
		}
	}
}

/**
 * The rows of `delta` emptied once its part has read them (physical/ddl/rules.ts emptiedWhereWritten): the delta holds
 * the rows of one run of the judge alone, and no COMMIT empties it (physical/ddl/rules.ts addRules). It is emptied as every session
 * table is (sql/print.ts sessionTableEmptied): by DELETE, which keeps its file and sends no invalidation, while it holds
 * the pages it keeps (sql/print.ts sessionTableKeptBytes), and by TRUNCATE once it holds more, so a delta never holds
 * more than those pages past a run and its run's rows, and the relcache invalidation a TRUNCATE sends every backend of
 * the database, each of which walks every plan it holds, is paid once in those pages' worth of a session's rows, where
 * a TRUNCATE at every run paid it at every judged COMMIT. The judge's statements read the delta through its readers (`addReaders`), so their plans outlive a truncation.
 * The judge runs inside no statement that holds the delta open: after SET CONSTRAINTS ALL IMMEDIATE it runs at the end
 * of the capture's arming INSERT, which reads the sentinel and the written set's variable alone (physical/ddl/rules.ts
 * arming).
 */
export const emptied = (delta: SessionDelta): PlStatement => sessionTableEmptied(delta.name)

/** A judged table's side as the judge's statements read it (`DeltaReads`): its relation, the side and its delta. */
export interface ReadDelta {
	readonly relation: TheoryTable
	readonly side: ProbeSide
	readonly delta: SessionDelta
}

/**
 * A read of a session's delta a judged statement makes (`headed`): the side it reads; its selection, the conjuncts of
 * the statement's own over the read's columns and constants alone, each over the delta's table `r1` (`overDelta`), in
 * the order of their texts, none where the statement reads every row; and the reader that returns the rows the
 * selection admits (identity.ruleDeltaReader), named by the delta and the selection's texts.
 */
export interface DeltaRead extends ReadDelta {
	readonly selection: ReadonlyArray<Expr>
	readonly reader: Identity<"ruleDeltaReader">
}

/**
 * The reads of the session deltas an installation's judged statements make (`headed`), each once by its delta and its
 * selection however many statements make it: one reader each (`addReaders`), and the B-trees of each delta its
 * readers seek through (`deltaIndexes`), which its table is stood up with.
 */
export class DeltaReads {
	readonly #b: InstallBuilder
	readonly #deltas: ReadonlyMap<string, ReadDelta>
	readonly #reads = new Map<string, Map<string, DeltaRead>>()

	constructor(b: InstallBuilder, deltas: ReadonlyArray<ReadDelta>) {
		this.#b = b
		this.#deltas = new Map(deltas.map((d) => [d.delta.name, d] as const))
	}

	/** The side whose delta is named `name`, none where no delta is. */
	delta(name: string): ReadDelta | undefined {
		return this.#deltas.get(name)
	}

	/**
	 * The read of `of`'s delta under `selection`, conjuncts over its table `r1`: each conjunct once, in the order of
	 * their texts as an identity reads them, each pattern by its language (row-functions.ts byLanguage), so every
	 * statement that reads the delta under the same conditions reads one reader, and two spellings of one language one.
	 */
	read(of: ReadDelta, selection: ReadonlyArray<Expr>): DeltaRead {
		const named = new Transform({
			...identityHooks,
			expr: (e) => byLanguage((are) => this.#b.languageOf(are), e)
		})
		const conjuncts = [
			...new Map(selection.map((e) => [printExpr(named.expr(e)), e] as const)).entries()
		].toSorted(([x], [y]) => compareStrings(x, y))
		const reader = identity.ruleDeltaReader(
			of.relation.name,
			deltaStem[of.side],
			of.delta.ident,
			conjuncts.map(([text]) => text)
		)
		const held = this.#reads.get(of.delta.name) ?? new Map<string, DeltaRead>()
		this.#reads.set(of.delta.name, held)
		const found = held.get(reader.canonical)
		if (found !== undefined) {
			return found
		}
		const read: DeltaRead = { ...of, selection: conjuncts.map(([, e]) => e), reader }
		held.set(reader.canonical, read)
		return read
	}

	/** The function `read`'s rows are returned by. */
	reader(read: DeltaRead): ObjectName {
		return objectName(this.#b.schema, this.#b.name(read.reader))
	}

	/** Every read of the delta named `name`, in the order of their readers' identities. */
	readsOf(name: string): ReadonlyArray<DeltaRead> {
		return [...(this.#reads.get(name)?.values() ?? [])].toSorted((x, y) =>
			compareStrings(x.reader.canonical, y.reader.canonical)
		)
	}

	/** Every delta some statement reads, each with its reads, in the order of the deltas' names. */
	all(): ReadonlyArray<{
		readonly of: ReadDelta
		readonly reads: NonEmptyReadonlyArray<DeltaRead>
	}> {
		return [...this.#reads.keys()].toSorted(compareStrings).flatMap((name) => {
			const reads = this.readsOf(name)
			return isNonEmpty(reads)
				? [{ of: defined(this.#deltas.get(name), "a read delta, a judged side's"), reads }]
				: []
		})
	}

	/** The B-trees the delta named `name` is stood up with (`deltaIndexes`). */
	indexesOf(name: string): ReadonlyArray<DeltaIndex> {
		const of = this.#deltas.get(name)
		return of === undefined
			? []
			: deltaIndexes(of, this.readsOf(name)).map((column) => ({
					name: this.#b.name(
						identity.ruleDeltaIndex(of.relation.name, deltaStem[of.side], of.delta.ident, column)
					),
					column
				}))
	}
}

/** A B-tree of a delta over one of its columns (`deltaIndexes`), by its name in pg_temp. */
export interface DeltaIndex {
	readonly name: string
	readonly column: string
}

/** Each of `xs`, or none where one is none. */
const everyOf = (
	xs: NonEmptyReadonlyArray<Expr | undefined>
): NonEmptyReadonlyArray<Expr> | undefined => {
	const [first, ...rest] = xs
	const kept: Array<Expr> = []
	for (const x of rest) {
		if (x === undefined) {
			return undefined
		}
		kept.push(x)
	}
	return first === undefined ? undefined : [first, ...kept]
}

/**
 * `e`, a conjunct a core holds over the columns of its FROM items, over the delta's table `r1`, where every column it
 * reads is a column of one read of a delta, which `column` names the table's column of, and it reads at least one: its
 * columns, constants, and the operators, casts and connectives that read nothing else, each over a builtin type (Expr
 * `binary` and `equalsAny` with no schema); none for any other, a subquery, a function call or a column of another
 * source among them, which a reader of no argument cannot read.
 */
const overDelta = (
	e: Expr,
	column: (read: Extract<Expr, { readonly kind: "column" }>) => string | undefined
): Expr | undefined => {
	let reads = 0
	const over = (x: Expr): Expr | undefined => {
		switch (x.kind) {
			case "column": {
				const c = column(x)
				if (c === undefined) {
					return undefined
				}
				reads += 1
				return col("r1", c)
			}
			case "literal":
				return x
			case "cast":
			case "collate":
			case "negate":
			case "not":
			case "isTrue": {
				const inner = over(x.expr)
				return inner === undefined ? undefined : { ...x, expr: inner }
			}
			case "binary": {
				const left = x.schema === undefined ? over(x.left) : undefined
				const right = left === undefined ? undefined : over(x.right)
				return left === undefined || right === undefined ? undefined : { ...x, left, right }
			}
			case "and":
			case "or":
			case "coalesce":
			case "greatest":
			case "least": {
				const args = everyOf(mapNonEmpty(x.args, over))
				return args === undefined ? undefined : { ...x, args }
			}
			case "between": {
				const expr = over(x.expr)
				const low = over(x.low)
				const high = over(x.high)
				return expr === undefined || low === undefined || high === undefined
					? undefined
					: { ...x, expr, low, high }
			}
			case "inList": {
				const [a, b, ...more] = x.list
				const expr = over(x.expr)
				const first = over(a)
				const second = over(b)
				const rest = everyOf([first, ...more.map(over)])
				return expr === undefined ||
					first === undefined ||
					second === undefined ||
					rest === undefined
					? undefined
					: { ...x, expr, list: [first, second, ...rest.slice(1)] }
			}
			case "equalsAny": {
				const expr = x.schema === undefined ? over(x.expr) : undefined
				const array = expr === undefined ? undefined : over(x.array)
				return expr === undefined || array === undefined ? undefined : { ...x, expr, array }
			}
			case "nullif": {
				const expr = over(x.expr)
				const absent = over(x.absent)
				return expr === undefined || absent === undefined ? undefined : { ...x, expr, absent }
			}
			case "excluded":
			case "returning":
			case "param":
			case "clock":
			case "inQuery":
			case "exists":
			case "subquery":
			case "array":
			case "row":
			case "case":
			case "call":
			case "mergeAction":
			case "domainValue":
			case "user":
			case "plVar":
			case "plSpecial":
			case "field":
			case "regclass":
			case "complement":
			case "lowerAscii":
			case "subscript":
				return undefined
		}
	}
	const moved = over(e)
	return moved === undefined || reads === 0 ? undefined : moved
}

/** `e`'s conjuncts: the arguments of each AND it is, at any depth, and itself where it is no AND. */
const conjunctsOf = (e: Expr): ReadonlyArray<Expr> =>
	e.kind === "and" ? e.args.flatMap(conjunctsOf) : [e]

/** The column of the delta's table each column `c<n>` of its CTE holds (`deltaRelation`), none for any other name. */
const deltaColumnAt = (of: ReadDelta, column: string): string | undefined => {
	const digits = column.startsWith("c") ? column.slice(1) : ""
	const n = Number(digits)
	return digits !== "" && Number.isSafeInteger(n) && String(n) === digits
		? of.delta.columns[n - 1]?.name
		: undefined
}

/**
 * A read of a delta a core's FROM holds (`headed`): the side it reads; the delta's column each column the core reads of
 * it holds, by its alias and name; and the source with the delta's CTE renamed `name`. A read is the delta's CTE itself
 * (lower/conservative/delta), or a derived table of one core that projects columns of one read alone, under no
 * condition, grouping, order or limit, its DISTINCT kept (a filter's input over a delta, and each pass-through
 * projection pruning leaves around it), whose i-th target names the column the derived table's i-th name holds.
 */
interface HeldRead {
	readonly of: ReadDelta
	readonly column: (read: Extract<Expr, { readonly kind: "column" }>) => string | undefined
	readonly renamed: (name: string) => FromSource
}

/** `source` as a read of a delta `reads` holds (`HeldRead`), none where it reads none. */
const heldRead = (source: FromSource, reads: DeltaReads): HeldRead | undefined => {
	if (source.kind === "cte") {
		const of = reads.delta(source.name)
		const alias = source.alias ?? source.name
		return of === undefined
			? undefined
			: {
					of,
					column: (read) => (read.table === alias ? deltaColumnAt(of, read.column) : undefined),
					renamed: (name) => ({ ...source, name, alias })
				}
	}
	if (source.kind !== "derived") {
		return undefined
	}
	const query = source.query
	const core = query.body
	if (
		query.with !== undefined ||
		query.orderBy.length > 0 ||
		query.limit !== undefined ||
		query.offset !== undefined ||
		core.kind !== "core" ||
		core.where !== undefined ||
		core.groupBy.length > 0 ||
		core.having !== undefined ||
		(core.distinct !== false && core.distinct !== true)
	) {
		return undefined
	}
	const [inner, ...others] = core.from
	if (inner === undefined || inner.kind === "joins" || others.length > 0) {
		return undefined
	}
	const below = heldRead(inner, reads)
	if (below === undefined) {
		return undefined
	}
	const projected = core.targets.map((t) =>
		t.expr.kind === "column" ? below.column(t.expr) : undefined
	)
	if (projected.some((c) => c === undefined)) {
		return undefined
	}
	return {
		of: below.of,
		column: (read) =>
			read.table === source.alias ? projected[source.columns.indexOf(read.column)] : undefined,
		renamed: (name) => ({
			...source,
			query: { ...query, body: { ...core, from: [below.renamed(name)] } }
		})
	}
}

/**
 * `statement` with every read of a session's delta read through the reader of its selection (`DeltaReads`): a core's
 * conjuncts over the columns of one read in its FROM and constants alone (`overDelta`), each moved from its WHERE into
 * the read's reader, as PostgreSQL moves such a conjunct into its scan of a table, which no call of a function admits;
 * a read the core holds no such conjunct of reads every row. Only a read where the WHERE meets every row it delivers
 * takes one, so never a LEFT join's source, whose rows the join completes. A judge's read of a delta of 253,458 nodes
 * whose rule constrains the nodes of one kind read every node, through a reader that returned every row, and kept that
 * kind's in the CTE it held them in: 92 statements of the giant pattern package's COMMIT read 23.3 million rows, 23.3 s
 * (edullm's s18 at 39989d602), where each read of its kind reads that kind's rows, by the index its delta is stood up
 * with (`deltaIndexes`).
 *
 * A reader the statement reads once is called where the read stands, which produces its rows once; one it reads twice
 * or more, the arms of a union of one relation's rows under one selection, or a region's occurrences, is read through
 * one MATERIALIZED CTE leading the statement's WITH, named past every relation the statement names, r<n> over its call
 * r<n+1>, which calls it once for the statement and holds its rows for each read: no read's rows are produced twice,
 * where a CTE over every reader held the rows its call produced a second time even for its one read.
 */
export const headed = (statement: OperandSelect, reads: DeltaReads): OperandSelect => {
	/** Each read's selection by the name the read's CTE is renamed to, past every name a statement holds. */
	const selected = new Map<string, DeltaRead>()
	const readName = (read: DeltaRead): string => {
		const name = `${readMark}${selected.size}`
		selected.set(name, read)
		return name
	}
	const pushed = new Transform({
		...identityHooks,
		core: (core) => {
			const sources = core.from.flatMap((item): ReadonlyArray<FromSource> =>
				item.kind === "joins"
					? [item.first, ...item.steps.flatMap((s) => (s.kind === "left" ? [] : [s.source]))]
					: [item]
			)
			const held = new Map(
				sources.flatMap((source) => {
					const read = heldRead(source, reads)
					return read === undefined ? [] : [[source, read] as const]
				})
			)
			if (held.size === 0 || core.where === undefined) {
				return core
			}
			const conjuncts = conjunctsOf(core.where)
			const moved = new Map<FromSource, Array<Expr>>()
			const kept = conjuncts.filter((conjunct) => {
				for (const [source, read] of held) {
					const over = overDelta(conjunct, read.column)
					if (over === undefined) {
						continue
					}
					const into = moved.get(source) ?? []
					into.push(over)
					moved.set(source, into)
					return false
				}
				return true
			})
			if (moved.size === 0) {
				return core
			}
			const renamed = (source: FromSource): FromSource => {
				const read = held.get(source)
				const selection = moved.get(source)
				return read === undefined || selection === undefined
					? source
					: read.renamed(readName(reads.read(read.of, selection)))
			}
			return {
				...core,
				from: core.from.map((item) =>
					item.kind === "joins"
						? {
								...item,
								first: renamed(item.first),
								steps: mapNonEmpty(item.steps, (s) => ({ ...s, source: renamed(s.source) }))
							}
						: renamed(item)
				),
				where: isNonEmpty(kept) ? (kept.length === 1 ? headNonEmpty(kept) : and(kept)) : undefined
			}
		}
	}).select(statement)
	/** Each read's selection by the name its CTE reads under: a marked one's, or every row of a delta read whole. */
	const readOf = (name: string): DeltaRead | undefined => {
		const marked = selected.get(name)
		if (marked !== undefined) {
			return marked
		}
		const of = reads.delta(name)
		return of === undefined ? undefined : reads.read(of, [])
	}
	const counts = new Map<DeltaRead, number>()
	let last = 0
	/** A generated relation name, r<n>, raises `last` to its n; any other name is none of the statement's numbering. */
	const numbered = (name: string | undefined): void => {
		const digits = name?.startsWith("r") === true ? name.slice(1) : ""
		const n = Number(digits)
		if (digits !== "" && Number.isSafeInteger(n) && String(n) === digits) {
			last = Math.max(last, n)
		}
	}
	const sourceOf = (source: FromSource): void => {
		const read = source.kind === "cte" ? readOf(source.name) : undefined
		if (read !== undefined) {
			counts.set(read, (counts.get(read) ?? 0) + 1)
		}
		numbered("alias" in source ? source.alias : undefined)
	}
	visitSelect(pushed, {
		...inertVisitor,
		fromItem: (item) => {
			if (item.kind === "joins") {
				sourceOf(item.first)
				for (const step of item.steps) {
					sourceOf(step.source)
				}
				return
			}
			sourceOf(item)
		},
		with: (w) => {
			for (const cte of w.ctes) {
				numbered(cte.name)
			}
		}
	})
	/** The call of `read`'s reader under `alias`, each column c<n> by its place, as the statement's reads name them. */
	const callOf = (read: DeltaRead, alias: string): FromSource => {
		const reader = reads.reader(read)
		return {
			kind: "function",
			call: qualifiedCall(reader.schema, reader.name, []),
			alias,
			columns: read.delta.columns.map((_, at) => `c${at + 1}`),
			lateral: false,
			ordinality: false
		}
	}
	/** Each reader read twice or more, its CTE named past every relation the statement names: r<n>, its call r<n+1>. */
	const shared = new Map(
		[...counts].flatMap(([read, n]) => {
			if (n < 2) {
				return []
			}
			const cte = `r${last + 1}`
			const inner = `r${last + 2}`
			last += 2
			const columns = read.delta.columns.map((_, at) => `c${at + 1}`)
			const head: Cte = {
				name: cte,
				columns,
				materialized: "MATERIALIZED",
				query: simpleSelect(
					columns.map((c) => ({ expr: col(inner, c), alias: undefined })),
					[callOf(read, inner)],
					undefined
				)
			}
			return [[read, head] as const]
		})
	)
	const resolved = new Transform({
		...identityHooks,
		fromSource: (source) => {
			const read = source.kind === "cte" ? readOf(source.name) : undefined
			if (read === undefined || source.kind !== "cte") {
				return source
			}
			const alias = source.alias ?? source.name
			const head = shared.get(read)
			return head === undefined ? callOf(read, alias) : { ...source, name: head.name, alias }
		}
	}).select(pushed)
	return withLeading(resolved, shared.values())
}

/**
 * What a read's CTE is renamed to while `headed` moves its selection: the mark, then the read's number. No relation
 * a statement names starts with it, since a lowering names each r<n> and a delta `__delta_...`.
 */
const readMark = "\u0001read"

/**
 * The columns `e`, a selection's conjunct over the delta's table `r1`, holds equal to constants (`deltaIndexes`): a
 * column equal to a literal, in an IN list of literals or equal to an element of a literal array; each column every
 * argument of an OR holds so; each column some argument of an AND holds so.
 */
const fixedBy = (e: Expr): ReadonlySet<string> => {
	const columnOf = (x: Expr): string | undefined =>
		x.kind === "column" && x.table === "r1" ? x.column : undefined
	const constant = (x: Expr): boolean =>
		x.kind === "literal" || (x.kind === "cast" && constant(x.expr))
	const fixing = (c: string | undefined, by: boolean): ReadonlySet<string> =>
		c !== undefined && by ? new Set([c]) : new Set()
	if (e.kind === "binary" && e.op === "=") {
		const left = columnOf(e.left)
		return left !== undefined
			? fixing(left, constant(e.right))
			: fixing(columnOf(e.right), constant(e.left))
	}
	if (e.kind === "inList") {
		return fixing(columnOf(e.expr), !e.not && e.list.every(constant))
	}
	if (e.kind === "equalsAny") {
		return fixing(columnOf(e.expr), constant(e.array))
	}
	if (e.kind === "and") {
		return new Set(e.args.flatMap((x) => [...fixedBy(x)]))
	}
	if (e.kind === "or") {
		const [first, ...rest] = mapNonEmpty(e.args, fixedBy)
		return new Set([...first].filter((c) => rest.every((fixed) => fixed.has(c))))
	}
	return new Set()
}

/**
 * The columns of `of`'s delta each a B-tree of its table holds (`DeltaReads` indexesOf), the delta's `reads` the
 * selections its readers read: of each selection that holds a column a B-tree may hold equal to constants (`fixedBy`),
 * the one most of the delta's selections hold so, the first in the delta's heading among those, where another
 * selection holds it too, so its reader reads the rows it admits through that column's B-tree, which PostgreSQL plans
 * at every size of the table, the empty one never analyzed among them, since the column's equality is priced at a row
 * (selfuncs.c DEFAULT_EQ_SEL); in the heading's order. A column no other selection holds takes none: its B-tree's
 * entries, one for each row every capture of the delta writes, cost the one read it would serve as much as that
 * read's own pass over the rows, 160 ms against 62 ms of 253,458 nodes. A column a B-tree may hold is one whose datum has a byte bound its entry fits within (schema/representability.ts
 * btreeEntry), of a type its default class orders, never a vector; a selection that fixes none reads every row of the
 * delta it tests. A B-tree costs every capture of the delta its entries, which the reads it serves repay: a judge's read
 * of one kind of node through the delta's B-tree of kinds reads that kind's rows, in 0.2 ms of 253,458 nodes where
 * the read of every row took 62 ms (JUDGEDELTA, s18).
 */
const deltaIndexes = (of: ReadDelta, reads: ReadonlyArray<DeltaRead>): ReadonlyArray<string> => {
	const indexable = new Set<string>(
		of.relation.heading.flatMap((f) => {
			const datum = datumBound(f.desc)
			return datum === undefined ||
				datum.family === "vector" ||
				btreeEntryBytes([{ name: f.column, datum, nullable: true }]) > btreeMaxItemSize
				? []
				: [f.column]
		})
	)
	const fixed = reads.map((read) =>
		[...new Set(read.selection.flatMap((e) => [...fixedBy(e)]))].filter((c) => indexable.has(c))
	)
	const held = new Map<string, number>()
	for (const columns of fixed) {
		for (const c of columns) {
			held.set(c, (held.get(c) ?? 0) + 1)
		}
	}
	const place = (c: string): number => of.delta.columns.findIndex((d) => d.name === c)
	const sought = new Set(
		fixed.flatMap((columns) => {
			const [first, ...rest] = columns
			const best =
				first === undefined
					? undefined
					: rest.reduce((most, c) => {
							const by = (held.get(c) ?? 0) - (held.get(most) ?? 0)
							return by > 0 || (by === 0 && place(c) < place(most)) ? c : most
						}, first)
			return best === undefined || (held.get(best) ?? 0) < 2 ? [] : [best]
		})
	)
	return [...sought].toSorted((x, y) => place(x) - place(y))
}

/** A B-tree of a delta's table (`DeltaIndex`), made by the stand-up that makes the table or that finds it without it. */
export const deltaIndex = (delta: SessionDelta, index: DeltaIndex): PlStatement => ({
	kind: "createSessionIndex",
	name: index.name,
	table: delta.name,
	column: index.column
})

/**
 * Each read delta's readers (`DeltaReads`), by the delta's name, each read once: the row type of the delta's rows
 * (SessionDelta `row`, named apart from its readers), its relation's heading's columns, and for each of its reads the
 * function the statements that read it so call, its rows' one SELECT, the read's selection its WHERE, no count of a
 * side of news among them, which the part nets before any statement reads the delta (`netted`):
 *
 *   RETURN QUERY SELECT r1.<column>, ... FROM pg_temp.<delta> AS r1 [WHERE <selection>]
 *
 * It deduplicates nothing. A side of news holds each image once once it is netted (`netted` keeps one row of each image
 * it keeps), and images are distinct rows; a side of olds may hold one row twice (a row found, put back and found
 * again), and the statement reads every Delta node as the DISTINCT of the fields it delivers
 * (lower/conservative/delta/index.ts lowerDelta), which takes those alike. A DISTINCT here sorted or hashed the delta's
 * every column, toasted text among them, once for each statement that read the delta: 378 times, 9.75 million rows,
 * 118.6 s of a 540-item package's COMMIT at f87b2aaab.
 *
 * It declares the rows a call returns (`sessionReaderRows`), so a statement that reads the delta looks each row's key up
 * in the tables it probes, where at PostgreSQL's own estimate for a set-returning function, a thousand rows, it hashed
 * a scan of the table below a million rows.
 *
 * A plan of a statement that reads the delta through it depends on the function, never on the table, so a TRUNCATE
 * the judge empties the table with once it has outgrown its page (`emptied`), a new file of the table and an
 * invalidation of every plan that reads it, leaves the judge's plans standing for the next run, and only the reader's
 * own SELECT is planned again. Its EXECUTE is revoked from PUBLIC, as each part's is: only the judge's definer runs it,
 * over a table only that definer made (`ensured`). Each is installed for `reasons`.
 */
export const addReaders = (
	b: InstallBuilder,
	reads: DeltaReads,
	reasons: ReadonlyArray<PhysicalReason>
): ReadonlyMap<string, ReadonlyArray<Node<"validate">>> =>
	new Map(
		reads.all().map(({ of, reads: each }) => {
			const delta = of.delta
			const rowNamed = objectName(b.schema, b.name(delta.row))
			const rowType = b.add(
				{
					kind: "rowType",
					ident: b.qualified("type", delta.row),
					ddl: [
						{ kind: "createRowType", name: rowNamed, attributes: delta.columns },
						{
							kind: "revoke",
							privileges: ["ALL"],
							on: { kind: "TYPE", names: [rowNamed] },
							from: [{ kind: "PUBLIC" }]
						}
					],
					reasons,
					phase: "setup"
				},
				[b.levelNode(of.relation.name)]
			)
			const nodes = each.map((read) => {
				const named = reads.reader(read)
				const reader: readonly [PlFunction, Revoke] = [
					{
						kind: "createFunction",
						language: "plpgsql",
						name: named,
						params: [],
						returns: {
							setOf: namedType(installationTypes(b.names.installation), rowNamed.name, []),
							rows: { kind: "declared", rows: sessionReaderRows }
						},
						volatility: "VOLATILE",
						parallel: "UNSAFE",
						security: "DEFINER",
						body: {
							declare: [],
							body: [
								{
									kind: "returnQuery",
									query: simpleSelect(
										mapNonEmpty(delta.columns, (c) => ({
											expr: col("r1", c.name),
											alias: undefined
										})),
										[{ kind: "table", table: sessionTable(delta.name), alias: "r1" }],
										isNonEmpty(read.selection) ? and(read.selection) : undefined
									)
								}
							]
						}
					},
					revokeOf(named, [])
				]
				return b.add(
					{
						kind: "lawFunction",
						ident: b.qualified("function", read.reader),
						ddl: reader,
						reasons,
						phase: "validate"
					},
					[rowType]
				)
			})
			return [delta.name, nodes] as const
		})
	)

/** REVOKE EXECUTE ON FUNCTION <fn>(<args>) FROM PUBLIC. */
export const revokeOf = (fn: ObjectName, args: ReadonlyArray<TypeRef>): Revoke => ({
	kind: "revoke",
	privileges: ["EXECUTE"],
	on: { kind: "FUNCTION", names: [{ ...fn, args }] },
	from: [{ kind: "PUBLIC" }]
})
