import { appendAll } from "#compiler/core/array.ts"
import { compareText } from "#compiler/core/canonical.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { KeyClasses, KeyFactors } from "#compiler/ir/keys.ts"
import type { CompletedOrder, Heading, HeadingColumn, OrderKey } from "#compiler/ir/rel.ts"
import { typeLabel } from "#compiler/ir/scalar.ts"
import { hasCapability } from "#compiler/scalar/registry.ts"

export interface OrderSubject {
	/** The exact distinct result heading. */
	readonly heading: Heading
	/**
	 * Its proved keys relative to the parameters and outer variables, those whose proofs hold in the context the order
	 * is read in (logical/annotate.ts orderSubjectOf), each over its factors and classes of equal columns: one minimal
	 * key of each factor, one column of each of its classes, together, are a key.
	 */
	readonly keys: ReadonlyArray<KeyFactors>
	/**
	 * Columns constant per evaluation (a parameter, an outer variable, a take's correlation): they break no tie and are
	 * never appended.
	 */
	readonly fixed: ReadonlyArray<string>
	/** The literal discriminant of a union of arms with different headings, empty for one heading group. */
	readonly discriminant: ReadonlyArray<string>
	/** Where the order was stated, the prefix of every diagnostic. */
	readonly loc: SourceLoc
}

const identity = (c: HeadingColumn): string => c.name

/**
 * The completed total order of `subject` that begins with `user`, or why there is none.
 *
 * Completing a user order into a total order without changing the answer.
 *
 * Start from the exact distinct result and the user's ordered fields, keeping their sequence and directions:
 *
 * 1. If those fields, with the columns fixed per evaluation, already determine a result tuple under valid current
 *    evidence, they form a total order.
 * 2. Otherwise append a proved candidate key retained in the final heading, skipping fields already ordered. The key is
 *    chosen by one deterministic policy: fewest additional fields, then the names of the additional columns, compared
 *    in that order. Its fields are appended in heading order, ascending. A key is over classes of equal columns, so a
 *    class with a column ordered or fixed needs nothing more, and another adds its orderable column of least name: of
 *    every key one column per class gives, that is the one the policy chooses.
 * 3. If no narrower retained key is proved, append the remaining result fields in canonical heading order, provided
 *    each has a native order compatible with equality.
 * 4. If no total order results, refuse with an actionable error: retaining a public key in find may resolve it, and a
 *    hidden row id never will.
 *
 * Over a union of arms with different headings, ordering uses the fields common to every arm and the discriminant's
 * roster order completes ties across arms: after the user's fields the discriminant is appended, ascending, so arms
 * are ordered by their roster position (enum order is roster order), and only then is the order completed
 * within the arms by the union's keys. The zero-column relation has the empty comparison tuple. The same
 * completion serves take, so a bounded subset is never an arbitrary choice among ties.
 *
 * Evidence is contextual: the keys read here are the subject's logical keys for the context it is compiled for, so a
 * deferred law that may be temporarily false never completes an order.
 *
 * The discriminant's roster order completes ties across arms of different headings.
 *
 * One heading group is a set of its whole heading; arms of different headings are told apart only by a key.
 */
