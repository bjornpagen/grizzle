/**
 * variant(name, roster, arms): a typed sum (ir/scalar.ts VariantType), one of a closed roster's arms, each a heading of
 * typed fields. A field of it holds one value: its arm's handle and a value of each of that arm's fields; the
 * installation stores it as one column of the variant's domain over its composite (physical/ddl/variants.ts).
 *
 * Its admission reads what a JavaScript caller passes once (core/host.ts hostRead): the name, a declared name; the
 * roster, a closed relation's (schema/relation.ts closedIdOf); and the arms, a plain record of at least one arm, each
 * named by a live handle of the roster, so the handles its arms name are the subset of the roster the variant holds,
 * every handle or some, as closedId(roster, { only }) holds one; each arm a plain record of field descriptors a builder
 * made (scalar/registry.ts describeField), each named by a declared name other than `tag`, which names the arm itself in
 * a value, of a type an arm holds (scalar/registry.ts isArmFieldType). Its Description lists the arms in the roster's
 * handle order, so two spellings of one variant are one, and its column reads each arm's fields by their own
 * descriptors' columns.
 *
 * A query's union is homogeneous, its rules sharing the query's one heading; a heterogeneous need, rows of several
 * shapes in one result, is restated as one heading holding a variant cell (a census of every consumer, 2026-11-25,
 * found none to restate).
 */
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { type Column, variantColumn } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription, ruleRefused } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { isPlainRecord, isRecord } from "#compiler/core/record.ts"
import { decodeDesc, type ExprDesc, type FieldDesc } from "#compiler/ir/desc.ts"
import { type Roster, rosterOf } from "#compiler/ir/scalar.ts"
import type { ClosedIdParts } from "#compiler/scalar/closed-id.ts"
import {
	computeCore,
	scalarTerm,
	armFieldTerm as armField,
	variantTag
} from "#compiler/scalar/compute/builders.ts"
import { predicateExpr, typedTermOf } from "#compiler/scalar/compute/term.ts"
import {
	carrierSql,
	type Described,
	defineField,
	describeField,
	type ScalarEnv,
	variantTagField
} from "#compiler/scalar/registry.ts"
import { rowHelpers } from "#compiler/schema/terms.ts"

/**
 * One arm as its admission read it: its handle, its fields, each by name with its descriptor, in declared order, and its
 * check (ir/desc.ts VariantArmDesc `check`), none where the variant states none for it.
 */
export interface VariantArmParts {
	readonly handle: string
	readonly fields: ReadonlyArray<readonly [string, Described]>
	readonly check: ExprDesc | undefined
}

/** What a variant's admission read: its name, its roster's parts and its arms in the roster's handle order. */
export interface VariantParts {
	readonly name: string
	readonly roster: ClosedIdParts
	readonly arms: ReadonlyArray<VariantArmParts>
	readonly loc: SourceLoc
}

const malformed = (loc: SourceLoc, what: string): CompileError => malformedDescription(loc, what)

/** A function the schema's author passes, a check's or a cases' handler, called with one argument as the author wrote it. */
type AuthorCallback = (argument: unknown) => unknown

/** One arm's fields, read from the caller's record: each a declared name other than `tag`, its descriptor a builder's. */
const readArm = (
	arm: unknown,
	loc: SourceLoc
): Result.Result<ReadonlyArray<readonly [string, Described]>, CompileError> => {
	if (!isPlainRecord(arm)) {
		return Result.err(malformed(loc, "an arm: a record of its fields' descriptors"))
	}
	const fields: Array<readonly [string, Described]> = []
	for (const name of Object.keys(arm)) {
		const fieldLoc = childLoc(loc, name)
		if (name === variantTagField) {
			return Result.err(
				ruleRefused(fieldLoc, "a variant arm's field is named apart from tag, which names its arm")
			)
		}
		if (!parseDeclaredName(name).ok) {
			return Result.err(malformed(fieldLoc, "an arm's field named by a declared name"))
		}
		const described = describeField(arm[name], fieldLoc)
		if (!described.ok) {
			return described
		}
		fields.push([name, described.value] as const)
	}
	return Result.ok(fields)
}

/**
 * The arms the caller's record states, in the roster's handle order: each named by a live handle of the roster, the
 * subset the variant holds, each read by readArm; a record of none is refused where its Description is typed, which
 * holds a variant to at least one arm (scalar/registry.ts variantAt). Its reading runs the caller's code at most once
 * (hostRead): a value whose reading throws is refused.
 */
