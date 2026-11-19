import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { withoutSourceLocs } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription, ruleRefused } from "#compiler/core/errors.ts"
import { type FunctionDigest, functionDigest } from "#compiler/core/fingerprint.ts"
import {
	type DeclaredName,
	DeclaredNamespace,
	type Identity,
	identity
} from "#compiler/core/identity.ts"
import { type SourceLoc, labeledChildLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { FieldDesc, FunctionDesc, FunctionTypeDesc, SchemaDesc } from "#compiler/ir/desc.ts"

/**
 * A declared function as ownership admitted it: its declared name, parsed; the level that declares it, whose
 * PostgreSQL schema it installs in; its identity at the naming door; its Description; and the digest of its
 * Description, which a call of it carries (core/fingerprint.ts FunctionDigest).
 */
export interface OwnedFunction {
	readonly name: DeclaredName
	readonly level: number
	readonly named: Identity<"declaredFunction">
	readonly desc: FunctionDesc
	readonly definition: FunctionDigest
}

/**
 * Whether a declared function's signature takes a field of this type: a value of a base type PostgreSQL passes as it
 * is, a closed id, passed as its code, which the call casts to its roster's domain where it reads the function's value,
 * or a contract or a refined text over one; never money, whose text is the session's locale's, bytes, a set, a span or
 * a vector.
 */
const signatureType = (t: FieldDesc): boolean => {
	switch (t.kind) {
		case "pg":
			return t.type !== "money"
		case "numeric":
		case "uuid":
		case "text":
		case "closedId":
			return true
		case "contract":
			return signatureType(t.base)
		case "bytes":
		case "pattern":
		case "span":
		case "bits":
		case "vector":
			return false
	}
}

/** The fields an argument or a result's type reads: its value's type, or each field of its heading. */
const typesOf = (t: FunctionTypeDesc): ReadonlyArray<FieldDesc> =>
	t.kind === "value" ? [t.type] : t.heading.map((f) => f.type)

/** The refusal of a signature over a type no declared function takes (signatureType), as the types name it. */
const signatureRefused = (loc: SourceLoc): CompileError =>
	ruleRefused(
		loc,
		"a declared function takes and returns values of a base type, a closed id, a contract or a refined text over one: no serial, money, bytes, set, span or vector"
	)

/**
 * The refusal of a call graph that breaks its rule, at the caller `fn`: a call of a function no level declares, of one
 * another level declares, whose schema the caller's search_path does not name, or a cycle back to the caller, which no
 * order of creation lets every SQL body find its callees standing.
 */
const callRefused = (fn: FunctionDesc, what: string): CompileError =>
	malformedDescription(fn.loc, `the calls of function ${fn.name} as ${what}`)

/** The first cycle through `start` among the calls of `functions`, as the names along it; none where there is none. */
const cycleThrough = (
	start: string,
	functions: Readonly<Record<string, OwnedFunction>>
): ReadonlyArray<string> | undefined => {
	const seen = new Set<string>()
	const walk = (name: string, path: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
		for (const callee of functions[name]?.desc.calls ?? []) {
			if (callee === start) {
				return [...path, callee]
			}
			if (!seen.has(callee)) {
				seen.add(callee)
				const found = walk(callee, [...path, callee])
				if (found !== undefined) {
					return found
				}
			}
		}
		return undefined
	}
	return walk(start, [start])
}

/**
 * Each function's calls held to the call graph's rule (callRefused): every callee declared at the caller's own level,
 * and no cycle.
 */
const callsHeld = (
	functions: Readonly<Record<string, OwnedFunction>>
): Result.Result<Readonly<Record<string, OwnedFunction>>, CompileError> => {
	for (const fn of Object.values(functions)) {
		for (const callee of fn.desc.calls) {
			const called = functions[callee]
			if (called === undefined) {
				return Result.err(
					callRefused(
						fn.desc,
						`calls of declared functions; it calls ${callee}, which no level declares`
					)
				)
			}
			if (called.level !== fn.level) {
				return Result.err(
					callRefused(
						fn.desc,
						`calls of its own level's functions, whose schema its search_path names; it calls ${callee}, which another level declares`
					)
				)
			}
		}
		const cycle = cycleThrough(fn.name, functions)
		if (cycle !== undefined) {
			return Result.err(callRefused(fn.desc, `a call graph of no cycle; ${cycle.join(" calls ")}`))
		}
	}
	return Result.ok(functions)
}

/**
 * Each function the levels declare, by name: one namespace across every level, since a call names a function by its
 * declaration alone, each name parsed by the declared-name rule (IdentifierCollision for two whose conversions agree),
 * each argument's and its result's types ones a signature takes, and its calls those of its own level's functions in a
 * call graph of no cycle (callsHeld). A function's level is the one that declares it.
 */
export const ownFunctions = (
	levels: NonEmptyReadonlyArray<SchemaDesc>
): Result.Result<Readonly<Record<string, OwnedFunction>>, CompileError> => {
	const names = DeclaredNamespace.of("function")
	const out: Record<string, OwnedFunction> = {}
	for (const [level, schema] of levels.entries()) {
		for (const fn of schema.functions ?? []) {
			const name = names.declare(fn.name, "function", fn.loc)
			if (!name.ok) {
				return name
			}
			const typed: ReadonlyArray<readonly [string, FunctionTypeDesc]> = [
				...fn.args.map((a) => [a.name, a.type] as const),
				["result", fn.returns]
			]
			for (const [at, t] of typed) {
				if (!typesOf(t).every(signatureType)) {
					return Result.err(
						signatureRefused(labeledChildLoc(fn.loc, at, `function ${fn.name} ${at}`))
					)
				}
			}
			out[name.value] = {
				name: name.value,
				level,
				named: identity.declaredFunction(name.value),
				desc: fn,
				definition: functionDigest(fn, withoutSourceLocs)
			}
		}
	}
	return callsHeld(out)
}

/** A level's functions in canonical order, by name: what its canonical Description holds. */
export const canonicalFunctions = (schema: SchemaDesc): ReadonlyArray<FunctionDesc> =>
	(schema.functions ?? []).toSorted((a, b) => compareStrings(a.name, b.name))
