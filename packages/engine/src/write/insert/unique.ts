import {
	appendNonEmpty,
	flatMapNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { type Identity, identity } from "#compiler/core/identity.ts"
import * as Order from "#compiler/core/order.ts"
import { fieldNames, type LawField, type RelationInfo } from "#compiler/ir/law.ts"
import {
	keyWitness,
	type PrimaryKeyObject,
	readFields,
	type RelationLaws,
	type UniqueObject,
	type UniqueObjects,
	witnessFields
} from "#compiler/laws/model/uniques.ts"
import type {
	Cte,
	Expr,
	FromItem,
	OrderItem,
	Select,
	SetCore,
	Target,
	WindowSpec
} from "#compiler/sql/ast.ts"
import {
	and,
	asc,
	call,
	col,
	conjunction,
	countStar,
	cte,
	cteRef,
	derived,
	distinctCore,
	eq,
	gt,
	lit,
	lt,
	not,
	notExists,
	or,
	provedCore,
	provedSelect,
	select,
	simpleSelect,
	target,
	types,
	unionAll,
	windowOf
} from "#compiler/sql/build.ts"
import { namedBody, namedQuery, type NameSupply } from "#compiler/sql/naming.ts"
import { type FieldColumns, fieldColumns } from "#compiler/write/defined.ts"
import { requestedValue, rowType, type WriteContext } from "#compiler/write/insert/statement.ts"
import { atObject, atRow, storedAt, withinRow } from "#compiler/write/probe.ts"
import {
	type ArmRefusal,
	type RefusalArm,
	refusalGuard,
	refusalRank
} from "#compiler/write/refusal.ts"

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
	/** The objects an INSERT arbitrating every object meets (EveryObject). */
	readonly every: EveryObject
}

/**
 * The objects an INSERT that arbitrates every object (ON CONFLICT DO NOTHING with no target) meets: every native unique
 * and exclusion object of the relation, its arbiter and each other in law order, each one a met row is classified at
 * (write/insert/protocol.ts Arbitration); or none, where some native object is no unique object, such as a family's slot
 * over a drawn law column, which no compared field names, so no such INSERT is built (RelationLaws `named`).
 */
export type EveryObject =
	| {
			readonly kind: "named"
			readonly arbiter: PrimaryKeyObject
			readonly others: ReadonlyArray<UniqueObject>
	  }
	| { readonly kind: "unnamed" }

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
 * the host, before any SQL (normalize.ts), which compares the values of every declared key whose fields it holds
 * (`hostHeld`), so of every such key object, and the spans of every span object of such fields an insert of complete
 * facts probes; or the statement, at a unique index, whose predicate and fields are no declared key's, at a span
 * primary key, and at an object reading a generated field, which PostgreSQL computes and the host never does. A carrier's or a described member's pairs are always the statement's: nobody
 * normalized them. */
export interface Probed {
	readonly object: UniqueObject
	readonly pairs: "host" | "statement"
	/**
	 * Which requested fact of a pair within the input the refusal names: the least of either, by key (`every`); or, at
	 * an insertion's span arbiter, one requested anew before one an equal stored fact repeats (`requestedAnew`), the
	 * fact the stored state does not already hold, as the classification after a READ COMMITTED span insert names it.
	 */
	readonly witness: "every" | "requestedAnew"
}

/**
 * Whether the host holds a fact's value at a field, which its same-key checks compare (normalize.ts): every field but a
 * generated one, whose value PostgreSQL computes from the row as it stores it, so that only a statement compares it, at
 * the field's generation expression over the requested fact (statement.ts requestedValue), and the value it compares is
 * the one PostgreSQL stores; and an instant or a place, which no host row holds and its statement stamps
 * (write/insert/stamp.ts), so two facts a key over one holds apart meet only as the statement stamps them. A key
 * generation is the host's: it fills every stated fact's value of it by the generation (runtime/write/fill.ts generation)
 * before any key is compared, and its statement writes that value.
 */