export const readArms = (
	arms: unknown,
	roster: ClosedIdParts,
	loc: SourceLoc
): ReadonlyArray<VariantArmParts> => {
	const read = hostRead(
		() => malformed(loc, "a variant's arms whose properties can be read: no refusing proxy"),
		(): Result.Result<ReadonlyArray<VariantArmParts>, CompileError> => {
			if (!isPlainRecord(arms)) {
				return Result.err(
					malformed(loc, "a variant's arms: a record of arms, each named by a handle of its roster")
				)
			}
			const handles = roster.roster.handles
			const keys = Object.keys(arms)
			if (keys.some((key) => !handles.includes(key))) {
				return Result.err(
					ruleRefused(loc, "a variant holds at least one arm, each named by a handle of its roster")
				)
			}
			const out: Array<VariantArmParts> = []
			for (const handle of handles.filter((h) => keys.includes(h))) {
				const fields = readArm(arms[handle], childLoc(loc, handle))
				if (!fields.ok) {
					return fields
				}
				out.push({ handle, fields: fields.value, check: undefined })
			}
			return Result.ok(out)
		}
	)
	if (!read.ok) {
		throw read.error
	}
	return read.value
}

/**
 * The environment a variant's descriptor resolves its rosters in: its tag's, which its roster's parts type, and each
 * roster an arm's field reads, a closed id's or a set's, which that field's own descriptor typed.
 */
const variantEnv = (parts: VariantParts): ScalarEnv => {
	const rosters = new Map<string, Roster>()
	for (const arm of parts.arms) {
		for (const [, described] of arm.fields) {
			const roster = rosterOf(described.scalar)
			if (roster !== undefined) {
				rosters.set(roster.closed, roster)
			}
		}
	}
	return {
		kind: "builder",
		roster: (name) =>
			name === parts.roster.roster.closed ? parts.roster.env.roster(name) : rosters.get(name)
	}
}

/** The Description of a variant (ir/desc.ts FieldDesc variant): its name, its roster and its arms' fields' descriptors. */
export const variantDesc = (parts: VariantParts): FieldDesc => ({
	kind: "variant",
	name: parts.name,
	roster: parts.roster.roster.closed,
	arms: parts.arms.map((arm) => ({
		handle: arm.handle,
		fields: arm.fields.map(([name, described]) => ({ name, desc: described.desc })),
		check: arm.check
	}))
})

/**
 * The arms of `parts` with each check `checks` states (variant's fourth argument): a record of at most one predicate
 * callback per handle of an arm with a field, each given a row of that arm's fields of the variant's VALUE as terms,
 * each carried by its field's descriptor in `arms`, the record the caller gave the variant, beside the row helpers a
 * row check compares them with (schema/terms.ts rowHelpers), and recorded as the predicate it returns, a predicate over
 * VALUE that reads that arm's fields alone, which the variant's domain's CHECK holds under the arm's code
 * (physical/ddl/variants.ts). The VALUE is of the type of the variant's descriptor without checks, described first, its
 * refusal thrown whether checks are stated or not. Its reading runs the caller's code at most once (core/host.ts
 * hostRead), each callback once.
 */
export const armChecks = (
	parts: VariantParts,
	arms: unknown,
	checks: unknown
): ReadonlyArray<VariantArmParts> => {
	const described = describeField(variantField(parts, {}), parts.loc)
	if (!described.ok) {
		throw described.error
	}
	const unchecked = described.value
	if (checks === undefined) {
		return parts.arms
	}
	const loc = childLoc(parts.loc, "checks")
	const read = hostRead(
		() => malformed(loc, "a variant's checks whose properties can be read: no refusing proxy"),
		(): Result.Result<ReadonlyArray<readonly [string, AuthorCallback]>, CompileError> => {
			if (!isPlainRecord(checks) || !isPlainRecord(arms)) {
				return Result.err(
					malformed(loc, "a variant's checks: a record of a predicate callback per arm")
				)
			}
			const out: Array<readonly [string, AuthorCallback]> = []
			for (const handle of Object.keys(checks)) {
				const callback = checks[handle]
				const arm = parts.arms.find((a) => a.handle === handle)
				if (arm === undefined || arm.fields.length === 0 || typeof callback !== "function") {
					return Result.err(
						malformed(
							childLoc(loc, handle),
							"a predicate callback (arm) => predicate of an arm of the variant with a field"
						)
					)
				}
				out.push([
					handle,
					(row: unknown): unknown => Reflect.apply(callback, undefined, [row])
				] as const)
			}
			return Result.ok(out)
		}
	)
	if (!read.ok) {
		throw read.error
	}
	const value = scalarTerm({ kind: "value" }, unchecked.scalar, unchecked)
	const stated = new Map(read.value)
	return parts.arms.map((arm): VariantArmParts => {
		const callback = stated.get(arm.handle)
		if (callback === undefined) {
			return arm
		}
		const declared = isPlainRecord(arms) ? arms[arm.handle] : undefined
		const row: Record<string, unknown> = { ...rowHelpers }
		for (const [name] of arm.fields) {
			row[name] = armField(
				value,
				arm.handle,
				name,
				isPlainRecord(declared) ? declared[name] : undefined
			)
		}
		const built = callback(Object.freeze(row))
		const expr = predicateExpr(built)
		if (expr === undefined) {
			throw malformed(
				childLoc(loc, arm.handle),
				"a predicate built from the arm's fields' comparisons"
			)
		}
		const owned = decodeDesc("expr", expr)
		if (!owned.ok) {
			throw owned.error
		}
		return { ...arm, check: owned.value }
	})
}

