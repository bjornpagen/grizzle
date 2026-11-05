import { appendAll } from "#compiler/core/array.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import {
	concatNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { fieldNames, type LawField } from "#compiler/ir/law.ts"
import type { StatementRole } from "#compiler/ir/products.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import { completeClass } from "#compiler/ir/write.ts"
import { witnessFields } from "#compiler/laws/model/uniques.ts"
import {
	type ColumnMap,
	emptyEnv,
	extendEnv,
	WriteParams
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import { rowOrSingle } from "#compiler/lower/conservative/vector/equality.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import type {
	Assignment,
	Cte,
	EmittedSql,
	Expr,
	Insert,
	Merge,
	Select,
	SelectCore,
	Target,
	Update
} from "#compiler/sql/ast.ts"

import {
	and,
	asc,
	col,
	core,
	countStar,
	cte,
	cteRef,
	eq,
	gt,
	join,
	lit,
	ne,
	notExists,
	select,
	simpleSelect,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import { type FieldColumns, fieldColumns, flatMapNonEmpty } from "#compiler/write/defined.ts"
import { arbiterLaw, type WrittenRelation } from "#compiler/write/frontend/compile.ts"
import {
	inputGuarantees,
	inputHeading,
	keyUniqueBy,
	type RelationInput,
	readInput,
	skipWhenEmptyOf,
	type WriteInput
} from "#compiler/write/insert/input.ts"

import {
	keyFirst,
	writtenFields,
	type ResultColumn,
	type Returning,
	resultText,
	rowType,
	type WithSelect,
	type WriteContext
} from "#compiler/write/insert/statement.ts"
import { buildProbe } from "#compiler/write/insert/unique.ts"
import type { InPlace, KeyArbiter } from "#compiler/write/put/choose.ts"
import type { MergeScope } from "#compiler/write/put/proof.ts"
import {
	type ArmRefusal,
	type RefusalArm,
	refusalGuard,
	refusalRank
} from "#compiler/write/refusal.ts"
import { explicitSerials } from "#compiler/write/serial/advance.ts"

/** What the rows of a put statement that updates in place mean. A refusal is never a row: a same-key pair within the
 * input and a unique object's refusal raise. */
export type PutResult =
	| {
			readonly kind: "upsert"
			readonly relation: string
			readonly columns: ReadonlyArray<ResultColumn>
			/** The complete fact, positions 0 to fields.length - 1, key first. */
			readonly fields: ReadonlyArray<string>
			readonly key: KeySet
	  }
	| {
			readonly kind: "update"
			readonly relation: string
			readonly columns: ReadonlyArray<ResultColumn>
			readonly fields: ReadonlyArray<string>
			readonly key: KeySet
			readonly old: number
	  }
	| {
			readonly kind: "merge"
			readonly relation: string
			readonly columns: ReadonlyArray<ResultColumn>
			readonly action: number
			readonly fields: ReadonlyArray<string>
			readonly first: number
			readonly key: KeySet
	  }

/** One put statement, in the shape of `WriteStatement`.
 *
 * The put statements that update in place, on a mutable relation.
 *
 * The DELETE-then-insert pair is the displacing deletion (delete/) followed by the insert protocol as the put's insert
 * half (insert/); this module builds the three targets that replace the pair on a mutable relation. Each is one
 * statement in the write chain's form, the input CTE then the data-modifying CTE then an outer SELECT that casts every
 * column to its result text, and each returns complete facts, so the outcome's
 * deltas and counts are read and netted by fact identity:
 *
 * - ON CONFLICT DO UPDATE, an enumerated put. The input is the host-normalized relation parameter, a set
 *   unique on the key, so one INSERT never proposes two rows at one key (which PostgreSQL refuses with
 *   21000 for DO UPDATE):
 *
 *     WITH "r1"(...) AS (SELECT ... FROM (SELECT pg_catalog.unnest($1::...[]) ...) AS "r0"),
 *     "r2" AS (INSERT INTO "s"."t" AS "r3" (k..., p...) [OVERRIDING SYSTEM VALUE] SELECT ... FROM "r1" ORDER BY k...
 *              ON CONFLICT (k...) DO UPDATE SET "p" = EXCLUDED."p", ...
 *                WHERE ("r3"."p", ...) <> (EXCLUDED."p", ...)
 *              RETURNING "r3"."k" AS ..., "r3"."p" AS ...)
 *     SELECT "r2".…::text ... FROM "r2"
 *
 *   Every returned row is a fact the put made present: inserted, or updated because its payload differed. An occupant
 *   equal to its member satisfies neither and returns nothing, so an identical put is no-change.
 *
 * - UPDATE ... FROM, a described put proved to read only existing keys. The member is the
 *   input CTE, read through SELECT DISTINCT and gated by the same-key check of the insert protocol, because an UPDATE
 *   whose FROM holds two rows at one key updates the row once with either, where the put's definition refuses the pair
 *   with the key law. Each returned row is the new fact and the old one, `RETURNING new.<f>, old.<f>`,
 *   since every row an UPDATE returns had an old version:
 *
 *     r2 AS (UPDATE "s"."t" AS "r3" SET "p" = "r1"."c2", ... FROM "r1"
 *            WHERE "r3"."k" = "r1"."c1" AND ("r3"."p", ...) <> ("r1"."c2", ...) [AND NOT EXISTS (SELECT 1 FROM "r4")]
 *            RETURNING new."k" AS ..., new."p" AS ..., old."k" AS ..., old."p" AS ...)
 *
 * - MERGE, a put with the deletion of absent keys under a proved scope (`mergeScopeProof`):
 *
 *     r2 AS (MERGE INTO "s"."t" AS "r3" USING "r1" ON "r3"."k" = "r1"."c1"
 *            WHEN MATCHED AND (payload differs) [AND NOT EXISTS r4] THEN UPDATE SET "p" = "r1"."c2", ...
 *            WHEN NOT MATCHED [AND NOT EXISTS r4] THEN INSERT (k..., p...) [OVERRIDING SYSTEM VALUE] VALUES (...)
 *            WHEN NOT MATCHED BY SOURCE AND <scope over r3> [AND NOT EXISTS r4] THEN DELETE
 *            RETURNING merge_action() AS ..., "r3"."k" AS ..., "r3"."p" AS ...)
 *
 *   A MERGE's RETURNING names the target's columns, which are the new row for an INSERT or UPDATE and the old row for a
 *   DELETE, never a source column, which a NOT MATCHED BY SOURCE row lacks. An INSERT or UPDATE row is a
 *   fact the put made present; a DELETE row is a fact the deletion member requested, counted as deleted.
 *
 * No UPDATE assigns a key or a serial field: the key is the arbiter and the match, and a relation with a serial field
 * outside its key never reaches these targets. An insert that supplies a serial key value, the insert
 * arm of ON CONFLICT DO UPDATE and of MERGE included, carries OVERRIDING SYSTEM VALUE. Each of these puts is followed
 * by the sequence advance past its facts' serial keys, the UPDATE ... FROM's too.
 *
 * The UPDATE and the MERGE report a same-key pair within their input as the insert protocol does: the statement changes
 * nothing, and the outer SELECT's second arm returns the input's facts at that key with the marker c9 true, the key
 * law, never an abort. */
export interface PutStatement {
	readonly role: StatementRole
	readonly ast: WithSelect
	readonly sql: EmittedSql
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly result: PutResult
	/** The enumerated input the put realizes, none for an input of no enumerated member (`WriteStatement`). */
	readonly skipWhenEmpty: ParamId | undefined
	readonly returning: Returning
}

/** Builds and emits one statement with fresh names numbered from the context's start and fresh placeholders (the
 * counterpart of `buildStatement` for the put results). */
const buildPut = (
	w: WriteContext,
	build: (supply: NameSupply) => {
		readonly ast: WithSelect
		readonly result: PutResult
		readonly skip: ParamId | undefined
		readonly returning: Returning
	}
): PutStatement => {
	const supply = new NameSupply({ relationStart: w.start.relation, columnStart: w.start.column })
	const placeholders = new WriteParams()
	w.cx.beginWriteStatement(supply, placeholders)
	const built = build(supply)
	const params = [...placeholders.slots]
	const sql = emitText(built.ast, supply.map())
	return Object.freeze({
		role: "member" as const,
		ast: built.ast,
		sql,
		params: Object.freeze(params),
		result: built.result,
		skipWhenEmpty: built.skip,
		returning: built.returning
	})
}

/** A put's spec. A same-key pair within the input raises the law of the relation's primary key. */
interface PutSpec {
	readonly relation: WrittenRelation
	readonly input: WriteInput
	/** The payload its choice proved it may update in place (`InPlace`). */
	readonly inPlace: InPlace
}

/** An upsert's spec: its enumerated slot's relation input and the primary key compared for equality that is its ON
 * CONFLICT arbiter. Its insert arm probes the relation's unique objects besides the arbiter. */
interface UpsertSpec extends PutSpec {
	readonly input: RelationInput
	readonly arbiter: KeyArbiter
}

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** The shared head of every put statement: the input CTE r1 reading the member as facts of the relation, cast into its
 * column types, and the same-key check r4 when the input is not proved unique on the key.
 *
 * The least key that occurs twice, so the witness never depends on the plan. */
const putHead = (w: WriteContext, spec: PutSpec, supply: NameSupply, at: string) => {
	const { relation, input } = spec
	const payload = spec.inPlace.payload
	const guarantees = inputGuarantees(input)
	const all = keyFirst(relation)
	/** The written fields its input carries: a put's facts carry the caller's and serial fields, never an owner's drawn
	 * count or accumulated end, which its families keep (rows-first.md §3). */
	const heading = inputHeading(input)
	const carried = writtenFields(relation).filter((f) => heading.some((c) => c.name === f.name))
	if (!isNonEmpty(carried)) {
		throw defect(`a put of ${relation.name} whose input carries none of its key`)
	}
	const written = carried
	const pk = relation.primaryFields
	const scan = supply.relation(internal("input scan"))
	const r1 = supply.relation(internal("input"))
	const r2 = supply.relation(internal("put"))
	const r3 = supply.relation(internal(`target ${relation.name}`))
	const r4 = keyUniqueBy(guarantees.keyUnique)
		? undefined
		: supply.relation(internal("same-key check"))
	const inputs = fieldColumns(written, () => supply.column(internal("input column")))
	const keys = fieldColumns(r4 === undefined ? [] : pk, () =>
		supply.column(internal("same-key column"))
	)
	const read = readInput(
		w,
		input,
		{
			kind: "input",
			fields: written,
			distinct: !guarantees.distinct,
			alias: scan,
			keys: inputs,
			into: { as: "write" }
		},
		at
	)
	const inCol = (f: LawField): Expr => col(r1, inputs.of(f))
	const ctes: [Cte, ...Array<Cte>] = [cte(r1, inputs.columns, read.select)]
	if (r4 !== undefined) {
		ctes.push(
			cte(r4, keys.columns, {
				...select({
					...core(
						pk.map((f) => target(inCol(f))),
						[cteRef(r1)],
						undefined
					),
					groupBy: pk.map(inCol),
					having: gt(countStar(), lit.int(1, types.integer))
				}),
				orderBy: pk.map((f) => asc(inCol(f))),
				limit: lit.int(1, types.integer)
			})
		)
	}
	const gate =
		r4 === undefined
			? undefined
			: notExists(simpleSelect([target(lit.int(1, types.integer))], [cteRef(r4)], undefined))
	const column = (f: LawField) => w.names.column(relation.name, f.name)
	return { all, written, pk, payload, r1, r2, r3, r4, keys, inputs, inCol, ctes, gate, column }
}

const factColumns = (fields: ReadonlyArray<LawField>): Array<ResultColumn> =>
	fields.map((f) => ({ name: f.name, type: rowType(f) }))

/** The second arm of a statement's verdict rows with a same-key check: the input's facts at the key r4 holds, in each
 * of the verdict heading's groups of fact columns, then the marker true. Every column is an input value, so none is
 * manufactured. */
const sameKeyArm = (
	head: ReturnType<typeof putHead>,
	r4: string,
	prefix: ReadonlyArray<Target>,
	groups: ReadonlyArray<FieldColumns<string>>
): SelectCore => {
	const r4Col = (f: LawField) => col(r4, head.keys.of(f))
	const facts = groups.flatMap((group) => group.pairs.map((p) => target(head.inCol(p.field))))
	return core(
		[...prefix, ...facts, target(lit.bool(true))],
		[
			join(
				cteRef(head.r1),
				cteRef(r4),
				and(mapNonEmpty(head.pk, (f) => eq(head.inCol(f), r4Col(f))))
			)
		],
		undefined
	)
}

/** A put statement's outer SELECT over its verdict rows `body`: the verdict CTE, the refusal CTE of
 * `arms`, and the delivered columns, `deliver` of the verdict CTE, guarded. */
const guardedPut = (
	w: WriteContext,
	supply: NameSupply,
	ctes: ReadonlyArray<Cte>,
	verdicts: { readonly body: Select["body"]; readonly columns: ReadonlyArray<string> },
	arms: (rv: string) => NonEmptyReadonlyArray<RefusalArm>,
	deliver: (rv: string) => ReadonlyArray<Target>
): WithSelect => {
	const rv = supply.relation(internal("verdicts"))
	const verdictCte: Cte = {
		name: rv,
		columns: verdicts.columns,
		materialized: "MATERIALIZED",
		query: select(verdicts.body)
	}
	const guarded = refusalGuard({ supply, schema: w.names.schema, verdicts: rv, arms: arms(rv) })
	return {
		...simpleSelect(deliver(rv), [cteRef(rv)], guarded.guard),
		with: { ctes: concatNonEmpty(ctes, [verdictCte, guarded.cte]), recursive: false }
	}
}

/** The same-key arm of a put's refusals: the verdict rows with the marker `c9`, the key law, its witness the key the
 * row holds, each key field in its column `keyCol(f)`. */
const sameKeyRefusal = (
	spec: PutSpec,
	rv: string,
	c9: string,
	keyCol: (f: LawField) => string
): RefusalArm => ({
	rank: refusalRank.sameKey,
	when: col(rv, c9),
	refusal: {
		kind: "law",
		law: arbiterLaw(spec.relation),
		relation: spec.relation.name,
		key: spec.relation.primaryFields.map((f) => ({
			field: f.name,
			expr: col(rv, keyCol(f)),
			type: rowType(f)
		}))
	}
})

/** INSERT ... ON CONFLICT (pk) DO UPDATE SET payload = EXCLUDED.payload WHERE (t.payload) <> (EXCLUDED.payload). */
export const buildUpsert = (w: WriteContext, spec: UpsertSpec): PutStatement => {
	const { relation, input } = spec
	const at = `put upsert ${relation.name}`
	return buildPut(w, (supply) => {
		const head = putHead(w, spec, supply, at)
		const { all, written, pk, payload, r1, r2, r3, inCol, ctes, column } = head
		const returned = fieldColumns(all, () => supply.column(internal("returned column")))
		/** The unique probe over the insert arm, after every other name: the input is enumerated, so
		 * the host refused a pair within it at every object whose pairs are the host's. */
		const probe = buildProbe(w, supply, {
			relation,
			requested: { kind: "complete", arbiter: spec.relation.uniques.arbiter },
			checks: spec.relation.uniques.checks,
			input: r1,
			inputs: head.inputs,
			normalized: true
		})
		if (probe !== undefined) {
			appendAll(ctes, probe.ctes)
		}
		const cU = probe === undefined ? undefined : supply.column(internal("unique marker"))
		const insert: Insert = {
			kind: "insert",
			with: undefined,
			table: w.names.relation(relation.name),
			alias: r3,
			columns: written.map(column),
			overriding:
				explicitSerials(spec.relation, completeClass).length > 0 ? "SYSTEM VALUE" : undefined,
			source: {
				kind: "query",
				query: {
					...simpleSelect(
						written.map((f) => target(inCol(f))),
						[cteRef(r1)],
						probe?.gate
					),
					orderBy: pk.map((f) => asc(inCol(f)))
				}
			},
			onConflict: {
				kind: "columns",
				columns: mapNonEmpty(pk, column),
				action: {
					kind: "doUpdate",
					set: mapNonEmpty(payload, (f): Assignment => ({
						column: column(f),
						value: { kind: "excluded", column: column(f) }
					})),
					where: ne(
						rowOrSingle(mapNonEmpty(payload, (f) => col(r3, column(f)))),
						rowOrSingle(
							mapNonEmpty(payload, (f) => ({ kind: "excluded" as const, column: column(f) }))
						)
					)
				}
			},
			returning: returned.pairs.map((p) => targetAs(col(r3, column(p.field)), p.column))
		}
		ctes.push(cte(r2, [], insert))
		const columns = factColumns(all)
		const result: PutResult = {
			kind: "upsert",
			relation: relation.name,
			columns,
			fields: fieldNames(all),
			key: fieldNames(pk)
		}
		const returning: Returning = {
			cte: r2,
			kind: "added",
			added: { columns: returned, conditions: [] }
		}
		const text = (alias: string) =>
			returned.pairs.map((p) =>
				targetAs(resultText(col(alias, p.column), rowType(p.field)), p.column)
			)
		if (probe === undefined || cU === undefined) {
			return {
				ast: {
					...select(core(text(r2), [cteRef(r2)], undefined)),
					with: { ctes, recursive: false }
				},
				result,
				skip: input.slot,
				returning
			}
		}
		/** The verdict rows: every fact the upsert made present, then the probe's refusal, the requested fact and its
		 * signed ordinal. */
		const body: Select["body"] = {
			kind: "setOp",
			op: "UNION ALL",
			arms: [
				core(
					[
						...returned.columns.map((c) => targetAs(col(r2, c), c)),
						targetAs(lit.int(0, types.integer), cU)
					],
					[cteRef(r2)],
					undefined
				),
				core(
					[...all.map((f) => target(probe.refusalValue(f))), target(probe.ordinal)],
					[cteRef(probe.refusal)],
					undefined
				)
			]
		}
		const ast = guardedPut(
			w,
			supply,
			ctes,
			{ body, columns: [...returned.columns, cU] },
			(rv) =>
				flatMapNonEmpty(probe.checks, (u, i): NonEmptyReadonlyArray<RefusalArm> => {
					const refusal: ArmRefusal = {
						kind: "law",
						law: u.law,
						relation: relation.name,
						key: witnessFields(u).map((f) => ({
							field: f.name,
							expr: col(rv, returned.of(f)),
							type: rowType(f)
						}))
					}
					return [
						{
							rank: refusalRank.uniqueWithin,
							when: eq(col(rv, cU), lit.int(-(i + 1), types.integer)),
							refusal
						},
						{
							rank: refusalRank.uniqueStored,
							when: eq(col(rv, cU), lit.int(i + 1, types.integer)),
							refusal
						}
					]
				}),
			text
		)
		return { ast, result, skip: input.slot, returning }
	})
}

/** UPDATE ... FROM the member, with the differs condition, RETURNING the new and the old fact. */
export const buildUpdateFrom = (w: WriteContext, spec: PutSpec): PutStatement => {
	const { relation, input } = spec
	const at = `put update ${relation.name}`
	return buildPut(w, (supply) => {
		const head = putHead(w, spec, supply, at)
		const { all, pk, payload, r1, r2, r3, r4, inCol, ctes, gate, column } = head
		const fresh = fieldColumns(all, () => supply.column(internal("new column")))
		const old = fieldColumns(all, () => supply.column(internal("old column")))
		const c9 = r4 === undefined ? undefined : supply.column(internal("same-key marker"))
		const update: Update = {
			kind: "update",
			table: w.names.relation(relation.name),
			alias: r3,
			set: mapNonEmpty(payload, (f): Assignment => ({ column: column(f), value: inCol(f) })),
			from: [cteRef(r1)],
			where: and(
				concatNonEmpty(
					pk.map((f) => eq(col(r3, column(f)), inCol(f))),
					[
						ne(
							rowOrSingle(mapNonEmpty(payload, (f) => col(r3, column(f)))),
							rowOrSingle(mapNonEmpty(payload, inCol))
						),
						...(gate === undefined ? [] : [gate])
					]
				)
			),
			returning: [
				...fresh.pairs.map((p) =>
					targetAs({ kind: "returning", side: "new", column: column(p.field) }, p.column)
				),
				...old.pairs.map((p) =>
					targetAs({ kind: "returning", side: "old", column: column(p.field) }, p.column)
				)
			],
			with: undefined
		}
		ctes.push(cte(r2, [], update))
		const text = (alias: string) =>
			[...fresh.pairs, ...old.pairs].map((p) =>
				targetAs(resultText(col(alias, p.column), rowType(p.field)), p.column)
			)
		const result: PutResult = {
			kind: "update",
			relation: relation.name,
			columns: [...factColumns(all), ...factColumns(all)],
			fields: fieldNames(all),
			key: fieldNames(pk),
			old: all.length
		}
		const skip = {
			skip: skipWhenEmptyOf(input),
			returning: {
				cte: r2,
				kind: "both",
				added: { columns: fresh, conditions: [] },
				removed: { columns: old, conditions: [] }
			}
		} as const
		if (c9 === undefined || r4 === undefined) {
			return {
				ast: {
					...select(core(text(r2), [cteRef(r2)], undefined)),
					with: { ctes, recursive: false }
				},
				result,
				...skip
			}
		}
		/** The verdict rows: every new fact with the old one it displaced, then the same-key pair. */
		const body: Select["body"] = {
			kind: "setOp",
			op: "UNION ALL",
			arms: [
				core(
					[
						...[...fresh.columns, ...old.columns].map((c) => targetAs(col(r2, c), c)),
						targetAs(lit.bool(false), c9)
					],
					[cteRef(r2)],
					undefined
				),
				sameKeyArm(head, r4, [], [fresh, old])
			]
		}
		const ast = guardedPut(
			w,
			supply,
			ctes,
			{ body, columns: [...fresh.columns, ...old.columns, c9] },
			(rv) => [sameKeyRefusal(spec, rv, c9, fresh.of)],
			text
		)
		return { ast, result, ...skip }
	})
}

/** A MERGE's spec: also the primary key compared for equality that it matches on, and the scope of the deletion it
 * absorbs. */
interface MergeSpec extends PutSpec {
	readonly arbiter: KeyArbiter
	readonly scope: MergeScope
}

/** The scope predicate over the MERGE target's columns (`MergeScope`). */
const scopePredicate = (w: WriteContext, spec: MergeSpec, r3: string): Expr | undefined => {
	const { relation, scope } = spec
	const map: Map<string, Expr> = new Map()
	for (const [column, field] of scope.fieldOf) {
		map.set(column, col(r3, w.names.column(relation.name, field)))
	}
	const columns: ColumnMap = map
	const env = extendEnv(
		emptyEnv,
		scope.nodes.map((n) => [n, columns] as const)
	)
	/** The proof binds each constant to a column of the relation's own occurrence, a Base of the relation
	 * (`scopedFacts`), so each is a field of the relation. */
	const parts: Array<Expr> = [
		...scope.predicates.map((p) => lowerExpr(w.cx, p, env)),
		...scope.constants.map((c) =>
			eq(col(r3, w.names.column(relation.name, c.field)), lowerExpr(w.cx, c.expr, env))
		)
	]
	return isNonEmpty(parts) ? and(parts) : undefined
}

/** MERGE INTO r USING (input) ON key WHEN MATCHED AND differs THEN UPDATE WHEN NOT MATCHED THEN INSERT WHEN NOT
 * MATCHED BY SOURCE AND <scope> THEN DELETE RETURNING merge_action(), <fact>. */
export const buildMerge = (w: WriteContext, spec: MergeSpec): PutStatement => {
	const { relation, input } = spec
	const at = `put merge ${relation.name}`
	return buildPut(w, (supply) => {
		const head = putHead(w, spec, supply, at)
		const { all, written, pk, payload, r1, r2, r3, r4, inCol, ctes, gate, column } = head
		const actionCol = supply.column(internal("merge action"))
		const returned = fieldColumns(all, () => supply.column(internal("returned column")))
		const c9 = r4 === undefined ? undefined : supply.column(internal("same-key marker"))
		const gatedBy = (condition: Expr): Expr =>
			gate === undefined ? condition : and([condition, gate])
		const gated = (condition: Expr | undefined): Expr | undefined =>
			condition === undefined ? gate : gatedBy(condition)
		const scope = scopePredicate(w, spec, r3)
		const notMatched = gated(undefined)
		const bySource = gated(scope)
		const merge: Merge = {
			kind: "merge",
			table: w.names.relation(relation.name),
			alias: r3,
			using: cteRef(r1),
			on: and(mapNonEmpty(pk, (f) => eq(col(r3, column(f)), inCol(f)))),
			whens: [
				{
					match: "MATCHED",
					condition: gatedBy(
						ne(
							rowOrSingle(mapNonEmpty(payload, (f) => col(r3, column(f)))),
							rowOrSingle(mapNonEmpty(payload, inCol))
						)
					),
					action: {
						kind: "update",
						set: mapNonEmpty(payload, (f) => ({ column: column(f), value: inCol(f) }))
					}
				},
				{
					match: "NOT MATCHED",
					condition: notMatched,
					action: {
						kind: "insert",
						overriding:
							explicitSerials(spec.relation, completeClass).length > 0 ? "SYSTEM VALUE" : undefined,
						row: mapNonEmpty(written, (f) => ({ column: column(f), value: inCol(f) }))
					}
				},
				{
					match: "NOT MATCHED BY SOURCE",
					condition: bySource,
					action: { kind: "delete" }
				}
			],
			returning: [
				targetAs({ kind: "mergeAction" }, actionCol),
				...returned.pairs.map((p) => targetAs(col(r3, column(p.field)), p.column))
			],
			with: undefined
		}
		ctes.push(cte(r2, [], merge))
		const text = (alias: string) => [
			targetAs(col(alias, actionCol), actionCol),
			...returned.pairs.map((p) =>
				targetAs(resultText(col(alias, p.column), rowType(p.field)), p.column)
			)
		]
		const result: PutResult = {
			kind: "merge",
			relation: relation.name,
			columns: [{ name: "action", type: wildcardText }, ...factColumns(all)],
			action: 0,
			fields: fieldNames(all),
			first: 1,
			key: fieldNames(pk)
		}
		const deleted = lit.text("DELETE", types.text)
		const skip = {
			skip: skipWhenEmptyOf(input),
			returning: {
				cte: r2,
				kind: "both",
				added: { columns: returned, conditions: [ne(col(r2, actionCol), deleted)] },
				removed: { columns: returned, conditions: [eq(col(r2, actionCol), deleted)] }
			}
		} as const
		if (c9 === undefined || r4 === undefined) {
			return {
				ast: {
					...select(core(text(r2), [cteRef(r2)], undefined)),
					with: { ctes, recursive: false }
				},
				result,
				...skip
			}
		}
		/** The verdict rows: every fact the MERGE changed with its action, then the same-key pair. */
		const body: Select["body"] = {
			kind: "setOp",
			op: "UNION ALL",
			arms: [
				core(
					[
						targetAs(col(r2, actionCol), actionCol),
						...returned.columns.map((c) => targetAs(col(r2, c), c)),
						targetAs(lit.bool(false), c9)
					],
					[cteRef(r2)],
					undefined
				),
				sameKeyArm(head, r4, [target(lit.text("INSERT", types.text))], [returned])
			]
		}
		const ast = guardedPut(
			w,
			supply,
			ctes,
			{ body, columns: [actionCol, ...returned.columns, c9] },
			(rv) => [sameKeyRefusal(spec, rv, c9, returned.of)],
			text
		)
		return { ast, result, ...skip }
	})
}
