import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { KeyClasses, KeyFactors } from "#compiler/ir/keys.ts"
import type {
	CompletedOrder,
	GroupOrders,
	Heading,
	HeadingColumn,
	OrderKey
} from "#compiler/ir/rel.ts"
import { typeLabel } from "#compiler/ir/scalar.ts"
import { breaksTies, hasCapability } from "#compiler/scalar/registry.ts"

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
	/**
	 * A key's columns in the order of the declared key they copy (logical/key-order.ts declaredKeyOrder), the order a
	 * chosen key's columns are appended in.
	 */
	readonly keyOrder: (columns: ReadonlyArray<string>) => ReadonlyArray<string>
	/** Where the order was stated, the prefix of every diagnostic. */
	readonly loc: SourceLoc
}

const identity = (c: HeadingColumn): string => c.name

/**
 * What a delivered relation's order is completed over (completeGroups): the subject of its rows, where they are of one
 * heading group; over a heterogeneous union, the subject of its rows over the columns every group holds, its keys those
 * that tell any two of its rows apart (`common`), its discriminant, which tells the groups apart, and each group's own
 * subject, in group order.
 */
export type GroupedSubject =
	| { readonly kind: "one"; readonly subject: OrderSubject }
	| {
			readonly kind: "groups"
			readonly common: OrderSubject
			readonly discriminant: ReadonlyArray<string>
			readonly groups: NonEmptyReadonlyArray<OrderSubject>
	  }

/** A failed completion at `loc`: why the order cannot be completed. */
const failAt = (loc: SourceLoc, tag: ProseTag, capability: string) =>
	Result.err(CompileError.make(prose(tag, loc, capability)))

/**
 * The keys `user` states over `subject`'s heading, each a field of it, once, of an admitted order, in their sequence
 * and directions; or why they are none.
 */
const statedKeys = (
	subject: OrderSubject,
	user: ReadonlyArray<OrderKey>
): Result.Result<ReadonlyArray<OrderKey>, CompileError> => {
	const columns = new Map(subject.heading.map((c) => [c.name, c]))
	const named = new Set<string>()
	const keys: Array<OrderKey> = []
	for (const k of user) {
		const column = columns.get(k.column)
		if (column === undefined) {
			return failAt(
				subject.loc,
				"MalformedDescription",
				`an order field of the final result heading; ${k.column} is not one of ${subject.heading.length === 0 ? "no field" : subject.heading.map((c) => c.name).join(", ")}`
			)
		}
		if (named.has(k.column)) {
			return failAt(
				subject.loc,
				"MalformedDescription",
				`each order field once; ${k.column} repeats`
			)
		}
		if (!hasCapability(column.type, "ordering")) {
			return failAt(
				subject.loc,
				"UnsupportedOperation",
				`ordering: ${k.column} of type ${typeLabel(column.type)} has no admitted order`
			)
		}
		named.add(k.column)
		keys.push({ column: k.column, dir: k.dir })
	}
	return Result.ok(keys)
}

/**
 * Whether `keys`, with the columns `subject` fixes per evaluation, hold one of its keys whole: every factor of it has a
 * minimal key each of whose classes has a column among them.
 */
const holdsKey = (subject: OrderSubject, keys: ReadonlyArray<OrderKey>): boolean => {
	const settled = new Set([...keys.map((k) => k.column), ...subject.fixed])
	return subject.keys.some((factors) =>
		factors.every((alternatives) =>
			alternatives.some((classes) =>
				classes.every((members) => members.some((c) => settled.has(c)))
			)
		)
	)
}

/**
 * `stated` cut after its first prefix that holds a key of `subject` with the columns it fixes (holdsKey), the empty one
 * among them: no two of its rows tie on that prefix, so every key after it is functionally determined by it and orders
 * nothing. The completed order is this prefix completed, the one derivation its every reader reads, the index a take or
 * a page seeks by (physical/indexes/engine.ts), the ORDER BY a statement prints and a page's row comparison, so they
 * cannot disagree, and none holds a column the order never needed: PostgreSQL trims no functionally dependent ORDER BY
 * column, so a printed one would keep a key's own index from ordering the read, and an index requested over one may
 * be one no B-tree entry holds (a text of no byte bound). `stated` whole where no prefix holds a key.
 */
const keyedPrefix = (
	subject: OrderSubject,
	stated: ReadonlyArray<OrderKey>
): ReadonlyArray<OrderKey> => {
	for (let length = 0; length < stated.length; length += 1) {
		const prefix = stated.slice(0, length)
		if (holdsKey(subject, prefix)) {
			return prefix
		}
	}
	return stated
}

/**
 * The completed total order of `subject`, rows of one heading group, that begins with `user` cut after its first
 * keyed prefix (keyedPrefix), or why there is none (completeFrom, after the user's keys are read: statedKeys).
 */
export const completeOrder = (
	subject: OrderSubject,
	user: ReadonlyArray<OrderKey>
): Result.Result<CompletedOrder, CompileError> =>
	Result.flatMap(statedKeys(subject, user), (keys) => completeFrom(subject, keys))

/**
 * The completed orders of a delivered relation that begin with `user`, each cut after its first keyed prefix
 * (keyedPrefix), one per heading group, in group order, or why there are none (ir/rel.ts GroupOrders).
 *
 * Rows of one heading group are completed as one relation (completeFrom). Over a heterogeneous union the user's keys,
 * fields every group holds, order rows across groups; where they hold no key of the union, two rows of different
 * groups may tie on them, and the discriminant follows them, ascending, a closed id's in its roster's order, so rows of
 * different groups never tie on the run. Where a key of the union lies within the fields every group holds, the union
 * has a result key, and its rows are ordered by it: the run completed over the union's own subject (`common`), its
 * key's fields appended, one comparator of every row, each group's order. Only a union with no such key orders each
 * group apart: the run completed over the group's own rows, by the group's key, its fields in declared key order, or
 * its whole heading, which no key of the union need complete, every group's heading being its rows' key. So rows of
 * two groups compare by the run, and a group's rows by its order.
 */
