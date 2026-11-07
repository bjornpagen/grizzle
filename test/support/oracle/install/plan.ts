import { exact, set, structuralHash } from "@grizzle/testing/oracle"
import { Array as Arr, Data, Formatter, Option, Order, Record as Rec, String as Str } from "effect"
import { CompileError, type CompileReason, prose, type ProseTag } from "#compiler/core/errors.ts"
import type { DomainDigest } from "#compiler/core/fingerprint.ts"

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
import { cosineNormMax, cosineNormMin } from "#compiler/ir/carriers.ts"
import { type CodeSlot, type RosterCodes } from "#compiler/ir/cells.ts"
import { type RosterCodec, rosterCodec } from "#compiler/ir/codes.ts"
import { candidateKeyFields, descText, type FieldDesc } from "#compiler/ir/desc.ts"
import type { OwnedSchema } from "#compiler/ir/products.ts"
import { numericMaxPrecision, numericMaxScale, numericMinScale } from "#compiler/ir/scalar.ts"
import { ProgramPatterns } from "#compiler/scalar/regex/patterns.ts"
import { admitSchemaDesc } from "#compiler/schema/admit.ts"

import type {
	ColumnDef,
	Ddl,
	Expr,
	GrantObjects,
	InlineConstraint,
	ObjectName,
	PrimaryKey,
	TableConstraint,
	TypeRef
} from "#compiler/sql/ast.ts"

import { definitionDigest } from "#compiler/physical/ddl/domains.ts"
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
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { printType } from "#compiler/sql/print.ts"
import { analyzeText, domainValue, membership } from "#compiler/text/refinement.ts"
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
	type OracleForeignKey,
	type OracleKey,
	type OracleOmission,
	type OracleRoster,
	type OracleTable,
	type PlanOptions,
	uncontracted
} from "#test/support/oracle/install/model.ts"
import { IdentifierScope, rosterNamesIdentity } from "#test/support/oracle/install/names.ts"
import { elementAt, entryOf } from "#test/support/oracle/pick.ts"
import { testTypeSchema } from "#test/support/sql.ts"

import { regex } from "arkregex"
/**
 * The planner reports its first refusal; internally it unwinds with this wrapper and planInstall turns it back into
 * a Result, so the build reads top to bottom.
 */
class PlanFailure extends Data.TaggedError("PlanFailure")<{ readonly refusal: CompileError }> {}

const refuse = (tag: ProseTag, location: string, text: string): never => {
	throw new PlanFailure({ refusal: CompileError.make(prose(tag, SourceLoc(location, []), text)) })
}

/** A refusal for `reason`, a reason with facts beyond a sentence. */
const refuseWith = (reason: CompileReason): never => {
	throw new PlanFailure({ refusal: CompileError.make(reason) })
}

const unwrap = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw new PlanFailure({ refusal: result.error })
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
			`the declared name ${Formatter.format(declared)}: ${kept.error}`
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
			`the declared schema name ${Formatter.format(declared)}: ${kept.error}`
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
	return and([
		not(call("isempty", [c])),
		not(call("lower_inf", [c])),
		not(call("upper_inf", [c])),
		call("lower_inc", [c]),
		not(call("upper_inc", [c]))
	])
}

/** The documented fixed width over a column: its upper endpoint less its lower, both as numeric, is the width. */
const spanWidth = (column: string, width: bigint): Expr => {
	const c = tableCol(column)
	return eq(
		binary("-", cast(call("upper", [c]), types.numeric), cast(call("lower", [c]), types.numeric)),
		lit.int(width, types.numeric)
	)
}

/**
 * The documented cosine domain over a column: pgvector's norm, in double precision, between the domain's derived
 * bounds (ir/carriers.ts cosineNormMin and cosineNormMax).
 */
const vectorNorm = (vectorSchema: string, column: string): Expr => ({
	kind: "between",
	expr: qualifiedCall(vectorSchema, "vector_norm", [tableCol(column)]),
	low: lit.float(cosineNormMin.value, types.double),
	high: lit.float(cosineNormMax.value, types.double),
	not: false
})

