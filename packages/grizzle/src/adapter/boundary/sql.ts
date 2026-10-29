import { Array as Arr, Option, Schema, SchemaGetter } from "effect"
import {
	type AlterDatabaseDefault,
	type AlterDefaultPrivileges,
	type AlterDomain,
	type AlterDomainAction,
	type AlterEnumAddValue,
	type AlterEnumRenameValue,
	type AlterRole,
	type AlterRoleAction,
	type AlterTable,
	type AlterTableAction,
	type Analyze,
	type Assignment,
	binaryOperators,
	builtinFunctionNames,
	builtinTypeNames,
	type Call,
	type Collation,
	type ColumnDef,
	type ColumnDefinition,
	type ColumnGeneration,
	type Comment,
	type CommentTarget,
	type ConflictAction,
	type ContextColumn,
	type CountStar,
	type CreateCarrier,
	type CreateConstraintTrigger,
	type CreateDomain,
	type CreateEnum,
	type CreateExtension,
	type CreateFunction,
	type CreateGuardTrigger,
	type CreateIndex,
	type CreateMaterializedView,
	type CreatePolicy,
	type CreateRole,
	type CreateSchema,
	type CreateStatistics,
	type CreateTable,
	type CreateView,
	type Cte,
	type CteBody,
	columnPrivileges,
	configurationParameters,
	type Ddl,
	type Delete,
	type DomainConstraint,
	type DoNothing,
	type DropFunction,
	type DropIndex,
	type DropObject,
	type DropPolicy,
	type DropTrigger,
	type ExclusionElement,
	type Expr,
	type FiniteFloat,
	type ForeignKeyColumn,
	type FrameBound,
	type FromItem,
	type RecordsetPlaceholder,
	type FunctionCall,
	type FunctionName,
	type FunctionRef,
	floatSpecials,
	type Grant,
	type GrantColumns,
	type Grantee,
	type GrantObjects,
	type GrantRole,
	type IndexKey,
	type InlineConstraint,
	type Insert,
	type InsertSource,
	type KeyColumn,
	type LiteralValue,
	type LockTable,
	type Merge,
	type MergeWhen,
	type ObjectName,
	type OnConflict,
	type OrderItem,
	type PlBlock,
	type PlDeclaration,
	type PlRecord,
	type PlStatement,
	type PrimaryKey,
	privileges,
	type QualifiedFunctionRef,
	type RaiseOption,
	type Refresh,
	type RenameColumn,
	type RenameConstraint,
	type RenameObject,
	type Revoke,
	type RevokeRole,
	type Select,
	type SelectBody,
	type SelectCore,
	type SetOperation,
	type SqlStatement,
	type TableConstraint,
	type TableName,
	type Target,
	type TriggerEvent,
	type Txn,
	type TypeRef,
	type Update,
	type ValuePlaceholder,
	type WindowSpec,
	type With
} from "#compiler/sql/ast.ts"
import { isFiniteFloat } from "#compiler/sql/build.ts"
import { type CarrierName, isCarrierName } from "#compiler/sql/naming.ts"

/**
 * A codec of exactly the AST type T: every value it decodes is a T, and every T is a value it encodes. A codec that
 * drifts from the AST either way does not typecheck.
 */
const exact =
	<T>() =>
	<S extends Schema.Codec<T, unknown>>(
		schema: S & ([T] extends [S["Type"]] ? unknown : never)
	): Schema.Codec<T, unknown> =>
		schema

const Ident = Schema.String
const Idents = Schema.Array(Ident)
const True = Schema.Literal(true)

/**
 * The JSON form a key holds before its value is decoded: anything, and for a list a nonempty one. The value's own schema
 * decodes it once, after the absence is read.
 */
const Present = Schema.Unknown
const PresentList = Schema.NonEmptyArray(Schema.Unknown)

/** A list clause: left out of the JSON form when empty. */
const list = <T>(item: Schema.Codec<T, unknown>) =>
	Schema.optionalKey(PresentList).pipe(
		Schema.decodeTo(Schema.Array(item), {
			decode: SchemaGetter.transformOptional((o) => Option.some(Option.getOrElse(o, () => []))),
			encode: SchemaGetter.transformOptional((o) => Option.filter(o, Arr.isReadonlyArrayNonEmpty))
		})
	)

/** A flag: written out only when true. */
const flag = Schema.optionalKey(True).pipe(
	Schema.decodeTo(Schema.Boolean, {
		decode: SchemaGetter.transformOptional((o) => Option.some(Option.isSome(o))),
		encode: SchemaGetter.transformOptional((o) =>
			Option.isSome(o) && o.value ? Option.some(true as const) : Option.none()
		)
	})
)

/** A single clause: left out of the JSON form when undefined. */
const maybe = <T>(clause: Schema.Codec<T, unknown>) =>
	Schema.optionalKey(Present).pipe(
		Schema.decodeTo(Schema.UndefinedOr(clause), {
			decode: SchemaGetter.transformOptional((o) => Option.some(Option.getOrUndefined(o))),
			encode: SchemaGetter.transformOptional((o) => Option.flatMap(o, Option.fromUndefinedOr))
		})
	)

/** A key no value of the variant writes: always left out, and undefined once decoded. */
const noKey = Schema.optionalKey(Schema.Never).pipe(
	Schema.decodeTo(Schema.Undefined, {
		decode: SchemaGetter.transformOptional(() => Option.some(undefined)),
		encode: SchemaGetter.transformOptional(() => Option.none())
	})
)

/** A flag no value of the variant sets: always left out, and false once decoded. */
const unset = Schema.optionalKey(Schema.Never).pipe(
	Schema.decodeTo(Schema.Literal(false), {
		decode: SchemaGetter.transformOptional(() => Option.some(false as const)),
		encode: SchemaGetter.transformOptional(() => Option.none())
	})
)

/** An order direction: DESC written out, ASC, the default, left out. */
const direction = Schema.optionalKey(Schema.Literal("DESC")).pipe(
	Schema.decodeTo(Schema.Literals(["ASC", "DESC"]), {
		decode: SchemaGetter.transformOptional((o) =>
			Option.some(Option.getOrElse(o, () => "ASC" as const))
		),
		encode: SchemaGetter.transformOptional((o) => Option.filter(o, (d) => d === "DESC"))
	})
)

