/**
 * The seal of every sealed unit (schema/api.ts sealed): every row of every member of the unit at its key k is inserted
 * by one transaction, the one that inserted the first of them at k, which founds the unit there. It holds against every
 * insert, a served program's and a role's direct SQL alike, at READ COMMITTED as at SERIALIZABLE.
 *
 * Which transaction founded k is recorded where it is founded, by its 64-bit id: each sealed unit has a founding table,
 * its key and `__founder` xid8, keyed by its key, which nothing but its members' seal guards writes or reads; and each
 * member a seal trigger, at the end of every statement that inserts into it:
 *
 *   CREATE TABLE "<schema>"."<founding of U>" ("<k1>" <base 1> NOT NULL, …, "__founder" xid8 NOT NULL,
 *     CONSTRAINT "<founding key>" PRIMARY KEY ("<k1>", …))
 *   REVOKE ALL ON TABLE "<schema>"."<founding of U>" FROM PUBLIC
 *   CREATE OR REPLACE FUNCTION "<schema>"."<seal guard of M>"() RETURNS trigger … SECURITY DEFINER AS $$
 *   BEGIN
 *     INSERT INTO "<schema>"."<founding of U>" ("<k1>", …, "__founder")
 *       SELECT DISTINCT "r1"."<m1>", …, pg_catalog.pg_current_xact_id() FROM "news" AS "r1"
 *       ON CONFLICT ("<k1>", …) DO NOTHING;
 *     IF EXISTS (SELECT FROM "news" AS "r1", "<schema>"."<founding of U>" AS "r2" WHERE "r2"."<k1>" = "r1"."<m1>"
 *         AND … AND "r2"."__founder" <> pg_catalog.pg_current_xact_id()) THEN
 *       RAISE EXCEPTION '…' USING ERRCODE = 'foreign_key_violation', CONSTRAINT = '__sealed',
 *         SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, HINT = '…';
 *     END IF;
 *     RETURN NEW;
 *   END $$
 *   CREATE TRIGGER "__sealed" AFTER INSERT ON <M> REFERENCING NEW TABLE AS "news" FOR EACH STATEMENT
 *     EXECUTE FUNCTION "<schema>"."<seal guard of M>"()
 *
 * The first statement founds each key the statement inserted at that no transaction has founded, under the inserting
 * transaction's id; the second refuses the statement where a key it inserted at is founded by another. One probe of the
 * founding key a key the statement inserted at: each statement's work is its delta's.
 *
 * Why it is exact. pg_current_xact_id() is the 64-bit id of the top-level transaction, inside a subtransaction too
 * (PostgreSQL 19, src/backend/utils/adt/xid8funcs.c pg_current_xact_id, GetTopFullTransactionId), and no two
 * transactions of a cluster ever hold one, so a founding row holds its transaction's id however deep in savepoints or
 * PL/pgSQL exception blocks it was written, and stands exactly where the row that founded it stands: a savepoint rolled
 * back takes both, and the key is founded again by the next row inserted there. A key some transaction founded is
 * founded by no other: its founding row's key refuses a second, and an insert that meets one in flight waits for its
 * transaction to end (nodeModifyTable.c's speculative insertion), then finds it committed and does nothing, or finds it
 * gone and founds the key itself. At READ COMMITTED the refusal's read is a statement of its own, whose snapshot holds
 * the founding row its insert waited for; at SERIALIZABLE a founding row committed past the transaction's snapshot
 * refuses its insert with 40001 (nodeModifyTable.c ExecCheckTIDVisible). Comparing the members' xmin instead is not
 * exact: a row inserted inside a savepoint holds the subtransaction's xid, which no SQL function relates to its
 * top-level transaction, and xmin is 32 bits, which a frozen row keeps as it was inserted (heap_getsysattr reads the
 * raw xmin), so an old row's xmin can equal a later transaction's own.
 *
 * A refusal raises 23503, the inserted row's key referencing no unit its transaction founded, under `__sealed` on the
 * member's table, which the installation maps to the unit's seal law (`sealConstraintLaws`, physical/install/plan.ts
 * constraintLaws), so a refused write names the law, and lawsOf lists it (program/laws.ts). The check is no constraint
 * PostgreSQL defers: SET CONSTRAINTS changes nothing of it, and it refuses the statement that breaks the seal.
 *
 * A migration that creates a founding table fills it from every member that may hold rows (`foundingFill`,
 * deploy/diff/diff.ts structure.foundings): each key a member holds a row at, founded by the migration's own
 * transaction, which has ended before any write reads it, so no later transaction adds a row under a unit stored before
 * its seal. Its key columns are the members' key columns' base types (ir/physical.ts lawColumnType): their values are
 * the members', which their columns' domains checked.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Identifier, RelationIdent } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import { lawColumnType } from "#compiler/ir/physical.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import type { TableConstraintLaw } from "#compiler/laws/model/model.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { revokeOf } from "#compiler/physical/ddl/deltas.ts"
import type { InstallNames } from "#compiler/physical/ddl/names.ts"
import { recordedLaw } from "#compiler/runtime/law-entry.ts"
import type { Owned, SealedUnit, UnitMember } from "#compiler/schema/own.ts"
import {
	type ColumnDef,
	type CreateTable,
	type CreateTransitionTrigger,
	type FromItem,
	type Insert,
	type ObjectName,
	type PlFunction,
	type PlStatement,
	type Revoke,
	transitionTables
} from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	call,
	col,
	distinctCore,
	eq,
	exists,
	lit,
	objectName,
	select,
	simpleSelect,
	table,
	target,
	types
} from "#compiler/sql/build.ts"
import type { RecordedLaw } from "#compiler/types/changeset/changeset.ts"

/** A sealed unit's seal law: the unit, the law's identity, and what it states, with its statement's catalog entry. */
export interface SealLaw {
	readonly unit: SealedUnit
	readonly id: Identifier<"sealLaw">
	readonly described: RecordedLaw
}

