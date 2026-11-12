import type { CheckedEntry, CheckedSchema } from "#compiler/analysis/schema.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import type { EntryName, LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { fieldNames, type LawField, type RelationInfo } from "#compiler/ir/law.ts"
import type { SerialClass } from "#compiler/ir/write.ts"
import { columnReads, witnessFields } from "#compiler/laws/model/uniques.ts"
import type { Cte, Expr, FunctionName, TypeRef } from "#compiler/sql/ast.ts"
import {
	cast,
	col,
	cteRef,
	lit,
	not,
	provedSelect,
	qualifiedCall,
	simpleSelect,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { fieldColumns } from "#compiler/write/defined.ts"
import { filterFields, filterReadsOther, renderMembership } from "#compiler/write/entry/render.ts"
import type { WrittenRelation } from "#compiler/write/frontend/compile.ts"
import { readInputFields, skipWhenEmptyOf, type WriteInput } from "#compiler/write/insert/input.ts"
import {
	buildStatement,
	type EntryCheckResult,
	ownBuild,
	requestedValue,
	rowType,
	type WriteContext,
	type WriteStatement,
	writeValue
} from "#compiler/write/insert/statement.ts"
import { type OutsideProbe, probeParams, readsDrawn } from "#compiler/write/insert/unique.ts"
import {
	outsideDetail,
	type RefusalArm,
	refusalCall,
	refusalGuard,
	refusalRank
} from "#compiler/write/refusal.ts"

/** The role's names a check reads (`WorldNames`, which the program layer passes as data): the filter
 * function of each writable entry, by the entry's name and its arguments' types; and each probe of an entry
 * (insert/unique.ts OutsideProbe), by the entry's name, the probe, whose identity names it (insert/unique.ts
 * probeIdentity), and the types of its parameters (insert/unique.ts probeParams), true where a fact of the target
 * outside the entry conflicts with them at the probe's object. */
export interface CheckNames {
	readonly filterFunction: (entry: string, args: ReadonlyArray<TypeRef>) => FunctionName
	readonly probe: (entry: string, probe: OutsideProbe, args: ReadonlyArray<TypeRef>) => FunctionName
}

/** What a write compiles as: reality, whose writes check nothing, or a role, whose names name the filter functions its
 * query entries' checks call. */
export type WriteWorld =
	| { readonly kind: "reality" }
	| { readonly kind: "role"; readonly names: CheckNames }

/** What a check reads of a requested fact for one probe, and what it refuses: the fields the probe's arguments are,
 * each once, in its argument order, and its function at their types; the law a fact outside the entry conflicting
 * there breaks; and the fields the refusal's witness names, the object's compared fields and its span. */
interface ProbeCall {
	readonly args: ReadonlyArray<LawField>
	readonly fn: (argTypes: ReadonlyArray<TypeRef>) => FunctionName
	readonly law: LawId
	readonly witness: ReadonlyArray<LawField>
}

const probeCall = (world: CheckNames, entry: string, probe: OutsideProbe): ProbeCall => ({
	args: probeParams(probe),
	fn: (argTypes) => world.probe(entry, probe, argTypes),
	law: probe.object.law,
	witness: witnessFields(probe.object)
})

/** The fields of `relation` a generation expression reads, in declared field order. */
const generatedFrom = (relation: RelationInfo, expr: ScalarExpr): ReadonlyArray<LawField> => {
	const reads = new Set(columnReads(expr).map((c) => c.name))
	return relation.fields.filter((f) => reads.has(f.name))
}

/** What a check refuses: an addition's facts outside the entry's membership, or conflicting at a unique object with a
 * fact outside the entry; or any fact of an addition the Db's claims leave outside the world. */
export type EntryCheck =
	| {
			readonly kind: "membership"
			readonly entry: CheckedEntry
			readonly relation: WrittenRelation
			/** The unique objects of the relation the check probes (`outsideProbes`). */
			readonly probes: ReadonlyArray<OutsideProbe>
			/** The base the entry's filter reads, checked, with the catalog its membership is lowered against, and the
			 * role's names, whose filter function the check calls when the filter reads another relation, and whose key
			 * and unique probes it calls. */
			readonly base: CheckedSchema
			readonly catalog: EvidenceCatalog
			readonly world: CheckNames
	  }
	| { readonly kind: "outside"; readonly entry: EntryName }

const entryOf = (check: EntryCheck): EntryName =>
	check.kind === "membership" ? check.entry.entry : check.entry

/** The probes of a query entry over `relation` an addition of serial class `serial` calls for a fact outside the entry:
 * every probe the role installs (insert/unique.ts RelationUniques.probes), at every declared key and every object no
 * declared key subsumes, so every object the addition's statement meets; but for a generated addition none reading a
 * field it draws, whose value the identity default draws only at the insert. */
export const outsideProbes = (
	relation: WrittenRelation,
	serial: SerialClass
): ReadonlyArray<OutsideProbe> =>
	serial.kind === "generated"
		? relation.uniques.probes.filter((probe) => !readsDrawn(probe.object, serial.drawn))
		: relation.uniques.probes

/** What the membership of a row in a query entry reads: the entry, the checked base its filter reads with the catalog
 * its membership is lowered against, and the role's names, whose filter function it calls when the filter reads another
 * relation. */
export type EntryMembership = Pick<
	Extract<EntryCheck, { readonly kind: "membership" }>,
	"entry" | "base" | "catalog" | "world"
>

/** The membership of the row whose fields `value` gives, in the entry (see `buildEntryCheck`): the row policy's own
 * predicate, or the role's filter function where the filter reads another relation. */
export const membershipOf = (
	w: WriteContext,
	check: EntryMembership,
	value: (field: LawField) => Expr
): Expr => {
	const { entry } = check
	if (!filterReadsOther(entry)) {
		const rendered = renderMembership(entry, {
			schema: check.base,
			names: w.names,
			catalog: check.catalog,
			row: value
		})
		if (!rendered.ok) {
			throw new Refusal(rendered.error)
		}
		return rendered.value
	}
	const fields = filterFields(entry)
	const fn = check.world.filterFunction(
		entry.entry,
		fields.map((f) => w.cx.baseTypeRef(rowType(f)))
	)
	return qualifiedCall(
		fn.schema,
		fn.name,
		fields.map((f) => cast(value(f), w.cx.baseTypeRef(rowType(f))))
	)
}

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** The check of `input`, an addition's facts (see `buildEntryCheck`).
 *
 * A query entry's checks of the facts its additions write, each raised inside one statement of the write's flight.
 *
 * A write into a role's query entry is DML on its target T under row security, whose policy holds exactly the entry's
 * rows. grizzle's own path never trips that policy, nor meets a fact the role cannot see:
 * before an addition writes, one statement reads the facts it is about to write, its fill's rows,
 * and judges each twice:
 *
 * - its membership in the entry: the policy's own predicate (`renderMembership`), or, when that reads another
 *   relation, the role's filter function over the row's filter fields, which runs as the owner, since the role reads
 *   no base relation but T;
 * - for every unique object of T the row's statement meets (`outsideProbes`), whether a fact of T outside the entry
 *   conflicts with the row there: for each key, the primary key and each candidate key, whether such a fact holds the
 *   row's key, through the role's key probe of that key; for each object no key subsumes, such as a key over a
 *   selected side, whether such a fact occupies it at the row's values, through the role's unique probe of
 *   it. Each probe runs as the owner and answers that alone. An object reading a serial field an addition leaves to
 *   the identity default is not probed: the value is drawn at the insert. A generated field an object reads is the
 *   field's generation expression over the row's fields, cast into their domains as the addition writes them, the
 *   value PostgreSQL stores; a row whose fields its domains refuse is refused there, on their law, before its
 *   membership is judged, which the README leaves unpromised for a row both outside the entry and breaking a rule.
 *
 * The verdicts are refusal arms over the rows, raised through the refusal function: a fact outside
 * the entry first, as the entry's `outside-world` refusal, which names the entry and carries no value; then a conflict
 * with a fact outside, on that object's law, the row's submitted values at the object's compared fields and span as its
 * DETAIL, the least first, in T's terms, which the adapter names in the entry's. The probe answers no more than the
 * collision itself reveals, and the witness carries only the role's own submitted values.
 *
 *   WITH "rv"(...) AS MATERIALIZED (SELECT <key values>, <membership> AS "inside", <probe>(<values>) AS "held", ...
 *                                   FROM <the addition's input>),
 *        "rw"(...) AS (SELECT 6, '42Z01', '<entry>', 'o["<entry>"]' FROM "rv" WHERE NOT "inside"
 *                      UNION ALL SELECT 7, '23000', '<object's law>', <key DETAIL> FROM "rv" WHERE "held" ...
 *                      ORDER BY 1, 4 LIMIT 1)
 *   SELECT 'true' FROM "rv" WHERE NOT EXISTS (SELECT 1 FROM "rw" WHERE "s"."__refuse"(...)) LIMIT 1
 *
 * The check runs right before the addition's statement. The relations a filter reads are not written in its stratum
 * (the front end refuses that), so the membership it judges is the stratum's own; a hidden fact is never written
 * through the entry, so neither is a probe's answer. A row the statement then inserts meets no fact outside the entry
 * in the transaction's snapshot at any unique object: a unique violation the server still raises there is a fact a
 * concurrent transaction committed, which aborts the apply (insert/unique.ts), and a 42501 is no outcome of the write
 * but its failure.
 *
 * An addition into an entry whose fixed fields read a context the Db holds no fact of has every fact outside the world
 * (frontend OutsideWrite): its check refuses any row of its source, with no membership to evaluate, at the start of its
 * stratum. */
export const buildEntryCheck = (
	w: WriteContext,
	input: WriteInput,
	check: EntryCheck
): WriteStatement<EntryCheckResult> => {
	const entry = entryOf(check)
	const at = `precheck ${entry}`
	const skipWhenEmpty = skipWhenEmptyOf(input)
	if (check.kind === "outside") {
		return buildStatement(w, ownBuild, (supply) => {
			const { from } = readInputFields(w, input, at)
			const refuse = refusalCall(
				w.names.schema,
				sqlstates.grizzleOutsideWorld,
				entry,
				outsideDetail(entry)
			)
			const output = supply.column({ kind: "internal", purpose: "outside-world refusal" })
			return {
				ast: {
					...provedSelect(
						"oneRow",
						[targetAs(cast(refuse, types.text), output)],
						[from],
						undefined
					),
					limit: lit.int(1, types.integer)
				},
				role: "probe",
				result: { kind: "entryCheck", entry },
				skipWhenEmpty
			}
		})
	}
	const { relation, probes } = check
	const calls = probes.map((probe) => probeCall(check.world, check.entry.entry, probe))
	/** The fields a refusal's witness names, each a column of the verdicts. */
	const keyFields = [...new Set(calls.flatMap((c) => c.witness))]
	return buildStatement(w, ownBuild, (supply) => {
		const { from, read } = readInputFields(w, input, at)
		const baseType = (f: LawField): TypeRef => w.cx.baseTypeRef(rowType(f))
		/** A field the row states, cast into its domain as the addition's statement writes it. */
		const written = (f: LawField): Expr => {
			const r = read(f.name)
			return writeValue(w, r.value, r.type, rowType(f), at)
		}
		/** The row's value at a field, at its base type: one it states as it reads, and a generated one at its generation
		 * expression over the fields it is generated from, written into their domains (insert/statement.ts
		 * requestedValue), the value PostgreSQL stores. */
		const typed = (f: LawField): Expr =>
			cast(
				f.writing.kind === "generated"
					? requestedValue(w, relation, generatedFrom(relation, f.writing.expr), written)(f)
					: read(f.name).value,
				baseType(f)
			)
		const rv = supply.relation(internal("verdicts"))
		const keyColumns = fieldColumns(keyFields, (f) => supply.column(internal(`key ${f.name}`)))
		const inside = supply.column(internal("membership"))
		const held = calls.map((call) => ({
			call,
			column: supply.column(internal(`held ${fieldNames(call.args).join(", ")}`))
		}))
		const verdicts: Cte = {
			name: rv,
			columns: [...keyColumns.columns, inside, ...held.map((h) => h.column)],
			materialized: "MATERIALIZED",
			query: simpleSelect(
				[
					...keyFields.map((f) => targetAs(typed(f), keyColumns.of(f))),
					targetAs(membershipOf(w, check, typed), inside),
					...held.map(({ call, column }) => {
						const fn = call.fn(call.args.map(baseType))
						return targetAs(qualifiedCall(fn.schema, fn.name, call.args.map(typed)), column)
					})
				],
				[from],
				undefined
			)
		}
		const arms: NonEmptyReadonlyArray<RefusalArm> = [
			{
				rank: refusalRank.outside,
				when: not(col(rv, inside)),
				refusal: { kind: "outside", entry }
			},
			...held.map(({ call, column }): RefusalArm => ({
				rank: refusalRank.heldOutside,
				when: col(rv, column),
				refusal: {
					kind: "law",
					law: call.law,
					relation: relation.name,
					key: call.witness.map((f) => ({
						field: f.name,
						expr: col(rv, keyColumns.of(f)),
						type: rowType(f)
					}))
				}
			}))
		]
		const guarded = refusalGuard({ supply, schema: w.names.schema, verdicts: rv, arms })
		const output = supply.column(internal("checked"))
		return {
			ast: {
				...provedSelect(
					"oneRow",
					[targetAs(lit.text("true", types.text), output)],
					[cteRef(rv)],
					guarded.guard
				),
				limit: lit.int(1, types.integer),
				with: { ctes: [verdicts, guarded.cte], recursive: false }
			},
			role: "probe",
			result: { kind: "entryCheck", entry },
			skipWhenEmpty
		}
	})
}