/** A function's parallel safety: SAFE written out, UNSAFE, PostgreSQL's default, left out. */
const parallelSafety = Schema.optionalKey(Schema.Literal("SAFE")).pipe(
	Schema.decodeTo(Schema.Literals(["SAFE", "UNSAFE"]), {
		decode: SchemaGetter.transformOptional((o) =>
			Option.some(Option.getOrElse(o, () => "UNSAFE" as const))
		),
		encode: SchemaGetter.transformOptional((o) => Option.filter(o, (p) => p === "SAFE"))
	})
)

/**
 * Effect Schemas of the SQL AST (sql/ast.ts), for a statement written to and read from outside the process: the DDL a
 * committed snapshot.json records (deploy/snapshot/build.ts writeSnapshot and readSnapshot). Each schema is built by
 * exact from the AST type it decodes to, so the two cannot drift apart: a schema whose type side is not exactly the
 * AST's, narrower or wider, does not typecheck. A statement as the compiler holds it, every clause stated, is the type
 * side (Schema.toType); the JSON form is the encoded side.
 *
 * The JSON form leaves out every clause that is none: an empty list, a false flag, an undefined clause, and the
 * default ascending order. Decoding states each one again and encoding leaves it out, so a statement has exactly one
 * JSON spelling: the form refuses an empty list or a false flag written out. Every other value is admitted and used as
 * it is.
 */
const ObjectNameSchema = exact<ObjectName>()(Schema.Struct({ schema: Ident, name: Ident }))
const ObjectNames = Schema.Array(ObjectNameSchema)

const CarrierNameSchema: Schema.Codec<CarrierName> = Schema.declare(isCarrierName)

const TableNameSchema = exact<TableName>()(Schema.Union([ObjectNameSchema, CarrierNameSchema]))

const CollationSchema = exact<Collation>()(
	Schema.Struct({
		schema: Schema.Literal("pg_catalog"),
		name: Schema.Literal("pg_c_utf8")
	})
)

const TypeRefSchema = exact<TypeRef>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("builtin"),
			name: Schema.Literals(builtinTypeNames),
			precision: noKey,
			scale: noKey,
			array: flag
		}),
		Schema.Struct({
			kind: Schema.Literal("builtin"),
			name: Schema.Literal("numeric"),
			precision: Schema.Finite,
			scale: maybe(Schema.Finite),
			array: flag
		}),
		Schema.Struct({
			kind: Schema.Literal("named"),
			schema: Ident,
			name: Ident,
			typmod: list(Schema.Finite),
			array: flag
		})
	])
)

const FiniteFloatSchema: Schema.Codec<FiniteFloat> = Schema.declare(isFiniteFloat)

const LiteralValueSchema = exact<LiteralValue>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("bool"), value: Schema.Boolean }),
		Schema.Struct({ kind: Schema.Literal("int"), value: Schema.BigInt }),
		Schema.Struct({ kind: Schema.Literal("decimal"), value: Schema.String }),
		Schema.Struct({ kind: Schema.Literal("float"), value: FiniteFloatSchema }),
		Schema.Struct({ kind: Schema.Literal("floatSpecial"), value: Schema.Literals(floatSpecials) }),
		Schema.Struct({ kind: Schema.Literal("text"), value: Schema.String })
	])
)

const QualifiedFunctionRefSchema = exact<QualifiedFunctionRef>()(
	Schema.Struct({ kind: Schema.Literal("qualified"), schema: Ident, name: Ident })
)

const FunctionRefSchema = exact<FunctionRef>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("builtin"), name: Schema.Literals(builtinFunctionNames) }),
		QualifiedFunctionRefSchema
	])
)

/** The recursive forms are reached through suspend, each typed by its AST type. */
const ExprRef: Schema.Codec<Expr, unknown> = Schema.suspend(
	(): Schema.Codec<Expr, unknown> => ExprSchema
)

const SelectRef: Schema.Codec<Select, unknown> = Schema.suspend(
	(): Schema.Codec<Select, unknown> => SelectSchema
)

const FromItemRef: Schema.Codec<FromItem, unknown> = Schema.suspend(
	(): Schema.Codec<FromItem, unknown> => FromItemSchema
)

const SelectBodyRef: Schema.Codec<SelectBody, unknown> = Schema.suspend(
	(): Schema.Codec<SelectBody, unknown> => SelectBodySchema
)

const CteBodyRef: Schema.Codec<CteBody, unknown> = Schema.suspend(
	(): Schema.Codec<CteBody, unknown> => CteBodySchema
)

const PlStatementRef: Schema.Codec<PlStatement, unknown> = Schema.suspend(
	(): Schema.Codec<PlStatement, unknown> => PlStatementSchema
)

const Exprs = Schema.Array(ExprRef)

const OrderItemSchema = exact<OrderItem>()(
	Schema.Struct({
		expr: ExprRef,
		direction
	})
)

const FrameBoundSchema = exact<FrameBound>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("unboundedPreceding") }),
		Schema.Struct({ kind: Schema.Literal("currentRow") }),
		Schema.Struct({ kind: Schema.Literal("unboundedFollowing") }),
		Schema.Struct({
			kind: Schema.Literal("offset"),
			offset: Schema.BigInt,
			direction: Schema.Literals(["PRECEDING", "FOLLOWING"])
		})
	])
)

const WindowSpecSchema = exact<WindowSpec>()(
	Schema.Struct({
		partitionBy: list(ExprRef),
		orderBy: list(OrderItemSchema),
		frame: maybe(Schema.Struct({ start: FrameBoundSchema, end: FrameBoundSchema }))
	})
)

const CountStarSchema = exact<CountStar>()(
	Schema.Struct({
		kind: Schema.Literal("call"),
		fn: Schema.Struct({ kind: Schema.Literal("builtin"), name: Schema.Literal("count") }),
		args: Schema.Tuple([]),
		star: True,
		filter: maybe(ExprRef),
		over: maybe(WindowSpecSchema)
	})
)

