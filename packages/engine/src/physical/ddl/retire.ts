import type { LawId } from "#compiler/core/ids.ts"
import { type Identity, identity } from "#compiler/core/identity.ts"
import { defect } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { rowEq } from "#compiler/ir/compare.ts"
import type { TermDesc } from "#compiler/ir/desc.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { columnType } from "#compiler/physical/ddl/names.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import type { OwnedStatement } from "#compiler/schema/own.ts"
import type {
	Cte,
	Delete,
	Expr,
	FromItem,
	FromSource,
	FunctionParam,
	ObjectName,
	PerformQuery,
	PlFunction,
	PlStatement,
	Revoke,
	Update
} from "#compiler/sql/ast.ts"
import {
	and,
	arrayOf,
	asc,
	call,
	col,
	core,
	cteRefAs,
	derived,
	distinctCore,
	functionNameOf,
	join,
	lit,
	not,
	notExists,
	operandSelect,
	param,
	qualifiedCall,
	select,
	table,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
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
 * The law of `body`'s fence: the foreign key the law model installs for the containment of its group in the header's
 * open groups, the one from `body` into `header` that references the retirement field.
 */
const fenceLaw = (b: InstallBuilder, body: string, header: string, lifecycle: LawField): LawId => {
	for (const { object } of b.natives) {
		if (
			object.kind === "ForeignKey" &&
			object.relation.name === body &&
			object.target.name === header &&
			object.targetColumns.some((c) => c.kind === "field" && c.field.name === lifecycle.name)
		) {
			return object.lawIds[0]
		}
	}
	throw defect(`the law model installs the fence of ${body} into the open groups of ${header}`)
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
				fence: { law: fenceLaw(b, first.relation, s.header.relation, lifecycle), body: first }
			}
		]
	})

/** The column every one of a unit's group keys travels as: `c<n>`, by the key field's position. */
const keyColumn = (at: number): string => `c${at + 1}`

/** One function parameter per key field, the array of that field's values, in key order: `$1` the first. */
const keyParams = (b: InstallBuilder, unit: UnitPlan): ReadonlyArray<FunctionParam> =>
	unit.key.map((field, at) => {
		const array = arrayOf(columnType(b.names, field.type).type)
		if (array === undefined) {
			throw defect(`a retirable key field ${unit.header}.${field.name} of a type with an array`)
		}
		return { name: `keys_${at + 1}`, type: array }
	})

/**
 * The distinct groups a call states, `(SELECT DISTINCT u.c1, … FROM unnest($1, …) AS u(c1, …)) AS <alias>(c1, …)`:
 * the function's key arrays read in lockstep, each group once.
 */
const statedGroups = (
	unit: UnitPlan,
	params: ReadonlyArray<FunctionParam>,
	alias: string
): FromSource => {
	const columns = unit.key.map((_, at) => keyColumn(at))
	const unnest: FromItem = {
		kind: "function",
		call: call(
			"unnest",
			params.map((p, at) => param(at + 1, p.type))
		),
		alias: "u",
		columns,
		lateral: false
	}
	const [first, ...rest] = columns.map((c) => targetAs(col("u", c), c))
	if (first === undefined) {
		throw defect(`a retirable header ${unit.header} keyed by one field at least`)
	}
	return derived(
		select(distinctCore([first, ...rest], [unnest], undefined)),
		alias,
		columns,
		false
	)
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
 * `PERFORM 1 FROM <header> AS h JOIN <groups> AS g ON <h at g> WHERE NOT h.<retired> ORDER BY h.<key> FOR <strength>
 * OF h`.
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
					table(unit.table.schema, unit.table.name, "h"),
					statedGroups(unit, params, "g"),
					atGroup(b, unit, "h", "g")
				)
			],
			open(unit, "h")
		),
		orderBy: unit.key.map((f) => asc(col("h", f.column))),
		limit: undefined,
		offset: undefined
	}
	return { kind: "lockRows", query, strength, of: "h" }
}

/**
 * The hold's refusal of a group the call states that is not open, its header absent or retired: the first in key
 * order, refused on the fence of the unit's first body at that group, the law every body's write into it would break,
 * `k["<body>",["<group field>",…],["<value>",…]]`, the refused group's values at the body's group fields.
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
		key: body.group.map((f, at) => ({ field: f.name, expr: col("g", keyColumn(at)), type: f.type }))
	})
	const openAt = operandSelect(
		core(
			[target(lit.int(1, types.integer))],
			[table(unit.table.schema, unit.table.name, "h")],
			and([atGroup(b, unit, "h", "g"), open(unit, "h")])
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
				[statedGroups(unit, params, "g")],
				notExists(openAt)
			),
			orderBy: unit.key.map((_, at) => asc(col("g", keyColumn(at)))),
			limit: lit.int(1, types.bigint),
			offset: undefined
		}
	}
}

/**
 * The retirement of the groups the locked headers head, one statement: every body's rows in them deleted, then each
 * header's retirement field set, so the fence's NO ACTION check, at the statement's end, finds no row of the group:
 *
 *   WITH "r"(c1, …) AS (SELECT h.<key> FROM <header> AS h JOIN <groups> AS g ON <h at g> WHERE NOT h.<retired>),
 *        "d1" AS (DELETE FROM <body 1> AS b USING "r" AS r WHERE <b at r>), …
 *   UPDATE <header> AS h SET <retired> = true FROM "r" AS r WHERE <h at r>
 *
 * It runs after the lock, under a snapshot of its own, so it reads every row of the groups any call that held them
 * committed, and the groups no call holds now.
 */
