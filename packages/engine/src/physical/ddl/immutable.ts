import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import type {
	CreateUpdateGuardTrigger,
	DropTrigger,
	EmittedText,
	Expr,
	ObjectName,
	PlFunction,
	Revoke,
	SqlStatement
} from "#compiler/sql/ast.ts"
import { call, calledAlone, lit, objectName, types } from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"

/** The name of every immutable relation's table's guard trigger. */
export const immutableTriggerName: string = identifierOf(identity.immutableTrigger())

/**
 * The bracket of a migration's data steps on guarded tables, the one spelling of it: each guard of `guards`, its
 * table's trigger as the installation the migration follows created it, dropped, `DROP TRIGGER <guard> ON <t>`, before
 * the steps, and created again as it stood after them, in their one transaction, so no committed state, nor any other
 * transaction, sees a table without its guard, and a step that fails rolls the dropping back with it. Only where the
 * guards come from differs: a draft's, from the previous installation's manifest (deploy/diff/diff.ts unguard), and a
 * custom migration's, from the catalog where its file runs (dataStepBracket).
 *
 * Dropped, never disabled: PostgreSQL counts a disabled trigger among a table's BEFORE ROW UPDATE triggers (trigger.c
 * SetTriggerFlags reads no tgenabled), and an UPDATE of a table that holds one computes every stored generated column of
 * every row it writes, whatever it assigns (nodeModifyTable.c ExecInitGenerated, so the anchor a backfill assigns,
 * sql/generation.ts, saves nothing), and copies the table's key columns' bitmap into its query's memory once a row
 * (trigger.c ExecBRUpdateTriggers, execMain.c ExecUpdateLockMode), so a backfill's UPDATE holds memory that grows with
 * its rows (test/pg/migrate/generated-fill-memory). Measured on 19.0, an UPDATE of a table of 49 stored generated
 * columns at 1,000, 2,000, 4,000 and 8,000 rows: ExecutorState 262144, 262144, 262144 and 524288 bytes with a BEFORE ROW
 * UPDATE trigger enabled or disabled, 131072 at every size with none.
 *
 * DROP TRIGGER takes ACCESS EXCLUSIVE on its table, where ALTER TABLE ... DISABLE TRIGGER took SHARE ROW EXCLUSIVE, so a
 * migration with data steps holds every guarded table locked against reads too until it commits. A served Db is fenced
 * from the installation while a migration runs (its prologue's snapshot guard), so only a direct SQL reader waits, for
 * the migration's one transaction.
 */
export const guardBracket = (
	guards: ReadonlyArray<CreateUpdateGuardTrigger>
): {
	readonly drop: ReadonlyArray<DropTrigger>
	readonly create: ReadonlyArray<CreateUpdateGuardTrigger>
} => ({
	drop: guards.map((g) => ({ kind: "dropTrigger", name: g.name, table: g.table, ifExists: false })),
	create: guards
})

/** A guard the catalog holds where a custom migration's file runs: its table and its trigger's function. */
export interface InstalledGuard {
	readonly table: ObjectName
	readonly function: ObjectName
}

/**
 * A custom migration's data step's bracket as the runner sends it (adapter/migrate/apply.ts), over what the catalog
 * holds where the step runs: `before` its statements, the call of each judged table's stand-up `standUps` names
 * (physical/ddl/rules.ts addStandUps), so a statement that writes a table the rule judge holds finds the session's
 * tables standing and is judged at its COMMIT, then each guard dropped (guardBracket); `after` them, each guard created
 * again over the function its trigger calls.
 */
export const dataStepBracket = (
	guards: ReadonlyArray<InstalledGuard>,
	standUps: ReadonlyArray<ObjectName>
): {
	readonly before: ReadonlyArray<EmittedText>
	readonly after: ReadonlyArray<EmittedText>
} => {
	const { drop, create } = guardBracket(
		guards.map((g): CreateUpdateGuardTrigger => ({
			kind: "createUpdateGuardTrigger",
			name: immutableTriggerName,
			table: g.table,
			function: g.function
		}))
	)
	const texts = (statements: ReadonlyArray<SqlStatement>): ReadonlyArray<EmittedText> =>
		statements.map((statement) => emitText(statement, emptyNameMap).text)
	return { before: [...standUpCalls(standUps), ...texts(drop)], after: texts(create) }
}

/**
 * The call of each stand-up of `standUps`, a statement of its own (sql/build.ts calledAlone): what a custom migration's
 * data step runs before its statements, inside its bracket (`dataStepBracket`) or, for a file that runs outside a
 * transaction, alone before them, each committing its session's tables for every statement after.
 */
export const standUpCalls = (standUps: ReadonlyArray<ObjectName>): ReadonlyArray<EmittedText> =>
	standUps.map((standUp) => emitText(calledAlone(standUp), emptyNameMap).text)

/** The fields of `relation` its guard holds fixed: every field its rows never change in place, but a generated one. */
const fixedFields = (relation: RelationInfo): ReadonlyArray<string> =>
	relation.fields.flatMap((f) =>
		f.writing.kind === "generated" || relation.inPlace.includes(f.name) ? [] : [f.column]
	)

/** `ROW(<record>."c1", …)` over `columns`. */
const rowOf = (
	record: "OLD" | "NEW",
	columns: readonly [string, ...ReadonlyArray<string>]
): Expr => ({
	kind: "row",
	items: mapNonEmpty(columns, (c) => ({
		kind: "field",
		record: { kind: "plSpecial", name: record },
		field: c
	}))
})

