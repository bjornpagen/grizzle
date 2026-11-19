import { type Identity, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { rowEq } from "#compiler/ir/compare.ts"
import type { TermDesc } from "#compiler/ir/desc.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import { fieldColumnType } from "#compiler/ir/physical.ts"
import { generations, reality } from "#compiler/laws/model/generation.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import type { OwnedStatement } from "#compiler/schema/own.ts"
import type {
	Cte,
	Delete,
	Expr,
	FromItem,
	FromSource,
	FunctionName,
	FunctionParam,
	ObjectName,
	PerformQuery,
	PlFunction,
	PlStatement,
	Revoke,
	Select,
	SetOf,
	SetOperand,
	Update
} from "#compiler/sql/ast.ts"
import {
	and,
	arrayOf,
	asc,
	call,
	col,
	core,
	countStar,
	cteRefAs,
	derived,
	distinctCore,
	functionNameOf,
	grouped,
	join,
	lit,
	not,
	notExists,
	operandSelect,
	operandUnionAll,
	provedSelect,
	qualifiedCall,
	select,
	table,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { assignments } from "#compiler/sql/generation.ts"
import { raised, refusalFunctionName } from "#compiler/write/refusal.ts"

/** A body relation of a unit as its functions read it: its table and its group fields in the header key's order. */
interface UnitBody {
	readonly relation: string
	readonly table: ObjectName
	readonly group: NonEmptyReadonlyArray<LawField>
}

/**
 * A retirable unit as its functions are built from it: its header's table, key fields and retirement field; each body
 * relation's table and group fields; and the fence a hold refuses by, the law that keeps its first body's rows in open
 * groups, with that body.
 */
interface UnitPlan {
	readonly header: string
	readonly table: ObjectName
	readonly key: NonEmptyReadonlyArray<LawField>
	readonly lifecycle: LawField
	readonly bodies: NonEmptyReadonlyArray<UnitBody>
	readonly fence: { readonly law: LawId; readonly body: UnitBody }
}

/** The handle of `relation`, which the law model holds for every ordinary relation of the installation. */
const relationInfo = (b: InstallBuilder, relation: string): RelationInfo => {
	const laws = b.model.relations.get(relation)
	if (laws === undefined) {
		throw defect(`the law model holds the retirable relation ${relation}`)
	}
	return laws.relation
}

/** The fields of `relation` named `names`, in their order. */
const fieldsNamed = (
	relation: RelationInfo,
	names: NonEmptyReadonlyArray<string>
): NonEmptyReadonlyArray<LawField> =>
	mapNonEmpty(names, (name) => {
		const field = relation.fields.find((f) => f.name === name)
		if (field === undefined) {
			throw defect(`${relation.name} holds the field ${name} its unit names`)
		}
		return field
	})

/** A side's field terms by name, in order: a unit's sides read fields alone (schema/own.ts, the retirable admission). */
const termNames = (terms: NonEmptyReadonlyArray<TermDesc>): NonEmptyReadonlyArray<string> =>
	mapNonEmpty(terms, (t) => {
		if (t.kind !== "field") {
			throw defect("a retirable statement's side reads fields alone")
		}
		return t.field
	})

/**
 * The law of `body`'s fence: the containment of its group in the header's open groups, the one law from `body` into
 * `header` a retirable statement states (analysis/theory/laws.ts), whichever reference the law model's foreign key for
 * it takes (laws/model/plan.ts referenceChoice): the header's retirement field beside its key, or a column of the
 * header's open keys.
 */
const fenceLaw = (b: InstallBuilder, body: string, header: string): LawId => {
	const fence = b.model.theory.laws.find(
		(law) =>
			law.source.kind === "retirable" &&
			law.detail.kind === "containment" &&
			law.detail.from.relation === body &&
			law.detail.to.relation === header
	)
	if (fence === undefined) {
		throw defect(`the theory states the fence of ${body} into the open groups of ${header}`)
	}
	return fence.id
}

/** Every unit of the installation, by its retirable statement, in the order ownership lists them. */
const unitPlans = (b: InstallBuilder): ReadonlyArray<UnitPlan> =>
	b.owned.statements.flatMap((s: OwnedStatement): ReadonlyArray<UnitPlan> => {
		if (s.kind !== "retirable") {
			return []
		}
		const header = relationInfo(b, s.header.relation)
		const [lifecycle] = fieldsNamed(header, [s.lifecycle])
		const bodies = mapNonEmpty(s.bodies, (side): UnitBody => {
			const relation = relationInfo(b, side.relation)
			return {
				relation: side.relation,
				table: b.names.relation(side.relation),
				group: fieldsNamed(relation, termNames(side.terms))
			}
		})
		const first = bodies[0]
		return [
			{
				header: s.header.relation,
				table: b.names.relation(s.header.relation),
				key: fieldsNamed(header, termNames(s.header.terms)),
				lifecycle,
				bodies,
				fence: { law: fenceLaw(b, first.relation, s.header.relation), body: first }
			}
		]
	})

/** The column every one of a unit's group keys travels as: `c<n>`, by the key field's position. */
const keyColumn = (at: number): string => `c${at + 1}`

/** One function parameter per key field, the array of that field's values, in key order: `keys_1` the first. */
const keyParams = (b: InstallBuilder, unit: UnitPlan): ReadonlyArray<FunctionParam> =>
	unit.key.map((field, at) => {
		const array = arrayOf(fieldColumnType(b.names, field.type).type)
		if (array === undefined) {
			throw defect(`a retirable key field ${unit.header}.${field.name} of a type with an array`)
		}
		return { name: `keys_${at + 1}`, type: array }
	})

/** A function's argument as its body reads it, by name. */
const argument = (p: FunctionParam): Expr => ({ kind: "plVar", name: p.name })

/**
 * The distinct groups a call states, `(SELECT DISTINCT <unnest>.c1, … FROM unnest(keys_1, …) AS <unnest>(c1, …)) AS
 * <alias>(c1, …)`: the function's key arrays read in lockstep, each group once.
 */
const statedGroups = (
	unit: UnitPlan,
	params: ReadonlyArray<FunctionParam>,
	alias: string,
	unnested: string
): FromSource => {
	const columns = unit.key.map((_, at) => keyColumn(at))
	const unnest: FromItem = {
		kind: "function",
		call: call("unnest", params.map(argument)),
		alias: unnested,
		columns,
		lateral: false,
		ordinality: false
	}
	const [first, ...rest] = columns.map((c) => targetAs(col(unnested, c), c))
	if (first === undefined) {
		throw defect(`a retirable header ${unit.header} keyed by one field at least`)
	}
	return derived(select(distinctCore([first, ...rest], [unnest], undefined)), alias, columns, false)
}

/** The header row at a group: its key fields, each equal to the group's column of its position, at its type. */
const atGroup = (b: InstallBuilder, unit: UnitPlan, header: string, group: string): Expr =>
	rowEq(
		{
			fields: unit.key,
			typeOf: (f) => f.type,
			left: (f) => col(header, f.column),
			right: (f) => col(group, keyColumn(unit.key.indexOf(f)))
		},
		b.names
	)

/** A body's rows in a group: its group fields, each equal to the group's column of its position, at its type. */
const bodyAtGroup = (b: InstallBuilder, body: UnitBody, alias: string, group: string): Expr =>
	rowEq(
		{
			fields: body.group,
			typeOf: (f) => f.type,
			left: (f) => col(alias, f.column),
			right: (f) => col(group, keyColumn(body.group.indexOf(f)))
		},
		b.names
	)

/** Whether a header row's group is open: its retirement field false. */
const open = (unit: UnitPlan, header: string): Expr => not(col(header, unit.lifecycle.column))

/**
 * The open headers of the groups a call states, in key order, locked until the transaction ends at `strength`:
 * `PERFORM 1 FROM <header> AS r1 JOIN <groups> AS r2 ON <r1 at r2> WHERE NOT r1.<retired> ORDER BY r1.<key> FOR
 * <strength> OF r1`, the groups' unnest r3.
 */
const lockOpen = (
	b: InstallBuilder,
	unit: UnitPlan,
	params: ReadonlyArray<FunctionParam>,
	strength: "KEY SHARE" | "UPDATE"
): PlStatement => {
	const query: PerformQuery = {
		body: core(
			[target(lit.int(1, types.integer))],
			[
				join(
					table(unit.table.schema, unit.table.name, "r1"),
					statedGroups(unit, params, "r2", "r3"),
					atGroup(b, unit, "r1", "r2")
				)
			],
			open(unit, "r1")
		),
		orderBy: unit.key.map((f) => asc(col("r1", f.column))),
		limit: undefined,
		offset: undefined
	}
	return { kind: "lockRows", query, strength, of: "r1" }
}

/**
 * The hold's refusal of a group the call states that is not open, its header absent or retired: the first in key
 * order, refused on the fence of the unit's first body at that group, the law every body's write into it would break,
 * `k["<body>",["<group field>",…],["<value>",…]]`, the refused group's values at the body's group fields: `PERFORM
 * <refusal> FROM <groups> AS r1 WHERE NOT EXISTS (SELECT 1 FROM <header> AS r3 WHERE <r3 at r1> AND NOT
 * r3.<retired>) ORDER BY r1.c1, … LIMIT 1`, the groups' unnest r2.
 */
const refuseClosed = (
	b: InstallBuilder,
	unit: UnitPlan,
	params: ReadonlyArray<FunctionParam>
): PlStatement => {
	const { body, law } = unit.fence
	const refusal = raised({
		kind: "law",
		law,
		relation: body.relation,
		key: body.group.map((f, at) => ({
			field: f.name,
			expr: col("r1", keyColumn(at)),
			type: f.type
		}))
	})
	const openAt = operandSelect(
		core(
			[target(lit.int(1, types.integer))],
			[table(unit.table.schema, unit.table.name, "r3")],
			and([atGroup(b, unit, "r3", "r1"), open(unit, "r3")])
		)
	)
	return {
		kind: "perform",
		query: {
			body: core(
				[
					target(
						qualifiedCall(b.schema, refusalFunctionName, [
							lit.text(refusal.state, types.text),
							lit.text(law, types.text),
							refusal.detail
						])
					)
				],
				[statedGroups(unit, params, "r1", "r2")],
				notExists(openAt)
			),
			orderBy: unit.key.map((_, at) => asc(col("r1", keyColumn(at)))),
			limit: lit.int(1, types.bigint),
			offset: undefined
		}
	}
}

/**
 * The retirement of the groups the locked headers head, one statement, which returns its counts: every body's rows in
 * them deleted, then each header's retirement field set, so the fence's NO ACTION check, at the statement's end, finds
 * no row of the group; and the count of each, the header's groups retired first, then each body's rows removed, in body
 * order, one array:
 *
 *   RETURN QUERY
 *   WITH r1(c1, …) AS MATERIALIZED (SELECT r2.<key> FROM <header> AS r2 JOIN <groups> AS r3 ON <r2 at r3>
 *          WHERE NOT r2.<retired>),
 *        r5 AS (DELETE FROM <body 1> AS r6 USING r1 AS r7 WHERE <r6 at r7> RETURNING 1 AS c1), …,
 *        r<n> AS (UPDATE <header> AS r<n + 1> SET <retired> = true FROM r1 AS r<n + 2> WHERE <r<n + 1> at r<n + 2>>
 *          RETURNING 1 AS c1)
 *   SELECT r<n + 4>.c1 AS c1
 *   FROM (SELECT array_agg(r<n + 3>.c2 ORDER BY r<n + 3>.c1) AS c1, r<n + 3>.c3 AS c2
 *         FROM (SELECT 0 AS c1, count(*) AS c2, 0 AS c3 FROM r<n> AS r<n + 5>
 *               UNION ALL SELECT 1, count(*), 0 FROM r5 AS r<n + 6> …) AS r<n + 3>(c1, c2, c3)
 *         GROUP BY r<n + 3>.c3) AS r<n + 4>(c1, c2)
 *   LIMIT 1
 *
 * its counts grouped by the constant every count row carries, one group, so no aggregate is read over no row, and the
 * group's one row returned; the groups' unnest is r4, and each body's CTE, its row and its locked groups take the next
 * three aliases, in body order. It runs after the lock, under a snapshot of its own, so it reads every row of the groups
 * any call that held them committed, and the groups no call holds now.
 */
const retireLocked = (
	b: InstallBuilder,
	unit: UnitPlan,
	params: ReadonlyArray<FunctionParam>
): PlStatement => {
	const alias = (n: number): string => `r${n}`
	const locked: Cte = {
		name: alias(1),
		columns: unit.key.map((_, at) => keyColumn(at)),
		materialized: "MATERIALIZED",
		query: operandSelect(
			core(
				unit.key.map((f, at) => targetAs(col(alias(2), f.column), keyColumn(at))),
				[
					join(
						table(unit.table.schema, unit.table.name, alias(2)),
						statedGroups(unit, params, alias(3), alias(4)),
						atGroup(b, unit, alias(2), alias(3))
					)
				],
				open(unit, alias(2))
			)
		)
	}
	const one = [targetAs(lit.int(1, types.integer), keyColumn(0))]
	const deletes = unit.bodies.map((body, at): Cte => {
		const [name, row, groups] = [alias(5 + 3 * at), alias(6 + 3 * at), alias(7 + 3 * at)]
		const removal: Delete = {
			kind: "delete",
			with: undefined,
			table: body.table,
			alias: row,
			using: [cteRefAs(locked.name, groups)],
			where: bodyAtGroup(b, body, row, groups),
			returning: one
		}
		return { name, columns: [], materialized: undefined, query: removal }
	})
	const n = 5 + 3 * deletes.length
	const [retired, header, groups, counted] = [alias(n), alias(n + 1), alias(n + 2), alias(n + 3)]
	const retirement: Update = {
		kind: "update",
		with: undefined,
		table: unit.table,
		alias: header,
		set: assignments(generations(b.model, reality)(unit.header), header, [
			{ column: unit.lifecycle.column, value: lit.bool(true) }
		]),
		from: [cteRefAs(locked.name, groups)],
		where: atGroup(b, unit, header, groups),
		returning: one
	}
	const [order, count, carried] = [keyColumn(0), keyColumn(1), keyColumn(2)]
	const counts = mapNonEmpty(
		[retired, ...deletes.map((d) => d.name)] as const,
		(cte, at): SetOperand =>
			core(
				[
					targetAs(lit.int(at, types.integer), order),
					targetAs(countStar(), count),
					targetAs(lit.int(0, types.integer), carried)
				],
				[cteRefAs(cte, alias(n + 5 + at))],
				undefined
			)
	)
	const array = alias(n + 4)
	const aggregated = grouped(
		core(
			[
				targetAs(
					{ ...call("array_agg", [col(counted, count)]), orderBy: [asc(col(counted, order))] },
					keyColumn(0)
				),
				targetAs(col(counted, carried), keyColumn(1))
			],
			[derived(operandSelect(operandUnionAll(counts)), counted, [order, count, carried], false)],
			undefined
		),
		[col(counted, carried)]
	)
	const query: Select = {
		...provedSelect(
			"oneRow",
			[targetAs(col(array, keyColumn(0)), keyColumn(0))],
			[derived(operandSelect(aggregated), array, [keyColumn(0), keyColumn(1)], false)],
			undefined
		),
		limit: lit.int(1, types.bigint)
	}
	return {
		kind: "returnQuery",
		query: {
			...query,
			with: {
				recursive: false,
				ctes: [
					locked,
					...deletes,
					{ name: retired, columns: [], materialized: undefined, query: retirement }
				]
			}
		}
	}
}

/** What a retirement returns: one array of its counts (`retireLocked`). */
const retirementCounts: SetOf = { setOf: defined(arrayOf(types.bigint), "bigint's array type") }

/** A unit function's DDL: its CREATE FUNCTION, then its REVOKE EXECUTE ... FROM PUBLIC. */
const unitFunctionDdl = (
	name: ObjectName,
	params: ReadonlyArray<FunctionParam>,
	returns: "void" | SetOf,
	body: NonEmptyReadonlyArray<PlStatement>
): readonly [PlFunction, Revoke] => {
	const fn: PlFunction = {
		kind: "createFunction",
		language: "plpgsql",
		name,
		params,
		returns,
		volatility: "VOLATILE",
		parallel: "UNSAFE",
		security: "DEFINER",
		body: { declare: [], body }
	}
	return [
		fn,
		{
			kind: "revoke",
			privileges: ["EXECUTE"],
			on: { kind: "FUNCTION", names: [functionNameOf(fn)] },
			from: [{ kind: "PUBLIC" }]
		}
	]
}

/** A unit function as a grant names it and orders after it: its object, and its name with its parameters' types. */
export interface UnitFunction {
	readonly node: Node<"structure">
	readonly name: FunctionName
}

/** Each unit's hold and retire functions, by its header relation. */
export interface UnitFunctions {
	readonly hold: UnitFunction
	readonly retire: UnitFunction
}

/**
 * Every retirable unit's two functions, each after the unit's tables, named for its header (identity.hold,
 * identity.retire), SECURITY DEFINER, so a role needs no privilege on a unit's table beyond what it holds to call one,
 * and PUBLIC holds none, revoked right after its creation as every grizzle function's is. A role whose served workload
 * holds the unit holds EXECUTE on its hold, and a role whose `retire` list names its header EXECUTE on its retirement
 * (physical/ddl/roles.ts addWorlds).
 *
 * - The hold, `<hold>(keys_1 <key 1>[], …) RETURNS void`, which a change member that touches a unit's body calls before
 *   its first statement that does, with the groups it states: it locks the open header of each, KEY SHARE, in key
 *   order, until the call's transaction ends, so no retirement of them commits while the call runs; and refuses a
 *   group whose header is absent or retired (refuseClosed). Under READ COMMITTED its refusal reads under a snapshot
 *   taken after the lock, so a group it locked is open there.
 * - The retirement, `<retire>(keys_1 <key 1>[], …) RETURNS SETOF bigint[]`, which a ChangeSet's retire member calls
 *   (write/hold/statement.ts buildUnitCall): it locks the open header of each group it is given, UPDATE, in key order,
 *   so it waits for every call that holds one and every insert whose foreign key check holds one, then, in a statement
 *   of its own, deletes every body's rows of the locked groups and sets their headers' retirement field, and returns
 *   one row, its counts: the groups it retired, then each body's rows it removed, in body order (retireLocked). A group
 *   already retired or absent is no change. No role holds UPDATE or DELETE on a unit's tables for it, so a group is
 *   retired whole and only by it, and its header is never reopened. A row outside the unit that references a row it
 *   removes, by a containment into a body, refuses it (23503 on that containment's foreign key).
 */
export const addUnitFunctions = (b: InstallBuilder): ReadonlyMap<string, UnitFunctions> => {
	const out = new Map<string, UnitFunctions>()
	for (const unit of unitPlans(b)) {
		const params = keyParams(b, unit)
		const after = [
			b.table(unit.header),
			...unit.bodies.map((body) => b.table(body.relation)),
			b.refusal
		]
		const add = (
			named: Identity<"hold" | "retire">,
			name: ObjectName,
			returns: "void" | SetOf,
			body: NonEmptyReadonlyArray<PlStatement>,
			why: string
		): UnitFunction => {
			b.name(named)
			const ddl = unitFunctionDdl(name, params, returns, body)
			const node = b.add(
				{
					kind: "unitFunction",
					ident: b.qualifiedOf("function", unit.header, named),
					ddl,
					reasons: [enforcement(why)],
					phase: "structure"
				},
				after
			)
			return { node, name: functionNameOf(ddl[0]) }
		}
		const hold = add(
			identity.hold(unit.header),
			b.names.hold(unit.header),
			"void",
			[lockOpen(b, unit, params, "KEY SHARE"), refuseClosed(b, unit, params)],
			`the open groups of ${unit.header} a call touches`
		)
		const retire = add(
			identity.retire(unit.header),
			b.names.retire(unit.header),
			retirementCounts,
			[lockOpen(b, unit, params, "UPDATE"), retireLocked(b, unit, params)],
			`the retirement of the groups of ${unit.header}`
		)
		out.set(unit.header, { hold, retire })
	}
	return out
}
