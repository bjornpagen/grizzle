import { resultTextCasts } from "#compiler/codec/scalar.ts"
import type { BudgetMeter } from "#compiler/core/budget.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import type { ConstraintName, ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { ParamDecl, StatementRole } from "#compiler/ir/products.ts"
import type { Heading, KeySet, ValidDag } from "#compiler/ir/rel.ts"
import { baseOf, contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { LowerContext, WriteParams } from "#compiler/lower/conservative/context.ts"
import type { PhysicalNames, WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import { wildcardText, withoutSerial } from "#compiler/scalar/compute/types.ts"
import type {
	EmittedSql,
	Expr,
	ObjectName,
	Select,
	SqlStatement,
	TypeRef,
	With
} from "#compiler/sql/ast.ts"
import { cast, types } from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import { printType } from "#compiler/sql/print.ts"
import type { FieldColumns } from "#compiler/write/defined.ts"

/** The installed names a write statement addresses: the query lowering's names plus the installed schema, whose
 * refusal function a refusing statement calls, each serial field's identity sequence,
 * `<schema>.<table>_<col>_seq`, and each relation's primary key constraint, `<table>__pk`, the named arbiter of an
 * insert into a span primary key. `InstallNames` satisfies it. */
export interface WriteNames extends PhysicalNames {
	readonly schema: string
	/** A serial field's advance function. */
	readonly advance: (relation: string, field: string) => ObjectName
	readonly primaryKey: (relation: string) => ConstraintName
}

/** One result column: a fact field by its name, or a protocol marker. */
export interface ResultColumn {
	readonly name: string
	readonly type: ScalarType
}

export type InsertVariant = "protocol" | "pureSet" | "generated" | "spanKey"

/** The action an insert statement realizes: an insertion, or a put's insert half. Its rows are facts made present
 * under that tag (`AddedTag`). */
export type InsertOf = "insert" | "put"

/** What an insert statement's rows mean: each is a fact the statement inserted. A refusal is never a row: the
 * statement raises it. */
export interface InsertResult {
	readonly kind: "insert"
	readonly relation: string
	readonly variant: InsertVariant
	readonly of: InsertOf
	/** The outer SELECT's columns, position by position: the fact fields. */
	readonly columns: ReadonlyArray<ResultColumn>
	/** The complete fact's fields, key first. */
	readonly fields: ReadonlyArray<string>
	readonly key: KeySet
}

/** What a deletion's rows mean: each is a fact the statement made absent. */
export interface DeleteResult {
	readonly kind: "delete"
	readonly relation: string
	/** exact: the facts a delete member names; displacing: the occupants a put replaces. */
	readonly mode: "exact" | "displacing"
	readonly columns: ReadonlyArray<ResultColumn>
	/** The complete fact's fields, key first. */
	readonly fields: ReadonlyArray<string>
	readonly key: KeySet
}

/** The statement that follows an insert into a span primary key and classifies each requested fact no equal stored
 * fact accounts for. Every such fact refuses the write, so the statement raises or returns no row. */
export interface SpanClassifyResult {
	readonly kind: "spanClassify"
	readonly relation: string
}

/** The sequence advance after explicit serial values; its rows carry nothing to decode. */
export interface SequenceAdvanceResult {
	readonly kind: "sequenceAdvance"
	readonly relation: string
	readonly field: string
}

/** A carrier's creation or fill; no rows. */
export interface CarrierResult {
	readonly kind: "carrier"
	readonly carrier: string
	readonly step: "create" | "fill"
}

/** The ANALYZE of filled carriers before a statement that joins them against a stored relation; no rows. */
export interface AnalyzeResult {
	readonly kind: "analyze"
	readonly carriers: ReadonlyArray<string>
}

/** A query entry's check of the facts an addition is about to write: no rows, or the
 * outside-world refusal of the entry it names, raised inside it. */
export interface EntryCheckResult {
	readonly kind: "entryCheck"
	readonly entry: string
}

export type WriteResult =
	| InsertResult
	| DeleteResult
	| SpanClassifyResult
	| SequenceAdvanceResult
	| CarrierResult
	| AnalyzeResult
	| EntryCheckResult

/** A built statement whose rows mean `R`.
 *
 * The write statement: what every statement the write lowering emits carries, and the per-statement state its builders
 * share.
 *
 * A write statement is one SQL statement of a ChangeSet's realization: the insert protocol, an exact or a
 * displacing deletion (delete/), a sequence advance (serial/), or a carrier's creation or fill (carriers/). Each keeps
 * its AST beside the emitted text, so a later stage can specialize a relation input into VALUES
 * (`specializeValues`) or explain it, and its placeholder slots in placeholder order, so the
 * caller encodes each relation input under the JSON keys the statement's recordset reads.
 *
 * Every DML write statement is a SELECT whose WITH holds the input CTE and the data-modifying CTE, as the insert
 * protocol is written: each enumerated member's recordset or carrier feeds the insert protocol and the deletions as
 * data-modifying CTEs in one statement chain, with RETURNING carrying inserted and deleted keys. A deletion could be a
 * bare DELETE ... RETURNING; the CTE form returns the same rows and keeps one statement kind, which the VALUES
 * specialization and the conservative lowering's statement type both take.
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
 * kind, and it fixes the recordset's JSON keys c1 to cn. */
export interface WriteStatement<R extends WriteResult = WriteResult> {
	readonly role: StatementRole
	/** The AST; `sql` is its emission. */
	readonly ast: SqlStatement
	readonly sql: EmittedSql
	/** Placeholder $n is params[n - 1], in the conservative lowering's slot vocabulary. */
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly result: R
	/** The enumerated input the statement realizes: when it holds no fact the statement does nothing, and an empty input
	 * produces no statement. None for a statement of no enumerated input. */
	readonly skipWhenEmpty: ParamId | undefined
}

/** The rows of one side a write statement's data-modifying CTE returns: the RETURNING column of each fact field, and the
 * conditions a row meets to be on that side, none when every row is. */
export interface ReturnedSide {
	readonly columns: FieldColumns<string>
	readonly conditions: ReadonlyArray<Expr>
}

/** What a write statement's data-modifying CTE `cte` returns, by side: the facts it made present (an insert's, an upsert's),
 * those it made absent (a deletion's), or both (an update's new facts and the old ones they displaced, a MERGE's by its
 * action). The delta carriers are filled from it. Its names are the statement's own, so it stays
 * beside the result, which is compared across a statement's per-execution forms. */
export type Returning = { readonly cte: string } & (
	| { readonly kind: "added"; readonly added: ReturnedSide }
	| { readonly kind: "removed"; readonly removed: ReturnedSide }
	| { readonly kind: "both"; readonly added: ReturnedSide; readonly removed: ReturnedSide }
)

/** A SELECT whose WITH holds a write statement's data-modifying CTE and the CTEs around it. */
export type WithSelect = Select & { readonly with: With }

/** A write statement of facts, a SELECT over the CTE that writes them, which states its RETURNING. */
export type ModifyingStatement<R extends InsertResult | DeleteResult> = WriteStatement<R> & {
	readonly ast: WithSelect
	readonly returning: Returning
}

/** The state the write builders share: a lowering context, whose naming and placeholder state each statement resets,
 * which lowers described members with its dispatch (the conservative one by default) and resolves PostgreSQL types. */
export interface WriteContext {
	readonly cx: LowerContext
	readonly names: WriteNames
	readonly meter: BudgetMeter
	/** Where a statement's generated names start: r0 and c1 for a statement of its own; past every name the parts before
	 * it used, for a part of a stratum's single statement, so the parts' names never collide. */
	readonly start: NameStart
	/** The statements the compilation built, which an equal request shares (StatementShare). */
	readonly share: StatementShare
}

/** The first relation and column numbers a statement's generated names take. */
export interface NameStart {
	readonly relation: number
	readonly column: number
}

/** A statement of its own numbers its relations from r0 and its columns from c1. */
export const ownStatement: NameStart = Object.freeze({ relation: 0, column: 1 })

/** The start past every generated name `nameMap` holds: the next part of a single statement starts there. */
export const namesPast = (nameMap: EmittedSql["nameMap"]): NameStart => {
	let relation = ownStatement.relation
	let column = ownStatement.column
	for (const entry of nameMap) {
		const n = Number(entry.name.slice(1))
		if (!Number.isSafeInteger(n)) {
			continue
		}
		if (entry.role === "relation") {
			relation = Math.max(relation, n + 1)
		} else {
			column = Math.max(column, n + 1)
		}
	}
	return { relation, column }
}

interface WriteContextOptions {
	/** The installed names of the relations the statements write. */
	readonly names: WriteNames
	/** The names the described members' queries read their relations under: reality's own, or a role's views. */
	readonly reads: PhysicalNames
	/** The ChangeSet's declared parameters, for a described member's take bound. */
	readonly params: ReadonlyArray<ParamDecl>
	readonly meter: BudgetMeter
	/** How a described member's query lowers: the conservative baseline (`dispatchNode`) or an optimized
	 * dispatch. */
	readonly dispatch: ConstructorParameters<typeof LowerContext>[2]
	readonly share: StatementShare
}

export const writeContext = (dag: ValidDag, options: WriteContextOptions): WriteContext => {
	const cx = new LowerContext(
		dag,
		{
			names: options.reads,
			params: options.params,
			subject: { kind: "query" },
			meter: options.meter
		},
		options.dispatch
	)
	return {
		cx,
		names: options.names,
		meter: options.meter,
		start: ownStatement,
		share: options.share
	}
}

const writeRefusal = (tag: ProseTag, at: string, capability: string): Refusal =>
	new Refusal(CompileError.make(prose(tag, SourceLoc("write lowering", [at]), capability)))

export const refuseWrite = (tag: ProseTag, at: string, capability: string): never => {
	throw writeRefusal(tag, at, capability)
}

/** What a builder builds of one statement: its AST, result, role and skipped input, and for a write of facts its
 * RETURNING. */
export interface Built<R extends WriteResult> {
	readonly ast: SqlStatement
	readonly result: R
	readonly role: StatementRole
	readonly skipWhenEmpty: ParamId | undefined
}

/** What building one statement made: what its builder built, its placeholder slots, and its text with its generated
 * names. */
export interface Made<B> {
	readonly built: B
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly sql: EmittedSql
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

/** The statements one write compilation built, for its other lowerings to share: the optimized artifact, each of its
 * statements in its small and its large per-execution form, and the conservative realization each build the insert
 * protocol, the span classification, the deletions and the carriers' creation, most over the same inputs. A statement is shared under the
 * request that determines it (Sharing): the installed names, where its generated names start, and its builder's spec.
 * An equal request is answered with the statement already built and emitted; the program charges each statement it
 * sends once (write/program/compile.ts). A share serves one compilation and holds what it built until that compilation
 * is done. */
export class StatementShare {
	readonly inserts =
		unshared<
			Made<Built<InsertResult> & { readonly ast: WithSelect; readonly returning: Returning }>
		>()
	readonly classifications = unshared<Made<Built<SpanClassifyResult>>>()
	readonly deletions =
		unshared<
			Made<Built<DeleteResult> & { readonly ast: WithSelect; readonly returning: Returning }>
		>()
	readonly creations = unshared<Made<Built<CarrierResult>>>()
}

/** How a statement is built: shared with every equal request of the compilation under `key` in `memo`, its spec's
 * parts, or built as its own. A statement that reads a described member is its own: lowering the member reads the DAG
 * and the dispatch of the lowering context, which differ between the artifacts, and records the lowering's
 * per-execution choices. Any other statement's build reads only the installed names (each type through them), its spec,
 * and the naming and placeholder state that buildStatement begins for it, so the key and where its names start
 * determine it. */
export type Sharing<B> =
	| {
			readonly kind: "shared"
			readonly memo: Shared<Made<B>>
			readonly key: ReadonlyArray<KeyPart>
	  }
	| { readonly kind: "own" }

export const ownBuild = { kind: "own" } as const

/** Builds and emits one statement with fresh single-assignment names, numbering relations from the context's start (r0
 * for a statement of its own, as the write protocols do), and fresh placeholders, or takes the statement an equal
 * request built (`sharing`). */
export const buildStatement = <B extends Built<WriteResult>>(
	w: WriteContext,
	sharing: Sharing<B>,
	build: (supply: NameSupply) => B
): B & Pick<WriteStatement, "sql" | "params"> => {
	const make = (): Made<B> => {
		const supply = new NameSupply({ relationStart: w.start.relation, columnStart: w.start.column })
		const placeholders = new WriteParams()
		w.cx.beginWriteStatement(supply, placeholders)
		const built = build(supply)
		return {
			built,
			params: Object.freeze([...placeholders.slots]),
			sql: emitText(built.ast, supply.map())
		}
	}
	let made: Made<B>
	if (sharing.kind === "own") {
		made = make()
	} else {
		let node = sharing.memo
		for (const part of [w.names, w.start.relation, w.start.column, ...sharing.key]) {
			const known = node.next.get(part)
			if (known === undefined) {
				const fresh = unshared<Made<B>>()
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

/** Whether a field is declared a serial generation request. */
export const isSerialField = (field: LawField): boolean => "serial" in field.type

/** The value type of a stored field as rows carry it: the serial generation flag dropped. */
export const rowType = (field: LawField): ScalarType => withoutSerial(field.type)

/** The heading of a relation's facts over `fields`, serial generation flags dropped. */
export const factHeading = (fields: ReadonlyArray<LawField>): Heading =>
	fields.map((f) => ({ name: f.name, type: rowType(f) }))

/** A type with every refinement dropped: a contract's base and unrefined text, the typmod kept. Its PostgreSQL type is
 * the base type with its typmod (LowerContext baseTypeRef), the type a deletion compares a member as against stored
 * facts (`CastInto` "compare"): a value outside a domain matches no fact instead of raising its check.
 * A text base is always built with the text carrier's own capabilities (`scalarAt`), so its
 * unrefined type is exactly the wildcard text. */
export const unrefined = (t: ScalarType): ScalarType => {
	const base = withoutSerial(baseOf(t))
	return base.carrier === "text" ? wildcardText : base
}

/** The heading a deletion compares a relation's facts as over `fields`: each field's unrefined type. */
export const compareHeading = (fields: ReadonlyArray<LawField>): Heading =>
	fields.map((f) => ({ name: f.name, type: unrefined(rowType(f)) }))

/** A value as its exact result text (codec resultTextCasts): money through numeric. */
export const resultText = (e: Expr, type: ScalarType): Expr =>
	resultTextCasts(type).reduce<Expr>(
		(acc, t) => cast(acc, t === "numeric" ? types.numeric : types.text),
		e
	)

/** The SQL type of an input column: its scalar type, and the PostgreSQL type its SQL expression has when the input
 * fixes it (a recordset's base type, a carrier's column type). A described member's lowering fixes none: a stored
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
	to: ScalarType,
	at: string
): Expr => {
	const target = w.cx.typeRef(to, at)
	if (from.sqlType !== undefined) {
		return printType(from.sqlType) === printType(target) ? value : cast(value, target)
	}
	const sameBase = printType(w.cx.baseTypeRef(from.type)) === printType(w.cx.baseTypeRef(to))
	return isDomain(to) || !sameBase ? cast(value, target) : value
}

const isDomain = (t: ScalarType): boolean =>
	contractOf(t) !== undefined || (t.carrier === "text" && t.text.regex !== "wildcard")
