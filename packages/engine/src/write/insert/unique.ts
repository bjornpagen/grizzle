import { type Identity, identity } from "#compiler/core/identity.ts"
import {
	appendNonEmpty,
	concatNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import * as Order from "#compiler/core/order.ts"
import { fieldNames, type LawField, type RelationInfo } from "#compiler/ir/law.ts"
import {
	columnReads,
	keyWitness,
	type PrimaryKeyObject,
	readFields,
	type RelationLaws,
	type UniqueObject,
	type UniqueObjects,
	witnessFields
} from "#compiler/laws/model/uniques.ts"
import type { ColumnMap, Env, LowerContext } from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { rowNe, typedEq } from "#compiler/lower/conservative/vector/equality.ts"
import type { Cte, Expr, OrderItem, Select, SetCore } from "#compiler/sql/ast.ts"
import {
	and,
	asc,
	binary,
	col,
	cte,
	cteRef,
	cteRefAs,
	exists,
	lit,
	notExists,
	provedCore,
	provedSelect,
	select,
	simpleSelect,
	target,
	types,
	unionAll
} from "#compiler/sql/build.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"
import { type FieldColumns, fieldColumns } from "#compiler/write/defined.ts"
import { requestedValue, rowType, type WriteContext } from "#compiler/write/insert/statement.ts"

/** The unique objects of a relation an insert meets: its arbiter, the primary key; every object
 * besides it, in law order, probed or not, on which a 23505 or 23P01 aborts the apply; the objects an insert of
 * complete facts probes, those besides the arbiter; and the probes of a query entry over it (`OutsideProbe`), which the
 * role installs and the entry's precheck calls. A generated addition's insert probes the objects that read none of the
 * fields it draws (`generatedChecks`). Each probed list holds fewer fields and no predicate first. `keys` are its
 * declared keys' objects, the arbiter first. */
export interface RelationUniques {
	readonly arbiter: PrimaryKeyObject
	readonly keys: NonEmptyReadonlyArray<PrimaryKeyObject>
	readonly others: ReadonlyArray<UniqueObject>
	readonly checks: ReadonlyArray<Probed>
	/** The probes of a query entry over the relation: each declared key's, then each object's no declared key subsumes
	 * (`beyondKeys`). */
	readonly probes: ReadonlyArray<OutsideProbe>
}

/**
 * A probe of a query entry over a relation T: true where a fact of T outside the entry, which the role cannot see,
 * conflicts with given values at one of T's unique objects. A declared key's, through the role's key probe of it,
 * named by the key's fields; or an object's no declared key subsumes, such as a key over a selected side, through its
 * unique probe, named by the object's installed name. The role's installation (physical/ddl/roles.ts)
 * creates exactly the probes of `RelationUniques.probes`, and an entry's precheck (write/entry/precheck.ts) calls
 * those its addition meets, each by its one identity (`probeIdentity`) at its one parameter list (`probeParams`).
 */
export type OutsideProbe =
	| { readonly kind: "key"; readonly object: PrimaryKeyObject }
	| { readonly kind: "unique"; readonly object: UniqueObject }

/** A probe's parameters, the given values it compares: every field its object reads, each once, in the object's order,
 * a declared key's compared fields then its span. */
export const probeParams = (probe: OutsideProbe): ReadonlyArray<LawField> => [
	...new Set(readFields(probe.object))
]

/** The identity a role's probe is installed and called by: a key probe by its key's fields in its witness order, a
 * unique probe by its object's installed name. */
export const probeIdentity = (
	role: Identity<"role">,
	entry: string,
	probe: OutsideProbe
): Identity<"keyProbe" | "uniqueProbe"> =>
	probe.kind === "key"
		? identity.keyProbe(role, entry, fieldNames(keyWitness(probe.object)))
		: identity.uniqueProbe(role, entry, probe.object.name)

/** An object a statement probes, and who refuses two requested facts of one enumerated input that it cannot both hold:
 * the host, before any SQL (normalize.ts), which compares the values of every declared key, so of every key object, and
 * the spans of every span object an insert of complete facts probes; or the statement, at a unique index, whose
 * predicate and fields are no declared key's, and at a span primary key, which only a generated addition probes. A
 * carrier's or a described member's pairs are always the statement's: nobody normalized them. */
export interface Probed {
	readonly object: UniqueObject
	readonly pairs: "host" | "statement"
}

/** Whether a unique object's guards select the rows it holds apart. */
const predicated = (u: UniqueObject): boolean => u.kind === "guarded"

/**
 * The guards a row, its fields read through `of`, meets to be held by a unique object: each of a `guarded` object's
 * guards, a conjunct of its law columns' guards, lowered over the row; none for an object over fields alone, which
 * holds every row.
 */
export const withinRow = (
	cx: LowerContext,
	u: UniqueObject,
	of: (f: LawField) => Expr
): ReadonlyArray<Expr> =>
	u.kind === "guarded"
		? u.within.map((g) => {
				const columns: ColumnMap = new Map(g.reads.map((f) => [f.name, of(f)] as const))
				const env: Env = new Map(columnReads(g.predicate).map((c) => [c.node, columns] as const))
				return lowerExpr(cx, g.predicate, env)
			})
		: []

/** The fields an object compares, its span counted. */
const width = (u: UniqueObject): number => witnessFields(u).length

/** Whether every conflict of `b` is a conflict of `a`: `a` has no predicate, compares a subset of `b`'s fields for
 * equality, and compares its span, if any, by overlap where `b` does, or for equality. */
const subsumes = (a: UniqueObject, b: UniqueObject): boolean => {
	const compared: ReadonlyArray<LawField> = b.equal
	return (
		!predicated(a) &&
		a.equal.every((f) => compared.includes(f)) &&
		(a.kind !== "span" || (b.kind === "span" && a.span === b.span) || compared.includes(a.span))
	)
}

/** `candidates` as a statement probes them: fewer fields first, a predicate last, each kept unless `settled` or an
 * object kept before it subsumes it, so every conflict at an object dropped is one at an object probed or settled. */
const probeOrder = (
	candidates: ReadonlyArray<UniqueObject>,
	settled: ReadonlyArray<UniqueObject>
): ReadonlyArray<UniqueObject> => {
	const ordered = candidates.toSorted(
		Order.combine(
			Order.mapInput(Order.compareBooleans, predicated),
			Order.mapInput(Order.compareNumbers, width)
		)
	)
	const kept: Array<UniqueObject> = []
	for (const o of ordered) {
		if (!settled.some((c) => subsumes(c, o)) && !kept.some((c) => subsumes(c, o))) {
			kept.push(o)
		}
	}
	return kept
}

/** Whether an object reads a field a generated addition draws (`drawn`), whose value it meets only at its insert. */
export const readsDrawn = (u: UniqueObject, drawn: ReadonlyArray<string>): boolean =>
	readFields(u).some((f) => drawn.includes(f.name))

/** The unique objects of `relation` no declared key subsumes, as a statement probes them (`probeOrder`): those whose
 * conflicts are no key's, a key over a selected side among them.
 *
 * A query entry's precheck (write/entry/precheck.ts) probes each of these beside its target's keys for a fact outside
 * the entry (`OutsideProbe`): a conflict at any other unique object is one at a key or at an object kept here, so a
 * write through the entry meets every stored fact at every unique object as a refusal by that object's law, and only a
 * concurrent commit as an abort. */
const beyondKeys = ({ primary, others, keys }: UniqueObjects): ReadonlyArray<UniqueObject> => {
	const declared: ReadonlyArray<UniqueObject> = keys
	return probeOrder(
		[primary, ...others].filter((u) => !declared.includes(u)),
		keys
	)
}

/** `objects` as a statement probes them, each with who refuses a pair of it within one input: the host at a key, and at
 * a span a complete insert probes (`complete`, normalize.ts hostChecks); the statement anywhere else. */
const probedAt = (
	objects: ReadonlyArray<UniqueObject>,
	complete: ReadonlyArray<UniqueObject>
): ReadonlyArray<Probed> =>
	Object.freeze(
		objects.map((object): Probed =>
			Object.freeze({
				object,
				pairs:
					object.kind === "key" || (object.kind === "span" && complete.includes(object))
						? "host"
						: "statement"
			})
		)
	)

/**
 * The objects a generated addition drawing `drawn` probes (see `buildProbe`): every unique object of the relation that
 * reads none of them, the arbiter among them when it does not, since the addition carries every value they compare; an
 * object that reads a drawn field it meets only at its insert, through a stored value its sequence had not passed.
 */
export const generatedChecks = (
	uniques: RelationUniques,
	drawn: ReadonlyArray<string>
): ReadonlyArray<Probed> =>
	probedAt(
		probeOrder(
			[uniques.arbiter, ...uniques.others].filter((u) => !readsDrawn(u, drawn)),
			[]
		),
		uniques.checks.map((c) => c.object)
	)

/** The unique objects an insert into `relation` meets (see `buildProbe`), which the write front end resolves once for each
 * relation a ChangeSet writes (`WrittenRelation`). A complete insert's arbiter settles its own conflicts, so it probes
 * the objects besides it; a generated addition's insert has no arbiter, its draws making every object that reads a field
 * it draws one it meets only through a stored value the sequence has not passed, so it probes every other object
 * (`generatedChecks`). */
export const relationUniques = (laws: RelationLaws): RelationUniques => {
	const { primary, keys } = laws.uniques
	const others = laws.beyond
	const complete = probeOrder(others, [primary])
	return Object.freeze({
		arbiter: primary,
		keys,
		others,
		checks: probedAt(complete, complete),
		probes: Object.freeze([
			...keys.map((object): OutsideProbe => Object.freeze({ kind: "key", object })),
			...beyondKeys(laws.uniques).map((object): OutsideProbe =>
				Object.freeze({ kind: "unique", object })
			)
		])
	})
}

/** The facts a probed statement requests: complete facts, every field key first, each probed only where its arbiter key
 * is free in the snapshot (an occupied one is the arbiter's to settle, a repeat or its conflict witness, and is never
 * inserted into another index), told apart by their primary key; or a generated addition's, its `fields` the
 * relation's fields but the ones it draws, key first, each probed, since the identity may draw its arbiter key at the
 * insert, and told apart by every field it holds, equal generated additions being one. */
export type Requested =
	| { readonly kind: "complete"; readonly arbiter: UniqueObject }
	| { readonly kind: "generated"; readonly fields: ReadonlyArray<LawField> }

/** What the probe needs of the statement it extends. */
interface ProbeSpec {
	readonly relation: RelationInfo
	readonly requested: Requested
	/** The objects to probe. */
	readonly checks: ReadonlyArray<Probed>
	/** The input CTE and its columns, each with the field it holds, in order. */
	readonly input: string
	readonly inputs: FieldColumns<string>
	/** Whether the input's facts were normalized on the host, which refuses a pair within the input at every object
	 * whose pairs are the host's (`Probed`). */
	readonly normalized: boolean
}

export interface ProbeSql {
	/** The CTEs to place before the data-modifying one: the probe's branches and the refusal it keeps. */
	readonly ctes: ReadonlyArray<Cte>
	/** The refusal CTE, at most one row: the requested fact's written fields, then the signed ordinal. */
	readonly refusal: string
	/** A written field's column of the refusal row. */
	readonly refusalCol: (f: LawField) => Expr
	/**
	 * The refused fact's value at any field: a written field's column, or a generated field's value computed from the
	 * row's written fields by its generation expression, the value PostgreSQL would have stored, so the refusal row
	 * lines up with the complete facts a statement returns.
	 */
	readonly refusalValue: (f: LawField) => Expr
	readonly ordinal: Expr
	/** The INSERT's gate: no refusal. */
	readonly gate: Expr
	/** The checks probed, the i-th of ordinal i + 1. */
	readonly checks: NonEmptyReadonlyArray<UniqueObject>
}

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** The probe CTEs of an insert or an upsert over `spec.input` (see `buildProbe`); undefined when there is nothing to
 * probe. Its names are drawn after every name the statement already holds, so a statement without one is unchanged.
 *
 * The unique objects an insert meets besides its arbiter, and the in-statement probe that classifies them.
 *
 * The insert protocol's ON CONFLICT names one arbiter, the primary key. Every other unique object of the relation is
 * checked by PostgreSQL as the row enters its index, with UNIQUE_CHECK_YES (an exclusion constraint alike): it waits on
 * an in-flight inserter of the same value and raises 23505 (23P01) once that commits. Two concurrent inserters of one
 * fact that both pass the arbiter's pre-check therefore meet at such an object, and the later one fails there though
 * the fact it requested is exactly the committed one, an exact repeat, which must
 * change nothing. So the statement probes those objects itself, under its own snapshot, for each requested fact whose
 * arbiter key is free in that snapshot (a fact whose arbiter key is occupied is the arbiter's to settle, a repeat or
 * its conflict witness, and is never inserted into another index):
 *
 * - a visible occupant of such an object is a different fact, since an equal one would occupy the arbiter key: the
 *   statement inserts nothing and reports the requested fact with the object's ordinal, invariant-rejected on the first
 *   attempt with that object's law and a key-only witness, the requested fact's values at the object's fields;
 * - two requested facts of one input that the object cannot both hold are reported the same way, with the ordinal
 *   negated, a conflict within the ChangeSet. Host normalization refuses such a pair among an enumerated input's facts
 *   before any SQL at every object whose pairs are the host's (`Probed`); the statement checks it for a carrier
 *   or a described member, which nobody normalized, at a unique index, whose predicate and fields are no declared key's,
 *   and at a span primary key a generated addition is probed at, whose overlaps the host does not compare.
 *
 * After that, a 23505 or 23P01 on any of these objects can only come from a row the statement's snapshot did not see,
 * committed or in flight when the row entered the index: the apply fails with TransientFailure{UnseenOccupant}
 * (packages/grizzle/src/adapter/outcomes), and on a caller's retry the committed row is visible, so the arbiter or the probe classifies
 * it: an exact repeat changes nothing, a different fact is the object's law. Reporting the law instead would be wrong:
 * PostgreSQL meets the occupant whatever the snapshot, so a ChangeSet that deletes it on its snapshot, where it is
 * absent, and adds a fact at its key, meets it as 23505 although every serial order commits the ChangeSet. Through a
 * role's query entry, row security hides every fact outside the entry from the probe, and the entry's precheck refuses
 * those first, at every key and every object no key subsumes (`OutsideProbe`), so there too only a concurrent commit
 * remains.
 *
 * A generated addition is a plain INSERT with no arbiter, whose identity draws the serial fields at the insert, so it
 * is never an exact repeat, and every requested fact is probed (`Requested`), at every object that reads no serial
 * field, the primary key among them when it reads none: the same visible occupants and pairs are its refusals, and
 * any other 23505 or 23P01 it meets aborts the apply, UnseenOccupant there, and GeneratedSerialUnique at an object that
 * reads a serial field, which a drawn value meets only as a stored value the sequence has not passed.
 *
 * The objects are a relation's unique objects other than its arbiter: a declared
 * candidate key (Unique), a key over a selected side (Unique over its law columns, with its selection), the generated
 * uniques of foreign keys, a constant selection's among them (Unique over a superkey), a span candidate key (WithoutOverlaps, an exclusion that raises 23P01) and the temporal unique of a PERIOD
 * reference's selected target. An object whose every conflict is also a conflict of the arbiter or of another probed
 * object without a predicate needs no probe of its own: its visible occupants are found there, and its unseen ones
 * abort the apply. A constant selection's composite unique (the referenced fields and the selector fields) always
 * contains a key, so it is never probed itself. */
export const buildProbe = (
	w: WriteContext,
	supply: NameSupply,
	spec: ProbeSpec
): ProbeSql | undefined => {
	const { relation, requested, checks, input, inputs } = spec
	/** The fields a requested fact holds, as `inputs` holds them, and those that tell two apart (`Requested`): a complete
	 * fact's are every field its input carries, which `inputs` pairs. */
	const fields: ReadonlyArray<LawField> =
		requested.kind === "complete" ? inputs.pairs.map((p) => p.field) : requested.fields
	const apart: ReadonlyArray<LawField> =
		requested.kind === "complete" ? relation.primaryFields : requested.fields
	if (!isNonEmpty(checks) || !isNonEmpty(fields)) {
		return undefined
	}
	const vectorSchema = w.names.vectorSchema
	const table = w.names.relation(relation.name)
	const column = (f: LawField) => w.names.column(relation.name, f.name)
	const stored = (alias: string) => (f: LawField) => col(alias, column(f))
	const inCol = (alias: string, f: LawField): Expr => col(alias, inputs.of(f))
	const same = (f: LawField, a: Expr, b: Expr): Expr => typedEq(rowType(f), a, b, vectorSchema)
	const predicate = (check: UniqueObject, of: (f: LawField) => Expr): ReadonlyArray<Expr> =>
		withinRow(w.cx, check, of)
	/** `a` and `b` conflict at the object: equal compared fields, overlapping spans. */
	const conflict = (
		check: UniqueObject,
		a: (f: LawField) => Expr,
		b: (f: LawField) => Expr
	): NonEmptyReadonlyArray<Expr> =>
		check.kind === "span"
			? appendNonEmpty(
					check.equal.map((f) => same(f, a(f), b(f))),
					binary("&&", a(check.span), b(check.span))
				)
			: mapNonEmpty(check.equal, (f) => same(f, a(f), b(f)))
	const one = [target(lit.int(1, types.integer))]
	const fact = (f: LawField) => inCol(input, f)
	const branches: Array<SetCore> = []
	for (const [i, { object: check, pairs }] of checks.entries()) {
		const ordinal = i + 1
		const own = predicate(check, fact)
		if (!spec.normalized || pairs === "statement") {
			/** Another requested fact the object cannot hold beside this one. */
			const other = supply.relation(internal("other requested fact"))
			const otherCol = (f: LawField) => inCol(other, f)
			branches.push(
				provedCore(
					"keyed",
					[...fields.map((f) => target(fact(f))), target(lit.int(-ordinal, types.integer))],
					[cteRef(input)],
					and(
						appendNonEmpty(
							own,
							exists(
								simpleSelect(
									one,
									[cteRefAs(input, other)],
									and(
										appendNonEmpty(
											[...predicate(check, otherCol), ...conflict(check, otherCol, fact)],
											rowNe(
												{ fields, typeOf: rowType, left: otherCol, right: (f) => inCol(input, f) },
												vectorSchema
											)
										)
									)
								)
							)
						)
					)
				)
			)
		}
		/** A visible occupant of the object, for a requested fact whose arbiter key is free (`Requested`). */
		const occupant = supply.relation(internal(`occupant of ${check.name}`))
		const free = (arbiter: UniqueObject): Expr => {
			const holder = supply.relation(internal(`arbiter occupant of ${relation.name}`))
			return notExists(
				simpleSelect(
					one,
					[{ kind: "table", table, alias: holder }],
					and(conflict(arbiter, stored(holder), fact))
				)
			)
		}
		branches.push(
			provedCore(
				"keyed",
				[...fields.map((f) => target(fact(f))), target(lit.int(ordinal, types.integer))],
				[cteRef(input)],
				and(
					concatNonEmpty(own, [
						exists(
							simpleSelect(
								one,
								[{ kind: "table", table, alias: occupant }],
								and(
									concatNonEmpty(
										predicate(check, stored(occupant)),
										conflict(check, stored(occupant), fact)
									)
								)
							)
						),
						...(requested.kind === "complete" ? [free(requested.arbiter)] : [])
					])
				)
			)
		)
	}
	const refusal = supply.relation(internal("unique refusal"))
	const refused = fieldColumns(fields, () => supply.column(internal("refused fact column")))
	const ordinalCol = supply.column(internal("unique ordinal"))
	const ctes: Array<Cte> = []
	const orderOf = (of: (f: LawField) => Expr, ordinal: Expr): ReadonlyArray<OrderItem> => [
		...apart.map((f) => asc(of(f))),
		asc(ordinal)
	]
	const [first, ...rest] = branches
	if (first === undefined) {
		return undefined
	}
	let query: Select
	if (rest.length === 0) {
		query = {
			...select(first),
			orderBy: apart.map((f) => asc(fact(f))),
			limit: lit.int(1, types.integer)
		}
	} else {
		/** Several branches are one UNION ALL, read in ordinal order. */
		const all = supply.relation(internal("unique probe"))
		const probed = fieldColumns(fields, () => supply.column(internal("probe column")))
		const probedOrdinal = supply.column(internal("probe column"))
		const allCol = (f: LawField) => col(all, probed.of(f))
		const allOrdinal = col(all, probedOrdinal)
		ctes.push(
			cte(all, [...probed.columns, probedOrdinal], select(unionAll("disjoint", [first, ...rest])))
		)
		query = {
			...provedSelect(
				"keyed",
				[...fields.map((f) => target(allCol(f))), target(allOrdinal)],
				[cteRef(all)],
				undefined
			),
			orderBy: orderOf(allCol, allOrdinal),
			limit: lit.int(1, types.integer)
		}
	}
	ctes.push(cte(refusal, [...refused.columns, ordinalCol], query))
	const refusalCol = (f: LawField): Expr => col(refusal, refused.of(f))
	return {
		ctes,
		refusal,
		refusalCol,
		refusalValue: requestedValue(w, relation, fields, refusalCol),
		ordinal: col(refusal, ordinalCol),
		gate: notExists(simpleSelect(one, [cteRef(refusal)], undefined)),
		checks: mapNonEmpty(checks, (p) => p.object)
	}
}