/** The seal law of every sealed unit of `owned`, by unit name. */
export const sealLaws = (owned: Owned): ReadonlyArray<SealLaw> =>
	[...owned.units.values()]
		.toSorted((a, b) => compareStrings(a.name, b.name))
		.flatMap((unit): ReadonlyArray<SealLaw> =>
			unit.sealed
				? [
						{
							unit,
							id: identifierOf(identity.sealLaw(unit.name)),
							described: recordedLaw({ kind: "sealed", unit: unit.name }, unit.entry)
						}
					]
				: []
		)

/** The constraint every seal guard's refusal reports, its member's seal trigger's name on its table. */
const sealTriggerName: Identifier<"sealTrigger"> = identifierOf(identity.sealTrigger())

/** The table identifier of the stored relation `relation` of `owned`, a unit's member. */
const memberTable = (owned: Owned, relation: string): RelationIdent => {
	const r = owned.relations[relation]
	if (r?.kind !== "relation") {
		defect(`a unit's member ${relation} is a stored relation`)
	}
	return r.ident
}

/**
 * The constraint map's entry of each sealed unit's member's seal trigger (laws/model/model.ts TableConstraintLaw): the
 * name its refusal reports on the member's table, which a write of the member raises, under the unit's seal law.
 */
export const sealConstraintLaws = (owned: Owned): ReadonlyArray<TableConstraintLaw> =>
	sealLaws(owned).flatMap((law) =>
		law.unit.members.map((m): TableConstraintLaw => ({
			kind: "constraint",
			name: sealTriggerName,
			owner: memberTable(owned, m.relation),
			laws: [{ law: law.id, described: law.described }]
		}))
	)

/** The founding table of the sealed unit `unit`, in the installation's root schema. */
export const foundingTableOf = (names: InstallNames, unit: string): ObjectName =>
	objectName(names.schema, identifierOf(identity.founding(unit)))

/** The founding table's column of each key's founding transaction. */
const founderColumn: Identifier<"founder"> = identifierOf(identity.founder())

/** The fields of `member` holding its unit's key, in the heading's order, as the checked schema types them. */
const keyFieldsOf = (
	checked: CheckedSchema,
	member: UnitMember
): NonEmptyReadonlyArray<LawField> => {
	const relation: RelationInfo = defined(
		checked.relations.get(member.relation),
		`the stored relation ${member.relation}`
	)
	return mapNonEmpty(member.fields, (name) =>
		defined(
			relation.fields.find((f) => f.name === name),
			`the field ${relation.name}.${name}`
		)
	)
}