/**
 * The immutability guard of every immutable relation's table: facts are inserted and deleted, never changed in place
 * (schema/api.ts mutable), and the guard holds it against every UPDATE, whoever runs it.
 *
 * No role holds UPDATE on an immutable relation (physical/ddl/roles.ts addWorlds), so a role's UPDATE is refused by
 * privilege, 42501. The table's owner, the migration identity, holds every privilege on it, and a direct writer that
 * runs as the owner, or a foreign key's ON UPDATE CASCADE, which PostgreSQL runs as the referencing table's owner, is
 * refused by no privilege. The guard refuses them too: one function per immutable relation,
 *
 *   CREATE OR REPLACE FUNCTION <schema>.<guard of R>() RETURNS trigger ... SECURITY DEFINER AS $$
 *   BEGIN
 *     IF pg_catalog.record_image_ne(ROW(OLD."f1", …), ROW(NEW."f1", …)) THEN
 *       RAISE EXCEPTION 'an UPDATE of an immutable relation changes its row'
 *         USING ERRCODE = 'insufficient_privilege', SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME,
 *         HINT = 'declare mutable(R) among the schema''s rules, or delete the row and insert it again';
 *     END IF;
 *     RETURN NEW;
 *   END $$;
 *
 * over its fixed fields, every field but those its rows change in place (ir/law.ts RelationInfo `inPlace`: an
 * accumulated copy an owner axis carries from a mutable owner, and a generated field over one) and its
 * generated fields, which PostgreSQL computes from the row's other fields; and the table's trigger, `BEFORE UPDATE ...
 * FOR EACH ROW` (sql/ast.ts CreateUpdateGuardTrigger), so an UPDATE that would change a fixed field of a row is refused
 * before it writes one, with the error a role's UPDATE meets (core/sqlstate.ts insufficientPrivilege), and every other
 * UPDATE, an owner axis's cascade of its count and copies, and a statement that changes no fixed field,
 * runs as before. A unit-local rule's judge reads its relations under this premise (analysis/theory/unit.ts wholeRule):
 * it takes a unit from the rows a transaction gave a relation where it lost one there, and an UPDATE of a fixed field
 * gives one and loses none.
 *
 * The comparison is the binary one, `*<>`'s, which the backfill decides a row's change by too
 * (deploy/diff/backfill.ts staged): it reads each value by its bytes, so it is defined over every type a field holds,
 * one with no equality operator among them.
 *
 * The function names the fields by name, never by number, so no catalog dependency ties it to a column: a migration
 * converts, renames and drops the table's columns under it, and replaces its body, in Validate, as it does a law
 * function's (deploy/diff/diff.ts); Structure's data steps on a table it guards run with its trigger dropped, created
 * again in the same transaction (guardBracket, diff.ts unguard), so a migration writes the rows its fields' changes call
 * for and no committed state holds a table without its guard.
 *
 * Each guard is created in Validate after its table, as a rule's capture is; a mutable relation, whose puts update it in
 * place, takes none.
 */
export const addImmutableGuards = (b: InstallBuilder): void => {
	b.name(identity.immutableTrigger())
	for (const relation of b.checked.relations.values()) {
		const fixed = fixedFields(relation)
		if (relation.mutable || !isNonEmpty(fixed)) {
			continue
		}
		const named = identity.immutableGuard(relation.name)
		const fn = objectName(b.schema, b.name(named))
		const ddl: readonly [PlFunction, Revoke] = [
			{
				kind: "createFunction",
				language: "plpgsql",
				name: fn,
				params: [],
				returns: "trigger",
				volatility: "VOLATILE",
				parallel: "UNSAFE",
				security: "DEFINER",
				body: {
					declare: [],
					body: [
						{
							kind: "if",
							branches: [
								{
									condition: call("record_image_ne", [rowOf("OLD", fixed), rowOf("NEW", fixed)]),
									body: [
										{
											kind: "raise",
											message: "an UPDATE of an immutable relation changes its row",
											using: [
												{
													option: "ERRCODE",
													value: lit.text("insufficient_privilege", types.text)
												},
												{ option: "SCHEMA", value: { kind: "plSpecial", name: "TG_TABLE_SCHEMA" } },
												{ option: "TABLE", value: { kind: "plSpecial", name: "TG_TABLE_NAME" } },
												{
													option: "HINT",
													value: lit.text(
														`declare mutable(${relation.name}) among the schema's rules, or delete the row and insert it again`,
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
			},
			{
				kind: "revoke",
				privileges: ["EXECUTE"],
				on: { kind: "FUNCTION", names: [{ ...fn, args: [] }] },
				from: [{ kind: "PUBLIC" }]
			}
		]
		const reasons = [enforcement(`the immutability of relation ${relation.name}`)]
		const table = b.table(relation.name)
		const fnNode = b.add(
			{
				kind: "immutableGuard",
				ident: b.qualified("function", named),
				ddl,
				reasons,
				phase: "validate"
			},
			[table]
		)
		const trigger: CreateUpdateGuardTrigger = {
			kind: "createUpdateGuardTrigger",
			name: immutableTriggerName,
			table: b.names.relation(relation.name),
			function: fn
		}
		b.add(
			{
				kind: "immutableTrigger",
				ident: {
					kind: "trigger",
					schema: b.names.levelOf(relation.name),
					relation: b.names.relationNamed(relation.name),
					name: identity.immutableTrigger()
				},
				ddl: [trigger],
				reasons,
				phase: "validate"
			},
			[fnNode, table]
		)
	}
}
