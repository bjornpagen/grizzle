/**
 * The rule judge's session deltas (physical/ddl/rules.ts addRules): for each side of each table a rule over a query
 * reads, the table of pg_temp a capture writes the rows a statement wrote into, how a judge's part nets, stands up and
 * empties it, and how a judged statement reads it. physical/ddl/rules.ts holds the captures' triggers, the sentinel
 * that arms the judge, the parts and the judge.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
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
import { temporarySchema } from "#compiler/core/temporary.ts"
import { weightOf } from "#compiler/core/zset.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import { baseTypeRef } from "#compiler/ir/physical.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import { heapTupleMaxBytes } from "#compiler/laws/model/model.ts"
import { inlineColumn, type RowColumn, rowBytes } from "#compiler/laws/model/rows.ts"
import { withLeading } from "#compiler/lower/conservative/context.ts"
import type { DeltaRelation } from "#compiler/lower/conservative/types.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { installationTypes } from "#compiler/physical/ddl/type-schemas.ts"
import type { Node } from "#compiler/physical/obligations/graph.ts"
import { typlens } from "#compiler/schema/representability.ts"
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
import { sessionTableEmptied } from "#compiler/sql/print.ts"
import { identityHooks, inertVisitor, Transform, visitSelect } from "#compiler/sql/transform.ts"

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
	/** The function the judge's statements read the delta through, and the row type of its rows (`readerOf`). */
	readonly reader: Identity<"ruleDeltaReader">
	/** The row type of the rows its reader returns. */
	readonly row: Identity<"ruleDeltaRow">
	readonly name: string
	readonly columns: NonEmptyReadonlyArray<ColumnDefinition>
	readonly table: NonEmptyReadonlyArray<ColumnDefinition>
	/** How its table stores its values (`deltaStorage`). */
	readonly storage: SessionTableStorage
	/** The CTE a judged statement that reads the delta reads it through, over its reader (`deltaHead`). */
	readonly head: Cte
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
 * The CTE a judged statement reads the delta `name` through (`headed`), named as its table is, each of `columns`, its
 * relation's heading's, in the column of its own name: the rows of the delta's reader `reader` (`readers`), MATERIALIZED,
 * so the statement calls the reader once and each of its reads of the delta scans the rows the CTE holds. A call at
 * each read would run the reader's SELECT of the whole delta there, once for each read.
 *
 *   WITH "<delta>"("<column>", ...) AS MATERIALIZED (SELECT "r1"."<column>", ... FROM <reader>() AS "r1")
 */
const deltaHead = (
	name: string,
	columns: NonEmptyReadonlyArray<ColumnDefinition>,
	reader: ObjectName
): Cte => ({
	name,
	columns: columns.map((c) => c.name),
	materialized: "MATERIALIZED",
	query: simpleSelect(
		columns.map((c) => ({ expr: col("r1", c.name), alias: undefined })),
		[
			{
				kind: "function",
				call: qualifiedCall(reader.schema, reader.name, []),
				alias: "r1",
				columns: [],
				lateral: false,
				ordinality: false
			}
		],
		undefined
	)
})

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
 * base type (a text column collated C.UTF-8 as every stored text column is), its table's, its storage, its name, the
 * reader the judge's statements read it through, and the head that reads it (`deltaHead`).
 */