const CallSchema = exact<Call>()(
	Schema.Struct({
		kind: Schema.Literal("call"),
		fn: FunctionRefSchema,
		args: Exprs,
		star: unset,
		distinct: flag,
		orderBy: list(OrderItemSchema),
		withinGroup: list(OrderItemSchema),
		over: maybe(WindowSpecSchema)
	})
)

const FunctionCallSchema = exact<FunctionCall>()(Schema.Union([CountStarSchema, CallSchema]))

const PlRecordSchema = exact<PlRecord>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("plVar"), name: Ident }),
		Schema.Struct({ kind: Schema.Literal("plSpecial"), name: Schema.Literals(["NEW", "OLD"]) })
	])
)

/** A value placeholder, written as its number, the form's `index`. */
const ValuePlaceholderSchema = exact<ValuePlaceholder>()(
	Schema.Finite.pipe(
		Schema.decodeTo(
			Schema.Struct({ placeholder: Schema.Literal("value"), number: Schema.Finite }),
			{
				decode: SchemaGetter.transform((number: number) => ({
					placeholder: "value" as const,
					number
				})),
				encode: SchemaGetter.transform((placeholder: ValuePlaceholder) => placeholder.number)
			}
		)
	)
)

/** The jsonb cast of a recordset's placeholder, the one type its form writes. */
const JsonbForm = Schema.Struct({ kind: Schema.Literal("builtin"), name: Schema.Literal("jsonb") })

/** A recordset's placeholder, written as the form's jsonb parameter of its number. */
const RecordsetPlaceholderSchema = exact<RecordsetPlaceholder>()(
	Schema.Struct({ kind: Schema.Literal("param"), index: Schema.Finite, type: JsonbForm }).pipe(
		Schema.decodeTo(
			Schema.Struct({ placeholder: Schema.Literal("recordset"), number: Schema.Finite }),
			{
				decode: SchemaGetter.transform(
					({ index }: { readonly index: number }): RecordsetPlaceholder => ({
						placeholder: "recordset",
						number: index
					})
				),
				encode: SchemaGetter.transform(({ number }: RecordsetPlaceholder) => ({
					kind: "param" as const,
					index: number,
					type: { kind: "builtin" as const, name: "jsonb" as const }
				}))
			}
		)
	)
)

const ExprSchema = exact<Expr>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("column"), table: maybe(Ident), column: Ident }),
		Schema.Struct({ kind: Schema.Literal("excluded"), column: Ident }),
		Schema.Struct({
			kind: Schema.Literal("returning"),
			side: Schema.Literals(["old", "new"]),
			column: Ident
		}),
		Schema.Struct({
			kind: Schema.Literal("param"),
			slot: ValuePlaceholderSchema,
			type: TypeRefSchema
		}).pipe(Schema.encodeKeys({ slot: "index" })),
		Schema.Struct({
			kind: Schema.Literal("literal"),
			value: LiteralValueSchema,
			type: TypeRefSchema
		}),
		Schema.Struct({ kind: Schema.Literal("cast"), expr: ExprRef, type: TypeRefSchema }),
		Schema.Struct({ kind: Schema.Literal("collate"), expr: ExprRef, collation: CollationSchema }),
		Schema.Struct({
			kind: Schema.Literal("binary"),
			op: Schema.Literals(binaryOperators),
			left: ExprRef,
			right: ExprRef,
			schema: maybe(Ident)
		}),
		Schema.Struct({ kind: Schema.Literal("negate"), expr: ExprRef }),
		Schema.Struct({ kind: Schema.Literal("and"), args: Exprs }),
		Schema.Struct({ kind: Schema.Literal("or"), args: Exprs }),
		Schema.Struct({ kind: Schema.Literal("not"), expr: ExprRef }),
		Schema.Struct({ kind: Schema.Literal("isTrue"), expr: ExprRef }),
		Schema.Struct({
			kind: Schema.Literal("between"),
			expr: ExprRef,
			low: ExprRef,
			high: ExprRef,
			not: flag
		}),
		Schema.Struct({ kind: Schema.Literal("inList"), expr: ExprRef, list: Exprs, not: flag }),
		Schema.Struct({ kind: Schema.Literal("inQuery"), expr: ExprRef, query: SelectRef, not: flag }),
		Schema.Struct({ kind: Schema.Literal("exists"), query: SelectRef, not: flag }),
		Schema.Struct({ kind: Schema.Literal("subquery"), query: SelectRef }),
		Schema.Struct({ kind: Schema.Literal("array"), query: SelectRef }),
		Schema.Struct({ kind: Schema.Literal("row"), items: Exprs }),
		Schema.Struct({
			kind: Schema.Literal("case"),
			operand: maybe(ExprRef),
			whens: Schema.NonEmptyArray(Schema.Struct({ when: ExprRef, result: ExprRef })),
			else: ExprRef
		}),
		FunctionCallSchema,
		Schema.Struct({ kind: Schema.Literals(["greatest", "least"]), args: Exprs }),
		Schema.Struct({ kind: Schema.Literal("mergeAction") }),
		Schema.Struct({ kind: Schema.Literal("domainValue") }),
		Schema.Struct({
			kind: Schema.Literal("user"),
			name: Schema.Literals(["CURRENT_USER", "SESSION_USER"])
		}),
		PlRecordSchema,
		Schema.Struct({
			kind: Schema.Literal("plSpecial"),
			name: Schema.Literals(["TG_OP", "TG_TABLE_NAME", "TG_TABLE_SCHEMA", "FOUND"])
		}),
		Schema.Struct({ kind: Schema.Literal("field"), record: PlRecordSchema, field: Ident })
	])
)

const TargetSchema = exact<Target>()(Schema.Struct({ expr: ExprRef, alias: maybe(Ident) }))
const Targets = Schema.Array(TargetSchema)

const ColumnDefinitionSchema = exact<ColumnDefinition>()(
	Schema.Struct({
		name: Ident,
		type: TypeRefSchema,
		collation: maybe(CollationSchema)
	})
)

const ContextColumnSchema = exact<ContextColumn>()(
	Schema.Struct({ field: Schema.String, column: ColumnDefinitionSchema })
)

