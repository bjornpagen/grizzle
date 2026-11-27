import { nominal } from "#compiler/core/brand.ts"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"
import type { InstallationManifest, PhysicalKind, PhysicalObject } from "#compiler/ir/products.ts"
import type {
	CreateConstant,
	CreateDeclaredFunction,
	PackConstant,
	PlBlock,
	PlFunction,
	SqlStatement,
	StubConstant
} from "#compiler/sql/ast.ts"
import { declaredBody, stubBody } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { functionSource, printStatement, typeOnSearchPath } from "#compiler/sql/print.ts"
import { type AstHooks, Transform } from "#compiler/sql/transform.ts"

/**
 * The SHA-256 of a PL/pgSQL function's source as PostgreSQL stores it, its pg_proc.prosrc (sql/print.ts
 * functionSource), in 64 lowercase hex digits: `encode(sha256(convert_to(prosrc, 'UTF8')), 'hex')` of the function
 * installed from the statement it digests, which the drift check holds every installed body to.
 */
export type SourceDigest = string & { readonly [sourceDigestBrand]: true }
declare const sourceDigestBrand: unique symbol

const sourceDigest = nominal<string, SourceDigest>()

/** The digest of the source a PL/pgSQL function installs as: of the body its CREATE FUNCTION writes (functionSource). */
const sourceDigestOf = (fn: PlFunction): SourceDigest =>
	sourceDigest(sha256Hex(wellFormed(functionSource(fn))))

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

/** A declared function's header: its CREATE OR REPLACE FUNCTION but its body, which its record holds by its digest. */
export type DeclaredHeader = Omit<CreateDeclaredFunction, "body">

/** A declared function's header: its CREATE OR REPLACE FUNCTION but its body. */
export const declaredHeader = (fn: CreateDeclaredFunction): DeclaredHeader => ({
	kind: fn.kind,
	name: fn.name,
	params: fn.params,
	returns: fn.returns,
	language: fn.language,
	volatility: fn.volatility,
	nullInput: fn.nullInput,
	namedAlone: fn.namedAlone
})

/**
 * A declared function as a committed snapshot records it: its header, and the digest of its body, the application's
 * text, which PostgreSQL stores whole as its source (sql/ast.ts DeclaredBody), so a draft replaces a function whose
 * body's digest changed and the drift check holds the installed source to it, as a PL/pgSQL function's.
 */
export interface RecordedDeclaredFunction {
	readonly kind: "recordedDeclaredFunction"
	readonly header: DeclaredHeader
	readonly source: SourceDigest
}

/**
 * A constant's header: the function its content names, its body's language, its parameters and its result type, which
 * a CREATE FUNCTION of a roster's or a dictionary's array, a library function or a row function (sql/ast.ts
 * CreateConstant) and a closed relation's literal pack (PackConstant, an SQL constant) alike state, and which the drift
 * check replays as the constant's stub (sql/ast.ts StubConstant). Its name is its content's digest (core/identity.ts),
 * so the header says what the constant holds; its language is what the drift check describes it by, a PL/pgSQL
 * constant by its header as PostgreSQL deparses it.
 */
export type ConstantHeader = Omit<StubConstant, "kind">

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
 * the drift check reads and only by its digest, a PL/pgSQL function's (RecordedFunction), a declared function's
 * (RecordedDeclaredFunction) and a constant's (RecordedConstant).
 */
export type RecordedStatement =
	| WholeStatement
	| RecordedFunction
	| RecordedDeclaredFunction
	| RecordedConstant

/** A statement a committed snapshot records whole: every installed statement but a PL/pgSQL function, a declared
 * function and a constant, its stub's among them. */
export type WholeStatement = Exclude<
	SqlStatement,
	PlFunction | CreateDeclaredFunction | CreateConstant | PackConstant | StubConstant
>

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

/** A constant's header, a literal pack's its function's, which takes no parameter and returns its codes. */
export const constantHeader = (c: CreateConstant | PackConstant | StubConstant): ConstantHeader =>
	c.kind === "packConstant"
		? { language: "sql", name: c.function, params: [], returns: types.codes }
		: { language: c.language, name: c.name, params: c.params, returns: c.returns }

/** An installed statement as its snapshot records it: a PL/pgSQL function and a constant by their headers, the
 * function with its source's digest; every other statement whole. */
const recordedStatement = (s: SqlStatement): RecordedStatement => {
	if (s.kind === "createConstant" || s.kind === "packConstant" || s.kind === "stubConstant") {
		return { kind: "recordedConstant", header: constantHeader(s) }
	}
	if (s.kind === "createDeclaredFunction") {
		return {
			kind: "recordedDeclaredFunction",
			header: declaredHeader(s),
			source: sourceDigest(sha256Hex(wellFormed(s.body)))
		}
	}
	if (s.kind !== "createFunction" || s.language === "sql") {
		return s
	}
	return { kind: "recordedFunction", header: functionHeader(s), source: sourceDigestOf(s) }
}