/**
 * The digest of a contract's domain's definition, which its domain is named by: its CREATE DOMAIN but for the names it
 * is created and checked under (physical/ddl/domains.ts definitionDigest), as the documented rule states it. Its base
 * is `base`, the type the contract's base resolves to: an inner contract's domain, a roster's domain, or the unrefined
 * base type, `text COLLATE pg_catalog.pg_c_utf8` for a text base. Its CHECK is the base's pattern test, membership in
 * the pattern's language, where the base is refined text outside any contract, or none. A contract's name is its
 * type-level brand alone, so two contracts of one definition share one domain. A contract's predicate is a CHECK the
 * minimal installer neither installs nor states, so its domain cannot be named here, and it is refused.
 */
const contractDigest = (
	field: Extract<FieldDesc, { readonly kind: "contract" }>,
	base: ColumnType,
	location: string
): DomainDigest => {
	if (field.predicate !== undefined) {
		return refuse(
			"UnsupportedOperation",
			location,
			`oracle install: the contract ${field.name}'s predicate, which its domain's name digests and the minimal installer leaves out`
		)
	}
	const inner = field.base
	const pattern =
		inner.kind === "text"
			? unwrap(analyzeText(inner.source, inner.flags, SourceLoc(location, []))).check
			: undefined
	return definitionDigest({
		base: base.sql,
		collation: base.sql.kind === "builtin" && base.sql.name === "text" ? cUtf8Collation : undefined,
		constraints:
			pattern === undefined || pattern.kind === "tautology"
				? []
				: [{ name: "", predicate: membership(pattern, domainValue) }]
	})
}

/** What a field descriptor stores under its contracts: the descriptor the column's storage CHECKs follow. */
const storedDesc = (field: FieldDesc): FieldDesc =>
	field.kind === "contract" ? storedDesc(field.base) : field

/** The Description an input states: an owned schema's, or the input itself. Either is decoded before it is used. */
const describedOf = (input: unknown): unknown =>
	isRecord(input) && Rec.has(input, "desc") && Rec.has(input, "fingerprint") ? input["desc"] : input

const isAdmittedSchemaName = (name: string): boolean =>
	regex("^[a-z_][a-z0-9_]*$").test(name) &&
	Buffer.byteLength(name, "utf8") <= maxIdentifierBytes.value &&
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
	boolean: { kind: "bool" },
	date: { kind: "date" }
}

/**
 * A column or domain of builtin text names pg_catalog.pg_c_utf8; every other type takes none: a named domain carries
 * its own, and smallint, a roster's base, or an extension type takes none.
 */
const takesCollation = (t: TypeRef): boolean => t.kind === "builtin" && t.name === "text"

const columnOfField = (table: OracleTable, field: string) => {
	const column = Arr.findFirst(table.columns, (c) => c.field === field)
	if (Option.isNone(column)) {
		throw new Error(`${table.relation} has no column for ${field}`)
	}
	return column.value.column
}

const builtin = (sql: ColumnType["sql"], value: ColumnType["value"]): ColumnType => ({
	sql,
	value,
	contract: uncontracted
})

/**
 * PostgreSQL's array input text of a roster's names: every element double-quoted, its quotes and backslashes escaped,
 * so a handle spelled NULL, with a comma, a brace or spaces at either end reads back as itself, and a hole is "".
 */
const namesArrayText = (names: ReadonlyArray<string>): string =>
	`{${Arr.join(
		Arr.map(names, (name) => `"${Str.replaceAll('"', '\\"')(Str.replaceAll("\\", "\\\\")(name))}"`),
		","
	)}}`

/**
 * A roster's codes in a fresh installation, which numbers its handles from 0 in declared order: the oracle's own
 * numbering, no hole.
 */
const freshCodes = (handles: ReadonlyArray<string>): RosterCodes =>
	Arr.map(handles, (handle): CodeSlot => ({ kind: "live", handle }))