const FromItemSchema = exact<FromItem>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("table"), table: TableNameSchema, alias: Ident }),
		Schema.Struct({ kind: Schema.Literal("cte"), name: Ident, alias: maybe(Ident) }),
		Schema.Struct({ kind: Schema.Literal("enclosing"), name: Ident, alias: Ident }),
		Schema.Struct({
			kind: Schema.Literal("derived"),
			query: SelectRef,
			alias: Ident,
			columns: Idents,
			lateral: flag
		}),
		Schema.Struct({
			kind: Schema.Literal("function"),
			call: CallSchema,
			alias: Ident,
			columns: Idents,
			lateral: flag
		}),
		Schema.Struct({
			kind: Schema.Literal("recordset"),
			source: RecordsetPlaceholderSchema,
			alias: Ident,
			columns: Schema.Array(ColumnDefinitionSchema)
		}),
		Schema.Struct({
			kind: Schema.Literal("values"),
			rows: Schema.Array(Exprs),
			alias: Ident,
			columns: Idents
		}),
		Schema.Struct({
			kind: Schema.Literal("context"),
			context: Schema.String,
			columns: Schema.NonEmptyArray(ContextColumnSchema),
			refusal: QualifiedFunctionRefSchema,
			alias: Ident
		}),
		Schema.Struct({
			kind: Schema.Literal("join"),
			left: FromItemRef,
			right: FromItemRef,
			on: ExprRef
		}),
		Schema.Struct({ kind: Schema.Literal("crossJoin"), left: FromItemRef, right: FromItemRef })
	])
)
/** Whether a clause that is false when none is set. */
const isSet = <A>(d: false | A): d is A => d !== false

/** DISTINCT, DISTINCT ON its expressions, or neither: false, left out of the JSON form. */
const distinct = Schema.optionalKey(
	Schema.Union([True, Schema.Struct({ on: Schema.Array(Present) })])
).pipe(
	Schema.decodeTo(Schema.Union([Schema.Boolean, Schema.Struct({ on: Exprs })]), {
		decode: SchemaGetter.transformOptional((o) => Option.some(Option.getOrElse(o, () => false))),
		encode: SchemaGetter.transformOptional((o) => Option.filter(o, isSet))
	})
)

const SelectCoreSchema = exact<SelectCore>()(
	Schema.Struct({
		kind: Schema.Literal("core"),
		distinct,
		targets: Targets,
		from: list(FromItemRef),
		where: maybe(ExprRef),
		groupBy: list(ExprRef),
		having: maybe(ExprRef)
	})
)

const SetOperationSchema = exact<SetOperation>()(
	Schema.Struct({
		kind: Schema.Literal("setOp"),
		op: Schema.Literals(["UNION", "UNION ALL", "INTERSECT", "EXCEPT"]),
		left: SelectBodyRef,
		right: SelectBodyRef
	})
)

const SelectBodySchema = exact<SelectBody>()(
	Schema.Union([SelectCoreSchema, SetOperationSchema, SelectRef])
)

const CteSchema = exact<Cte>()(
	Schema.Struct({
		name: Ident,
		columns: list(Ident),
		materialized: maybe(Schema.Literals(["MATERIALIZED", "NOT MATERIALIZED"])),
		query: CteBodyRef
	})
)

const WithSchema = exact<With>()(Schema.Struct({ recursive: flag, ctes: Schema.Array(CteSchema) }))

const SelectSchema = exact<Select>()(
	Schema.Struct({
		kind: Schema.Literal("select"),
		with: maybe(WithSchema),
		body: SelectBodyRef,
		orderBy: list(OrderItemSchema),
		limit: maybe(ExprRef),
		offset: maybe(ExprRef)
	})
)

const AssignmentSchema = exact<Assignment>()(Schema.Struct({ column: Ident, value: ExprRef }))
const Assignments = Schema.Array(AssignmentSchema)

const DoNothingSchema = exact<DoNothing>()(Schema.Struct({ kind: Schema.Literal("doNothing") }))

const ConflictActionSchema = exact<ConflictAction>()(
	Schema.Union([
		DoNothingSchema,
		Schema.Struct({
			kind: Schema.Literal("doSelect"),
			where: maybe(ExprRef)
		}),
		Schema.Struct({ kind: Schema.Literal("doUpdate"), set: Assignments, where: maybe(ExprRef) })
	])
)

const OnConflictSchema = exact<OnConflict>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("columns"),
			columns: Idents,
			action: ConflictActionSchema
		}),
		Schema.Struct({
			kind: Schema.Literal("constraint"),
			constraint: Ident,
			action: DoNothingSchema
		})
	])
)

const InsertSourceSchema = exact<InsertSource>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("query"), query: SelectRef }),
		Schema.Struct({ kind: Schema.Literal("values"), rows: Schema.Array(Exprs) })
	])
)

const InsertSchema = exact<Insert>()(
	Schema.Struct({
		kind: Schema.Literal("insert"),
		with: maybe(WithSchema),
		table: TableNameSchema,
		alias: maybe(Ident),
		columns: Idents,
		overriding: maybe(Schema.Literals(["SYSTEM VALUE", "USER VALUE"])),
		source: InsertSourceSchema,
		onConflict: maybe(OnConflictSchema),
		returning: list(TargetSchema)
	})
)

const UpdateSchema = exact<Update>()(
	Schema.Struct({
		kind: Schema.Literal("update"),
		with: maybe(WithSchema),
		table: ObjectNameSchema,
		alias: Ident,
		set: Assignments,
		from: list(FromItemRef),
		where: maybe(ExprRef),
		returning: list(TargetSchema)
	})
)

const DeleteSchema = exact<Delete>()(
	Schema.Struct({
		kind: Schema.Literal("delete"),
		with: maybe(WithSchema),
		table: TableNameSchema,
		alias: Ident,
		using: list(FromItemRef),
		where: maybe(ExprRef),
		returning: list(TargetSchema)
	})
)

