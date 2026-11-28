import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { sameContent, withoutSourceLocs } from "#compiler/core/canonical.ts"
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
import type {
	FieldDesc,
	FunctionDesc,
	FunctionTypeDesc,
	HeadingDesc,
	SchemaDesc
} from "#compiler/ir/desc.ts"

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
 * a digest, passed as its bytea, which the call casts to the installation's digest domain where it reads the value, so
 * the domain's CHECK holds its 32 octets, or a contract or a refined text over one; or a variant, passed as its
 * composite, which the call casts to the variant's domain where it reads the function's value, so the domain's CHECK
 * holds its arm whole; never money, whose text is the session's locale's, an exact value of any size, whose integers or
 * scale only a stored column's CHECK holds and no cast of a function's value checks, a computed numeric's bound, which
 * no function's body is held to, bytes, a set, a span, a vector or a search document.
 */
const signatureType = (t: FieldDesc): boolean => {
	switch (t.kind) {
		case "pg":
			return t.type !== "money"
		case "numeric":
		case "uuid":
		case "text":
		case "closedId":
		case "sha256":
		case "variant":
			return true
		case "contract":
			return signatureType(t.base)
		case "exact":
		case "computedNumeric":
		case "bytes":
		case "pattern":
		case "span":
		case "bits":
		case "vector":
		case "search":
			return false
	}
}

/** The fields an argument or a result's type reads: its value's type, or each field's of its heading, a heading a
 * field holds rows or a row of among them. */
const typesOf = (t: FunctionTypeDesc): ReadonlyArray<FieldDesc> =>
	t.kind === "value" ? [t.type] : t.heading.flatMap((f) => typesOf(f.type))

/** The headings a type names: the heading it is rows or a row of, then each heading a field of that one names. */
const headingsOf = (t: FunctionTypeDesc): ReadonlyArray<HeadingDesc> =>
	t.kind === "value" ? [] : [t.heading, ...t.heading.flatMap((f) => headingsOf(f.type))]

/**
 * Whether a signature's type is a closed id of a subset of its roster, through its contracts: a value of a subset comes
 * from a value of that subset (ir/scalar.ts subsetWithin), and no function's body is one, since the call casts its
 * value to the roster's domain alone, so a function's closed id is of its whole roster. A variant's arm field of a
 * subset is its domain's, which the call casts the function's value to (physical/ddl/variants.ts).
 */
const subsetId = (t: FieldDesc): boolean =>
	t.kind === "closedId" ? t.only !== undefined : t.kind === "contract" && subsetId(t.base)

/** The refusal of a signature over a type no declared function takes (signatureType), as the types name it. */
const signatureRefused = (loc: SourceLoc): CompileError =>
	ruleRefused(
		loc,
		"a declared function takes and returns values of a base type, a closed id, a digest, a contract or a refined text over one, or a variant: no serial, money, exact value, bytes, set, range or vector"
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

/** The headings a declared function's signature names, each once a use: those its arguments and its result are rows
 * or a row of, and every heading a field of one of them names. */
const signatureHeadings = (fn: FunctionDesc): ReadonlyArray<HeadingDesc> =>
	[...fn.args.map((a) => a.type), fn.returns].flatMap(headingsOf)

/**
 * Each function's body held to the row types its level holds for it: every heading it names is one its own signature
 * names (signatureHeadings), a heading a field of its arguments' or its result's holds among them, or a callee's
 * signature does, each of its own level (callsHeld), whose row types the installation creates before the function. A
 * heading no signature of the function's reach names may stand in no schema of its level, or stand there for another
 * function alone and go with it, so naming one is refused.
 */
const bodiesHeld = (
	functions: Readonly<Record<string, OwnedFunction>>
): Result.Result<Readonly<Record<string, OwnedFunction>>, CompileError> => {
	for (const fn of Object.values(functions)) {
		const held = [
			...signatureHeadings(fn.desc),
			...fn.desc.calls.flatMap((callee) =>
				signatureHeadings(
					defined(functions[callee], `the function ${callee} ${fn.name} calls`).desc
				)
			)
		]
		for (const placeholder of fn.desc.body.named) {
			if ("spelling" in placeholder) {
				continue
			}
			const { rowType } = placeholder
			if (!held.some((h) => sameContent(h, rowType))) {
				return Result.err(
					malformedDescription(
						fn.desc.loc,
						`the row types function ${fn.name}'s body names as those of the headings its own signature or its callees' names; it names the row type of fields ${rowType.map((f) => f.name).join(", ")}, which none of them does`
					)
				)
			}
		}
	}
	return Result.ok(functions)
}

/**
 * Each function the levels declare, by name: one namespace across every level, since a call names a function by its
 * declaration alone, each name parsed by the declared-name rule (IdentifierCollision for two whose conversions agree),
 * each argument's and its result's types ones a signature takes, its calls those of its own level's functions in a call
 * graph of no cycle (callsHeld), and every heading its body names one its signature or a callee's takes or returns
 * (bodiesHeld). A function's level is the one that declares it.
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
				const loc = labeledChildLoc(fn.loc, at, `function ${fn.name} ${at}`)
				if (!typesOf(t).every(signatureType)) {
					return Result.err(signatureRefused(loc))
				}
				if (typesOf(t).some(subsetId)) {
					return Result.err(
						ruleRefused(
							loc,
							"a declared function's closed id is of its whole roster: no function's body is a value of a subset"
						)
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
	return Result.flatMap(callsHeld(out), bodiesHeld)
}

/** A level's functions in canonical order, by name: what its canonical Description holds. */
export const canonicalFunctions = (schema: SchemaDesc): ReadonlyArray<FunctionDesc> =>
	(schema.functions ?? []).toSorted((a, b) => compareStrings(a.name, b.name))