/** The column of a variant: its tag's roster and each arm's fields' columns (core/decoder.ts variantColumn). */
const variantColumnOf = <A>(parts: VariantParts): Column<A> =>
	variantColumn<A>(
		parts.roster.roster.closed,
		parts.arms.map((arm) => ({
			handle: arm.handle,
			fields: arm.fields.map(([name, described]) => [name, described.column] as const)
		}))
	)

/**
 * The descriptor of the variant `parts` admitted, frozen: its column, of host type A, beside `members`, which its public
 * constructor states (public/fields.ts variant): the name, roster and arms it was given, and the terms over it.
 */
export const variantField = <A, const M extends Readonly<Record<string, unknown>>>(
	parts: VariantParts,
	members: M
) =>
	defineField(
		{},
		carrierSql.variant,
		variantDesc(parts),
		{ ...members, column: variantColumnOf<A>(parts) },
		parts.loc,
		variantEnv(parts)
	)

/** The loc a variant's diagnostics name it by. */
export const variantLoc = (name: unknown): SourceLoc =>
	SourceLoc(`variant(${typeof name === "string" ? name : "?"})`, [])

/** A cases branch's value as its handler returned it: a term, or a JavaScript value, which takes the other branch's type. */
const isTerm = (value: unknown): boolean => typedTermOf(value) !== undefined

/**
 * `cases(x, handlers)` over a variant (public/fields.ts variant): one term per arm, a handler for every arm, each given
 * the arm's fields of `x` as terms, each carried by its field's descriptor in `arms`, the record the caller gave the
 * variant, its tag read by `tagColumn`, the variant's (public/fields.ts variant): `CASE x.tag WHEN … END`, the last arm
 * the ELSE, so the case analysis is exhaustive by construction and an arm's field is read only in its own branch. A
 * branch whose handler returns a JavaScript value takes the other branches' type; some branch is a term, which the
 * result's type and carrier are read from.
 */
export const variantCases = (
	parts: VariantParts,
	arms: unknown,
	tagColumn: Column<string>
): ((value: unknown, handlers: unknown) => Readonly<Record<string, unknown>>) => {
	return (value, handlers) => {
		const loc = childLoc(parts.loc, "cases")
		const read = hostRead(
			() => malformed(loc, "a cases's handlers whose properties can be read: no refusing proxy"),
			(): Result.Result<
				ReadonlyArray<
					readonly [VariantArmParts, AuthorCallback, Readonly<Record<string, unknown>>]
				>,
				CompileError
			> => {
				if (!isPlainRecord(handlers) || !isPlainRecord(arms)) {
					return Result.err(malformed(loc, "a handler for each arm of the variant"))
				}
				const handles = parts.arms.map((arm) => arm.handle)
				const keys = Object.keys(handlers)
				if (keys.length !== handles.length || keys.some((key) => !handles.includes(key))) {
					return Result.err(
						malformed(loc, `a handler for each arm of the variant: ${handles.join(", ")}`)
					)
				}
				const paired: Array<
					readonly [VariantArmParts, AuthorCallback, Readonly<Record<string, unknown>>]
				> = []
				for (const arm of parts.arms) {
					const handler = handlers[arm.handle]
					const declared = arms[arm.handle]
					if (typeof handler !== "function" || !isPlainRecord(declared)) {
						return Result.err(
							malformed(childLoc(loc, arm.handle), "a function of the arm's fields")
						)
					}
					paired.push([
						arm,
						(fields: unknown): unknown => Reflect.apply(handler, undefined, [fields]),
						declared
					] as const)
				}
				return Result.ok(paired)
			}
		)
		if (!read.ok) {
			throw read.error
		}
		const branches = read.value.map(([arm, handler, declared]) => {
			const fields = Object.fromEntries(
				arm.fields.map(
					([name]) => [name, armField(value, arm.handle, name, declared[name])] as const
				)
			)
			const branch = handler(Object.freeze(fields))
			return [arm.handle, branch] as const
		})
		const tag = variantTag(value, tagColumn)
		const [last, ...earlier] = branches.toReversed()
		if (last === undefined) {
			throw malformed(loc, "a variant of at least one arm")
		}
		let folded: unknown = last[1]
		for (const [handle, branch] of earlier) {
			if (isTerm(branch)) {
				folded = computeCore.cond(computeCore.eq(tag, handle), branch, folded)
			} else if (isTerm(folded)) {
				folded = computeCore.cond(computeCore.ne(tag, handle), folded, branch)
			} else {
				throw malformed(
					childLoc(loc, handle),
					"a term in some branch of a cases: two literals alone type no term; state one as Type.literal(type, value)"
				)
			}
		}
		if (!isTerm(folded) || !isRecord(folded)) {
			throw malformed(loc, "a term in some branch of a cases, which its type is read from")
		}
		return folded
	}
}