const MergeWhenSchema = exact<MergeWhen>()(
	Schema.Union([
		Schema.Struct({
			match: Schema.Literals(["MATCHED", "NOT MATCHED BY SOURCE"]),
			condition: maybe(ExprRef),
			action: Schema.Union([
				Schema.Struct({ kind: Schema.Literal("update"), set: Assignments }),
				Schema.Struct({ kind: Schema.Literal("delete") }),
				DoNothingSchema
			])
		}),
		Schema.Struct({
			match: Schema.Literal("NOT MATCHED"),
			condition: maybe(ExprRef),
			action: Schema.Union([
				Schema.Struct({
					kind: Schema.Literal("insert"),
					overriding: maybe(Schema.Literal("SYSTEM VALUE")),
					row: Assignments
				}),
				DoNothingSchema
			])
		})
	])
)

const MergeSchema = exact<Merge>()(
	Schema.Struct({
		kind: Schema.Literal("merge"),
		with: maybe(WithSchema),
		table: ObjectNameSchema,
		alias: Ident,
		using: FromItemRef,
		on: ExprRef,
		whens: Schema.NonEmptyArray(MergeWhenSchema),
		returning: list(TargetSchema)
	})
)

const CteBodySchema = exact<CteBody>()(
	Schema.Union([SelectRef, InsertSchema, UpdateSchema, DeleteSchema, MergeSchema])
)

const ColumnGenerationSchema = exact<ColumnGeneration>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("identity"), sequence: ObjectNameSchema }),
		Schema.Struct({ kind: Schema.Literal("stored"), expr: ExprRef })
	])
)

const ColumnDefSchema = exact<ColumnDef>()(
	Schema.Struct({
		name: Ident,
		type: TypeRefSchema,
		collation: maybe(CollationSchema),
		generated: maybe(ColumnGenerationSchema),
		default: maybe(ExprRef)
	})
)

const KeyColumnSchema = exact<KeyColumn>()(
	Schema.Struct({
		column: Ident,
		withoutOverlaps: flag
	})
)

const ForeignKeyColumnSchema = exact<ForeignKeyColumn>()(
	Schema.Struct({
		column: Ident,
		period: flag
	})
)

const ExclusionElementSchema = exact<ExclusionElement>()(
	Schema.Struct({
		column: Ident,
		operator: Schema.Literal("&&")
	})
)

const PrimaryKeySchema = exact<PrimaryKey>()(
	Schema.Struct({
		kind: Schema.Literal("primaryKey"),
		name: Ident,
		columns: Schema.Array(KeyColumnSchema)
	})
)

const InlineConstraintSchema = exact<InlineConstraint>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("unique"),
			name: Ident,
			columns: Schema.Array(KeyColumnSchema)
		}),
		Schema.Struct({ kind: Schema.Literal("check"), name: Ident, predicate: ExprRef }),
		Schema.Struct({
			kind: Schema.Literal("exclude"),
			name: Ident,
			method: Schema.Literal("gist"),
			elements: Schema.Array(ExclusionElementSchema)
		})
	])
)

const TableConstraintSchema = exact<TableConstraint>()(
	Schema.Union([
		PrimaryKeySchema,
		InlineConstraintSchema,
		Schema.Struct({
			kind: Schema.Literal("foreignKey"),
			name: Ident,
			columns: Schema.Array(ForeignKeyColumnSchema),
			references: ObjectNameSchema,
			referencedColumns: Schema.Array(ForeignKeyColumnSchema),
			deferrable: maybe(Schema.Literals(["INITIALLY DEFERRED", "INITIALLY IMMEDIATE"]))
		})
	])
)

const CreateSchemaSchema = exact<CreateSchema>()(
	Schema.Struct({
		kind: Schema.Literal("createSchema"),
		name: Ident,
		authorization: maybe(Ident)
	})
)

const CreateTableSchema = exact<CreateTable>()(
	Schema.Struct({
		kind: Schema.Literal("createTable"),
		table: ObjectNameSchema,
		columns: Schema.NonEmptyArray(ColumnDefSchema),
		primaryKey: PrimaryKeySchema,
		secondary: Schema.Array(InlineConstraintSchema)
	})
)

const AlterTableActionSchema = exact<AlterTableAction>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("addColumn"), column: ColumnDefSchema }),
		Schema.Struct({ kind: Schema.Literal("dropColumn"), column: Ident }),
		Schema.Struct({ kind: Schema.Literal("dropDefault"), column: Ident }),
		Schema.Struct({
			kind: Schema.Literal("alterColumnType"),
			column: Ident,
			type: TypeRefSchema,
			collation: maybe(CollationSchema),
			using: ExprRef
		}),
		Schema.Struct({
			kind: Schema.Literal("addIdentity"),
			column: Ident,
			sequence: ObjectNameSchema
		}),
		Schema.Struct({ kind: Schema.Literal("dropIdentity"), column: Ident }),
		Schema.Struct({
			kind: Schema.Literal("addConstraint"),
			constraint: TableConstraintSchema,
			notValid: flag
		}),
		Schema.Struct({
			kind: Schema.Literal("addConstraintUsingIndex"),
			name: Ident,
			constraint: Schema.Literals(["PRIMARY KEY", "UNIQUE"]),
			index: Ident
		}),
		Schema.Struct({ kind: Schema.Literal("validateConstraint"), name: Ident }),
		Schema.Struct({ kind: Schema.Literal("dropConstraint"), name: Ident }),
		Schema.Struct({ kind: Schema.Literal("enableRowSecurity") }),
		Schema.Struct({ kind: Schema.Literal("disableRowSecurity") })
	])
)

const AlterTableSchema = exact<AlterTable>()(
	Schema.Struct({
		kind: Schema.Literal("alterTable"),
		table: ObjectNameSchema,
		actions: Schema.NonEmptyArray(AlterTableActionSchema)
	})
)

const RenameObjectSchema = exact<RenameObject>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("rename"),
			object: Schema.Literals([
				"TABLE",
				"INDEX",
				"MATERIALIZED VIEW",
				"TYPE",
				"DOMAIN",
				"SEQUENCE",
				"STATISTICS"
			]),
			name: ObjectNameSchema,
			to: Ident
		}),
		Schema.Struct({
			kind: Schema.Literal("rename"),
			object: Schema.Literal("ROLE"),
			name: Ident,
			to: Ident
		}),
		Schema.Struct({
			kind: Schema.Literal("rename"),
			object: Schema.Literal("SCHEMA"),
			name: Ident,
			to: Ident
		})
	])
)