/** The key columns of `member`, its unit's key's, in the heading's order. */
const keyColumnsOf = (checked: CheckedSchema, member: UnitMember): NonEmptyReadonlyArray<string> =>
	mapNonEmpty(keyFieldsOf(checked, member), (f) => f.column)

/** The founding table of `unit` over its first member's key columns, which every member's are by name and type. */
const foundingTable = (
	b: InstallBuilder,
	unit: SealedUnit,
	first: UnitMember,
	name: ObjectName
): CreateTable => {
	const keys = keyFieldsOf(b.checked, first)
	const columns: NonEmptyReadonlyArray<ColumnDef> = [
		...mapNonEmpty(keys, (f): ColumnDef => {
			const { type, collation } = lawColumnType(b.names, f.type)
			return { name: f.column, type, collation, generated: undefined }
		}),
		{ name: founderColumn, type: types.xid8, collation: undefined, generated: undefined }
	]
	return {
		kind: "createTable",
		table: name,
		columns,
		primaryKey: {
			kind: "primaryKey",
			name: b.name(identity.foundingKey(unit.name)),
			columns: mapNonEmpty(keys, (f) => ({ column: f.column, withoutOverlaps: false }))
		},
		secondary: []
	}
}

/** The alias of the rows a seal's statement reads, and of the founding table beside them. */
const [rows, founded] = ["r1", "r2"] as const

/** This transaction's 64-bit id, its top-level transaction's. */
const thisTransaction = call("pg_current_xact_id", [])

/**
 * The founding of each key of `from`'s rows, read under the alias `rows` by its key columns `keys`, that no transaction
 * has founded, under this transaction's id, into the founding table `into` over `foundingKeys`: a seal guard's of the
 * rows its statement inserted, and a migration's fill of the rows a member holds.
 */
const founding = (
	into: ObjectName,
	foundingKeys: NonEmptyReadonlyArray<string>,
	keys: NonEmptyReadonlyArray<string>,
	from: FromItem
): Insert => ({
	kind: "insert",
	with: undefined,
	table: into,
	alias: undefined,
	onConflict: { kind: "columns", columns: foundingKeys, action: { kind: "doNothing" } },
	returning: [],
	columns: [...foundingKeys, founderColumn],
	source: {
		kind: "query",
		query: select(
			distinctCore(
				[...mapNonEmpty(keys, (k) => target(col(rows, k))), target(thisTransaction)],
				[from],
				undefined
			)
		)
	}
})

/**
 * The fill of the founding table of `unit` from its member `member`'s table, which a migration runs as it creates the
 * founding table beside a member that may hold rows (deploy/diff/diff.ts): each key the member holds a row at, founded
 * by the migration's transaction. A fresh installation's members hold none.
 */
export const foundingFill = (
	names: InstallNames,
	checked: CheckedSchema,
	unit: SealedUnit,
	member: UnitMember
): Insert => {
	const keys = keyColumnsOf(checked, member)
	const memberName = names.relation(member.relation)
	return founding(
		foundingTableOf(names, unit.name),
		keys,
		keys,
		table(memberName.schema, memberName.name, rows)
	)
}

/**
 * The seal guard's body over a member of `unit` whose key columns are `keys` (see the header), the founding table
 * `into` keyed by `foundingKeys`.
 */