const retireLocked = (
	b: InstallBuilder,
	unit: UnitPlan,
	params: ReadonlyArray<FunctionParam>
): PlStatement => {
	const locked: Cte = {
		name: "r",
		columns: unit.key.map((_, at) => keyColumn(at)),
		materialized: "MATERIALIZED",
		query: operandSelect(
			core(
				unit.key.map((f, at) => targetAs(col("h", f.column), keyColumn(at))),
				[
					join(
						table(unit.table.schema, unit.table.name, "h"),
						statedGroups(unit, params, "g"),
						atGroup(b, unit, "h", "g")
					)
				],
				open(unit, "h")
			)
		)
	}
	const deletes = unit.bodies.map((body, at): Cte => {
		const removal: Delete = {
			kind: "delete",
			with: undefined,
			table: body.table,
			alias: "b",
			using: [cteRefAs("r", "r")],
			where: bodyAtGroup(b, body, "b", "r"),
			returning: []
		}
		return { name: `d${at + 1}`, columns: [], materialized: undefined, query: removal }
	})
	const statement: Update = {
		kind: "update",
		with: { recursive: false, ctes: [locked, ...deletes] },
		table: unit.table,
		alias: "h",
		set: [{ column: unit.lifecycle.column, value: lit.bool(true) }],
		from: [cteRefAs("r", "r")],
		where: atGroup(b, unit, "h", "r"),
		returning: []
	}
	return { kind: "modify", statement }
}

/** A unit function's DDL: its CREATE FUNCTION, then its REVOKE EXECUTE ... FROM PUBLIC. */
const unitFunctionDdl = (
	name: ObjectName,
	params: ReadonlyArray<FunctionParam>,
	body: NonEmptyReadonlyArray<PlStatement>
): readonly [PlFunction, Revoke] => {
	const fn: PlFunction = {
		kind: "createFunction",
		language: "plpgsql",
		name,
		params,
		returns: "void",
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

/** Each unit's hold and retire functions, by its header relation. */
export interface UnitFunctions {
	readonly hold: Node<"structure">
	readonly retire: Node<"structure">
}

/**
 * Every retirable unit's two functions, each after the unit's tables, named for its header (identity.hold,
 * identity.retire), SECURITY DEFINER, so a role needs no privilege on a unit's table beyond what it holds to call one,
 * and PUBLIC holds none, revoked right after its creation as every grizzle function's is.
 *
 * - The hold, `<hold>(keys_1 <key 1>[], …) RETURNS void`, which a change member that touches a unit's body calls before
 *   its first statement that does, with the groups it states: it locks the open header of each, KEY SHARE, in key
 *   order, until the call's transaction ends, so no retirement of them commits while the call runs; and refuses a
 *   group whose header is absent or retired (refuseClosed). Under READ COMMITTED its refusal reads under a snapshot
 *   taken after the lock, so a group it locked is open there.
 * - The retirement, `<retire>(keys_1 <key 1>[], …) RETURNS void`: it locks the open header of each group it is given,
 *   UPDATE, in key order, so it waits for every call that holds one and every insert whose foreign key check holds
 *   one, then, in a statement of its own, deletes every body's rows of the locked groups and sets their headers'
 *   retirement field (retireLocked). A group already retired or absent is no change. No role holds UPDATE or DELETE on
 *   a unit's tables for it, so a group is retired whole and only by it, and its header is never reopened.
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
			body: NonEmptyReadonlyArray<PlStatement>,
			why: string
		): Node<"structure"> => {
			b.name(named)
			return b.add(
				{
					kind: "unitFunction",
					ident: b.qualifiedOf("function", unit.header, named),
					ddl: unitFunctionDdl(name, params, body),
					reasons: [enforcement(why)],
					phase: "structure"
				},
				after
			)
		}
		const hold = add(
			identity.hold(unit.header),
			b.names.hold(unit.header),
			[lockOpen(b, unit, params, "KEY SHARE"), refuseClosed(b, unit, params)],
			`the open groups of ${unit.header} a call touches`
		)
		const retire = add(
			identity.retire(unit.header),
			b.names.retire(unit.header),
			[lockOpen(b, unit, params, "UPDATE"), retireLocked(b, unit, params)],
			`the retirement of the groups of ${unit.header}`
		)
		out.set(unit.header, { hold, retire })
	}
	return out
}
