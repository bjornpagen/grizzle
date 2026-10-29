import { exact, set } from "@grizzle/testing/oracle"
import { Array as Arr, Option, Order, Record as Rec, Schema, String as Str } from "effect"
import {
	CompileError,
	type CompileReason,
	isCompileError,
	prose,
	type ProseTag
} from "#compiler/core/errors.ts"

import {
	type DeclaredName,
	identity as door,
	maxIdentifierBytes,
	parseDeclaredName,
	parseSchemaName,
	type SchemaName
} from "#compiler/core/identity.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import { isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { decodeDesc, descText, type FieldDesc } from "#compiler/ir/desc.ts"
import type { OwnedSchema } from "#compiler/ir/products.ts"

import type {
	ColumnDef,
	Ddl,
	Expr,
	InlineConstraint,
	ObjectName,
	PrimaryKey,
	TableConstraint,
	TypeRef
} from "#compiler/sql/ast.ts"

import {
	and,
	binary,
	builtinType,
	call,
	cast,
	cUtf8Collation,
	eq,
	lit,
	namedType,
	not,
	numericType,
	objectName,
	qualifiedCall,
	tableCol,
	types
} from "#compiler/sql/build.ts"
import { emit, unmetered } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { printType } from "#compiler/sql/print.ts"
import type {
	AuthoredRelationDesc as RelationDesc,
	SchemaDesc,
	AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"
import type { InstalledAt } from "#test/support/kernel/naming.ts"
import {
	type ColumnType,
	type InstallPlan,
	type OracleColumn,
	type OracleDomain,
	type OracleEnum,
	type OracleForeignKey,
	type OracleKey,
	type OracleOmission,
	type OracleTable,
	type PlanOptions,
	uncontracted
} from "#test/support/oracle/install/model.ts"
import { IdentifierScope } from "#test/support/oracle/install/names.ts"
import { elementAt, entryOf } from "#test/support/oracle/pick.ts"

import { regex } from "arkregex"
/**
 * The planner reports its first refusal; internally it unwinds with this wrapper and planInstall turns it back into
 * a Result, so the build reads top to bottom.
 */
class PlanFailure extends Schema.TaggedError<PlanFailure, { readonly brand: unique symbol }>()(
	"PlanFailure",
	{
		refusal: Schema.declare(isCompileError)
	}
) {}

const refuse = (tag: ProseTag, location: string, text: string): never => {
	throw PlanFailure.make({ refusal: CompileError.make(prose(tag, SourceLoc(location, []), text)) })
}

/** A refusal for `reason`, a reason with facts beyond a sentence. */
const refuseWith = (reason: CompileReason): never => {
	throw PlanFailure.make({ refusal: CompileError.make(reason) })
}

const unwrap = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw PlanFailure.make({ refusal: result.error })
	}
	return result.value
}

/** Semantic identity: the canonical text without source locations (packages/engine/src/ir/desc.ts). */
const identity = (value: unknown): string => unwrap(descText(value))

/**
 * A declared name that keeps the naming door's rule (core/identity.ts parseDeclaredName), which every name the oracle
 * derives from it is minted from; a name that breaks it is refused as malformed.
 */
const declaredAt = (declared: string, location: string): DeclaredName => {
	const kept = parseDeclaredName(declared)
	if (!kept.ok) {
		return refuse(
			"MalformedDescription",
			location,
			`the declared name ${JSON.stringify(declared)}: ${kept.error}`
		)
	}
	return kept.value
}

/** A schema's declared name that keeps the naming door's rule for schemas (core/identity.ts parseSchemaName), or its
 * refusal as malformed. */
const schemaAt = (declared: string, location: string): SchemaName => {
	const kept = parseSchemaName(declared)
	if (!kept.ok) {
		return refuse(
			"MalformedDescription",
			location,
			`the declared schema name ${JSON.stringify(declared)}: ${kept.error}`
		)
	}
	return kept.value
}

/** A CHECK of a table. */
type CheckConstraint = TableConstraint & { readonly kind: "check" }

/**
 * The documented span shape over a column: nonempty, bounded on both sides, lower bound inclusive, upper bound
 * exclusive.
 */
const spanShape = (column: string): Expr => {
	const c = tableCol(column)
	return and(
		not(call("isempty", [c])),
		not(call("lower_inf", [c])),
		not(call("upper_inf", [c])),
		call("lower_inc", [c]),
		not(call("upper_inc", [c]))
	)
}

/** The documented fixed width over a column: its upper endpoint less its lower, both as numeric, is the width. */
const spanWidth = (column: string, width: bigint): Expr => {
	const c = tableCol(column)
	return eq(
		binary("-", cast(call("upper", [c]), types.numeric), cast(call("lower", [c]), types.numeric)),
		lit.int(width, types.numeric)
	)
}

