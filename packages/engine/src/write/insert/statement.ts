import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ConstraintName, EntryName, StoredRelationName } from "#compiler/core/ids.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { DagTemplates } from "#compiler/ir/dag-digest.ts"
import { columnReads } from "#compiler/ir/expr.ts"
import type { HeadName } from "#compiler/ir/instant.ts"
import { generationOf, type LawField, type RelationInfo } from "#compiler/ir/law.ts"
import type { Needs } from "#compiler/ir/needs.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { ParamDecl, StatementRole } from "#compiler/ir/products.ts"
import type { Heading, KeySet, ValidDag } from "#compiler/ir/rel.ts"
import { baseOf, regexOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	type ColumnMap,
	type Env,
	envOf,
	carriesNothing,
	evaluatedAsItStands,
	LowerContext,
	WriteParams
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr, lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import type { BoundCarrierOf, WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import {
	type TextDelivered,
	textDelivered,
	textItself,
	textRows
} from "#compiler/lower/delivery.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import {
	bodyPositionNames,
	type EmittedSql,
	type StatementText,
	type Expr,
	type FromItem,
	type InsertTarget,
	type ObjectName,
	type OrderItem,
	type RowsProof,
	type Select,
	type SqlStatement,
	type TypeRef,
	type With
} from "#compiler/sql/ast.ts"
import {
	call,
	cast,
	col,
	derived,
	lit,
	provedCore,
	sameTypeRef,
	select,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { emitText, type TextOf } from "#compiler/sql/emit.ts"
import type { TableGeneration } from "#compiler/sql/generation.ts"
import { namedQuery, NameSupply, type NameSupplyStart } from "#compiler/sql/naming.ts"
import type { FieldColumns } from "#compiler/write/defined.ts"

/** The installed names a write statement addresses: the query lowering's names plus the installed schema, whose
 * refusal function a refusing statement calls, and each relation's primary key constraint, `<table>__pk`, the named
 * arbiter of an insert into a span primary key. `InstallNames` satisfies it. */
export interface WriteNames extends PhysicalNames {
	readonly schema: string
	/** A head's stamp function, by its name (ir/instant.ts HeadName, physical/ddl/stamps.ts), which the statement that
	 * stamps it calls. */
	readonly stamp: (head: HeadName) => ObjectName
	/** A head's table, by its name, whose rows of the groups a delete of a place's relation removes it deletes
	 * (write/insert/stamp.ts placeReleases). */
	readonly head: (head: HeadName) => ObjectName
	readonly primaryKey: (relation: string) => ConstraintName
}

/**
 * The source of an INSERT of new keys: `rows` sorted by `key`, the primary key under the fixed collation, so concurrent
 * inserters take new-key locks in one order (protocol.ts), read whole as a derived table under a name of the
 * statement's own supply:
 *
 *   SELECT "<name>"."<c>", ... FROM (<rows, each output named "<c>"> ORDER BY <key>) AS "<name>"
 *
 * PostgreSQL flattens the outer query into the INSERT and plans the sorted rows apart under that name (allpaths.c
 * set_subquery_pathlist), its ModifyTable reading them as the sort leaves them, as it read the INSERT's own sorted
 * source. That source had no alias, and PostgreSQL 19 plans an unaliased subquery as `unnamed_subquery`
 * (parse_relation.c), the name every other one of the statement takes too, so each searched the numbered names
 * `unnamed_subquery_1`, `_2`, ... against every name the statement's planning had used before it (planner.c
 * choose_plan_name): a search quadratic in a statement's parts, an INSERT per part. A name of the supply is the
 * statement's alone, found new in one pass.
 */
export const keyOrderedSource = (
	supply: NameSupply,
	rows: Select,
	key: NonEmptyReadonlyArray<OrderItem>
): Extract<InsertTarget["source"], { readonly kind: "query" }> => {
	const name = supply.relation({ kind: "internal", purpose: "key-ordered insert source" })
	const columns = bodyPositionNames(rows.body).map(() =>
		supply.column({ kind: "internal", purpose: "key-ordered insert source column" })
	)
	return {
		kind: "query",
		query: select(
			provedCore(
				"keyed",
				columns.map((c) => target(col(name, c))),
				[derived(namedQuery({ ...rows, orderBy: key }, columns), name, false)],
				undefined
			)
		)
	}
}

/** One result column: a fact field by its name, or a protocol marker. */
export interface ResultColumn {
	readonly name: string
	readonly type: ScalarType
}

export type InsertVariant = "protocol" | "pureSet" | "spanKey" | "family"

/** The action an insert statement realizes: an insertion, or a put's insert half. Its rows are facts made present
 * under that tag (`AddedTag`). */
export type InsertOf = "insert" | "put"

/**
 * Which requested facts an insert statement proposes to its INSERT:
 * - `every`: each one, the arbiter settling a stored row at its key, an insertion's exact repeat or its conflict, a
 *   put's commit after its deletion;
 * - `unstored`: into a family owner, only those at no stored key. A proposed owner carries every
 *   count and end its input does not carry at its start, and PostgreSQL judges a proposed row by every CHECK before any
 *   arbiter meets its key (PostgreSQL 19 nodeModifyTable.c ExecInsert: ExecConstraints, then the speculative insertion), so a
 *   stored owner proposed again would meet a check over an end, such as an invoice's lines summing to its amount, at
 *   that placeholder. A stored owner at a requested key is instead an insertion's exact repeat or its conflict, read
 *   from its row, or the row a put's UPDATE wrote, its families as they are.
 */
export type Proposal = "every" | "unstored"

/** Which requested facts an insert, which meets stored facts at its arbiter, proposes (Proposal): only those at no
 * stored arbiter key into a family owner, whose rows carry counts and ends; every one into any other relation, whose
 * proposed row is its requested fact. */
export const proposalOf = (relation: RelationInfo): Proposal =>
	relation.heading.some((f) => f.writing.kind === "drawn" || f.writing.kind === "accumulated")
		? "unstored"
		: "every"

/** What an insert statement's rows mean: each is a fact the statement inserted. A refusal is never a row: the
 * statement raises it. */
export interface InsertResult {
	readonly kind: "insert"
	readonly relation: StoredRelationName
	readonly variant: InsertVariant
	readonly of: InsertOf
	readonly proposes: Proposal
	/** The outer SELECT's columns, position by position: the fact fields. */
	readonly columns: ReadonlyArray<ResultColumn>
	/** The complete fact's fields, key first. */
	readonly fields: ReadonlyArray<string>
	readonly key: KeySet
}

/** What a deletion's rows mean: each is a fact the statement made absent. */
export interface DeleteResult {
	readonly kind: "delete"
	readonly relation: StoredRelationName
	/** exact: the facts a delete member names; displacing: the occupants a put replaces. */
	readonly mode: "exact" | "displacing"
	readonly columns: ReadonlyArray<ResultColumn>
	/** The complete fact's fields, key first. */
	readonly fields: ReadonlyArray<string>
	readonly key: KeySet
}

/** A carrier's fill (write/carriers/carriers.ts carrierStash); its one row carries nothing to decode. */
export interface CarrierResult {
	readonly kind: "carrier"
	readonly carrier: string
}

/** A query entry's check of the facts an addition is about to write: no rows, or the
 * outside-world refusal of the entry it names, raised inside it. */
export interface EntryCheckResult {
	readonly kind: "entryCheck"
	readonly entry: EntryName
}

export type WriteResult = InsertResult | DeleteResult | CarrierResult | EntryCheckResult

/** A built statement whose rows mean `R`.
 *
 * The write statement: what every statement the write lowering emits carries, and the per-statement state its builders
 * share.
 *
 * A write statement is one SQL statement of a ChangeSet's realization: the insert protocol, an exact or a
 * displacing deletion (delete/), or a carrier's creation or fill (carriers/). Each keeps
 * its AST beside the emitted text, so a later stage can explain it, and its placeholder slots in placeholder order, so
 * the caller encodes each relation input as the arrays the statement reads, one placeholder per column.
 *
 * Every DML write statement is a SELECT whose WITH holds the input CTE and the data-modifying CTE, as the insert
 * protocol is written: each enumerated member's arrays or carrier feeds the insert protocol and the deletions as
 * data-modifying CTEs in one statement chain, with RETURNING carrying inserted and deleted keys. A deletion could be a
 * bare DELETE ... RETURNING; the CTE form returns the same rows and keeps one statement kind, which the single
 * statement's parts and the conservative lowering's statement type both take.
 *
 * Result mode: PgConnection 4.0.2 delivers no text results, so the outermost SELECT casts every
 * result column to text, money through numeric (codec resultTextCasts), and the result descriptor records the scalar
 * type each column decodes as. The descriptors say what each returned row means, so the write program and
 * the runtime never parse SQL to read an outcome: an insert row is a fact the statement inserted, a deletion row a
 * fact it made absent. A refusal is never a row: the statement that detects it raises it, so PostgreSQL aborts the
 * transaction.
 *
 * Column order. A Description's fields are unordered, so a relation's heading is in code-unit order.
 * Every statement lists a relation's columns key first, the primary key in its declared order and
 * then the other fields in heading order: for Task(id, account, kind) keyed by id that is id, account,
 * kind, and it fixes the input arrays' columns c1 to cn. */
export interface WriteStatement<
	R extends WriteResult = WriteResult,
	T extends StatementText = EmittedSql
> {
	readonly role: StatementRole
	/** The AST; `sql` is its emission where it is sent alone, none where a single statement composes it (StatementWriting). */
	readonly ast: SqlStatement
	readonly sql: T
	/** Placeholder $n is params[n - 1], in the conservative lowering's slot vocabulary. */
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly result: R
	/** What its rows need of the call's inputs (ir/needs.ts): where they hold no such fact the statement does nothing,
	 * and the runtime sends none. */
	readonly needs: Needs
}

/** The rows of one side a write statement's data-modifying CTE returns: the RETURNING column of each fact field, and the
 * conditions a row meets to be on that side, none when every row is. */
export interface ReturnedSide {
	readonly columns: FieldColumns<string>
	readonly conditions: ReadonlyArray<Expr>
}

/** What a write statement's CTE `cte` holds, by side: the facts it made present (an insert's, an upsert's), those it
 * made absent (a deletion's), or both (an update's new facts and the old ones they displaced, a MERGE's by its action);
 * or an insertion's facts it made present beside the stored facts it met and did not refuse (`insertion`, protocol.ts
 * writesMet), each side its verdict rows of one class. The read-backs' deltas are read from it. Its names are the
 * statement's own, so it stays beside the result. */
export type Returning = { readonly cte: string } & (
	| { readonly kind: "added"; readonly added: ReturnedSide }
	| { readonly kind: "removed"; readonly removed: ReturnedSide }
	| { readonly kind: "both"; readonly added: ReturnedSide; readonly removed: ReturnedSide }
	| { readonly kind: "insertion"; readonly added: ReturnedSide; readonly met: ReturnedSide }
)

/** A SELECT whose WITH holds a write statement's data-modifying CTE and the CTEs around it. */
export type WithSelect = Select & { readonly with: With }

/** A write statement of facts, a SELECT over the CTE that writes them, which states its RETURNING. */
export type ModifyingStatement<
	R extends InsertResult | DeleteResult,
	T extends StatementText = EmittedSql
> = WriteStatement<R, T> & {
	readonly ast: WithSelect
	readonly returning: Returning
}

/** The state the write builders share: a lowering context, whose naming and placeholder state each statement resets,
 * which lowers described members with its dispatch (the conservative one by default) and resolves PostgreSQL types. */
export interface WriteContext {
	readonly cx: LowerContext
	readonly names: WriteNames
	/** The isolation the write runs at, which decides how its inserts meet stored rows (insert/protocol.ts
	 * Arbitration). */
	readonly level: Isolation
	/** Where a statement's generated names start: r0 and c1 for a statement of its own; past every name the parts before
	 * it used, for a part of a stratum's single statement, so the parts' names never collide. */
	readonly start: NameSupplyStart
	/** What an UPDATE of a relation's table meets of its stored generated columns, as the compilation's updater runs it
	 * (laws/model/generation.ts generations), which every UPDATE's SET list is built against (sql/generation.ts). */
	readonly generation: (relation: string) => TableGeneration
}

/**
 * A write context that builds statements (buildStatement): how it makes their text, printed where a statement is sent
 * alone (sql/emit.ts emitText), none where a stratum's single statement composes it as a part (unprintedText), whose
 * names may read the CTEs the single statement holds, so a print of it apart would read names nothing binds
 * (sql/scope.ts); and the statements the compilation built of that text, which an equal request shares.
 */
export interface StatementWriting<T extends StatementText> extends WriteContext {
	readonly text: TextOf<T>
	readonly share: StatementShare<T>
}

/** A statement of its own numbers its relations from r0 and its columns from c1. */
export const ownStatement: NameSupplyStart = Object.freeze({ relationStart: 0, columnStart: 1 })

interface WriteContextOptions {
	/** The installed names of the relations the statements write. */
	readonly names: WriteNames
	/** The names the described members' queries read their relations under: reality's own, or a role's views. */
	readonly reads: PhysicalNames
	/** The ChangeSet's declared parameters, for a described member's take bound. */
	readonly params: ReadonlyArray<ParamDecl>
	/** How a described member's query lowers: the conservative baseline (`dispatchNode`) or an optimized
	 * dispatch. */
	readonly dispatch: ConstructorParameters<typeof LowerContext>[2]
	readonly share: StatementShare<EmittedSql>
	readonly level: Isolation
	readonly generation: (relation: string) => TableGeneration
	/** The templates of the write's compile (lower/conservative/types.ts WriteLowering). */
	readonly templates: DagTemplates
	/** Where its InputSets of the relation parameters its ChangeSet binds to queries read (WriteLowering `bound`). */
	readonly bound: BoundCarrierOf
}

/** The write context of a compilation's statements, each printed, as a statement sent alone is (StatementWriting). */
export const writeContext = (
	dag: ValidDag,
	options: WriteContextOptions
): StatementWriting<EmittedSql> => {
	const cx = new LowerContext(
		dag,
		{
			names: options.reads,
			params: options.params,
			subject: { kind: "write", templates: options.templates, bound: options.bound }
		},
		options.dispatch,
		evaluatedAsItStands,
		carriesNothing
	)
	return {
		cx,
		names: options.names,
		level: options.level,
		start: ownStatement,
		text: emitText,
		share: options.share,
		generation: options.generation
	}
}

/** What a builder builds of one statement: its AST, result, role and skipped input, and for a write of facts its
 * RETURNING. */
export interface Built<R extends WriteResult> {
	readonly ast: SqlStatement
	readonly result: R
	readonly role: StatementRole
	readonly needs: Needs
}

/** What building one statement made: what its builder built, its placeholder slots, and its text with its generated
 * names (StatementWriting `text`). */
export interface Made<B, T extends StatementText> {
	readonly built: B
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly sql: T
}

/**
 * A part of the request a shared statement is built under, compared as a Map compares its keys: an object by identity,
 * a primitive by value (a number by SameValueZero, so a part never distinguishes -0 from 0). A request that holds a list
 * of parts before other parts states the list's length first, so requests of different contents never agree.
 */
export type KeyPart = object | string | number | bigint | boolean | undefined

/**
 * What one compilation built of one kind of statement, by the request each was built under (Sharing): one level of Maps
 * per part of the request, so no request is spelled as text and two requests are one exactly when they agree part by
 * part. `made` is what was built under the request that leads here, undefined while nothing was.
 */
export interface Shared<V> {
	made: V | undefined
	readonly next: Map<KeyPart, Shared<V>>
}

const unshared = <V>(): Shared<V> => ({ made: undefined, next: new Map() })

/** The statements one write compilation built, for its other lowerings to share: the optimized artifact and the
 * conservative realization each build the insert protocol, the deletions and the carriers' creation, most over the same
 * inputs. A statement is shared under the
 * request that determines it (Sharing): the installed names, where its generated names start, and its builder's spec.
 * An equal request is answered with the statement already built and emitted; the program charges each statement it
 * sends once (write/program/compile.ts). A share serves one compilation and holds what it built until that compilation
 * is done. */
export class StatementShare<T extends StatementText> {
	readonly inserts =
		unshared<
			Made<Built<InsertResult> & { readonly ast: WithSelect; readonly returning: Returning }, T>
		>()
	readonly deletions =
		unshared<
			Made<Built<DeleteResult> & { readonly ast: WithSelect; readonly returning: Returning }, T>
		>()
}

/** How a statement is built: shared with every equal request of the compilation under `key` in `memo`, its spec's
 * parts, or built as its own. A statement that reads a described member is its own: lowering the member reads the DAG
 * and the dispatch of the lowering context, which differ between the artifacts. Any other statement's build reads only the installed names (each type through them), its spec,
 * and the naming and placeholder state that buildStatement begins for it, so the key and where its names start
 * determine it. */
export type Sharing<B, T extends StatementText> =
	| {
			readonly kind: "shared"
			readonly memo: Shared<Made<B, T>>
			readonly key: ReadonlyArray<KeyPart>
	  }
	| { readonly kind: "own" }

export const ownBuild = { kind: "own" } as const

/** Builds one statement with fresh single-assignment names, numbering relations from the context's start (r0 for a
 * statement of its own, as the write protocols do), and fresh placeholders, its text the context's (StatementWriting `text`),
 * or takes the statement an equal request built (`sharing`). */
export const buildStatement = <B extends Built<WriteResult>, T extends StatementText>(
	w: StatementWriting<T>,
	sharing: Sharing<B, T>,
	build: (supply: NameSupply) => B
): B & Pick<WriteStatement<WriteResult, T>, "sql" | "params"> => {
	const make = (): Made<B, T> => {
		const supply = new NameSupply(w.start)
		const placeholders = new WriteParams()
		w.cx.beginWriteStatement(supply, placeholders)
		const built = build(supply)
		return {
			built,
			params: Object.freeze([...placeholders.slots]),
			sql: w.text(built.ast, supply.map())
		}
	}
	let made: Made<B, T>
	if (sharing.kind === "own") {
		made = make()
	} else {
		let node = sharing.memo
		for (const part of [w.names, w.start.relationStart, w.start.columnStart, ...sharing.key]) {
			const known = node.next.get(part)
			if (known === undefined) {
				const fresh = unshared<Made<B, T>>()
				node.next.set(part, fresh)
				node = fresh
			} else {
				node = known
			}
		}
		made = node.made ?? make()
		node.made = made
	}
	return Object.freeze({ ...made.built, sql: made.sql, params: made.params })
}

/** A relation's fields' handles key first: the primary key in its declared order, then the other fields in heading
 * order. */
export const keyFirst = (relation: RelationInfo): NonEmptyReadonlyArray<LawField> => {
	const key: NonEmptyReadonlyArray<LawField> = relation.primaryFields
	return [...key, ...relation.heading.filter((f) => !key.includes(f))]
}

/** Whether a statement writes a field's column: every field but one PostgreSQL generates from its row, which no
 * INSERT, UPDATE or MERGE lists (428C9) and no addition's facts carry; it is read back with the rest. */
const isWritten = (field: LawField): boolean => field.writing.kind !== "generated"

/**
 * The fields an addition writes, key first (`keyFirst`): every field but a generated one (`isWritten`). A key
 * generation is no generated column but one grizzle writes (law.ts FieldWriting keyGenerated), so the list leads with
 * the primary key whole.
 */
export const writtenFields = (relation: RelationInfo): NonEmptyReadonlyArray<LawField> => {
	const key: NonEmptyReadonlyArray<LawField> = relation.primaryFields
	return [...key, ...relation.heading.filter((f) => !key.includes(f) && isWritten(f))]
}

/** Whether a fact carries a field: a caller's. A drawn or accumulated field is grizzle's and a generated one
 * PostgreSQL's, so no fact carries either. */
export const isCarried = (field: Pick<LawField, "writing">): boolean =>
	field.writing.kind === "caller"

/**
 * The value an insert writes a field at when its input does not carry it: a drawn field, which
 * outside a nesting is a fresh owner's count of a counted family, at 0, an accumulated one, a fresh owner's empty
 * family's end, at its start; none for a field its fact carries.
 */
export const startOf = (names: PhysicalNames, field: LawField): Expr | undefined => {
	switch (field.writing.kind) {
		case "drawn":
			return lowerLiteral(names, { kind: "int", value: 0n }, field.type)
		case "accumulated":
			return lowerLiteral(names, field.writing.start, field.type)
		case "caller":
		case "generated":
		case "keyGenerated":
		case "instant":
		case "place":
			return undefined
	}
}

/**
 * A requested fact's value at every field of its relation, as a statement reading its input states it: `carried`'s
 * value, `colOf`, for a field its input carries; the start an insert writes it at (startOf) for a drawn count or an
 * accumulated end it does not; and for a generated field its generation expression over the requested fact's values at
 * the fields it reads, the value PostgreSQL stores, so a requested fact lines up with the complete facts a statement
 * returns. An input carries the written fields alone, never a generated one, whatever its source.
 */
export const requestedValue = (
	w: WriteContext,
	relation: RelationInfo,
	carried: ReadonlyArray<LawField>,
	colOf: (f: LawField) => Expr
): ((f: LawField) => Expr) => {
	const value = (f: LawField): Expr => {
		if (carried.includes(f)) {
			return colOf(f)
		}
		const generation = generationOf(f)
		if (generation !== undefined) {
			const reads = columnReads([generation])
			const row: ColumnMap = new Map(
				reads.map((c) => {
					const read = defined(
						relation.fields.find((g) => g.name === c.name),
						`the field ${relation.name}.${c.name} a generated field reads`
					)
					return [c.name, value(read)] as const
				})
			)
			const env: Env = envOf(reads.map((c) => [c.node, row] as const))
			return lowerExpr(w.cx, generation, env)
		}
		return defined(
			startOf(w.names, f),
			`the start of ${relation.name}.${f.name}, a field a requested fact does not carry`
		)
	}
	return value
}

/** The value type of a stored field as rows carry it: its type. */
export const rowType = (field: LawField): ScalarType => field.type

/** The heading of a relation's facts over `fields`. */
export const factHeading = (fields: ReadonlyArray<LawField>): Heading =>
	fields.map((f) => ({ name: f.name, type: rowType(f) }))

/** A type with every refinement dropped: a contract's base, unrefined text and a closed id of every handle of its
 * roster, the typmod kept. Its PostgreSQL type is the base type with its typmod (LowerContext baseTypeRef), the type a
 * deletion compares a member as against stored facts (`CastInto` "compare"): a value outside a domain matches no fact
 * instead of raising its check. A text base is always built with the text carrier's own capabilities (`scalarAt`), so
 * its unrefined type is exactly the wildcard text. */
export const unrefined = (t: ScalarType): ScalarType => {
	const base = baseOf(t)
	switch (base.carrier) {
		case "text":
			return wildcardText
		case "code":
			return base.only === undefined ? base : Object.freeze({ ...base, only: undefined })
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "bytes":
		case "sha256":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
		case "exactInteger":
		case "exactMoney":
		case "variant":
			return base
	}
}

/** The heading a deletion compares a relation's facts as over `fields`: each field's unrefined type. */
export const compareHeading = (fields: ReadonlyArray<LawField>): Heading =>
	fields.map((f) => ({ name: f.name, type: unrefined(rowType(f)) }))

/** One column a write statement returns: its value, its result text (lower/delivery.ts), and its name. */
export interface ReturnedColumn {
	readonly expr: Expr
	readonly delivered: TextDelivered
	readonly alias: string
}

/**
 * The returned column `alias` of `expr`, a value of type `type`: its result text, but a bytes value's SHA-256 digest,
 * `encode(sha256(expr), 'hex')`, the identity the outcome nets it by (scalar/values/bytes.ts BytesDigest), which is
 * all the outcome reads of it, so no write sends a bytes value back.
 */
export const returnedColumn = (expr: Expr, type: ScalarType, alias: string): ReturnedColumn =>
	type.carrier === "bytes"
		? {
				expr: call("encode", [call("sha256", [expr]), lit.text("hex", types.text)]),
				delivered: textItself,
				alias
			}
		: { expr, delivered: textDelivered(type), alias }

/**
 * The SELECT of the rows a write statement returns: `columns` of each row of `from` where `where` holds, under the
 * proof `rows`, each its result text (lower/delivery.ts textRows), a bytes column its digest (`returnedColumn`), so a
 * write's answer is whole. Its WITH is the caller's.
 */
export const returnedRows = (
	rows: RowsProof,
	columns: ReadonlyArray<ReturnedColumn>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): Select =>
	textRows(
		{
			kind: "select",
			with: undefined,
			body: provedCore(
				rows,
				columns.map((c) => targetAs(c.expr, c.alias)),
				from,
				where
			),
			orderBy: [],
			limit: undefined,
			offset: undefined
		},
		columns.map((c) => c.delivered),
		[]
	)

/** The SQL type of an input column: its scalar type, and the PostgreSQL type its SQL expression has when the input
 * fixes it (an input array's base type, a carrier's column type). A described member's lowering fixes none: a stored
 * column keeps its domain, a literal is cast to its base (`context.ts` baseTypeRef). */
export interface InputColumnType {
	readonly type: ScalarType
	readonly sqlType: TypeRef | undefined
}

/** The value of an input column written into a stored column of type `to`: cast to the column's type, a refined
 * write casting to the domain, whenever the input's SQL type differs from it, or is not
 * fixed and the column is a domain or the base types differ. An input of the column's own type is never cast to
 * itself. */
export const writeValue = (
	w: WriteContext,
	value: Expr,
	from: InputColumnType,
	to: ScalarType
): Expr => {
	const column = w.cx.typeRef(to)
	if (from.sqlType !== undefined) {
		return sameTypeRef(from.sqlType, column) ? value : cast(value, column)
	}
	return isDomain(to) || !writeKeeps(w, from.type, to) ? cast(value, column) : value
}

/** Whether writing a value of `from`, a type no SQL type fixes, into a column of `to` keeps it (writeValue): their base
 * types and typmods agree, so the write casts it at most into a domain, which only checks a value, and two distinct
 * values stay distinct. Otherwise the cast may round two values onto one, as numeric(12, 4) into numeric(10, 2). */
export const writeKeeps = (w: WriteContext, from: ScalarType, to: ScalarType): boolean =>
	sameTypeRef(w.cx.baseTypeRef(from), w.cx.baseTypeRef(to))

const isDomain = (t: ScalarType): boolean =>
	t.contract !== undefined || (t.carrier === "text" && regexOf(t.text) !== undefined)
