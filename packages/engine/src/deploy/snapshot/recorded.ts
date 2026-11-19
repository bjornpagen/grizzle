import { nominal } from "#compiler/core/brand.ts"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import type { InstallationManifest, PhysicalKind, PhysicalObject } from "#compiler/ir/products.ts"
import type {
	CreateConstant,
	Expr,
	FunctionParam,
	ObjectName,
	PackConstant,
	PlBlock,
	PlFunction,
	SqlStatement,
	TypeRef
} from "#compiler/sql/ast.ts"
import { lit, types } from "#compiler/sql/build.ts"
import { functionSource } from "#compiler/sql/print.ts"
import { type AstHooks, Transform } from "#compiler/sql/transform.ts"

/**
 * The SHA-256 of a PL/pgSQL function's source as PostgreSQL stores it, its pg_proc.prosrc (sql/print.ts
 * functionSource), in 64 lowercase hex digits: `encode(sha256(convert_to(prosrc, 'UTF8')), 'hex')` of the function
 * installed from the statement it digests, which the drift check holds every installed body to.
 */
export type SourceDigest = string & { readonly [sourceDigestBrand]: true }
declare const sourceDigestBrand: unique symbol

const sourceDigest = nominal<string, SourceDigest>()

/** The digest of the source a PL/pgSQL block installs as. */
const sourceDigestOf = (block: PlBlock): SourceDigest =>
	sourceDigest(sha256Hex(functionSource(block)))

/** A function's CREATE FUNCTION without its body, one variant per form of what it returns. */
type HeaderOf<F> = F extends unknown ? Omit<F, "body"> : never

/** A PL/pgSQL function's header: its CREATE FUNCTION but its body, which its record holds by its source's digest. */
export type FunctionHeader = HeaderOf<PlFunction>

/**
 * A PL/pgSQL function as a committed snapshot records it: its header, and the digest of the source its body installs as
 * (SourceDigest). Its whole text is in the committed migration file that installed it, and no reader of the snapshot
 * needs it again: a draft compares a body by its digest and drops the function by its header, and the drift check
 * replays the header with a stub body and holds the installed source to the digest.
 */
export interface RecordedFunction {
	readonly kind: "recordedFunction"
	readonly header: FunctionHeader
	readonly source: SourceDigest
}

/**
 * A constant's header: the function its content names, its parameters and its result type, which a CREATE FUNCTION of
 * a roster's or a dictionary's array (sql/ast.ts CreateConstant) and a closed relation's literal pack (PackConstant)
 * alike state. Its name is its content's digest (core/identity.ts), so the header says what the constant holds.
 */
export interface ConstantHeader {
	readonly name: ObjectName
	readonly params: ReadonlyArray<FunctionParam>
	readonly returns: TypeRef
}

/**
 * A constant as a committed snapshot records it: its header alone, whose name digests its content, so a changed content
 * is another function, which a draft creates beside it and the drift check finds missing by its name. Its body is in
 * the committed migration file that created it, and grizzle never replaces a constant in place.
 */
export interface RecordedConstant {
	readonly kind: "recordedConstant"
	readonly header: ConstantHeader
}

/**
 * An installed statement as a committed snapshot records it: whole, as every statement is but the ones whose body only
 * the drift check reads and only by its digest, a PL/pgSQL function's (RecordedFunction) and a constant's
 * (RecordedConstant).
 */
export type RecordedStatement = WholeStatement | RecordedFunction | RecordedConstant

/** A statement a committed snapshot records whole: every installed statement but a PL/pgSQL function and a constant. */
export type WholeStatement = Exclude<SqlStatement, PlFunction | CreateConstant | PackConstant>

/** An installed object as a committed snapshot records it, its statements recorded (RecordedStatement). */
export interface RecordedObject {
	readonly kind: PhysicalKind
	readonly ident: string
	readonly ddl: ReadonlyArray<RecordedStatement>
}

/**
 * An installation's manifest as a committed snapshot records it: each object by its kind, its identity and its recorded
 * statements, in install order, and the dependencies, the logins' defaults, the PUBLIC revokes and the comments whole.
 * What the compile's manifest holds besides (each object's reasons, its state and its phase) only the compile reads.
 */
export interface RecordedManifest {
	readonly objects: ReadonlyArray<RecordedObject>
	readonly edges: InstallationManifest<SqlStatement>["edges"]
	readonly roleDefaults: ReadonlyArray<SqlStatement>
	readonly publicRevokes: ReadonlyArray<SqlStatement>
	readonly comments: ReadonlyArray<SqlStatement>
}

/** A PL/pgSQL function's header, by the form of what it returns. */
export const functionHeader = (fn: PlFunction): FunctionHeader => {
	const { kind, language, name, volatility, parallel, security } = fn
	if (fn.returns === "trigger") {
		return {
			kind,
			language,
			name,
			volatility,
			parallel,
			security,
			returns: fn.returns,
			params: fn.params
		}
	}
	if (typeof fn.returns !== "string") {
		return {
			kind,
			language,
			name,
			volatility,
			parallel,
			security,
			returns: fn.returns,
			params: fn.params
		}
	}
	if (fn.returns === "boolean") {
		return {
			kind,
			language,
			name,
			volatility,
			parallel,
			security,
			returns: fn.returns,
			params: fn.params
		}
	}
	return {
		kind,
		language,
		name,
		volatility,
		parallel,
		security,
		returns: fn.returns,
		params: fn.params
	}
}