/**
 * The roster domain's one CHECK over VALUE, the documented range proof: the names constant names a handle at the code,
 * `(names())[VALUE + 1] <> ''::pg_catalog.name`, which a code past either end reads as NULL, refused by IS TRUE.
 */
const rosterCheck = (names: ObjectName): Expr =>
	binary(
		"<>",
		{
			kind: "subscript",
			array: qualifiedCall(names.schema, names.name, []),
			index: binary("+", { kind: "domainValue" }, lit.int(1, types.integer))
		},
		lit.text("", types.name(false))
	)

/**
 * A contract that only a closed relation's field uses still gets its domain, as the real installer gives it one: a
 * lowering casts a refined delivered value to its domain, so the domain must exist even though the closed rows live
 * in the installation's constants and no table column is typed by it.
 *
 * Keys first, so a containment may name a key declared after it.
 */
const build = (input: unknown, planSchema: InstalledAt, options: PlanOptions): InstallPlan => {
	const desc = unwrap(admitSchemaDesc(describedOf(input)))
	const { unsupported, vectorSchema, extensionSchema, codes: numbering } = options
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
			`${Formatter.format(schema)} is not an admitted schema identifier`
		)
	}

	/**
	 * One namespace for everything that lands in pg_class or pg_type: tables and their row types, sequences, the
	 * indexes behind PRIMARY KEY and UNIQUE, and domains. Functions land in pg_proc, a namespace of their own.
	 */
	const schemaScope = new IdentifierScope(`schema ${schema}`)
	const functionScope = new IdentifierScope(`the functions of schema ${schema}`)
	const skipped: Array<OracleOmission> = []
	const omit = (location: string, what: string, reason: string) => {
		if (unsupported === "skip") {
			skipped.push({ location, what, reason })
		} else {
			refuse("UnsupportedOperation", location, `oracle install: ${what}: ${reason}`)
		}
	}

	/**
	 * The codes of a roster: a fresh installation's, or the installation's own, which must hold the roster's live
	 * handles in their declared order.
	 */
	const codesOf = (
		closed: DeclaredName,
		handles: ReadonlyArray<string>,
		location: string
	): RosterCodec => {
		if (numbering.kind === "fresh") {
			return rosterCodec(closed, freshCodes(handles))
		}
		const codec = numbering.codes.rosters.get(closed)
		const live = codec === undefined ? undefined : Arr.filter(codec.names, (name) => name !== "")
		if (
			codec === undefined ||
			live === undefined ||
			!Arr.makeEquivalence(Str.Equivalence)(live, handles)
		) {
			return refuse(
				"MalformedDescription",
				location,
				`the installation's codes hold roster ${closed} with its handles ${Formatter.format(handles)} live in their declared order`
			)
		}
		return codec
	}
	const rosters = new Map<string, OracleRoster>()
	for (const { value: r, location } of relations) {
		if (r.kind !== "closed") {
			continue
		}
		const closed = declaredAt(r.name, location)
		const codes = codesOf(closed, r.handles, location)
		const names = unwrap(functionScope.claim(rosterNamesIdentity(codes).identifier, location))
		const domain = unwrap(schemaScope.claim(door.rosterDomain(closed).identifier, location))
		rosters.set(r.name, {
			closed: r.name,
			names: objectName(schema, names),
			domain: objectName(schema, domain),
			codes
		})
	}

	const domains = new Map<string, { readonly identity: string; readonly domain: OracleDomain }>()
	/** Each contract domain by its identifier: contracts of one physical definition share one domain. */
	const definitionDomains = new Map<string, string>()

	/**
	 * A field descriptor's column type.
	 *
	 * The column is text COLLATE pg_c_utf8, without the text refinement domain and its CHECK.
	 *
	 * The domain is installed without its predicate's CHECK.
	 */
	const resolve = (field: FieldDesc, location: string): ColumnType => {
		switch (field.kind) {
			case "pg":
				return builtin(builtinType(field.type), pgValues[field.type])
			case "numeric": {
				const { precision, scale } = field
				if (precision < 1 || precision > numericMaxPrecision.value) {
					refuse(
						"MalformedDescription",
						location,
						`numeric precision lies in 1..${numericMaxPrecision.value}`
					)
				}
				if (scale < numericMinScale.value || scale > numericMaxScale.value) {
					refuse(
						"MalformedDescription",
						location,
						`a numeric scale lies in ${numericMinScale.value}..${numericMaxScale.value}`
					)
				}
				return builtin(numericType(precision, scale), { kind: "numeric" })
			}
			case "uuid":
				return builtin(builtinType("uuid"), { kind: "uuid" })
			case "text":
				return builtin(builtinType("text"), { kind: "text" })
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
					return {
						...domain.base,
						sql: namedType(testTypeSchema(domain.name.schema), domain.name.name, []),
						contract: { kind: "contract", name: field.name }
					}
				}
				const base = resolve(field.base, location)
				const named = door.contractDomain(contractDigest(field, base, location)).identifier
				const shared = definitionDomains.get(named)
				const name = shared ?? unwrap(schemaScope.claim(named, location))
				definitionDomains.set(named, name)
				const domain: OracleDomain = {
					contract: field.name,
					name: objectName(schema, name),
					base,
					location
				}
				domains.set(field.name, { identity: identity(field), domain })
				return {
					...base,
					sql: namedType(testTypeSchema(schema), name, []),
					contract: { kind: "contract", name: field.name }
				}
			}
			case "span": {
				const endpoint = resolve(field.endpoint, location)
				const carrier = integerSpanCarrier(endpoint)
				if (carrier === undefined) {
					return refuse(
						"UnsupportedOperation",
						location,
						"a span endpoint is integer, bigint or a contract over them, never serial"
					)
				}
				const range = carrier === "range4" ? "int4range" : "int8range"
				return builtin(builtinType(range), { kind: "span", carrier })
			}
			case "closedId": {
				const target = rosters.get(field.roster)
				if (target === undefined) {
					return refuse(
						"MalformedDescription",
						location,
						`closedId names ${field.roster}, which is no roster of the schema`
					)
				}
				return builtin(namedType(testTypeSchema(schema), target.domain.name, []), {
					kind: "code",
					roster: target.codes
				})
			}
			case "bits":
				return refuse(
					"UnsupportedOperation",
					location,
					"oracle install: a set column's bits domain reads the roster's live() constant, which the minimal installer leaves to the real installer"
				)
			case "vector": {
				if (
					!Number.isInteger(field.dimensions) ||
					field.dimensions < 1 ||
					field.dimensions > 16000
				) {
					refuse("MalformedDescription", location, "a vector has 1..16000 dimensions")
				}
				return builtin(namedType(testTypeSchema(vectorSchema), "vector", [field.dimensions]), {
					kind: "vector",
					dimensions: field.dimensions
				})
			}
		}
	}

	for (const { value: r, location } of relations) {
		if (r.kind !== "closedRelation") {
			continue
		}
		const contracts = Arr.flatMap(Rec.toEntries(r.fields), ([name, field]) =>
			field.kind === "contract" ? [[name, field] as const] : []
		)
		for (const [name, field] of contracts) {
			resolve(field, `${location} field ${name}`)
		}
		omit(
			location,
			`closed relation ${r.name}`,
			"its rows are installation constants the closed lowering packs, and its laws are discharged in the migration"
		)
	}

	/**
	 * A key over `fields` of a relation with these columns: a span key places its one span field last, WITHOUT
	 * OVERLAPS, and needs a btree_gist operator class for every other component.
	 */
	const keyOf = (
		relation: string,
		columns: ReadonlyArray<OracleColumn>,
		name: string,
		fields: Arr.NonEmptyReadonlyArray<string>,
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
		for (const [field, decl] of Rec.toEntries(r.fields)) {
			const fieldLocation = formatLoc(
				SourceLoc(`field ${r.name}.${field}`, [desc.name, "relations", r.name, "fields", field])
			)
			if (decl.writing.kind === "generated") {
				refuse(
					"UnsupportedOperation",
					fieldLocation,
					"oracle install: a generated field's STORED expression needs the expression lowering"
				)
			}
			const fieldDesc = decl.type
			const column = unwrap(
				columnScope.claim(door.column(declaredAt(field, fieldLocation)).identifier, fieldLocation)
			)
			if (decl.writing.kind === "drawn" || decl.writing.kind === "accumulated") {
				refuse(
					"UnsupportedOperation",
					fieldLocation,
					`oracle install: a ${decl.writing.kind} field needs the family lowering`
				)
			}
			const type = resolve(fieldDesc, fieldLocation)
			const serial = decl.writing.kind === "serial"
			/**
			 * The column's storage CHECKs, in the real installer's order: a span's shape and its width; a vector's norm. A
			 * span endpoint's contract predicate is a predicate CHECK, which the minimal installer leaves out (see the
			 * header).
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
		Option.isNone(set(structuralHash, exact)(a, b))

	for (const { value: s, location } of statements) {
		switch (s.kind) {
			case "key": {
				const table = storedTable(s.side.relation, location, "key")
				for (const t of s.side.terms) {
					columnFor(table, t.field, location)
				}
				const fields = candidateKeyFields(s.side)
				if (fields === undefined) {
					break
				}
				const name = door.key(table.relation, fields).identifier
				unwrap(schemaScope.claim(name, location))
				unwrap(table.constraints.claim(name, location))
				table.keys.push(keyOf(table.relation, table.columns, name, fields, location))
				break
			}
			case "mutable":
				storedTable(s.relation, location, "mutable").mutable = true
				break
			case "contained":
			case "check":
			case "family":
			case "tree":
			case "fold":
			case "alternatives":
				break
		}
	}
	/**
	 * A containment law: a foreign key between stored tables, a closed id's membership in its own roster (the roster's
	 * domain), or omitted with why.
	 */
	const planContained = (
		s: Extract<StatementDesc, { readonly kind: "contained" }>,
		location: string
	): void => {
		const { left, right } = s
		const leftFields = candidateKeyFields(left)
		const rightFields = candidateKeyFields(right)
		if (leftFields === undefined || rightFields === undefined) {
			omit(
				location,
				"a containment of a selected side or a pred term",
				"a selected side or a pred term needs its law columns, generated per term"
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
			/** A lone closed-id field contained in its own roster's id is the roster's domain: no table, no FK. */
			const handle = leftFields.length === 1 && rightFields.length === 1 && rightFields[0] === "id"
			const column = handle
				? columnFor(source, elementAt(leftFields, 0, "the containment's fields"), location)
				: undefined
			if (
				column?.type.value.kind === "code" &&
				column.type.value.roster.roster === right.relation
			) {
				return
			}
			omit(
				location,
				`a containment into the roster ${right.relation}`,
				"only a closed id's membership in its own roster is the roster's domain; any other is a closed CHECK"
			)
			return
		}
		if (target?.value.kind === "closedRelation") {
			omit(
				location,
				`a containment into the closed relation ${right.relation}`,
				"a containment into a closed relation is a closed CHECK over its constant, which needs the closed lowering"
			)
			return
		}
		const referenced = storedTable(right.relation, location, "contained")
		const declaredKey = Arr.findFirst([referenced.primaryKey, ...referenced.keys], (k) =>
			sameFields(rightFields, k.fields)
		)
		if (Option.isNone(declaredKey) || leftFields.length !== rightFields.length) {
			omit(
				location,
				`a containment into ${right.relation}(${Arr.join(rightFields, ", ")})`,
				"its target fields are not a declared key, so it needs a residual law"
			)
			return
		}
		/** Into a span key, the containment is the PERIOD foreign key, its span pair last. */
		const pairs = Arr.map(leftFields, (f, i) => ({
			from: f,
			to: elementAt(rightFields, i, "the containment's target fields")
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
			{ relation: left.relation, fields: Arr.map(pairs, (p) => p.from) },
			{ relation: right.relation, fields: Arr.map(pairs, (p) => p.to) },
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
			case "key":
				if (candidateKeyFields(s.side) === undefined) {
					omit(
						location,
						"a key of a selected side or a pred term",
						"a selected side or a pred term needs its law columns, generated per term"
					)
				}
				break
			case "family":
			case "tree":
			case "fold":
			case "alternatives":
				omit(location, `a ${s.kind} law`, `a ${s.kind} law needs its native lowering`)
				break
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
	 * DDL, in installation order: namespace; each roster's names constant and its domain; contract domains; tables with
	 * their keys; references; then the PUBLIC revokes.
	 */
	const ddl: Array<Ddl> = [{ kind: "createSchema", name: schema, authorization: undefined }]
	/** A span key over more than its span field needs btree_gist's operator classes for the others. */
	const needsBtreeGist = Arr.some([...tables.values()], (t) =>
		Arr.some([t.primaryKey, ...t.keys], (k) => k.span.kind === "span" && k.fields.length > 1)
	)
	if (needsBtreeGist) {
		ddl.push({ kind: "createExtension", name: "btree_gist", schema: extensionSchema })
	}
	for (const r of rosters.values()) {
		ddl.push({
			kind: "createConstant",
			name: r.names,
			params: [],
			returns: types.name(true),
			body: lit.text(namesArrayText(r.codes.names), types.name(true))
		})
		ddl.push({
			kind: "createDomain",
			name: r.domain,
			base: types.smallint,
			collation: undefined,
			constraints: [
				{
					name: door.domainCheck(door.rosterDomain(declaredAt(r.closed, r.closed))).identifier,
					predicate: rosterCheck(r.names)
				}
			]
		})
	}
	for (const { domain } of Arr.dedupeWith(
		[...domains.values()],
		(a, b) => a.domain.name.name === b.domain.name.name
	)) {
		ddl.push({
			kind: "createDomain",
			name: domain.name,
			base: domain.base.sql,
			collation: takesCollation(domain.base.sql) ? cUtf8Collation : undefined,
			constraints: []
		})
	}
	const foreignKeyColumns = (
		table: OracleTable,
		fields: ReadonlyArray<string>,
		period: boolean
	): Arr.NonEmptyReadonlyArray<{ readonly column: string; readonly period: boolean }> => {
		const columns = Arr.map(fields, (f, i) => ({
			column: columnOfField(table, f),
			period: period && i === fields.length - 1
		}))
		if (!Arr.isReadonlyArrayNonEmpty(columns)) {
			throw new Error(`a foreign key of ${table.relation} has no column`)
		}
		return columns
	}
	const keyColumns = (
		table: OracleTable,
		key: OracleKey
	): Arr.NonEmptyReadonlyArray<{ readonly column: string; readonly withoutOverlaps: boolean }> => {
		const span = key.span
		return span.kind === "none"
			? Arr.map(key.fields, (f) => ({ column: columnOfField(table, f), withoutOverlaps: false }))
			: Arr.append(
					Arr.map(
						Arr.filter(key.fields, (f) => f !== span.field),
						(f) => ({ column: columnOfField(table, f), withoutOverlaps: false })
					),
					{ column: columnOfField(table, span.field), withoutOverlaps: true }
				)
	}
	for (const table of Rec.values(finalTables)) {
		const columns = Arr.map(table.columns, (c): ColumnDef => ({
			name: c.column,
			type: c.type.sql,
			collation: takesCollation(c.type.sql) ? cUtf8Collation : undefined,
			generated:
				c.sequence.kind === "none" ? undefined : { kind: "identity", sequence: c.sequence.name }
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
							deferrable: fk.period ? "INITIALLY DEFERRED" : undefined,
							onUpdate: undefined
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
	const constantNames = Arr.map([...rosters.values()], (r) => ({ ...r.names, args: [] }))
	const domainNames = [
		...Arr.map([...rosters.values()], (r) => r.domain),
		...Arr.dedupeWith(
			Arr.map([...domains.values()], (d): ObjectName => d.domain.name),
			(a: ObjectName, b: ObjectName) => a.name === b.name
		)
	]
	const revokeFromPublic = (on: GrantObjects): Ddl => ({
		kind: "revoke",
		privileges: ["ALL"],
		on,
		from: [{ kind: "PUBLIC" }]
	})
	if (Arr.isReadonlyArrayNonEmpty(tableNames)) {
		ddl.push(revokeFromPublic({ kind: "TABLE", names: tableNames }))
	}
	if (Arr.isReadonlyArrayNonEmpty(sequenceNames)) {
		ddl.push(revokeFromPublic({ kind: "SEQUENCE", names: sequenceNames }))
	}
	if (Arr.isReadonlyArrayNonEmpty(constantNames)) {
		ddl.push(revokeFromPublic({ kind: "FUNCTION", names: constantNames }))
	}
	if (Arr.isReadonlyArrayNonEmpty(domainNames)) {
		ddl.push(revokeFromPublic({ kind: "DOMAIN", names: domainNames }))
	}

	const sql = Arr.map(ddl, (statement) => unwrap(emit(statement, emptyNameMap)).text)
	return {
		declared: desc.name,
		schema,
		tables: finalTables,
		rosters: Rec.fromEntries(rosters),
		codes: {
			rosters: new Map(Arr.map([...rosters.values()], (r) => [r.codes.roster, r.codes] as const))
		},
		domains: Rec.fromEntries(Arr.map([...domains], ([name, { domain }]) => [name, domain])),
		loadOrder,
		ddl,
		sql,
		vectorSchema,
		skipped,
		fill: {
			order: { families: [], layouts: new Map() },
			closed: new Map(),
			patterns: ProgramPatterns.of([])
		}
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
 * - per roster, its names constant, a zero-argument IMMUTABLE SQL function returning each code's handle in code order
 *   as a name[] (a hole the empty name), named by the digest of those names, and its smallint domain, typing every
 *   closedId column, whose one CHECK admits exactly the codes the constant names a handle at; the codes are a fresh
 *   installation's or the installation's own (PlanOptions.codes);
 * - no closed relation: its rows are installation constants the closed lowering packs, and its laws are discharged in
 *   the migration, so it and every containment into it are recorded in `skipped`;
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
 * never dropped silently: a containment or key of a selected side or a pred term, a non-key containment, a row check,
 * a family, tree, fold or alternatives law, or a derived relation is refused by default and recorded in `skipped`
 * under `unsupported: "skip"`.
 *
 * The minimal installer installs no predicate CHECK: a text refinement's pattern (the column is plain text), a
 * contract's predicate (its domain has no CHECK), a span endpoint's contract predicate, a row check and a finite
 * check. Each needs the compiler's predicate lowering, which the minimal installer would only restate. The physical
 * oracle models them by what they admit instead: test/pg/physical/checks.ts states each declaration's meaning on the
 * host and holds the real installer's CHECKs to it, probe by probe (the text domains in test/pg/physical/oracle.test.ts,
 * every other class in test/pg/physical/checks.test.ts). A plan only restricts which facts may be stored by those
 * CHECKs, and the oracle loads only facts its generators drew inside them.
 *
 * The span and vector CHECKs are the oracle's own statement of the documented storage rules, never read from src but
 * for the cosine domain's two limits, so a catalog comparison checks the real installer's against them independently:
 *
 * - a span is nonempty, bounded on both sides, lower bound inclusive and upper bound exclusive (its shape CHECK), and a
 *   span of a fixed width spans exactly that many endpoint steps, the endpoints compared as numeric so no width at an
 *   endpoint type's limits overflows (its width CHECK);
 * - a vector lies in the nondegenerate cosine domain: its norm, accumulated by pgvector's vector_norm in double
 *   precision, lies between cosineNormMin and cosineNormMax (2^-68 and 2^63, both exact binary values), read from
 *   their one spelling in ir/carriers.ts.
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
		if (error instanceof PlanFailure) {
			return Result.err(error.refusal)
		}
		throw error
	}
}