/** The documented cosine domain over a column: pgvector's norm, in double precision, between 2^-16 and 2^16. */
const vectorNorm = (vectorSchema: string, column: string): Expr => ({
	kind: "between",
	expr: qualifiedCall(vectorSchema, "vector_norm", [tableCol(column)]),
	low: lit.float(2 ** -16, types.double),
	high: lit.float(2 ** 16, types.double),
	not: false
})

/** What a field descriptor stores under its contracts: the descriptor the column's storage CHECKs follow. */
const storedDesc = (field: FieldDesc): FieldDesc =>
	field.kind === "contract" ? storedDesc(field.base) : field

/** The Description an input states: an owned schema's, or the input itself. Either is decoded before it is used. */
const describedOf = (input: unknown): unknown =>
	isRecord(input) && Rec.has(input, "desc") && Rec.has(input, "fingerprint") ? input["desc"] : input

const isAdmittedSchemaName = (name: string): boolean =>
	regex("^[a-z_][a-z0-9_]*$").test(name) &&
	Buffer.byteLength(name, "utf8") <= maxIdentifierBytes &&
	!Str.startsWith("pg_")(name)

interface Located<A> {
	readonly value: A
	readonly location: string
}

interface TableDraft {
	readonly relation: string
	readonly name: ObjectName
	readonly columns: Array<OracleColumn>
	readonly primaryKey: OracleKey
	readonly keys: Array<OracleKey>
	readonly foreignKeys: Array<OracleForeignKey>
	mutable: boolean
	readonly location: string
	readonly constraints: IdentifierScope
	readonly index: number
}

const integerSpanCarrier = (type: ColumnType): "range4" | "range8" | undefined => {
	if (type.value.kind !== "integer") {
		return undefined
	}
	if (type.value.carrier === "int4") {
		return "range4"
	}
	if (type.value.carrier === "int8") {
		return "range8"
	}
	return undefined
}

/** The value kind each builtin PostgreSQL field type stores, as the column type's host value. */
const pgValues: {
	readonly [T in Extract<FieldDesc, { readonly kind: "pg" }>["type"]]: ColumnType["value"]
} = {
	smallint: { kind: "integer", carrier: "int2" },
	integer: { kind: "integer", carrier: "int4" },
	bigint: { kind: "integer", carrier: "int8" },
	real: { kind: "float", carrier: "float4" },
	"double precision": { kind: "float", carrier: "float8" },
	money: { kind: "money" },
	boolean: { kind: "bool" }
}

/**
 * A column or domain of builtin text names pg_catalog.pg_c_utf8; every other type takes none: a named domain carries
 * its own, an enum or an extension type takes none.
 */
const takesCollation = (t: TypeRef): boolean => t.kind === "builtin" && t.name === "text"

const columnOfField = (table: OracleTable, field: string) => {
	const column = Arr.findFirst(table.columns, (c) => c.field === field)
	if (Option.isNone(column)) {
		throw new Error(`${table.relation} has no column for ${field}`)
	}
	return column.value.column
}

const plain = (type: ColumnType) => ({ type, serial: false })

const builtin = (sql: ColumnType["sql"], value: ColumnType["value"]): ColumnType => ({
	sql,
	value,
	contract: uncontracted
})

/**
 * A contract that only a closed relation's payload uses still gets its domain, as the real installer gives it one:
 * a lowering casts a refined delivered payload value to its domain, so the domain must exist even though the closed
 * facts themselves live in the query as a typed VALUES relation and no table column is typed by it.
 *
 * Keys first, so a containment may name a key declared after it.
 */