export const sessionDeltaOf = (
	b: InstallBuilder,
	relation: RelationInfo,
	side: ProbeSide
): SessionDelta => {
	const columns = mapNonEmpty(relation.heading, (f): ColumnDefinition => {
		const type = baseTypeRef(b.names, f.type)
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
	const reader = identity.ruleDeltaReader(relation.name, deltaStem[side], ident)
	const row = identity.ruleDeltaRow(relation.name, deltaStem[side], ident)
	const name = b.name(ident)
	return {
		ident,
		reader,
		row,
		name,
		columns,
		table,
		storage,
		head: deltaHead(name, columns, objectName(b.schema, b.name(reader)))
	}
}

/**
 * `delta` of `relation` as a Delta node reads it (lower/conservative/types.ts DeltaRelation): the CTE the judged
 * statement reads it through (SessionDelta `head`), each field of its relation's heading in the column of its place,
 * c<n> (`instanceOf`).
 */
export const deltaRelation = (relation: RelationInfo, delta: SessionDelta): DeltaRelation => ({
	kind: "cte",
	cte: delta.head.name,
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
const imageOf = (relation: RelationInfo, side: JudgedSide): NonEmptyReadonlyArray<string> => {
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
	relation: RelationInfo,
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
export const netted = (relation: RelationInfo, side: JudgedSide): PlStatement => {
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
 * its one reused page, and by TRUNCATE once it holds more, so a delta never holds more than that page past a run and its
 * run's rows, and the relcache invalidation a TRUNCATE sends every backend of the database, each of which walks every
 * plan it holds, is paid once a page's worth of a session's rows, where a TRUNCATE at every run paid it at every judged
 * COMMIT. The judge's statements read the delta through its reader (`addReaders`), so their plans outlive a truncation.
 * The judge runs inside no statement that holds the delta open: after SET CONSTRAINTS ALL IMMEDIATE it runs at the end
 * of the capture's arming INSERT, which reads the sentinel and the written set's variable alone (physical/ddl/rules.ts
 * arming).
 */
export const emptied = (delta: SessionDelta): PlStatement => sessionTableEmptied(delta.name)

/**
 * `statement` with the CTE of each session's delta it reads (`deltaHead`) leading its WITH, in the order `heads` holds
 * them: every Delta node of the statement over a delta reads that delta's CTE, so the statement calls each delta's
 * reader once, however many of its reads read the delta (the arms of a union over one relation, the occurrences of a
 * region, a negation's test), where a call at each read read every row of the delta again for each.
 */
export const headed = (
	statement: OperandSelect,
	heads: ReadonlyMap<string, Cte>
): OperandSelect => {
	const read: Array<string> = []
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
		if (source.kind === "cte" && heads.has(source.name) && !read.includes(source.name)) {
			read.push(source.name)
		}
		numbered("alias" in source ? source.alias : undefined)
	}
	visitSelect(statement, {
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
	/** Each delta the statement reads, its head named past every relation the statement names: r<n> and its reader r<n+1>. */
	const named = new Map(
		read.map((delta) => {
			const head = defined(heads.get(delta), "a delta the statement reads has its head")
			const cte = `r${last + 1}`
			const inner = `r${last + 2}`
			last += 2
			return [delta, { head, cte, inner }] as const
		})
	)
	const renamed = new Transform({
		...identityHooks,
		fromSource: (source) => {
			const to = source.kind === "cte" ? named.get(source.name) : undefined
			return to === undefined || source.kind !== "cte" ? source : { ...source, name: to.cte }
		}
	}).select(statement)
	return withLeading(
		renamed,
		[...named.values()].map(({ head, cte, inner }) => instanceOf(head, cte, inner))
	)
}

/**
 * A delta's head (`deltaHead`) as one statement holds it: named `cte`, its reader read under `inner`, each column c<n>
 * by its place, as the statement's reads of the delta name them (`sessionDelta`).
 */
const instanceOf = (head: Cte, cte: string, inner: string): Cte => {
	const columns = head.columns.map((_, at) => `c${at + 1}`)
	const body = head.query
	if (body.kind !== "select" || body.body.kind !== "core") {
		throw defect("a delta's head is one SELECT of its reader")
	}
	const [source] = body.body.from
	if (source?.kind !== "function") {
		throw defect("a delta's head reads its reader")
	}
	return {
		...head,
		name: cte,
		columns,
		query: simpleSelect(
			columns.map((c) => ({ expr: col(inner, c), alias: undefined })),
			[{ ...source, alias: inner, columns }],
			undefined
		)
	}
}

/**
 * Each delta's reader (SessionDelta `reader`), by the delta's name, `deltas` each with the relation it is a side of: the
 * row type of the delta's rows (SessionDelta `row`, named apart from the reader), its relation's heading's columns, and
 * the function the judge's statements read the delta through, its rows' one SELECT, no count of a side of news among
 * them, which the part nets before any statement reads the delta (`netted`):
 *
 *   RETURN QUERY SELECT r1.<column>, ... FROM pg_temp.<delta> AS r1
 *
 * It deduplicates nothing. A side of news holds each image once once it is netted (`netted` keeps one row of each image
 * it keeps), and images are distinct rows; a side of olds may hold one row twice (a row found, put back and found
 * again), and the statement reads every Delta node as the DISTINCT of the fields it delivers
 * (lower/conservative/delta/index.ts lowerDelta), which takes those alike. A DISTINCT here sorted or hashed the delta's
 * every column, toasted text among them, once for each statement that read the delta: 378 times, 9.75 million rows,
 * 118.6 s of a 540-item package's COMMIT at f87b2aaab.
 *
 * A plan of a statement that reads the delta through it depends on the function, never on the table, so a TRUNCATE
 * the judge empties the table with once it has outgrown its page (`emptied`), a new file of the table and an
 * invalidation of every plan that reads it, leaves the judge's plans standing for the next run, and only the reader's
 * own SELECT is planned again. Its EXECUTE is revoked from PUBLIC, as each part's is: only the judge's definer runs it,
 * over a table only that definer made (`ensured`). Each is installed for `reasons`.
 */
export const addReaders = (
	b: InstallBuilder,
	deltas: ReadonlyArray<{ readonly relation: RelationInfo; readonly delta: SessionDelta }>,
	reasons: ReadonlyArray<PhysicalReason>
): ReadonlyMap<string, Node<"validate">> =>
	new Map(
		deltas.map(({ relation, delta }) => {
			const named = objectName(b.schema, b.name(delta.reader))
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
				[b.levelNode(relation.name)]
			)
			const reader: readonly [PlFunction, Revoke] = [
				{
					kind: "createFunction",
					language: "plpgsql",
					name: named,
					params: [],
					returns: {
						setOf: namedType(installationTypes(b.names.installation), rowNamed.name, [])
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
									undefined
								)
							}
						]
					}
				},
				revokeOf(named, [])
			]
			const node = b.add(
				{
					kind: "lawFunction",
					ident: b.qualified("function", delta.reader),
					ddl: reader,
					reasons,
					phase: "validate"
				},
				[rowType]
			)
			return [delta.name, node] as const
		})
	)

/** REVOKE EXECUTE ON FUNCTION <fn>(<args>) FROM PUBLIC. */
export const revokeOf = (fn: ObjectName, args: ReadonlyArray<TypeRef>): Revoke => ({
	kind: "revoke",
	privileges: ["EXECUTE"],
	on: { kind: "FUNCTION", names: [{ ...fn, args }] },
	from: [{ kind: "PUBLIC" }]
})
