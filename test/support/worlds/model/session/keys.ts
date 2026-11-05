import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { valueText } from "#test/pg/laws/families/model.ts"
import { relationSpecOf } from "#test/support/worlds/model/session/state.ts"
import { keysOf } from "#test/support/worlds/model/session/writes.ts"
import type {
	BaseSpec,
	ClosedSpec,
	DerivedSpec,
	EntrySpec,
	Occurrence,
	Rule,
	Source,
	Term
} from "#test/support/worlds/model/types.ts"

/**
 * The keys grizzle proves of a role relation, which `db.get` reads by (packages/engine/src/ir/keys.ts, logical/props.ts,
 * logical/closure.ts, analysis/derived/world.ts, analysis/logical/get.ts): a get is eligible exactly when one of the
 * relation's keys lies within the fields it binds, since the read binds them to literals and only a key whose every
 * column is a literal leaves at most one row.
 *
 * - An ordinary relation: its primary key and each declared key. A closed roster: its handle (its values distinct), or
 *   nothing at all when it has at most one member. A derived relation: its definition's keys, as a world relation's.
 * - A world relation (a query entry), or a derived one: its definition's minimal keys, each a set of head fields, or its
 *   first head field in canonical order when the definition has at most one fact (inheritedKeys keys such a view by
 *   that one column), or the whole heading when nothing narrower is proven.
 * - One rule (a match region under a projection, logical/props.ts projectProps): the rule states dependencies over its
 *   variables: a scan determines every variable it binds once each column of one of its source's keys is bound to a
 *   known variable, a literal or a context field; a context has at most one fact, so its scan needs nothing; an
 *   equality comparison with a literal or a context field fixes its variable, and one between two variables equates
 *   them; a negation only filters (an AntiJoin keeps the left's dependencies). The projection keeps each determinant
 *   (a source key every field of which the occurrence binds, a side of an equality of two variables) whose variables,
 *   the fixed ones aside, each have a head field standing for them (its first copy in canonical order, or the first copy
 *   of a variable that alone determines it), and every head field copying a variable, alone: each determines every head
 *   field its closure reaches, so two copies of one variable determine each other. Head fields are a key when, with
 *   the fields nothing determines, they reach the whole heading by those dependencies.
 * - Several rules (a Union of one heading group): a key of every arm, every two arms told apart by a head field both
 *   fix to different literals, the columns every arm fixes to one literal taken as given; its union keys are the arms'
 *   keys with the separators added, minimized greedily from the end of the heading (no exchange), and the whole
 *   heading. Two head fields equal in every row of every arm (copies of variables one class of its rule's equalities
 *   of two variables) are equal in the union, so its keys are every minimal set that reaches the heading by those
 *   equalities, the columns fixed alike and the union keys.
 *
 * grizzle finds every minimal key of the dependencies it states, with no bound, and so does the model.
 */

/** A relation's minimal keys as grizzle proves them, each in heading order. */
type Keys = ReadonlyArray<ReadonlyArray<string>>

const byText = Order.String

/** A comparison's verdict. */
type Ordering = -1 | 0 | 1