const RenameColumnSchema = exact<RenameColumn>()(
	Schema.Struct({
		kind: Schema.Literal("renameColumn"),
		table: ObjectNameSchema,
		from: Ident,
		to: Ident
	})
)

const RenameConstraintSchema = exact<RenameConstraint>()(
	Schema.Struct({
		kind: Schema.Literal("renameConstraint"),
		table: ObjectNameSchema,
		from: Ident,
		to: Ident
	})
)

const DomainConstraintSchema = exact<DomainConstraint>()(
	Schema.Struct({
		name: Ident,
		predicate: ExprRef
	})
)

const CreateDomainSchema = exact<CreateDomain>()(
	Schema.Struct({
		kind: Schema.Literal("createDomain"),
		name: ObjectNameSchema,
		base: TypeRefSchema,
		collation: maybe(CollationSchema),
		constraints: Schema.Array(DomainConstraintSchema)
	})
)

const AlterDomainActionSchema = exact<AlterDomainAction>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("addConstraint"),
			constraint: DomainConstraintSchema,
			notValid: flag
		}),
		Schema.Struct({ kind: Schema.Literal("validateConstraint"), name: Ident }),
		Schema.Struct({ kind: Schema.Literal("dropConstraint"), name: Ident })
	])
)

const AlterDomainSchema = exact<AlterDomain>()(
	Schema.Struct({
		kind: Schema.Literal("alterDomain"),
		name: ObjectNameSchema,
		action: AlterDomainActionSchema
	})
)

const CreateEnumSchema = exact<CreateEnum>()(
	Schema.Struct({
		kind: Schema.Literal("createEnum"),
		name: ObjectNameSchema,
		labels: Schema.Array(Schema.String)
	})
)

const AlterEnumAddValueSchema = exact<AlterEnumAddValue>()(
	Schema.Struct({
		kind: Schema.Literal("alterEnumAddValue"),
		name: ObjectNameSchema,
		label: Schema.String,
		ifNotExists: flag,
		position: maybe(
			Schema.Struct({ kind: Schema.Literals(["BEFORE", "AFTER"]), label: Schema.String })
		)
	})
)

const AlterEnumRenameValueSchema = exact<AlterEnumRenameValue>()(
	Schema.Struct({
		kind: Schema.Literal("alterEnumRenameValue"),
		name: ObjectNameSchema,
		from: Schema.String,
		to: Schema.String
	})
)

const IndexKeySchema = exact<IndexKey>()(
	Schema.Struct({
		key: Schema.Union([
			Schema.Struct({ kind: Schema.Literal("column"), column: Ident }),
			Schema.Struct({ kind: Schema.Literal("expr"), expr: ExprRef })
		]),
		collation: maybe(CollationSchema),
		opclass: maybe(ObjectNameSchema),
		direction
	})
)

const CreateIndexSchema = exact<CreateIndex>()(
	Schema.Struct({
		kind: Schema.Literal("createIndex"),
		name: Ident,
		table: ObjectNameSchema,
		unique: flag,
		concurrently: flag,
		method: Schema.Literals(["btree", "gist", "hnsw"]),
		keys: Schema.Array(IndexKeySchema),
		include: list(Ident),
		where: maybe(ExprRef)
	})
)

const DropIndexSchema = exact<DropIndex>()(
	Schema.Struct({
		kind: Schema.Literal("dropIndex"),
		name: ObjectNameSchema,
		concurrently: flag,
		ifExists: flag
	})
)

const CreateMaterializedViewSchema = exact<CreateMaterializedView>()(
	Schema.Struct({
		kind: Schema.Literal("createMaterializedView"),
		name: ObjectNameSchema,
		columns: Idents,
		query: SelectRef
	})
)

const CreateViewSchema = exact<CreateView>()(
	Schema.Struct({
		kind: Schema.Literal("createView"),
		name: ObjectNameSchema,
		columns: Schema.NonEmptyArray(Ident),
		barrier: Schema.Boolean,
		query: SelectRef
	})
)

const CreatePolicySchema = exact<CreatePolicy>()(
	Schema.Struct({
		kind: Schema.Literal("createPolicy"),
		name: Ident,
		table: ObjectNameSchema,
		role: Ident,
		filter: ExprRef
	})
)

const DropPolicySchema = exact<DropPolicy>()(
	Schema.Struct({
		kind: Schema.Literal("dropPolicy"),
		name: Ident,
		table: ObjectNameSchema
	})
)

const DropObjectSchema = exact<DropObject>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("drop"),
			object: Schema.Literals(["TABLE", "MATERIALIZED VIEW", "VIEW", "TYPE", "DOMAIN", "SEQUENCE"]),
			name: ObjectNameSchema,
			ifExists: flag
		}),
		Schema.Struct({
			kind: Schema.Literal("drop"),
			object: Schema.Literal("ROLE"),
			name: Ident,
			ifExists: flag
		}),
		Schema.Struct({
			kind: Schema.Literal("drop"),
			object: Schema.Literal("SCHEMA"),
			name: Ident,
			ifExists: flag
		})
	])
)

const FunctionNameSchema = exact<FunctionName>()(
	Schema.Struct({
		schema: Ident,
		name: Ident,
		args: Schema.Array(TypeRefSchema)
	})
)

const DropFunctionSchema = exact<DropFunction>()(
	Schema.Struct({
		kind: Schema.Literal("dropFunction"),
		name: FunctionNameSchema,
		ifExists: flag
	})
)

const DropTriggerSchema = exact<DropTrigger>()(
	Schema.Struct({
		kind: Schema.Literal("dropTrigger"),
		name: Ident,
		table: ObjectNameSchema,
		ifExists: flag
	})
)

const TriggerEventSchema = exact<TriggerEvent>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("INSERT") }),
		Schema.Struct({ kind: Schema.Literal("DELETE") }),
		Schema.Struct({ kind: Schema.Literal("UPDATE"), of: Schema.NonEmptyArray(Ident) })
	])
)