const build = (input: unknown, planSchema: InstalledAt, options: PlanOptions): InstallPlan => {
	const desc = unwrap(decodeDesc("schema", describedOf(input)))
	const { unsupported, vectorSchema, extensionSchema } = options
	const schemaLocation = formatLoc(desc.loc)

	/** schema.extend: the base's relations and statements come first, under the one schema. */
	const levels: Array<SchemaDesc> = []
	for (let d: SchemaDesc | undefined = desc; d !== undefined; d = d.extends) {
		levels.unshift(d)
	}
	/** An identical repeat, at one level or across levels, is one declaration. */
	const relations: Array<Located<RelationDesc>> = []
	const statements: Array<Located<StatementDesc>> = []
	const byName = new Map<string, Located<RelationDesc> & { readonly identity: string }>()
	const seenStatements = new Set<string>()
	/** Declares a relation of the level at `at`, once, refusing a name declared differently. */
	const declareRelation = (r: RelationDesc, at: ReadonlyArray<string | number>): void => {
		const located = {
			value: r,
			location: formatLoc(SourceLoc(`relation ${r.name}`, [...at, "relations", r.name])),
			identity: identity(r)
		}
		const previous = byName.get(r.name)
		if (previous !== undefined && previous.identity === located.identity) {
			return
		}
		if (previous !== undefined) {
			refuseWith({
				_tag: "DuplicateIdentity",
				at: SourceLoc(located.location, []),
				duplicate: { kind: "relation", name: r.name, earlier: SourceLoc(previous.location, []) }
			})
		}
		byName.set(r.name, located)
		relations.push(located)
	}
	/** Declares statement `i` of the level at `at`, once. */
	const declareStatement = (
		s: StatementDesc,
		i: number,
		at: ReadonlyArray<string | number>
	): void => {
		const text = identity(s)
		if (seenStatements.has(text)) {
			return
		}
		seenStatements.add(text)
		statements.push({
			value: s,
			location: formatLoc(SourceLoc(`${s.kind} statement`, [...at, "statements", i]))
		})
	}
	for (const [depth, level] of levels.entries()) {
		/**
		 * An authored level states no locations, so each declaration is located by its
		 * path, a level told apart by its depth: the base is 0, each extension one more.
		 */
		const at = depth === 0 ? [level.name] : [level.name, "extension", depth]
		for (const r of level.relations) {
			declareRelation(r, at)
		}
		for (const [i, s] of level.statements.entries()) {
			declareStatement(s, i, at)
		}
	}

	const schema =
		planSchema.kind === "declared"
			? door.schema(schemaAt(desc.name, schemaLocation)).identifier
			: planSchema.installation.identifier
	if (!isAdmittedSchemaName(schema)) {
		refuse(
			"MalformedDescription",
			schemaLocation,
			`${JSON.stringify(schema)} is not an admitted schema identifier`
		)
	}

	/**
	 * One namespace for everything that lands in pg_class or pg_type: tables and their row types, sequences, the
	 * indexes behind PRIMARY KEY and UNIQUE, enums and domains.
	 */
	const schemaScope = new IdentifierScope(`schema ${schema}`)
	const skipped: Array<OracleOmission> = []
	const omit = (location: string, what: string, reason: string) => {
		if (unsupported === "skip") {
			skipped.push({ location, what, reason })
		} else {
			refuse("UnsupportedOperation", location, `oracle install: ${what}: ${reason}`)
		}
	}

	const enums = new Map<string, OracleEnum>()
	for (const { value: r, location } of relations) {
		if (r.kind !== "closed") {
			continue
		}
		const name = schemaScope.claim(door.enumType(declaredAt(r.name, location)).identifier, location)
		enums.set(r.name, { closed: r.name, name: objectName(schema, unwrap(name)), labels: r.handles })
	}

	const domains = new Map<string, { readonly identity: string; readonly domain: OracleDomain }>()

	/**
	 * A field descriptor's column type, and whether it is a serial declaration.
	 *
	 * The column is text COLLATE pg_c_utf8, without the text refinement domain and its CHECK.
	 *
	 * The domain is installed without its predicate's CHECK.
	 */
	const resolve = (
		field: FieldDesc,
		location: string
	): { readonly type: ColumnType; readonly serial: boolean } => {
		switch (field.kind) {
			case "pg":
				return plain(builtin(builtinType(field.type), pgValues[field.type]))
			case "numeric": {
				if (!("precision" in field)) {
					return plain(builtin(types.numeric, { kind: "numeric" }))
				}
				const { precision, scale } = field
				if (precision < 1 || precision > 1000) {
					refuse("MalformedDescription", location, "numeric precision lies in 1..1000")
				}
				if (scale < -1000 || scale > 1000) {
					refuse("MalformedDescription", location, "a numeric scale lies in -1000..1000")
				}
				return plain(builtin(numericType(precision, scale), { kind: "numeric" }))
			}
			case "serial": {
				const carrier =
					field.type === "smallserial" ? "int2" : field.type === "serial" ? "int4" : "int8"
				const sql = builtinType(
					carrier === "int2" ? "smallint" : carrier === "int4" ? "integer" : "bigint"
				)
				return { type: builtin(sql, { kind: "integer", carrier }), serial: true }
			}
			case "uuid":
				return plain(builtin(builtinType("uuid"), { kind: "uuid" }))
			case "text":
				return plain(builtin(builtinType("text"), { kind: "text" }))
			case "contract": {
				const existing = domains.get(field.name)
				if (existing !== undefined && existing.identity !== identity(field)) {
					refuseWith({
						_tag: "DuplicateIdentity",
						at: SourceLoc(location, []),
						duplicate: {
							kind: "contract",
							name: field.name,
							earlier: SourceLoc(existing.domain.location, [])
						}
					})
				}
				if (existing !== undefined) {
					const { domain } = existing
					return plain({
						...domain.base,
						sql: namedType(domain.name.schema, domain.name.name, []),
						contract: { kind: "contract", name: field.name }
					})
				}
				const base = resolve(field.base, location)
				if (base.serial) {
					refuse("MalformedDescription", location, "a contract is not itself a serial declaration")
				}
				const name = unwrap(
					schemaScope.claim(
						door.contractDomain(declaredAt(field.name, location)).identifier,
						location
					)
				)
				const domain: OracleDomain = {
					contract: field.name,
					name: objectName(schema, name),
					base: base.type,
					location
				}
				domains.set(field.name, { identity: identity(field), domain })
				return plain({
					...base.type,
					sql: namedType(schema, name, []),
					contract: { kind: "contract", name: field.name }
				})
			}
			case "span": {
				const endpoint = resolve(field.endpoint, location)
				const carrier = integerSpanCarrier(endpoint.type)
				if (endpoint.serial || carrier === undefined) {
					return refuse(
						"UnsupportedOperation",
						location,
						"a span endpoint is integer, bigint or a contract over them, never serial"
					)
				}
				const range = carrier === "range4" ? "int4range" : "int8range"
				return plain(builtin(builtinType(range), { kind: "span", carrier }))
			}
			case "closedId": {
				const target = enums.get(field.roster)
				if (target === undefined) {
					return refuse(
						"MalformedDescription",
						location,
						`closedId names ${field.roster}, which is no closed relation of the schema`
					)
				}
				return plain(
					builtin(namedType(schema, target.name.name, []), {
						kind: "enum",
						closed: field.roster,
						labels: target.labels
					})
				)
			}
			case "vector": {
				if (
					!Number.isInteger(field.dimensions) ||
					field.dimensions < 1 ||
					field.dimensions > 16000
				) {
					refuse("MalformedDescription", location, "a vector has 1..16000 dimensions")
				}
				return plain(
					builtin(namedType(vectorSchema, "vector", [field.dimensions]), {
						kind: "vector",
						dimensions: field.dimensions
					})
				)
			}
		}
	}

	for (const { value: r, location } of relations) {
		if (r.kind !== "closed") {
			continue
		}
		const contracts = Arr.flatMap(Rec.toEntries(r.payload), ([name, field]) =>
			field.kind === "contract" ? [[name, field] as const] : []
		)
		for (const [name, field] of contracts) {
			resolve(field, `${location} payload ${name}`)
		}
	}

	/**
	 * A key over `fields` of a relation with these columns: a span key places its one span field last, WITHOUT
	 * OVERLAPS, and needs a btree_gist operator class for every other component.
	 */
	const keyOf = (
		relation: string,
		columns: ReadonlyArray<OracleColumn>,
		name: string,
		fields: ReadonlyArray<string>,
		location: string
	): OracleKey => {
		const label = `key (${Arr.join(fields, ", ")}) of ${relation}`
		const fieldTypes = Arr.map(fields, (f) => {
			const column = Arr.findFirst(columns, (c) => c.field === f)
			if (Option.isNone(column)) {
				return refuse(
					"MalformedDescription",
					location,
					`${label}: ${f} is not a field of ${relation}`
				)
			}
			return column.value.type
		})
		const spans = Arr.flatMap(fields, (field, i) =>
			fieldTypes[i]?.value.kind === "span" ? [field] : []
		)
		if (spans.length > 1) {
			refuseWith({
				_tag: "UnrepresentableKey",
				at: SourceLoc(location, []),
				subject: label,
				key: fields,
				fault: { kind: "spans", fields: spans }
			})
		}
		const [span] = spans
		if (span === undefined) {
			return { name, fields, span: { kind: "none" } }
		}
		for (const [i, f] of fields.entries()) {
			if (fieldTypes[i]?.value.kind === "vector") {
				refuseWith({
					_tag: "UnrepresentableKey",
					at: SourceLoc(location, []),
					subject: label,
					key: fields,
					fault: { kind: "gistOperatorClass", field: f }
				})
			}
		}
		return { name, fields, span: { kind: "span", field: span } }
	}

	const tables = new Map<string, TableDraft>()
	const checks = new Map<string, ReadonlyArray<CheckConstraint>>()
	for (const [index, { value: r, location }] of relations.entries()) {
		if (r.kind === "derived") {
			omit(location, `derived relation ${r.name}`, "a materialized view needs the query lowering")
			continue
		}
		if (r.kind !== "relation") {
			continue
		}
		const table = unwrap(
			schemaScope.claim(door.table(declaredAt(r.name, location)).identifier, location)
		)
		const columnScope = new IdentifierScope(`table ${schema}.${table}`)
		const constraints = new IdentifierScope(`the constraints of ${schema}.${table}`)
		const columns: Array<OracleColumn> = []
		const tableChecks: Array<CheckConstraint> = []
		const check = (name: string, predicate: Expr, at: string) => {
			unwrap(constraints.claim(name, at))
			tableChecks.push({ kind: "check", name, predicate })
		}
		for (const [field, fieldDesc] of Rec.toEntries(r.fields)) {
			const fieldLocation = formatLoc(
				SourceLoc(`field ${r.name}.${field}`, [desc.name, "relations", r.name, "fields", field])
			)
			const column = unwrap(
				columnScope.claim(door.column(declaredAt(field, fieldLocation)).identifier, fieldLocation)
			)
			const { type, serial } = resolve(fieldDesc, fieldLocation)
			/**
			 * The column's storage CHECKs, in the real installer's order: a span's shape and its width; a vector's norm. A
			 * span endpoint's contract predicate is a predicate CHECK, which the minimal installer leaves out (see the header).
			 */
			const stored = storedDesc(fieldDesc)
			if (stored.kind === "span") {
				check(
					door.spanCheck(r.name, field, { kind: "shape" }).identifier,
					spanShape(column),
					fieldLocation
				)
			}
			if (stored.kind === "span" && stored.width !== undefined) {
				check(
					door.spanCheck(r.name, field, { kind: "width" }).identifier,
					spanWidth(column, stored.width),
					fieldLocation
				)
			}
			if (stored.kind === "vector") {
				check(
					door.normCheck(r.name, field).identifier,
					vectorNorm(vectorSchema, column),
					fieldLocation
				)
			}
			if (!serial) {
				columns.push({ field, column, type, sequence: { kind: "none" }, location: fieldLocation })
				continue
			}
			const sequence = unwrap(
				schemaScope.claim(door.sequence(r.name, field).identifier, fieldLocation)
			)
			columns.push({
				field,
				column,
				type,
				sequence: { kind: "identity", name: objectName(schema, sequence) },
				location: fieldLocation
			})
		}
		checks.set(r.name, tableChecks)
		const pk = door.primaryKey(r.name).identifier
		unwrap(schemaScope.claim(pk, location))
		unwrap(constraints.claim(pk, location))
		tables.set(r.name, {
			relation: r.name,
			name: objectName(schema, table),
			columns,
			primaryKey: keyOf(r.name, columns, pk, r.primaryKey, location),
			keys: [],
			foreignKeys: [],
			mutable: false,
			location,
			constraints,
			index
		})
	}

	const columnFor = (table: TableDraft, field: string, location: string): OracleColumn => {
		const column = Arr.findFirst(table.columns, (c) => c.field === field)
		if (Option.isNone(column)) {
			return refuse(
				"MalformedDescription",
				location,
				`${field} is not a field of ${table.relation}`
			)
		}
		return column.value
	}
	const storedTable = (relation: string, location: string, what: string): TableDraft => {
		const table = tables.get(relation)
		if (table !== undefined) {
			return table
		}
		const declared = byName.get(relation)
		return declared?.value.kind === "derived"
			? refuseWith({ _tag: "LawOnDerived", at: SourceLoc(location, []), relation })
			: refuse(
					"MalformedDescription",
					location,
					declared === undefined
						? `${what} names ${relation}, which is no relation of the schema`
						: `${what} names the ${declared.value.kind} relation ${relation}, which has no table`
				)
	}
	/** A containment's fields name a key when they hold the key's fields, in any order. */
	const sameFields = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
		Option.isNone(set(exact)(a, b))

	for (const { value: s, location } of statements) {
		switch (s.kind) {
			case "key": {
				const table = storedTable(s.relation, location, "key")
				for (const f of s.fields) {
					columnFor(table, f, location)
				}
				const name = door.key(table.relation, s.fields).identifier
				unwrap(schemaScope.claim(name, location))
				unwrap(table.constraints.claim(name, location))
				table.keys.push(keyOf(table.relation, table.columns, name, s.fields, location))
				break
			}
			case "mutable":
				storedTable(s.relation, location, "mutable").mutable = true
				break
			case "contained":
			case "check":
			case "mirrors":
			case "capacity":
				break
		}
	}
	/** A containment law: a foreign key between stored tables, an enum's membership, or omitted with why. */
	const planContained = (
		s: Extract<StatementDesc, { readonly kind: "contained" }>,
		location: string
	): void => {
		const { left, right } = s
		if (Rec.keys(left.selection).length > 0 || Rec.keys(right.selection).length > 0) {
			omit(
				location,
				"a selected containment",
				"a selected-source or selected-target law needs its tag columns or a residual law function"
			)
			return
		}
		const source = storedTable(left.relation, location, "contained")
		const target = byName.get(right.relation)
		if (target === undefined) {
			refuse(
				"MalformedDescription",
				location,
				`contained names ${right.relation}, which is no relation of the schema`
			)
		}
		if (target?.value.kind === "closed") {
			/** closedId membership is the enum itself: no table, no FK. */
			const handle =
				left.fields.length === 1 && right.fields.length === 1 && right.fields[0] === "id"
			const column = handle
				? columnFor(source, elementAt(left.fields, 0, "the containment's fields"), location)
				: undefined
			if (column?.type.value.kind === "enum" && column.type.value.closed === right.relation) {
				return
			}
			omit(
				location,
				`a containment into the closed relation ${right.relation}`,
				"only closedId membership is enforced by the enum; a payload containment is a finite CHECK"
			)
			return
		}
		const referenced = storedTable(right.relation, location, "contained")
		const declaredKey = Arr.findFirst([referenced.primaryKey, ...referenced.keys], (k) =>
			sameFields(right.fields, k.fields)
		)
		if (Option.isNone(declaredKey) || left.fields.length !== right.fields.length) {
			omit(
				location,
				`a containment into ${right.relation}(${Arr.join(right.fields, ", ")})`,
				"its target fields are not a declared key, so it needs a residual law"
			)
			return
		}
		/** Into a span key, the containment is the PERIOD foreign key, its span pair last. */
		const pairs = Arr.map(left.fields, (f, i) => ({
			from: f,
			to: elementAt(right.fields, i, "the containment's target fields")
		}))
		const targetSpan = declaredKey.value.span
		const period = targetSpan.kind === "span"
		if (targetSpan.kind === "span") {
			pairs.sort((a, b) => Number(a.to === targetSpan.field) - Number(b.to === targetSpan.field))
		}
		const sourceColumns = Arr.map(pairs, (p) => columnFor(source, p.from, location))
		const targetColumns = Arr.map(pairs, (p) => columnFor(referenced, p.to, location))
		for (const [i, c] of sourceColumns.entries()) {
			const t = elementAt(targetColumns, i, "the target columns")
			if (printType(c.type.sql) !== printType(t.type.sql)) {
				refuse(
					"MalformedDescription",
					location,
					`contained pairs ${left.relation}.${c.field} (${printType(c.type.sql)}) with ${right.relation}.${t.field} (${printType(t.type.sql)})`
				)
			}
		}
		/**
		 * Named by its source columns in the order the constraint lists them: a PERIOD foreign key's span last.
		 */
		const name = door.foreignKey(
			{ relation: left.relation, fields: Arr.map(pairs, (p) => p.from), selection: [] },
			{ relation: right.relation, fields: Arr.map(pairs, (p) => p.to), selection: [] },
			period
		).identifier
		unwrap(source.constraints.claim(name, location))
		source.foreignKeys.push({
			name,
			fields: Arr.map(pairs, (p) => p.from),
			references: right.relation,
			referencedFields: Arr.map(pairs, (p) => p.to),
			period,
			location
		})
	}
	for (const { value: s, location } of statements) {
		switch (s.kind) {
			case "contained":
				planContained(s, location)
				break
			case "check":
				omit(location, `row check ${s.name}`, "a table CHECK needs the predicate lowering")
				break
			case "mirrors":
				omit(location, "mirrors", "a mirror pair needs deferred or residual enforcement")
				break
			case "capacity":
				omit(location, "capacity", "a capacity law needs a partial UNIQUE or a residual law")
				break
			case "key":
			case "mutable":
				break
		}
	}

	/**
	 * Referenced tables load first. Immediate foreign keys check at the end of each statement, so a self-reference
	 * loads in one statement, but a cycle between tables cannot load at all. A deferred PERIOD foreign key checks at
	 * COMMIT, after the whole load, so it imposes no order.
	 */
	/** The tables in the order their relations are declared. */
	const byIndex = Order.mapInput(Order.Number, (t: TableDraft) => t.index)
	const loadOrder: Array<string> = []
	{
		const pending = Arr.sort(tables.values(), byIndex)
		const placed = new Set<string>()
		while (pending.length > 0) {
			const next = Arr.findFirstIndex(pending, (t) =>
				Arr.every(
					t.foreignKeys,
					(fk) => fk.period || fk.references === t.relation || placed.has(fk.references)
				)
			)
			if (Option.isNone(next)) {
				const stuck = Arr.join(
					Arr.map(pending, (t) => t.relation),
					", "
				)
				return refuse(
					"UnsupportedOperation",
					pending[0]?.location ?? schemaLocation,
					`oracle install: the immediate foreign keys among ${stuck} form a cycle, which needs deferral`
				)
			}
			const [table] = pending.splice(next.value, 1)
			if (table === undefined) {
				break
			}
			placed.add(table.relation)
			loadOrder.push(table.relation)
		}
	}

	/** The tables, as the plan exposes them. */
	const finalTables: Record<string, OracleTable> = {}
	for (const t of Arr.sort(tables.values(), byIndex)) {
		finalTables[t.relation] = {
			relation: t.relation,
			name: t.name,
			columns: t.columns,
			primaryKey: t.primaryKey,
			keys: t.keys,
			foreignKeys: t.foreignKeys,
			mutable: t.mutable,
			location: t.location
		}
	}

	/**
	 * DDL, in installation order: namespace; enums and domains; tables with their keys; references; then the PUBLIC
	 * revokes.
	 */
	const ddl: Array<Ddl> = [{ kind: "createSchema", name: schema, authorization: undefined }]
	/** A span key over more than its span field needs btree_gist's operator classes for the others. */
	const needsBtreeGist = Arr.some([...tables.values()], (t) =>
		Arr.some([t.primaryKey, ...t.keys], (k) => k.span.kind === "span" && k.fields.length > 1)
	)
	if (needsBtreeGist) {
		ddl.push({ kind: "createExtension", name: "btree_gist", schema: extensionSchema })
	}
	for (const e of enums.values()) {
		ddl.push({ kind: "createEnum", name: e.name, labels: e.labels })
	}
	for (const { domain } of domains.values()) {
		ddl.push({
			kind: "createDomain",
			name: domain.name,
			base: domain.base.sql,
			collation: takesCollation(domain.base.sql) ? cUtf8Collation : undefined,
			constraints: []
		})
	}
	const foreignKeyColumns = (table: OracleTable, fields: ReadonlyArray<string>, period: boolean) =>
		Arr.map(fields, (f, i) => ({
			column: columnOfField(table, f),
			period: period && i === fields.length - 1
		}))
	const keyColumns = (table: OracleTable, key: OracleKey) => {
		const span = key.span
		return span.kind === "none"
			? Arr.map(key.fields, (f) => ({ column: columnOfField(table, f), withoutOverlaps: false }))
			: [
					...Arr.map(
						Arr.filter(key.fields, (f) => f !== span.field),
						(f) => ({ column: columnOfField(table, f), withoutOverlaps: false })
					),
					{ column: columnOfField(table, span.field), withoutOverlaps: true }
				]
	}
	for (const table of Rec.values(finalTables)) {
		const columns = Arr.map(table.columns, (c): ColumnDef => ({
			name: c.column,
			type: c.type.sql,
			collation: takesCollation(c.type.sql) ? cUtf8Collation : undefined,
			generated:
				c.sequence.kind === "none" ? undefined : { kind: "identity", sequence: c.sequence.name },
			default: undefined
		}))
		if (!Arr.isReadonlyArrayNonEmpty(columns)) {
			throw new Error(`${table.relation} has no column`)
		}
		const primaryKey: PrimaryKey = {
			kind: "primaryKey",
			name: table.primaryKey.name,
			columns: keyColumns(table, table.primaryKey)
		}
		const constraints: Array<InlineConstraint> = [
			...Arr.map(table.keys, (k) => ({
				kind: "unique" as const,
				name: k.name,
				columns: keyColumns(table, k)
			})),
			...entryOf(checks, table.relation, "the tables' storage CHECKs")
		]
		ddl.push({
			kind: "createTable",
			table: table.name,
			columns,
			primaryKey,
			secondary: constraints
		})
	}
	/** The table a foreign key references. */
	const referencedBy = (fk: OracleForeignKey): OracleTable => {
		const referenced = finalTables[fk.references]
		if (referenced === undefined) {
			throw new Error(`${fk.name} references ${fk.references}, which has no table`)
		}
		return referenced
	}
	for (const table of Rec.values(finalTables)) {
		for (const fk of table.foreignKeys) {
			const referenced = referencedBy(fk)
			ddl.push({
				kind: "alterTable",
				table: table.name,
				actions: [
					{
						kind: "addConstraint",
						constraint: {
							kind: "foreignKey",
							name: fk.name,
							columns: foreignKeyColumns(table, fk.fields, fk.period),
							references: referenced.name,
							referencedColumns: foreignKeyColumns(referenced, fk.referencedFields, fk.period),
							deferrable: fk.period ? "INITIALLY DEFERRED" : undefined
						},
						notValid: false
					}
				]
			})
		}
	}

	/** PUBLIC holds nothing on any schema object. */
	const tableNames = Arr.map(Rec.values(finalTables), (t) => t.name)
	const sequenceNames = Arr.flatMap(Rec.values(finalTables), (t) =>
		Arr.flatMap(t.columns, (c) => (c.sequence.kind === "none" ? [] : [c.sequence.name]))
	)
	const publicOnly = [{ kind: "PUBLIC" as const }]
	if (tableNames.length > 0) {
		ddl.push({
			kind: "revoke",
			privileges: ["ALL"],
			on: { kind: "TABLE", names: tableNames },
			from: publicOnly
		})
	}
	if (sequenceNames.length > 0) {
		ddl.push({
			kind: "revoke",
			privileges: ["ALL"],
			on: { kind: "SEQUENCE", names: sequenceNames },
			from: publicOnly
		})
	}
	if (enums.size > 0) {
		ddl.push({
			kind: "revoke",
			privileges: ["ALL"],
			on: { kind: "TYPE", names: Arr.map([...enums.values()], (e) => e.name) },
			from: publicOnly
		})
	}
	if (domains.size > 0) {
		ddl.push({
			kind: "revoke",
			privileges: ["ALL"],
			on: { kind: "DOMAIN", names: Arr.map([...domains.values()], (d) => d.domain.name) },
			from: publicOnly
		})
	}

	const sql = Arr.map(ddl, (statement) => unwrap(emit(statement, emptyNameMap, unmetered)).text)
	return {
		declared: desc.name,
		schema,
		tables: finalTables,
		enums: Rec.fromEntries(enums),
		domains: Rec.fromEntries(Arr.map([...domains], ([name, { domain }]) => [name, domain])),
		loadOrder,
		ddl,
		sql,
		vectorSchema,
		skipped
	}
}