/** A heading in canonical order (packages/engine/src/core/order.ts compareStrings: code-unit order). */
const canonical = (fields: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort([...new Set(fields)], byText)

/**
 * Key order (logical/closure.ts keyOrder): the shorter first, then the one holding the first heading column only one
 * holds.
 */
const keyOrder =
	(heading: ReadonlyArray<string>) =>
	(a: ReadonlyArray<string>, b: ReadonlyArray<string>): Ordering => {
		if (a.length !== b.length) {
			return a.length < b.length ? -1 : 1
		}
		for (const c of heading) {
			const inA = a.includes(c)
			if (inA !== b.includes(c)) {
				return inA ? -1 : 1
			}
		}
		return 0
	}

const within = (key: ReadonlyArray<string>, fields: ReadonlyArray<string>): boolean =>
	Arr.every(key, (c) => fields.includes(c))

/** The keys among `found` no shorter one lies within, in key order. */
const antichain = (
	heading: ReadonlyArray<string>,
	found: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.sort(
		Arr.filter(found, (k) => !Arr.some(found, (o) => o.length < k.length && within(o, k))),
		keyOrder(heading)
	)

/**
 * A view's keys from its definition's root keys (analysis/logical/derived.ts inheritedKeys): its first column when the
 * root has the empty key (at most one fact), the root's nonempty keys otherwise, the whole heading failing those.
 */
const inherited = (heading: ReadonlyArray<string>, root: Keys): Keys => {
	const [first] = heading
	if (Arr.some(root, (k) => k.length === 0)) {
		return [first === undefined ? heading : [first]]
	}
	const nonempty = Arr.filter(root, (k) => k.length > 0)
	return nonempty.length > 0 ? nonempty : [heading]
}

/** A closed roster's keys (props.ts Closed): nothing at all for at most one member, its handle otherwise. */
const closedKeys = (closed: ClosedSpec): Keys => (closed.members.length <= 1 ? [[]] : [["id"]])

/** A derived relation's keys: its materialized view's unique indexes, its definition's keys as a view's. */
export const derivedKeys = (base: BaseSpec, derived: DerivedSpec): Keys =>
	inherited(canonical(Rec.keys(derived.rules[0].head)), rulesKeys(base, derived.rules))

/** The keys of the relation a source names, as the scan over it sees them. */
const sourceKeys = (base: BaseSpec, source: Source): Keys => {
	switch (source.kind) {
		case "ordinary":
			return keysOf(base, source.name)
		case "context":
			return [[]]
		case "closed": {
			const closed = Option.getOrUndefined(
				Arr.findFirst(base.closed, (c) => c.name === source.name)
			)
			return closed === undefined ? [] : closedKeys(closed)
		}
		case "derived": {
			const derived = Option.getOrUndefined(
				Arr.findFirst(base.derived, (d) => d.name === source.name)
			)
			return derived === undefined ? [] : derivedKeys(base, derived)
		}
	}
}

/** The variables an occurrence binds. */
const varsOf = (o: Occurrence): ReadonlyArray<string> =>
	Arr.flatMap(Rec.values(o.fields), (t) => (t.kind === "var" ? [t.name] : []))

/** A term fixed per evaluation of the rule: a literal, a typed handle or a context's field. */
const fixedTerm = (t: Term): boolean =>
	t.kind === "literal" || t.kind === "handle" || t.kind === "context"

/** A constant's text: a literal's value or a typed handle's member, none for any other term. */
const constantText = (t: Term): string | undefined =>
	t.kind === "literal" ? valueText(t.value) : t.kind === "handle" ? valueText(t.member) : undefined

/** One rule as the region and projection grizzle builds of it. */
interface Arm {
	/** Its head fields in canonical order. */
	readonly heading: ReadonlyArray<string>
	/** Whether head fields determine every variable a head field copies. */
	readonly determines: (given: ReadonlyArray<string>) => boolean
	/** The literal a head field is fixed to in every row, by its text, when it is one. */
	readonly literalAt: (field: string) => string | undefined
	/** Its minimal keys, in key order; the empty key when the rule has at most one row. */
	readonly keys: Keys
	/** Whether two head fields are equal in every row: copies of variables its equalities of two variables join. */
	readonly equal: (a: string, b: string) => boolean
}

const armOf = (base: BaseSpec, rule: Rule): Arm => {
	const heading = canonical(Rec.keys(rule.head))
	const scans = Arr.map(rule.matches, (o) => ({
		occurrence: o,
		vars: varsOf(o),
		keys: sourceKeys(base, o.source)
	}))
	const equalities = Arr.filter(rule.comparisons, (c) => c.op === "=")
	/**
	 * The variables `start` determines by the dependencies the rule states: a scan determines every variable it binds
	 * once each column of one of its source's keys is bound to a known variable, a literal or a context field; an
	 * equality with a literal or a context field fixes its variable, and one between two variables equates them.
	 */
	const closure = (start: ReadonlyArray<string>): ReadonlySet<string> => {
		const known = new Set(start)
		const knownTerm = (t: Term): boolean => fixedTerm(t) || (t.kind === "var" && known.has(t.name))
		const learn = (name: string): boolean => {
			const before = known.size
			known.add(name)
			return known.size > before
		}
		let changed = true
		while (changed) {
			changed = false
			for (const s of scans) {
				const fires = Arr.some(s.keys, (k) =>
					Arr.every(k, (column) => {
						const t = s.occurrence.fields[column]
						return t !== undefined && knownTerm(t)
					})
				)
				if (fires) {
					for (const v of s.vars) {
						changed = learn(v) || changed
					}
				}
			}
			for (const c of equalities) {
				if (c.left.kind === "var" && knownTerm(c.right)) {
					changed = learn(c.left.name) || changed
				}
				if (c.right.kind === "var" && knownTerm(c.left)) {
					changed = learn(c.right.name) || changed
				}
			}
		}
		return known
	}
	/** Each variable's class under the equalities of two variables, by a member every variable of the class reaches. */
	const joined = new Map<string, string>()
	const classOf = (name: string): string => {
		let at = name
		for (let up = joined.get(at); up !== undefined; up = joined.get(at)) {
			at = up
		}
		return at
	}
	for (const c of equalities) {
		if (c.left.kind !== "var" || c.right.kind !== "var") {
			continue
		}
		const x = classOf(c.left.name)
		const y = classOf(c.right.name)
		if (x !== y) {
			joined.set(y, x)
		}
	}
	/** The variables nothing determines: a scan of a relation of at most one fact, a literal's or a context's equality. */
	const fixedVars = closure([])
	/** The variable a head field copies, none for a literal or a context field. */
	const copied = (field: string): string | undefined => {
		const t = rule.head[field]
		return t?.kind === "var" ? t.name : undefined
	}
	/** Each variable the head copies, with its first copy in canonical order (logical/props.ts projectProps `copies`). */
	const firstCopy = new Map<string, string>()
	for (const f of heading) {
		const x = copied(f)
		if (x !== undefined && !firstCopy.has(x)) {
			firstCopy.set(x, f)
		}
	}
	/**
	 * The head field standing for a variable: its first copy, else the first copy, in canonical order, of a variable
	 * that alone determines it; none when no copied variable does.
	 */
	const standFor = (x: string): string | undefined => {
		const own = firstCopy.get(x)
		if (own !== undefined) {
			return own
		}
		for (const [y, f] of firstCopy) {
			if (closure([y]).has(x)) {
				return f
			}
		}
		return undefined
	}
	/**
	 * The rule's determinants, the left sides of the dependencies its match region and filter state: each key of a
	 * scan's source every field of which the occurrence binds, read as the variables bound there (a literal or a context
	 * field is a constant, and a key with an unbound field states nothing), and each side of an equality of two variables.
	 */
	const determinants: ReadonlyArray<ReadonlyArray<string>> = [
		...Arr.flatMap(scans, (s) =>
			Arr.flatMap(s.keys, (k): ReadonlyArray<ReadonlyArray<string>> => {
				const terms = Arr.map(k, (column) => s.occurrence.fields[column])
				return Arr.every(terms, (t) => t !== undefined)
					? [Arr.flatMap(terms, (t) => (t.kind === "var" ? [t.name] : []))]
					: []
			})
		),
		...Arr.flatMap(equalities, (c) =>
			c.left.kind === "var" && c.right.kind === "var" ? [[c.left.name], [c.right.name]] : []
		)
	]
	/** The dependency head fields state: every other head field the closure of the variables they copy reaches. */
	const dependencyFrom = (fields: ReadonlyArray<string>) => {
		const reached = closure(
			Arr.flatMap(fields, (f) => {
				const x = copied(f)
				return x === undefined ? [] : [x]
			})
		)
		const to = Arr.filter(heading, (o) => {
			const x = copied(o)
			return !fields.includes(o) && (x === undefined || reached.has(x))
		})
		return { from: fields, to }
	}
	/**
	 * The projection's dependencies (projectProps): each determinant whose variables beside the fixed ones all have a
	 * head field standing for them, from those fields, and every head field copying a variable, alone, each determining
	 * every other head field its closure reaches, a copy of a reached variable or a literal or context field. So two
	 * copies of one variable, or of equal ones, determine each other.
	 */
	const dependencies = [
		...Arr.flatMap(determinants, (d) => {
			const from = Arr.map(
				Arr.filter(d, (x) => !fixedVars.has(x)),
				standFor
			)
			return Arr.every(from, (f) => f !== undefined) ? [dependencyFrom(from)] : []
		}),
		...Arr.flatMap(heading, (f) => (copied(f) === undefined ? [] : [dependencyFrom([f])]))
	]
	/** A head field no key needs: a literal, a context's field, or a copy of a variable determined by nothing. */
	const fixedField = (field: string): boolean => {
		const t = rule.head[field]
		return t === undefined || fixedTerm(t) || (t.kind === "var" && fixedVars.has(t.name))
	}
	/**
	 * Whether head fields are a key of the projection: with the fields nothing determines (fixedField), they reach every
	 * head field by the projection's dependencies.
	 */
	const determines = (given: ReadonlyArray<string>): boolean => {
		const known = new Set([...given, ...Arr.filter(heading, (f) => fixedField(f))])
		let changed = true
		while (changed) {
			changed = false
			for (const dep of dependencies) {
				if (Arr.every(dep.from, (f) => known.has(f)) && Arr.some(dep.to, (f) => !known.has(f))) {
					for (const f of dep.to) {
						known.add(f)
					}
					changed = true
				}
			}
		}
		return Arr.every(heading, (f) => known.has(f))
	}
	/** A variable an equality with a constant, or a one-member roster's scan, fixes to that constant. */
	const literalOfVar = (name: string): string | undefined => {
		for (const c of equalities) {
			const right =
				c.left.kind === "var" && c.left.name === name ? constantText(c.right) : undefined
			if (right !== undefined) {
				return right
			}
			const left =
				c.right.kind === "var" && c.right.name === name ? constantText(c.left) : undefined
			if (left !== undefined) {
				return left
			}
		}
		for (const s of scans) {
			const closed =
				s.occurrence.source.kind === "closed"
					? Option.getOrUndefined(
							Arr.findFirst(base.closed, (c) => c.name === s.occurrence.source.name)
						)
					: undefined
			const [only, ...more] = closed?.members ?? []
			const t = s.occurrence.fields["id"]
			if (only !== undefined && more.length === 0 && t?.kind === "var" && t.name === name) {
				return valueText(only)
			}
		}
		return undefined
	}
	const literalAt = (field: string): string | undefined => {
		const t = rule.head[field]
		if (t === undefined) {
			return undefined
		}
		switch (t.kind) {
			case "literal":
				return valueText(t.value)
			case "handle":
				return valueText(t.member)
			case "var":
				return literalOfVar(t.name)
			case "context":
				return undefined
		}
	}
	const keys = antichain(
		heading,
		minimalSets(
			Arr.filter(heading, (f) => !fixedField(f)),
			determines
		)
	)
	const equal = (a: string, b: string): boolean => {
		const x = copied(a)
		const y = copied(b)
		return x !== undefined && y !== undefined && classOf(x) === classOf(y)
	}
	return { heading, determines, literalAt, keys, equal }
}

/** Every subset of a list, the smaller first, each in the list's order. */
const subsetsBySize = (items: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => {
	const none: ReadonlyArray<ReadonlyArray<string>> = [[]]
	const all = Arr.reduce(items, none, (subsets, item) => [
		...subsets,
		...Arr.map(subsets, (s) => [...s, item])
	])
	return Arr.sort(
		all,
		Order.mapInput(Order.Number, (s: ReadonlyArray<string>) => s.length)
	)
}

/** The minimal subsets of `fields` that pass `test`, the empty one included, smaller first. */
const minimalSets = (
	fields: ReadonlyArray<string>,
	test: (given: ReadonlyArray<string>) => boolean
): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.reduce(
		subsetsBySize(fields),
		Arr.empty<ReadonlyArray<string>>(),
		(found: ReadonlyArray<ReadonlyArray<string>>, subset) =>
			!Arr.some(found, (k) => within(k, subset)) && test(subset) ? [...found, subset] : found
	)

/** Whether two arms are told apart by a head field among `cs` that each fixes to a different literal. */
const separated = (cs: ReadonlyArray<string>, a: Arm, b: Arm): boolean =>
	Arr.some(cs, (c) => {
		const x = a.literalAt(c)
		const y = b.literalAt(c)
		return x !== undefined && y !== undefined && x !== y
	})

/** The root keys of a rule set's definition: its one arm's, or its union's. */
const rulesKeys = (base: BaseSpec, rules: Arr.NonEmptyReadonlyArray<Rule>): Keys => {
	const arms = Arr.map(rules, (r) => armOf(base, r))
	const [first, ...rest] = arms
	if (rest.length === 0) {
		return first.keys
	}
	const heading = first.heading
	const pairs = Arr.flatMap(arms, (a, i) => Arr.map(arms.slice(i + 1), (b) => [a, b] as const))
	const commonFixed = Arr.filter(heading, (c) => {
		const x = first.literalAt(c)
		return x !== undefined && Arr.every(arms, (a) => a.literalAt(c) === x)
	})
	const isKey = (given: ReadonlyArray<string>): boolean => {
		const cs = [...given, ...Arr.filter(commonFixed, (c) => !given.includes(c))]
		if (within(heading, cs)) {
			return true
		}
		return (
			Arr.every(arms, (a) => a.determines(cs)) && Arr.every(pairs, ([a, b]) => separated(cs, a, b))
		)
	}
	const separators = Arr.filter(heading, (c) =>
		Arr.every(arms, (a) => a.literalAt(c) !== undefined)
	)
	const candidates = [
		...Arr.flatMap(arms, (a) =>
			Arr.map(
				Arr.filter(a.keys, (k) => within(k, heading)),
				(k) => [...k, ...separators]
			)
		),
		heading
	]
	const found: Array<ReadonlyArray<string>> = []
	for (const candidate of candidates) {
		let key = Arr.filter(heading, (c) => candidate.includes(c))
		if (!isKey(key)) {
			continue
		}
		for (let i = key.length - 1; i >= 0; i--) {
			const without = key.toSpliced(i, 1)
			if (isKey(without)) {
				key = without
			}
		}
		if (!Arr.some(found, (k) => k.length === key.length && within(k, key))) {
			found.push(key)
		}
	}
	const unionKeys = antichain(heading, found)
	const equal = Arr.flatMap(heading, (a) =>
		Arr.flatMap(heading, (b) =>
			a !== b && Arr.every(arms, (arm) => arm.equal(a, b)) ? [[a, b] as const] : []
		)
	)
	/** Whether head fields reach the heading by the fields fixed alike, the equal fields and the union keys. */
	const reaches = (given: ReadonlyArray<string>): boolean => {
		const known = new Set([...given, ...commonFixed])
		let changed = true
		while (changed) {
			changed = false
			for (const [a, b] of equal) {
				if (known.has(a) && !known.has(b)) {
					known.add(b)
					changed = true
				}
			}
			const reached = [...known]
			if (!within(heading, reached) && Arr.some(unionKeys, (k) => within(k, reached))) {
				for (const f of heading) {
					known.add(f)
				}
				changed = true
			}
		}
		return within(heading, [...known])
	}
	return antichain(
		heading,
		minimalSets(
			Arr.filter(heading, (f) => !commonFixed.includes(f)),
			reaches
		)
	)
}

/** The keys of a role relation: its relation's for a whole entry, its definition's as a view's for a query entry. */
const entryKeys = (base: BaseSpec, entry: EntrySpec): Keys =>
	entry.kind === "query"
		? inherited(canonical(Rec.keys(entry.rules[0].head)), rulesKeys(base, entry.rules))
		: relationSpecOf(base, entry.relation) !== undefined
			? keysOf(base, entry.relation)
			: sourceKeys(base, {
					kind: Arr.some(base.closed, (c) => c.name === entry.relation) ? "closed" : "derived",
					name: entry.relation
				})

/** A role relation's heading: a whole entry's relation's fields, a query entry's head fields. */
const headingOf = (base: BaseSpec, entry: EntrySpec): ReadonlyArray<string> => {
	if (entry.kind === "query") {
		return Rec.keys(entry.rules[0].head)
	}
	const relation = relationSpecOf(base, entry.relation)
	if (relation !== undefined) {
		return Arr.map(relation.fields, (f) => f.name)
	}
	const derived = Option.getOrUndefined(
		Arr.findFirst(base.derived, (d) => d.name === entry.relation)
	)
	return derived === undefined ? ["id"] : Rec.keys(derived.rules[0].head)
}

/**
 * Whether `db.get` takes a field set of a role relation as a key: when one of the relation's keys lies within it (the
 * whole heading always does). A field the relation does not have is no key.
 */
export const entryKeyed = (
	base: BaseSpec,
	entry: EntrySpec,
	fields: ReadonlyArray<string>
): boolean => {
	const heading = headingOf(base, entry)
	return (
		within(fields, heading) &&
		(within(heading, fields) || Arr.some(entryKeys(base, entry), (k) => within(k, fields)))
	)
}