/** A header's function with `body`. */
const withBody = (h: FunctionHeader, body: PlBlock): PlFunction => {
	if (h.returns === "trigger") {
		return { ...h, returns: h.returns, params: h.params, body }
	}
	if (typeof h.returns !== "string") {
		return { ...h, returns: h.returns, params: h.params, body }
	}
	if (h.returns === "boolean") {
		return { ...h, returns: h.returns, params: h.params, body }
	}
	return { ...h, returns: h.returns, params: h.params, body }
}

/** A constant's header, a literal pack's its function's, which takes no parameter and returns its bits. */
export const constantHeader = (c: CreateConstant | PackConstant): ConstantHeader =>
	c.kind === "createConstant"
		? { name: c.name, params: c.params, returns: c.returns }
		: { name: c.function, params: [], returns: types.varbit }

/** An installed statement as its snapshot records it: a PL/pgSQL function and a constant by their headers, the
 * function with its source's digest; every other statement whole. */
const recordedStatement = (s: SqlStatement): RecordedStatement => {
	if (s.kind === "createConstant" || s.kind === "packConstant") {
		return { kind: "recordedConstant", header: constantHeader(s) }
	}
	if (s.kind !== "createFunction" || s.language === "sql") {
		return s
	}
	return { kind: "recordedFunction", header: functionHeader(s), source: sourceDigestOf(s.body) }
}

/** Each compiled object's record, made once: a PL/pgSQL function's digests its whole source, which a draft compares
 * many times over. */
const records = new WeakMap<PhysicalObject<SqlStatement>, RecordedObject>()

/** An installed object as its snapshot records it. */
const recordedObject = (o: PhysicalObject<SqlStatement>): RecordedObject => {
	const known = records.get(o)
	if (known !== undefined) {
		return known
	}
	const record: RecordedObject = { kind: o.kind, ident: o.ident, ddl: o.ddl.map(recordedStatement) }
	records.set(o, record)
	return record
}

/**
 * Whether an object's record, a committed snapshot's, is the record of the compiled object `now`: its statements are
 * what `now`'s record holds, a function's header and its source's digest, every other statement whole. It is how a
 * draft asks whether an installed object changed.
 */
export const sameRecord = (was: RecordedObject, now: PhysicalObject<SqlStatement>): boolean =>
	canonicalEquals(was.ddl, recordedObject(now).ddl)

/** An installation's manifest as its snapshot records it. */
export const recordedManifest = (m: InstallationManifest<SqlStatement>): RecordedManifest => ({
	objects: m.objects.map(recordedObject),
	edges: m.edges,
	roleDefaults: m.roleDefaults,
	publicRevokes: m.publicRevokes,
	comments: m.comments
})

/**
 * The stub body a recorded PL/pgSQL function is replayed with: one RAISE, which PL/pgSQL accepts in a function of any
 * result, and which never runs, since the drift check rolls its replay back. Its text is no part of any description:
 * the check describes a PL/pgSQL function by its header and holds the installed source to its record's digest.
 */
const stubBody: PlBlock = {
	declare: [],
	body: [
		{
			kind: "raise",
			message: "the drift check's stub of a recorded body, which never runs",
			using: []
		}
	]
}

/**
 * The value a recorded constant is replayed as: the empty value of its type, an empty array or an empty bit string, a
 * constant's every result type. The drift check describes a constant by its name, its owner and its result type alone,
 * and the scratch replay reads no row, so no value is read.
 */
const stubValue = (returns: TypeRef): Expr =>
	returns.array ? lit.text("{}", returns) : lit.bits("", returns)

/**
 * A recorded statement as the drift check replays it: a PL/pgSQL function with its header and the stub body, a constant
 * returning the empty value of its type, every other statement whole.
 */
export const replayedStatement = (s: RecordedStatement): SqlStatement => {
	if (s.kind === "recordedFunction") {
		return withBody(s.header, stubBody)
	}
	if (s.kind === "recordedConstant") {
		const { name, params, returns } = s.header
		return { kind: "createConstant", name, params, returns, body: stubValue(returns) }
	}
	return s
}

/** A header with its names and types rebuilt by `t`, as a CREATE FUNCTION's are. */
const transformedHeader = (h: FunctionHeader, t: Transform): FunctionHeader => {
	const name = t.name(h.name, "function")
	if (h.returns === "trigger") {
		return { ...h, name }
	}
	const params = h.params.map((p) => t.functionParam(p))
	if (typeof h.returns !== "string") {
		return { ...h, name, params, returns: { setOf: t.type(h.returns.setOf) } }
	}
	if (h.returns === "boolean") {
		return { ...h, name, params, returns: h.returns }
	}
	return { ...h, name, params, returns: h.returns }
}

/**
 * Recorded statements rebuilt by `hooks` (sql/transform.ts): a header's names and types as a CREATE FUNCTION's, a source's
 * digest kept, since PostgreSQL carries no rename into a function's source text; every other statement as the transform
 * rebuilds it.
 */
export const transformRecorded = (
	list: ReadonlyArray<RecordedStatement>,
	hooks: AstHooks
): ReadonlyArray<RecordedStatement> => {
	const t = new Transform(hooks)
	return list.map((s): RecordedStatement => {
		if (s.kind === "recordedFunction") {
			return { ...s, header: transformedHeader(s.header, t) }
		}
		if (s.kind === "recordedConstant") {
			const { name, params, returns } = s.header
			return {
				kind: s.kind,
				header: {
					name: t.name(name, "function"),
					params: params.map((p) => t.functionParam(p)),
					returns: t.type(returns)
				}
			}
		}
		return recordedStatement(t.statement(s))
	})
}