const CreateConstraintTriggerSchema = exact<CreateConstraintTrigger>()(
	Schema.Struct({
		kind: Schema.Literal("createConstraintTrigger"),
		name: Ident,
		table: ObjectNameSchema,
		events: Schema.NonEmptyArray(TriggerEventSchema),
		function: ObjectNameSchema
	})
)

const CreateGuardTriggerSchema = exact<CreateGuardTrigger>()(
	Schema.Struct({
		kind: Schema.Literal("createGuardTrigger"),
		name: Ident,
		table: ObjectNameSchema,
		function: ObjectNameSchema
	})
)

const AlterDatabaseDefaultSchema = exact<AlterDatabaseDefault>()(
	Schema.Struct({
		kind: Schema.Literal("alterDatabaseDefault"),
		parameter: Schema.Literal("default_transaction_isolation"),
		value: Schema.Literal("serializable")
	})
)

const CreateRoleSchema = exact<CreateRole>()(
	Schema.Struct({
		kind: Schema.Literal("createRole"),
		name: Ident,
		login: Schema.Boolean
	})
)

const AlterRoleActionSchema = exact<AlterRoleAction>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("set"),
			parameter: Schema.Literals(configurationParameters),
			value: Schema.String
		}),
		Schema.Struct({
			kind: Schema.Literal("reset"),
			parameter: Schema.Literals(configurationParameters)
		})
	])
)

const AlterRoleSchema = exact<AlterRole>()(
	Schema.Struct({
		kind: Schema.Literal("alterRole"),
		name: Ident,
		action: AlterRoleActionSchema
	})
)

const GrantRoleSchema = exact<GrantRole>()(
	Schema.Struct({
		kind: Schema.Literal("grantRole"),
		role: Ident,
		to: Ident
	})
)

const RevokeRoleSchema = exact<RevokeRole>()(
	Schema.Struct({
		kind: Schema.Literal("revokeRole"),
		role: Ident,
		from: Ident
	})
)

const Privileges = Schema.Array(Schema.Literals(privileges))

const GrantObjectsSchema = exact<GrantObjects>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("TABLE"), names: ObjectNames }),
		Schema.Struct({ kind: Schema.Literal("SEQUENCE"), names: ObjectNames }),
		Schema.Struct({ kind: Schema.Literal("SCHEMA"), names: Idents }),
		Schema.Struct({ kind: Schema.Literal("TYPE"), names: ObjectNames }),
		Schema.Struct({ kind: Schema.Literal("DOMAIN"), names: ObjectNames }),
		Schema.Struct({ kind: Schema.Literal("FUNCTION"), names: Schema.Array(FunctionNameSchema) })
	])
)

const GranteeSchema = exact<Grantee>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("role"), name: Ident }),
		Schema.Struct({ kind: Schema.Literal("PUBLIC") })
	])
)
const Grantees = Schema.Array(GranteeSchema)

const GrantSchema = exact<Grant>()(
	Schema.Struct({
		kind: Schema.Literal("grant"),
		privileges: Privileges,
		on: GrantObjectsSchema,
		to: Grantees
	})
)

const RevokeSchema = exact<Revoke>()(
	Schema.Struct({
		kind: Schema.Literal("revoke"),
		privileges: Privileges,
		on: GrantObjectsSchema,
		from: Grantees
	})
)

const GrantColumnsSchema = exact<GrantColumns>()(
	Schema.Struct({
		kind: Schema.Literal("grantColumns"),
		privilege: Schema.Literals(columnPrivileges),
		table: ObjectNameSchema,
		columns: Schema.NonEmptyArray(Ident),
		to: Ident
	})
)

const AlterDefaultPrivilegesSchema = exact<AlterDefaultPrivileges>()(
	Schema.Struct({
		kind: Schema.Literal("alterDefaultPrivileges"),
		forRole: maybe(Ident),
		inSchema: maybe(Ident),
		privileges: Privileges,
		on: Schema.Literals(["TABLES", "SEQUENCES", "FUNCTIONS", "TYPES"]),
		from: Grantees
	})
)

const CreateExtensionSchema = exact<CreateExtension>()(
	Schema.Struct({
		kind: Schema.Literal("createExtension"),
		name: Ident,
		schema: Ident
	})
)

const CreateStatisticsSchema = exact<CreateStatistics>()(
	Schema.Struct({
		kind: Schema.Literal("createStatistics"),
		name: ObjectNameSchema,
		statistics: Schema.Array(Schema.Literals(["ndistinct", "dependencies", "mcv"])),
		columns: Idents,
		table: ObjectNameSchema
	})
)

const LockTableSchema = exact<LockTable>()(
	Schema.Struct({
		kind: Schema.Literal("lockTable"),
		tables: ObjectNames,
		mode: Schema.Literals([
			"ACCESS SHARE",
			"SHARE",
			"SHARE ROW EXCLUSIVE",
			"EXCLUSIVE",
			"ACCESS EXCLUSIVE"
		]),
		wait: Schema.Literals(["wait", "nowait"])
	})
)

const CommentTargetSchema = exact<CommentTarget>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literals(["SCHEMA", "ROLE"]), name: Ident }),
		Schema.Struct({
			kind: Schema.Literals([
				"TABLE",
				"VIEW",
				"MATERIALIZED VIEW",
				"TYPE",
				"DOMAIN",
				"SEQUENCE",
				"INDEX",
				"STATISTICS"
			]),
			name: ObjectNameSchema
		}),
		Schema.Struct({ kind: Schema.Literal("COLUMN"), relation: ObjectNameSchema, column: Ident }),
		Schema.Struct({
			kind: Schema.Literals(["CONSTRAINT", "TRIGGER", "POLICY"]),
			name: Ident,
			on: ObjectNameSchema
		}),
		Schema.Struct({
			kind: Schema.Literal("DOMAIN CONSTRAINT"),
			name: Ident,
			domain: ObjectNameSchema
		}),
		Schema.Struct({ kind: Schema.Literal("FUNCTION"), name: FunctionNameSchema })
	])
)