/**
 * The oracle's minimal installation plan for an owned schema.
 *
 * A pure planner that turns a SchemaDesc into the smallest DDL with the storage semantics of the real installer, the
 * minimal catalog test/pg/physical holds the real one against:
 *
 * - one PostgreSQL schema;
 * - one table per stored relation, every column NOT NULL, text columns COLLATE pg_catalog.pg_c_utf8, serial fields
 *   GENERATED ALWAYS AS IDENTITY with a named sequence;
 * - PRIMARY KEY from the relation's third argument and UNIQUE from each key(R, fields), with no implicit full-row
 *   UNIQUE;
 * - an enum per closed relation, in roster order, typing every closedId column;
 * - a domain per contract, with no constraint;
 * - the fixed-form CHECKs of every span and vector column, under the names the real installer gives them (below);
 * - an immediate NO ACTION foreign key for each containment whose target fields are a key of a stored relation;
 * - no role: the worlds are the real installer's, held to their worlds behaviourally (test/pg/worlds), and the
 *   oracle reads and loads as the owner.
 *
 * A primary key or key(R, fields) with a span field is a temporal key, PRIMARY KEY or UNIQUE (<scalars>,
 * <span> WITHOUT OVERLAPS) with btree_gist for the scalars, and a containment into such a key is the deferred PERIOD
 * foreign key. The span key's B-tree exact-repeat arbiter is not installed: it is
 * an ON CONFLICT arbiter for the insert protocol, and over nonempty spans it refuses nothing the WITHOUT OVERLAPS
 * constraint admits.
 *
 * A relation, contract or statement that the schema or an extension repeats identically is one declaration; a
 * conflicting repeat of a relation or contract name is DuplicateIdentity, as ownership
 * decides it (packages/engine/src/schema/own.ts).
 *
 * Identifiers are the installer's own, minted by the naming door (core/identity.ts), so the oracle never spells a naming
 * rule; names.ts claims them per PostgreSQL namespace, the oracle's own prediction of IdentifierCollision. What the minimal installer leaves out is
 * never dropped silently: a residual law, a selected or non-key containment, a row check, mirrors, capacity, or a
 * derived relation is refused by default and recorded in `skipped` under `unsupported: "skip"`.
 *
 * The minimal installer installs no predicate CHECK: a text refinement's pattern (the column is plain text), a
 * contract's predicate (its domain has no CHECK), a span endpoint's contract predicate, a row check and a finite
 * check. Each needs the compiler's predicate lowering, which the minimal installer would only restate. The physical
 * oracle models them by what they admit instead: test/pg/physical/checks.ts states each declaration's meaning on the
 * host and holds the real installer's CHECKs to it, probe by probe (the text domains in test/pg/physical/oracle.test.ts,
 * every other class in test/pg/physical/checks.test.ts). A plan only restricts which facts may be stored by those
 * CHECKs, and the oracle loads only facts its generators drew inside them.
 *
 * The span and vector CHECKs are the oracle's own statement of the documented storage rules, never read from src, so a
 * catalog comparison checks the real installer's against them independently:
 *
 * - a span is nonempty, bounded on both sides, lower bound inclusive and upper bound exclusive (its shape CHECK), and a
 *   span of a fixed width spans exactly that many endpoint steps, the endpoints compared as numeric so no width at an
 *   endpoint type's limits overflows (its width CHECK);
 * - a vector lies in the nondegenerate cosine domain: its norm, accumulated by pgvector's vector_norm in double
 *   precision, lies between 2^-16 and 2^16, both exact binary values.
 *
 * A span endpoint typed by a contract with a predicate also carries that predicate over each endpoint, a predicate CHECK
 * like the contract domain's own, which the minimal installer leaves out (see above).
 *
 * The minimal installation plan of a schema under `schema`, or the first refusal.
 */
export const planInstall = (
	input: SchemaDesc | OwnedSchema,
	schema: InstalledAt,
	options: PlanOptions
): Result.Result<InstallPlan, CompileError> => admitInstallPlan(input, schema, options)

/**
 * The admission core of planInstall: it decodes what it is given, so a description the types refuse is refused as
 * malformed, as a JavaScript caller's would be.
 */
const admitInstallPlan = (
	input: unknown,
	schema: InstalledAt,
	options: PlanOptions
): Result.Result<InstallPlan, CompileError> => {
	try {
		return Result.ok(build(input, schema, options))
	} catch (error) {
		if (Schema.is(PlanFailure)(error)) {
			return Result.err(error.refusal)
		}
		throw error
	}
}