const guardBody = (
	unit: SealedUnit,
	into: ObjectName,
	foundingKeys: NonEmptyReadonlyArray<string>,
	keys: NonEmptyReadonlyArray<string>
): NonEmptyReadonlyArray<PlStatement> => {
	const inserted: FromItem = { kind: "transition", table: transitionTables.news, alias: rows }
	/** A key the statement inserted at whose founding row holds another transaction as its founder. */
	const foreign = exists(
		simpleSelect(
			[],
			[inserted, table(into.schema, into.name, founded)],
			and([
				...mapNonEmpty(foundingKeys, (k, i) =>
					eq(
						col(founded, k),
						col(rows, defined(keys[i], "a member's key column at each of its unit's"))
					)
				),
				binary("<>", col(founded, founderColumn), thisTransaction)
			])
		)
	)
	return [
		{ kind: "modify", statement: founding(into, foundingKeys, keys, inserted) },
		{
			kind: "if",
			branches: [
				{
					condition: foreign,
					body: [
						{
							kind: "raise",
							message: `a row of sealed unit ${unit.name} is inserted at a key another transaction founded`,
							using: [
								{ option: "ERRCODE", value: lit.text("foreign_key_violation", types.text) },
								{ option: "CONSTRAINT", value: lit.text(sealTriggerName, types.text) },
								{ option: "SCHEMA", value: { kind: "plSpecial", name: "TG_TABLE_SCHEMA" } },
								{ option: "TABLE", value: { kind: "plSpecial", name: "TG_TABLE_NAME" } },
								{
									option: "HINT",
									value: lit.text(
										`insert every row of unit ${unit.name} at a key in the transaction that inserts the first of them`,
										types.text
									)
								}
							]
						}
					]
				}
			],
			else: []
		},
		{ kind: "return", value: { kind: "plSpecial", name: "NEW" } }
	]
}

/** A trigger function of `body`, SECURITY DEFINER, so its caller holds no privilege on the founding table. */
const triggerFunction = (
	name: ObjectName,
	body: NonEmptyReadonlyArray<PlStatement>
): readonly [PlFunction, Revoke] => [
	{
		kind: "createFunction",
		language: "plpgsql",
		name,
		params: [],
		returns: "trigger",
		volatility: "VOLATILE",
		parallel: "UNSAFE",
		security: "DEFINER",
		body: { declare: [], body }
	},
	revokeOf(name, [])
]

/**
 * Each sealed unit's founding table, in Structure after its members' tables, and, in Validate as a rule's captures are,
 * each member's seal guard and seal trigger (see the header), each object under the unit's seal law. A sealed unit no
 * relation sits under has nothing to seal.
 */
export const addSeals = (b: InstallBuilder): void => {
	const laws = sealLaws(b.owned)
	if (laws.length === 0) {
		return
	}
	b.name(identity.founder())
	b.name(identity.sealTrigger())
	for (const law of laws) {
		const unit = law.unit
		const [first] = unit.members
		if (first === undefined) {
			continue
		}
		const reasons: ReadonlyArray<PhysicalReason> = [{ kind: "law", law: law.id }]
		const foundingNamed = identity.founding(unit.name)
		b.name(foundingNamed)
		const into = foundingTableOf(b.names, unit.name)
		const created = foundingTable(b, unit, first, into)
		const foundingNode = b.add(
			{
				kind: "founding",
				ident: b.qualified("table", foundingNamed),
				ddl: [
					created,
					{
						kind: "revoke",
						privileges: ["ALL"],
						on: { kind: "TABLE", names: [into] },
						from: [{ kind: "PUBLIC" }]
					}
				],
				reasons,
				phase: "structure"
			},
			unit.members.map((m) => b.table(m.relation))
		)
		const foundingKeys = mapNonEmpty(created.primaryKey.columns, (c) => c.column)
		for (const member of unit.members) {
			const memberNode = b.table(member.relation)
			const guardNamed = identity.sealGuard(unit.name, member.relation)
			const guard = objectName(b.schema, b.name(guardNamed))
			const guardNode = b.add(
				{
					kind: "lawFunction",
					ident: b.qualified("function", guardNamed),
					ddl: triggerFunction(
						guard,
						guardBody(unit, into, foundingKeys, keyColumnsOf(b.checked, member))
					),
					reasons,
					phase: "validate"
				},
				[foundingNode, memberNode]
			)
			const sealing: CreateTransitionTrigger = {
				kind: "createTransitionTrigger",
				name: sealTriggerName,
				table: b.names.relation(member.relation),
				event: "insert",
				function: guard
			}
			b.add(
				{
					kind: "lawTrigger",
					ident: {
						kind: "trigger",
						schema: b.names.levelOf(member.relation),
						relation: b.names.relationNamed(member.relation),
						name: identity.sealTrigger()
					},
					ddl: [sealing],
					reasons,
					phase: "validate"
				},
				[guardNode, memberNode]
			)
		}
	}
}