const CommentSchema = exact<Comment>()(
	Schema.Struct({ kind: Schema.Literal("comment"), on: CommentTargetSchema, text: Schema.String })
)

const PlDeclarationSchema = exact<PlDeclaration>()(
	Schema.Struct({ name: Ident, type: TypeRefSchema })
)

const RaiseOptionSchema = exact<RaiseOption>()(
	Schema.Struct({
		option: Schema.Literals([
			"ERRCODE",
			"CONSTRAINT",
			"DETAIL",
			"HINT",
			"MESSAGE",
			"SCHEMA",
			"TABLE",
			"COLUMN"
		]),
		value: ExprRef
	})
)

const PlStatements = Schema.Array(PlStatementRef)

const PlStatementSchema = exact<PlStatement>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("if"),
			branches: Schema.NonEmptyArray(Schema.Struct({ condition: ExprRef, body: PlStatements })),
			else: list(PlStatementRef)
		}),
		Schema.Struct({ kind: Schema.Literal("assign"), target: Ident, value: ExprRef }),
		Schema.Struct({
			kind: Schema.Literal("forQuery"),
			variable: Ident,
			query: SelectRef,
			body: PlStatements
		}),
		Schema.Struct({ kind: Schema.Literal("perform"), query: SelectRef }),
		Schema.Struct({
			kind: Schema.Literal("case"),
			operand: ExprRef,
			whens: Schema.Array(Schema.Struct({ values: Exprs, body: PlStatements })),
			else: maybe(PlStatements)
		}),
		Schema.Struct({
			kind: Schema.Literal("raise"),
			message: Schema.String,
			using: Schema.Array(RaiseOptionSchema)
		}),
		Schema.Struct({ kind: Schema.Literal("return"), value: ExprRef })
	])
)

const PlBlockSchema = exact<PlBlock>()(
	Schema.Struct({
		declare: Schema.Array(PlDeclarationSchema),
		body: Schema.NonEmptyArray(PlStatementRef)
	})
)

const plpgsqlHeader = {
	kind: Schema.Literal("createFunction"),
	language: Schema.Literal("plpgsql"),
	name: ObjectNameSchema,
	volatility: Schema.Literal("VOLATILE"),
	parallel: parallelSafety,
	security: Schema.Literal("DEFINER"),
	searchPath: Schema.NonEmptyArray(Ident),
	planCacheMode: Schema.Literal("force_custom_plan"),
	body: PlBlockSchema
} as const

const FunctionParamSchema = Schema.Struct({ name: Ident, type: TypeRefSchema })

const CreateFunctionSchema = exact<CreateFunction>()(
	Schema.Union([
		Schema.Struct({
			...plpgsqlHeader,
			returns: Schema.Literal("trigger"),
			params: Schema.Tuple([])
		}),
		Schema.Struct({
			...plpgsqlHeader,
			returns: Schema.Literal("boolean"),
			params: Schema.Array(FunctionParamSchema)
		}),
		Schema.Struct({
			...plpgsqlHeader,
			returns: Schema.Literal("void"),
			params: Schema.Array(FunctionParamSchema)
		}),
		Schema.Struct({
			kind: Schema.Literal("createFunction"),
			language: Schema.Literal("sql"),
			name: ObjectNameSchema,
			volatility: Schema.Literal("STABLE"),
			parallel: parallelSafety,
			security: Schema.Literal("DEFINER"),
			searchPath: Schema.NonEmptyArray(Ident),
			planCacheMode: Schema.Literal("force_generic_plan"),
			returns: Schema.Literal("boolean"),
			params: Schema.Array(FunctionParamSchema),
			body: ExprRef
		})
	])
)

const TxnSchema = exact<Txn>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("begin"),
			readOnly: flag
		}),
		Schema.Struct({ kind: Schema.Literal("commit") }),
		Schema.Struct({ kind: Schema.Literal("rollback") })
	])
)

const RefreshSchema = exact<Refresh>()(
	Schema.Struct({
		kind: Schema.Literal("refresh"),
		view: ObjectNameSchema,
		concurrently: Schema.Boolean
	})
)

const CreateCarrierSchema = exact<CreateCarrier>()(
	Schema.Struct({
		kind: Schema.Literal("createCarrier"),
		name: CarrierNameSchema,
		columns: Schema.NonEmptyArray(ColumnDefSchema)
	})
)

const AnalyzeSchema = exact<Analyze>()(
	Schema.Struct({
		kind: Schema.Literal("analyze"),
		carriers: Schema.Array(CarrierNameSchema)
	})
)

const DdlSchema = exact<Ddl>()(
	Schema.Union([
		CreateSchemaSchema,
		CreateTableSchema,
		AlterTableSchema,
		RenameObjectSchema,
		RenameColumnSchema,
		RenameConstraintSchema,
		CreateDomainSchema,
		AlterDomainSchema,
		CreateEnumSchema,
		AlterEnumAddValueSchema,
		AlterEnumRenameValueSchema,
		CreateIndexSchema,
		DropIndexSchema,
		CreateMaterializedViewSchema,
		CreateViewSchema,
		CreatePolicySchema,
		DropPolicySchema,
		DropObjectSchema,
		DropFunctionSchema,
		DropTriggerSchema,
		CreateFunctionSchema,
		CreateConstraintTriggerSchema,
		CreateGuardTriggerSchema,
		AlterDatabaseDefaultSchema,
		CreateRoleSchema,
		AlterRoleSchema,
		GrantRoleSchema,
		RevokeRoleSchema,
		GrantSchema,
		RevokeSchema,
		GrantColumnsSchema,
		AlterDefaultPrivilegesSchema,
		CreateExtensionSchema,
		CreateStatisticsSchema,
		LockTableSchema,
		CommentSchema
	])
)

export const SqlStatementSchema = exact<SqlStatement>()(
	Schema.Union([
		SelectRef,
		InsertSchema,
		UpdateSchema,
		DeleteSchema,
		MergeSchema,
		DdlSchema,
		CreateCarrierSchema,
		TxnSchema,
		RefreshSchema,
		AnalyzeSchema
	])
)