/** Each compiled object's record, made once: a PL/pgSQL function's digests its whole source, which a draft compares
 * many times over. */
const records = new WeakMap<PhysicalObject<SqlStatement>, RecordedObject>()

/** An installed object as its snapshot records it. */
/** An installed object as its snapshot records it, each statement recorded (recordedStatement), each object once. */
export const recordedObject = (o: PhysicalObject<SqlStatement>): RecordedObject => {
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

/**
 * What PostgreSQL holds of a recorded statement: a statement recorded whole as it prints, so the proof a select core
 * carries in place of a DISTINCT (sql/ast.ts RowsProof), which prints nothing, is no part of it; a function and a
 * constant by their records, a function's source by its digest.
 */
const heldOf = (s: RecordedStatement): RecordedStatement | string =>
	s.kind === "recordedFunction" ||
	s.kind === "recordedDeclaredFunction" ||
	s.kind === "recordedConstant"
		? s
		: printStatement(s)

/**
 * Whether an object's record holds what PostgreSQL holds of the compiled object `now`, statement by statement
 * (heldOf): the same record, or one whose statements print alike, a select core's proof aside. A role's world object
 * whose compile proves its rows unique by a key it gained, and so states its proof where it stated none, prints the
 * same statement and is the same object.
 */
export const samePrinted = (was: RecordedObject, now: PhysicalObject<SqlStatement>): boolean => {
	const after = recordedObject(now).ddl
	return (
		canonicalEquals(was.ddl, after) ||
		(was.ddl.length === after.length &&
			was.ddl.every((s, i) => {
				const t = after[i]
				return t !== undefined && canonicalEquals(heldOf(s), heldOf(t))
			}))
	)
}

/** An installation's manifest as its snapshot records it. */
export const recordedManifest = (m: InstallationManifest<SqlStatement>): RecordedManifest => ({
	objects: m.objects.map(recordedObject),
	edges: m.edges,
	roleDefaults: m.roleDefaults,
	publicRevokes: m.publicRevokes,
	comments: m.comments
})

/**
 * The stub body a recorded declared function is replayed with, by its language: PL/pgSQL's one RAISE, as a PL/pgSQL
 * function's stub; and for SQL, one SELECT of NULL as its result's type, which PostgreSQL validates against the result
 * as it creates the function, a set of a row type's values included, whose one column is the row, its type named as a
 * body names one (typeOnSearchPath), since PostgreSQL validates the body under the function's own settings (pg_proc.c
 * ProcedureCreate). Neither runs, and the check describes the function by its header and holds its installed source to
 * the record's digest.
 */
const declaredStub = (h: DeclaredHeader): CreateDeclaredFunction["body"] => {
	switch (h.language) {
		case "plpgsql":
			return declaredBody(
				"BEGIN RAISE EXCEPTION 'the drift check''s stub of a recorded body, which never runs'; END"
			)
		case "sql":
			return declaredBody(
				`SELECT NULL::${typeOnSearchPath("setOf" in h.returns ? h.returns.setOf : h.returns)}`
			)
	}
}

/**
 * A recorded statement as the drift check replays it: a PL/pgSQL function with its header and the stub body, which
 * never runs, since every function grizzle writes in PL/pgSQL is VOLATILE or STABLE, which PostgreSQL never folds, and
 * a declared function's call stands in no CHECK, generation, key or contract (schema/terms.ts rowForeign,
 * scalar/compute/lower.ts), where PostgreSQL would plan it as it creates the object; a constant as its stub, returning
 * NULL of its type, which every check the replay can evaluate admits (sql/ast.ts StubConstant); every other statement
 * whole.
 */
export const replayedStatement = (s: RecordedStatement): SqlStatement => {
	if (s.kind === "recordedFunction") {
		return withBody(s.header, stubBody)
	}
	if (s.kind === "recordedConstant") {
		return { kind: "stubConstant", ...s.header }
	}
	if (s.kind === "recordedDeclaredFunction") {
		return { ...s.header, body: declaredStub(s.header) }
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
		return { ...h, name, params, returns: { ...h.returns, setOf: t.type(h.returns.setOf) } }
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
		if (s.kind === "recordedDeclaredFunction") {
			const h = s.header
			return {
				...s,
				header: {
					...h,
					name: t.name(h.name, "function"),
					params: h.params.map((p) => t.functionParam(p)),
					returns: t.declaredReturns(h.returns),
					namedAlone: h.namedAlone.map((type) => t.type(type))
				}
			}
		}
		if (s.kind === "recordedConstant") {
			const { language, name, params, returns } = s.header
			return {
				kind: s.kind,
				header: {
					language,
					name: t.name(name, "function"),
					params: params.map((p) => t.functionParam(p)),
					returns: t.type(returns)
				}
			}
		}
		return recordedStatement(t.statement(s))
	})
}