export const completeOrder = (
	subject: OrderSubject,
	user: ReadonlyArray<OrderKey>
): Result.Result<CompletedOrder, CompileError> => {
	const loc = subject.loc
	const fail = (tag: ProseTag, capability: string) =>
		Result.err(CompileError.make(prose(tag, loc, capability)))
	const columns = new Map(subject.heading.map((c) => [c.name, c]))
	const ordered = new Set<string>()
	const keys: Array<OrderKey> = []
	for (const k of user) {
		const column = columns.get(k.column)
		if (column === undefined) {
			return fail(
				"MalformedDescription",
				`an order field of the final result heading; ${k.column} is not one of ${subject.heading.length === 0 ? "no field" : subject.heading.map((c) => c.name).join(", ")}`
			)
		}
		if (ordered.has(k.column)) {
			return fail("MalformedDescription", `each order field once; ${k.column} repeats`)
		}
		if (!hasCapability(column.type, "ordering")) {
			return fail(
				"UnsupportedOperation",
				`ordering: ${k.column} of type ${typeLabel(column.type)} has no admitted order`
			)
		}
		ordered.add(k.column)
		keys.push({ column: k.column, dir: k.dir })
	}
	const fixed = new Set(subject.fixed)
	const settled = (c: string) => ordered.has(c) || fixed.has(c)
	/** Whether some key's every factor has a minimal key each of whose classes has a column ordered or fixed. */
	const total = () =>
		subject.keys.some((factors) =>
			factors.every((alternatives) =>
				alternatives.some((classes) => classes.every((members) => members.some(settled)))
			)
		)
	const append = (column: string) => {
		if (ordered.has(column) || fixed.has(column)) {
			return
		}
		ordered.add(column)
		keys.push({ column, dir: "asc" })
	}
	if (subject.heading.length === 0 || total()) {
		return Result.ok({ keys })
	}
	for (const d of subject.discriminant) {
		if (columns.has(d)) {
			append(d)
		}
	}
	if (total()) {
		return Result.ok({ keys })
	}
	const orderable = (c: string): boolean => {
		const column = columns.get(c)
		return column !== undefined && hasCapability(column.type, "ordering")
	}
	/**
	 * The columns a minimal key of a factor adds: each class not yet ordered or fixed, by its orderable column of least
	 * name, sorted by name; undefined when such a class has no orderable column.
	 */
	const adding = (classes: KeyClasses): ReadonlyArray<string> | undefined => {
		const chosen: Array<string> = []
		for (const members of classes) {
			if (members.some(settled)) {
				continue
			}
			const [least] = members.filter(orderable).toSorted(compareText)
			if (least === undefined) {
				return undefined
			}
			chosen.push(least)
		}
		return chosen.toSorted(compareText)
	}
	/** Fewer names first, then the sorted names compared in order. */
	const fewer = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
		if (a.length !== b.length) {
			return a.length - b.length
		}
		for (const [i, x] of a.entries()) {
			const d = compareText(x, b[i] ?? x)
			if (d !== 0) {
				return d
			}
		}
		return 0
	}
	/**
	 * A proved candidate key narrower than the whole heading: fewest additional fields, then the column names.
	 *
	 * A key's factors are independent and their columns disjoint, so each factor's minimal key of fewest additional
	 * columns, then least names, together are the key of fewest additional columns, then least names: two choices first
	 * differ where one factor's do. As many identities as additional fields, and the counts are equal here.
	 */
	const candidates = subject.keys
		.flatMap((factors) => {
			const chosen: Array<string> = []
			let classes = 0
			for (const alternatives of factors) {
				const [best] = alternatives
					.flatMap((alternative) => {
						const adds = adding(alternative)
						return adds === undefined ? [] : [{ adds, classes: alternative.length }]
					})
					.toSorted((a, b) => fewer(a.adds, b.adds))
				if (best === undefined) {
					return []
				}
				appendAll(chosen, best.adds)
				classes += best.classes
			}
			if (classes >= subject.heading.length) {
				return []
			}
			const set = new Set(chosen)
			/** The chosen columns, in heading order. */
			const additional = subject.heading.filter((c) => set.has(c.name))
			return [
				{
					additional: additional.map((c) => c.name),
					identities: additional.map(identity).toSorted(compareText)
				}
			]
		})
		.toSorted((a, b) => {
			if (a.additional.length !== b.additional.length) {
				return a.additional.length - b.additional.length
			}
			for (const [i, x] of a.identities.entries()) {
				const y = b.identities[i]
				if (y === undefined) {
					break
				}
				const d = compareText(x, y)
				if (d !== 0) {
					return d
				}
			}
			return 0
		})
	const chosen = candidates[0]
	if (chosen !== undefined) {
		for (const c of chosen.additional) {
			append(c)
		}
		return Result.ok({ keys })
	}
	/** The remaining result fields, in canonical heading order. */
	const discriminated = subject.discriminant.length > 0
	for (const c of subject.heading) {
		if (ordered.has(c.name) || fixed.has(c.name)) {
			continue
		}
		if (!hasCapability(c.type, "ordering")) {
			return fail(
				"UnsupportedOperation",
				`ordering: completing the order needs ${c.name}, whose type ${typeLabel(c.type)} has no admitted order; retain a key of the result in find`
			)
		}
		append(c.name)
	}
	if (!discriminated || total()) {
		return Result.ok({ keys })
	}
	return fail(
		"UnsupportedOperation",
		"ordering: a completed total order over the fields common to every arm; no key of the union lies within them, so retain a key in each arm's find"
	)
}