export const hostHeld = (field: Pick<LawField, "writing">): boolean => {
	switch (field.writing.kind) {
		case "caller":
		case "drawn":
		case "accumulated":
		case "keyGenerated":
			return true
		case "generated":
		case "instant":
		case "place":
			return false
	}
}

/** Whether a unique object's guards select the rows it holds apart. */
const predicated = (u: UniqueObject): boolean => u.kind === "guarded"

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
		Order.thenBy(
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
 * a span a complete insert probes (`complete`, normalize.ts hostChecks), whose every field it holds (`hostHeld`); the
 * statement anywhere else. */
const probedAt = (
	objects: ReadonlyArray<UniqueObject>,
	complete: ReadonlyArray<UniqueObject>
): ReadonlyArray<Probed> =>
	Object.freeze(
		objects.map((object): Probed =>
			Object.freeze({
				object,
				witness: "every",
				pairs:
					(object.kind === "key" || (object.kind === "span" && complete.includes(object))) &&
					readFields(object).every(hostHeld)
						? "host"
						: "statement"
			})
		)
	)

/** The unique objects an insert into `relation` meets (see `buildProbe`), which the write front end resolves once for each
 * relation a ChangeSet writes (`WrittenRelation`). An insert's arbiter settles its own conflicts, so it probes the
 * objects besides it. */
export const relationUniques = (laws: RelationLaws): RelationUniques => {
	const { primary, keys } = laws.uniques
	const others = laws.beyond
	const complete = probeOrder(others, [primary])
	return Object.freeze({
		arbiter: primary,
		keys,
		others,
		every: laws.named
			? Object.freeze({ kind: "named" as const, arbiter: primary, others })
			: Object.freeze({ kind: "unnamed" as const }),
		checks: probedAt(complete, complete),
		probes: Object.freeze([
			...keys.map((object): OutsideProbe => Object.freeze({ kind: "key", object })),
			...beyondKeys(laws.uniques).map((object): OutsideProbe =>
				Object.freeze({ kind: "unique", object })
			)
		])
	})
}

/** A unique object as a role holding its relation's fields alone reaches it: a guarded one at its compared fields and
 * guards (uniques.ts GuardedReach `fields`), every other as it is. */
const reachedByFields = <U extends UniqueObject>(u: U): U =>
	u.kind === "guarded" ? { ...u, reach: { kind: "fields" } } : u

/**
 * A relation's unique objects as a role writing it through a query entry probes them: each guarded one at its compared
 * fields and guards (`reachedByFields`), since the role holds column privileges on the relation's fields alone, none on
 * a UNIQUE's law columns (physical/ddl/roles.ts). Its outside probes run as their owner and are as they are.
 */
export const entryUniques = (u: RelationUniques): RelationUniques =>
	Object.freeze({
		...u,
		others: u.others.map(reachedByFields),
		checks: u.checks.map((c): Probed => ({ ...c, object: reachedByFields(c.object) })),
		every:
			u.every.kind === "named"
				? Object.freeze({ ...u.every, others: u.every.others.map(reachedByFields) })
				: u.every
	})

/** The facts a probed statement requests: complete facts, every field key first, each probed only where its arbiter key
 * is free in the snapshot (an occupied one is the arbiter's to settle, a repeat or its conflict witness, and is never
 * inserted into another index), told apart by their primary key; or the facts of an INSERT with no arbiter, each probed
 * at every object it checks and told apart by every field it holds (`none`): a family member's plain insert's, every
 * field its row layout writes, rows no stored row repeats (write/family/additions.ts insertOf). */
export type Requested =
	| { readonly kind: "complete"; readonly arbiter: UniqueObject }
	| { readonly kind: "none"; readonly fields: ReadonlyArray<LawField> }

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
	/**
	 * What the input CTE's rows are: `set`, a statement's input read as a set over its every column (insert/input.ts
	 * readInput), no row of it repeating another; or `rows`, rows that may repeat, a family's laid-out candidates.
	 */
	readonly rows: "set" | "rows"
	/**
	 * Who meets a stored occupant of a probed object: the probe, under the statement's snapshot (`probed`), the insert
	 * protocol's at READ COMMITTED; or the INSERT's arbitration of every object (`met`), the protocol's at SERIALIZABLE
	 * (protocol.ts Arbitration), so the probe reads only the input, for the pairs within it.
	 */
	readonly occupants: "probed" | "met"
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

/**
 * The refusal arms of a probe's refusal rows over `relation` (`buildProbe`), two for each object it probed: a pair within
 * the statement's facts, the object's ordinal negated (rank uniqueWithin), and a stored occupant, its ordinal
 * (uniqueStored), each raising the object's law with the refused fact's values, read by `value`, at the object's fields
 * (witnessFields).
 */
export const probeArms = (
	relation: string,
	checks: NonEmptyReadonlyArray<UniqueObject>,
	ordinal: Expr,
	value: (f: LawField) => Expr
): NonEmptyReadonlyArray<RefusalArm> =>
	flatMapNonEmpty(checks, (u, i): NonEmptyReadonlyArray<RefusalArm> => {
		const refusal: ArmRefusal = {
			kind: "law",
			law: u.law,
			relation,
			key: witnessFields(u).map((f) => ({ field: f.name, expr: value(f), type: rowType(f) }))
		}
		return [
			{
				rank: refusalRank.uniqueWithin,
				when: eq(ordinal, lit.int(-(i + 1), types.integer)),
				refusal
			},
			{
				rank: refusalRank.uniqueStored,
				when: eq(ordinal, lit.int(i + 1, types.integer)),
				refusal
			}
		]
	})

/**
 * The guard an INSERT into `relation` is gated by on its probe's refusal (`buildProbe`): the refusal CTE over the probe's
 * refusal row, its arms `probeArms` at the refused fact's values (ProbeSql `refusalValue`), and the guard that raises it
 * through the installation's refusal function, so a refused statement inserts nothing.
 */
export const probeGuard = (
	w: WriteContext,
	supply: NameSupply,
	relation: string,
	probe: ProbeSql
): { readonly cte: Cte; readonly guard: Expr } =>
	refusalGuard({
		supply,
		schema: w.names.schema,
		verdicts: probe.refusal,
		arms: probeArms(relation, probe.checks, probe.ordinal, probe.refusalValue)
	})

/** The rows of a probe branch (`buildProbe`): its FROM, read where `where` holds, and each row's requested fact, its value
 * at each field read by `of` in that FROM's scope. */
interface BranchRows {
	readonly from: ReadonlyArray<FromItem>
	readonly where: Expr
	readonly of: (f: LawField) => Expr
}

/**
 * The requested facts of `input` another requested fact conflicts with at `check` (`buildProbe`'s pair branch), each
 * meeting the check's guards, read by windows over the input's distinct facts: the input once, however PostgreSQL
 * estimates it, never once per fact.
 *
 * They are the facts the pair `EXISTS (SELECT 1 FROM <input> AS o WHERE <o meets the guards> AND <o conflicts with the
 * fact> AND (<o's fields>) <> (<the fact's>))` keeps: a fact o meeting the guards, equal to the fact at the check's
 * compared fields and, at a span object, its span overlapping the fact's, and unequal to it at some field, so neither
 * the fact itself nor one equal to it at every field. PostgreSQL estimates a CTE it holds no statistics of at a row and
 * ran that pair as a nested loop of two scans of the input, k² rows for a check k facts meet.
 *
 * The windows read the distinct facts meeting the guards (`facts`): the input itself where it is a set over every field
 * a fact states, a statement's input read as one (insert/input.ts readInput), whose rows repeat no fact, and SELECT
 * DISTINCT of every field where its rows may repeat or hold more columns than its facts. No field is NULL (a requested
 * fact is a value of each field's type, and the statement names no NULL), and DISTINCT and a window's partition compare
 * a column by its type's default equality, the `=` the pair compares by and whose negation its `<>` is, a vector's too.
 * So a fact's others are exactly the other distinct facts, and two of them agree at the compared fields exactly where
 * one partition by those fields holds both. The windows carry every field of a fact, never the compared fields alone
 * joined back to the input for the facts paired: PostgreSQL estimates a CTE at one row and may plan that join as a
 * nested loop over the input, its rows times the facts paired, every fact where every fact is paired, which is the
 * pair's own cost the windows replace.
 *
 * - At an object of no span: a fact is paired where its partition by the compared fields holds another fact,
 *   `count(*) OVER (PARTITION BY <compared>) > 1`.
 * - At a span object: every span is nonempty, bounded and half-open (ir/scalar.ts SpanInfo), so lower() and upper()
 *   are never NULL, and two spans overlap exactly where each starts before the other ends. Over each partition by the
 *   compared fields, ordered by lower(span), a fact's reach is max(upper(span)) over the facts starting no later than
 *   it (the default frame, which takes its peers), one value for peers. A fact r is paired where the fact before it
 *   reaches past r's start, lag(reach, 1, lower(span)) > lower(span), or the fact after it starts before r's end,
 *   lead(lower(span), 1, upper(span)) < upper(span); the defaults, r's own start and end, hold neither. Each holds only
 *   of an overlap: a reach past r's start is the end of a fact starting no later than r, another fact, or r itself
 *   where the fact before r is its peer, which then overlaps it; and the fact after r starts no earlier than r, so
 *   starting before r's end it overlaps r. Each overlap holds one: a fact y overlapping r and starting before it starts
 *   no later than the fact before r, whose reach is then at least y's end, or r's own where that fact is r's peer; a
 *   peer of r is before it, and so is the fact just before r, or after it, and so is the fact just after r; and a fact
 *   starting after r, before r's end, leaves the fact just after r starting no later.
 *
 * Each fact paired is one row, where the pair kept one for each input row equal to it: the probe reads its branches'
 * rows only for the one refusal it orders by their fields and limits to (`buildProbe`), which a repeat does not change.
 */
const pairedFacts = (
	w: WriteContext,
	supply: NameSupply,
	spec: {
		readonly relation: RelationInfo
		readonly fields: NonEmptyReadonlyArray<LawField>
		readonly input: string
		readonly inputs: FieldColumns<string>
		readonly check: UniqueObject
		/** Whether the input's rows are a set over every field a fact states (ProbeSpec `rows`), so its facts repeat none. */
		readonly facts: "set" | "rows"
	}
): BranchRows => {
	const { relation, fields, input, inputs, check } = spec
	const columnsOf = (): FieldColumns<string> =>
		fieldColumns(fields, () => supply.column(internal("paired fact column")))
	/** The facts read from `alias`, each field's column under it, and every such column as a target. */
	const factsAt = (alias: string, columns: FieldColumns<string>) => ({
		at: requestedValue(w, relation, fields, (f) => col(alias, columns.of(f))),
		carried: fields.map((f) => target(col(alias, columns.of(f))))
	})
	const read = factsAt(input, inputs)
	const distinct = supply.relation(internal("distinct requested fact"))
	const distinctColumns = columnsOf()
	const factTargets = mapNonEmpty(fields, (f) => target(col(input, inputs.of(f))))
	const guards = conjunction(withinRow(w.cx, check, read.at))
	const distinctFacts = derived(
		namedQuery(
			select(
				spec.facts === "set"
					? provedCore("keyed", factTargets, [cteRef(input)], guards)
					: distinctCore(factTargets, [cteRef(input)], guards)
			),
			distinctColumns.columns
		),
		distinct,
		false
	)
	const unique = factsAt(distinct, distinctColumns)
	if (check.kind !== "span") {
		const counted = supply.relation(internal("facts at the compared fields"))
		const countedColumns = columnsOf()
		const facts = supply.column(internal("count at the compared fields"))
		return {
			from: [
				derived(
					namedQuery(
						select(
							provedCore(
								"keyed",
								[
									...unique.carried,
									target({ ...countStar(), over: windowOf(check.equal.map(unique.at), []) })
								],
								[distinctFacts],
								undefined
							)
						),
						[...countedColumns.columns, facts]
					),
					counted,
					false
				)
			],
			where: gt(col(counted, facts), lit.int(1, types.bigint)),
			of: factsAt(counted, countedColumns).at
		}
	}
	const lower = (e: Expr): Expr => call("lower", [e])
	const upper = (e: Expr): Expr => call("upper", [e])
	const byStart = (at: (f: LawField) => Expr): WindowSpec =>
		windowOf(check.equal.map(at), [asc(lower(at(check.span)))])
	const reached = supply.relation(internal("facts with their reach"))
	const reachedColumns = columnsOf()
	const reach = supply.column(internal("reach"))
	const reaching = factsAt(reached, reachedColumns)
	const one = lit.int(1, types.integer)
	const neighboured = supply.relation(internal("facts with their neighbours"))
	const neighbouredColumns = columnsOf()
	const before = supply.column(internal("reach before"))
	const after = supply.column(internal("start after"))
	const of = factsAt(neighboured, neighbouredColumns).at
	return {
		from: [
			derived(
				namedQuery(
					select(
						provedCore(
							"keyed",
							[
								...reaching.carried,
								target({
									...call("lag", [col(reached, reach), one, lower(reaching.at(check.span))]),
									over: byStart(reaching.at)
								}),
								target({
									...call("lead", [
										lower(reaching.at(check.span)),
										one,
										upper(reaching.at(check.span))
									]),
									over: byStart(reaching.at)
								})
							],
							[
								derived(
									namedQuery(
										select(
											provedCore(
												"keyed",
												[
													...unique.carried,
													target({
														...call("max", [upper(unique.at(check.span))]),
														over: byStart(unique.at)
													})
												],
												[distinctFacts],
												undefined
											)
										),
										[...reachedColumns.columns, reach]
									),
									reached,
									false
								)
							],
							undefined
						)
					),
					[...neighbouredColumns.columns, before, after]
				),
				neighboured,
				false
			)
		],
		where: or([
			gt(col(neighboured, before), lower(of(check.span))),
			lt(col(neighboured, after), upper(of(check.span)))
		]),
		of
	}
}

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
 *   at a span primary key a generated addition is probed at, whose overlaps the host does not compare, and at an object
 *   reading a generated field, whose value the host never computes.
 *
 * A requested fact's value at a generated field is its generation expression over the fields it carries, cast into
 * their domains as the statement reads its input (statement.ts requestedValue): the value PostgreSQL stores for it, so
 * the probe compares what the index compares.
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
		requested.kind === "none" ? requested.fields : inputs.pairs.map((p) => p.field)
	const apart: ReadonlyArray<LawField> =
		requested.kind === "complete" ? relation.primaryFields : requested.fields
	if (!isNonEmpty(checks) || !isNonEmpty(fields)) {
		return undefined
	}
	const inCol = (alias: string, f: LawField): Expr => col(alias, inputs.of(f))
	const predicate = (check: UniqueObject, of: (f: LawField) => Expr): ReadonlyArray<Expr> =>
		withinRow(w.cx, check, of)
	const one = [target(lit.int(1, types.integer))]
	/** A requested fact's value at a field, read under `alias`: its input's column for a field it carries, and a
	 * generated field's generation expression over them (statement.ts requestedValue), the value PostgreSQL stores. */
	const requestedAt = (alias: string): ((f: LawField) => Expr) =>
		requestedValue(w, relation, fields, (f) => inCol(alias, f))
	const fact = requestedAt(input)
	/** Each branch: its rows, its signed ordinal, and its witnesses' rank, if it ranks them. */
	const branches: Array<{
		readonly rows: BranchRows
		readonly ordinal: number
		readonly rank: Expr | undefined
	}> = []
	for (const [i, { object: check, pairs, witness }] of checks.entries()) {
		const ordinal = i + 1
		const own = predicate(check, fact)
		if (!spec.normalized || pairs === "statement") {
			const rows = pairedFacts(w, supply, {
				relation,
				fields,
				input,
				inputs,
				check,
				facts:
					spec.rows === "set" && inputs.pairs.every((p) => fields.includes(p.field))
						? "set"
						: "rows"
			})
			branches.push({
				rows,
				ordinal: -ordinal,
				rank:
					witness === "requestedAnew"
						? (() => {
								const row = atRow(w, relation, fields, rows.of)
								return storedAt(w, supply, relation.name, row.access, row.equal)
							})()
						: undefined
			})
		}
		if (spec.occupants === "probed") {
			branches.push({
				ordinal,
				rank: undefined,
				rows: {
					from: [cteRef(input)],
					where: and(
						appendNonEmpty(
							[
								...own,
								...(requested.kind === "none"
									? []
									: [
											not(
												storedAt(
													w,
													supply,
													relation.name,
													atObject(w, relation.name, requested.arbiter, fact),
													[]
												)
											)
										])
							],
							storedAt(w, supply, relation.name, atObject(w, relation.name, check, fact), [])
						)
					),
					of: fact
				}
			})
		}
	}
	/** A branch's rows: the requested fact's fields, its signed ordinal, and any further targets `extra`. */
	const coreOf = (b: (typeof branches)[number], extra: ReadonlyArray<Target>): SetCore =>
		provedCore(
			"keyed",
			[
				...fields.map((f) => target(b.rows.of(f))),
				target(lit.int(b.ordinal, types.integer)),
				...extra
			],
			b.rows.from,
			b.rows.where
		)
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
	/** Where some branch ranks its witnesses (Probed `witness`), the rank of each branch's rows, false where it ranks
	 * none; read first by the refusal's order. It is computed only for rows of a pair, so it reads a stored row only on
	 * a statement whose gate refuses. */
	const ranked = branches.some((b) => b.rank !== undefined)
	let query: Select
	if (rest.length === 0) {
		query = {
			...select(coreOf(first, [])),
			orderBy: [
				...(first.rank === undefined ? [] : [asc(first.rank)]),
				...apart.map((f) => asc(first.rows.of(f)))
			],
			limit: lit.int(1, types.integer)
		}
	} else {
		/** Several branches are one UNION ALL, read in ordinal order. */
		const all = supply.relation(internal("unique probe"))
		const probed = fieldColumns(fields, () => supply.column(internal("probe column")))
		const probedOrdinal = supply.column(internal("probe column"))
		const allCol = (f: LawField) => col(all, probed.of(f))
		const allOrdinal = col(all, probedOrdinal)
		const probedRank = ranked ? supply.column(internal("probe rank")) : undefined
		const arm = (b: (typeof branches)[number]): SetCore =>
			coreOf(b, probedRank === undefined ? [] : [target(b.rank ?? lit.bool(false))])
		ctes.push(
			cte(
				all,
				namedBody(select(unionAll("disjoint", [arm(first), ...rest.map(arm)])), [
					...probed.columns,
					probedOrdinal,
					...(probedRank === undefined ? [] : [probedRank])
				])
			)
		)
		query = {
			...provedSelect(
				"keyed",
				[...fields.map((f) => target(allCol(f))), target(allOrdinal)],
				[cteRef(all)],
				undefined
			),
			orderBy: [
				...(probedRank === undefined ? [] : [asc(col(all, probedRank))]),
				...orderOf(allCol, allOrdinal)
			],
			limit: lit.int(1, types.integer)
		}
	}
	ctes.push(cte(refusal, namedBody(query, [...refused.columns, ordinalCol])))
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