export const completeGroups = (
	subject: GroupedSubject,
	user: ReadonlyArray<OrderKey>
): Result.Result<GroupOrders, CompileError> => {
	switch (subject.kind) {
		case "one":
			return Result.map(completeOrder(subject.subject, user), (order): GroupOrders => [order])
		case "groups":
			return Result.flatMap(statedKeys(subject.common, user), (keys) => {
				const named = new Set(keys.map((k) => k.column))
				const run: ReadonlyArray<OrderKey> = holdsKey(subject.common, keys)
					? keys
					: [
							...keys,
							...subject.discriminant
								.filter((d) => !named.has(d) && !subject.common.fixed.includes(d))
								.map((column): OrderKey => ({ column, dir: "asc" }))
						]
				const common = completeFrom(subject.common, run)
				return common.ok && holdsKey(subject.common, common.value.keys)
					? Result.ok(mapNonEmpty(subject.groups, () => common.value))
					: Result.eachNonEmpty(subject.groups, (group) => completeFrom(group, run))
			})
	}
}

/**
 * The completed total order of `subject`, rows of one heading group, that begins with the keys `stated`, columns of its
 * heading, each once; or why there is none.
 *
 * Completing a user order into a total order without changing the answer.
 *
 * Start from the exact distinct result and the user's ordered fields, keeping their sequence and directions:
 *
 * 1. If those fields, with the columns fixed per evaluation, already determine a result tuple under valid current
 *    evidence, they form a total order.
 * 2. Otherwise append a proved candidate key retained in the final heading, skipping fields already ordered. The key is
 *    chosen by one deterministic policy: fewest additional fields, then the names of the additional columns, compared
 *    in that order. Its fields are appended ascending, in the order of the declared key they copy (subject `keyOrder`),
 *    so the key's own unique index delivers the order; a field that copies none follows, in heading order. A key is
 *    over classes of equal columns, so a
 *    class with a column ordered or fixed needs nothing more, and another adds its orderable column of least name: of
 *    every key one column per class gives, that is the one the policy chooses.
 * 3. If no narrower retained key is proved, append the remaining result fields, provided each has a native order
 *    compatible with equality (breaksTies): an admitted order, or a closed id's codes, an unordered roster's among them,
 *    which never move, though no order the caller states reads them. They follow the declared key they copy where they
 *    lie within one (subject `keyOrder`), as a heading that is its own key does, else canonical heading order.
 * 4. If no total order results, refuse with an actionable error: retaining a public key in find may resolve it, and a
 *    hidden row id never will.
 *
 * The zero-column relation has the empty comparison tuple. The same completion serves take, so a bounded subset is
 * never an arbitrary choice among ties.
 *
 * Evidence is contextual: the keys read here are the subject's logical keys for the context it is compiled for, so a
 * deferred law that may be temporarily false never completes an order.
 *
 * One heading group is a set of its whole heading.
 */
const completeFrom = (
	subject: OrderSubject,
	stated: ReadonlyArray<OrderKey>
): Result.Result<CompletedOrder, CompileError> => {
	const columns = new Map(subject.heading.map((c) => [c.name, c]))
	const keys: Array<OrderKey> = [...keyedPrefix(subject, stated)]
	const ordered = new Set(keys.map((k) => k.column))
	const fixed = new Set(subject.fixed)
	const settled = (c: string) => ordered.has(c) || fixed.has(c)
	/** Appends `column`, ascending: never a settled one, which the key's classes and the heading's walk each skip. */
	const append = (column: string) => {
		ordered.add(column)
		keys.push({ column, dir: "asc" })
	}
	if (subject.heading.length === 0 || holdsKey(subject, keys)) {
		return Result.ok({ keys })
	}
	const orderable = (c: string): boolean => {
		const column = columns.get(c)
		return column !== undefined && breaksTies(column.type)
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
			const [least] = members.filter(orderable).toSorted(compareStrings)
			if (least === undefined) {
				return undefined
			}
			chosen.push(least)
		}
		return chosen.toSorted(compareStrings)
	}
	/** Fewer names first, then the sorted names compared in order. */
	const fewer = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
		if (a.length !== b.length) {
			return a.length - b.length
		}
		for (const [i, x] of a.entries()) {
			const d = compareStrings(x, defined(b[i], "two candidates of one width"))
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
					identities: additional.map(identity).toSorted(compareStrings)
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
				const d = compareStrings(x, y)
				if (d !== 0) {
					return d
				}
			}
			return 0
		})
	const chosen = candidates[0]
	if (chosen !== undefined) {
		for (const c of subject.keyOrder(chosen.additional)) {
			append(c)
		}
		return Result.ok({ keys })
	}
	const remaining = subject.heading.filter((c) => !settled(c.name)).map((c) => c.name)
	for (const name of subject.keyOrder(remaining)) {
		const type = defined(columns.get(name), "a remaining field of the heading").type
		if (!breaksTies(type)) {
			return failAt(
				subject.loc,
				"UnsupportedOperation",
				`ordering: completing the order needs ${name}, whose type ${typeLabel(type)} has no admitted order; retain a key of the result in find`
			)
		}
		append(name)
	}
	return Result.ok({ keys })
}
