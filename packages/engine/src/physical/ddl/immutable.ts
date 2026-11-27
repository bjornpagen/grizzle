import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { type Identity, identifierOf, identity } from "#compiler/core/identity.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import type {
	CreateImmutableGuardTrigger,
	EmittedText,
	Expr,
	GuardBracket,
	GuardFiring,
	GuardScope,
	ObjectName,
	PlFunction,
	PlStatement,
	Revoke
} from "#compiler/sql/ast.ts"
import { call, calledAlone, eq, lit, objectName, types } from "#compiler/sql/build.ts"
import { costChosen, emitText } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"

/** What a closed relation's guards fire on, one trigger each (sql/ast.ts CreateImmutableGuardTrigger). */
const guardFirings = ["rows", "truncate"] as const satisfies NonEmptyReadonlyArray<GuardFiring>

/** The identity of every guarded table's guard trigger firing on `on`, the one name of its kind every such table's takes. */
const guardIdentity = (
	on: GuardFiring
): Identity<"immutableTrigger" | "immutableTruncateTrigger"> =>
	on === "rows" ? identity.immutableTrigger() : identity.immutableTruncateTrigger()

/** The name of a guard trigger by what it fires on (guardIdentity). */
const guardTriggerName = (on: GuardFiring): string => identifierOf(guardIdentity(on))

/** The name of every immutable relation's table's guard trigger of its rows. */
export const immutableTriggerName: string = guardTriggerName("rows")

/** The name of every immutable relation's table's guard trigger of a TRUNCATE. */
export const immutableTruncateTriggerName: string = guardTriggerName("truncate")

/**
 * The bracket that lifts the closed relations' guards in `scope` around an action in its one transaction, the one
 * removal path of a closed relation's rows: `unguard` before the action, which finds every guard trigger in scope by
 * the closed rule's own names, records it in the transaction and drops it, and `reguard` after it, which creates each
 * again as the closed rule created it (sql/ast.ts GuardBracket, sql/catalog.ts guardBracketBlock), so no committed
 * state, nor any other transaction, sees a table without its guard, and an action that fails rolls the dropping back
 * with it. It is SQL over the catalog alone, its scope the tables or schemas it names: a draft's data steps bracket the
 * tables the previous installation guards that the target keeps (deploy/diff/diff.ts unguard), a custom migration's
 * the installation's schemas (dataStepBracket), and a test's reset of a closed relation the tables it empties.
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
 * bracket holds every guarded table of its scope locked against reads too until its transaction commits. A served Db
 * is fenced from the installation while a migration runs (its prologue's snapshot guard), so only a direct SQL reader
 * waits, for the migration's one transaction.
 */
export const guardBracket = (
	scope: GuardScope
): { readonly unguard: GuardBracket; readonly reguard: GuardBracket } => {
	const guards = mapNonEmpty(guardFirings, (on) => ({ name: guardTriggerName(on), on }))
	return {
		unguard: { kind: "guardBracket", side: "unguard", scope, guards },
		reguard: { kind: "guardBracket", side: "reguard", scope, guards }
	}
}

/** The bracket of `scope` (guardBracket) as the texts a session sends: `before` the action, `after` it. */
export const guardBracketTexts = (
	scope: GuardScope
): { readonly before: EmittedText; readonly after: EmittedText } => {
	const { unguard, reguard } = guardBracket(scope)
	return {
		before: emitText(unguard, emptyNameMap, costChosen).text,
		after: emitText(reguard, emptyNameMap, costChosen).text
	}
}

/**
 * A custom migration's data step's bracket as the runner sends it (adapter/migrate/apply.ts), over the installation's
 * schemas `schemas`: `before` its statements, the call of each judged table's stand-up `standUps` names
 * (physical/ddl/rules.ts addStandUps), so a statement that writes a table the rule judge holds finds the session's
 * tables standing and is judged at its COMMIT, then every guard of the schemas lifted (guardBracket); `after` them, the
 * re-check of each level `rechecks` names (physical/ddl/recheck.ts), each after SET CONSTRAINTS ALL IMMEDIATE, so the
 * judge keeps every stored table the step's writes reach before the re-check reads them and a rule the step breaks is
 * refused in the step's own transaction, naming its law; then each guard created again. No schema, before the
 * installation's first migration, holds no guard to lift, and an installation with no rule or stored relation over a
 * closed relation no re-check.
 */
export const dataStepBracket = (
	schemas: ReadonlyArray<string>,
	standUps: ReadonlyArray<ObjectName>,
	rechecks: ReadonlyArray<ObjectName>
): {
	readonly before: ReadonlyArray<EmittedText>
	readonly after: ReadonlyArray<EmittedText>
} => {
	const lifted = isNonEmpty(schemas) ? [guardBracketTexts({ kind: "schemas", schemas })] : []
	return {
		before: [...standUpCalls(standUps), ...lifted.map((b) => b.before)],
		after: [
			...(isNonEmpty(rechecks)
				? [
						emitText({ kind: "setConstraintsImmediate" }, emptyNameMap, costChosen).text,
						...rechecks.map(
							(recheck) => emitText(calledAlone(recheck), emptyNameMap, costChosen).text
						)
					]
				: []),
			...lifted.map((b) => b.after)
		]
	}
}

/**
 * The call of each stand-up of `standUps`, a statement of its own (sql/build.ts calledAlone): what a custom migration's
 * data step runs before its statements, inside its bracket (`dataStepBracket`) or, for a file that runs outside a
 * transaction, alone before them, each committing its session's tables for every statement after.
 */
export const standUpCalls = (standUps: ReadonlyArray<ObjectName>): ReadonlyArray<EmittedText> =>
	standUps.map((standUp) => emitText(calledAlone(standUp), emptyNameMap, costChosen).text)

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
 * The immutability guard of every immutable relation's table, a closed relation's: its facts are inserted, never changed
 * in place or deleted (schema/api.ts mutable), and the guard holds it against every UPDATE and every DELETE, whoever
 * runs it.
 *
 * No role holds UPDATE or DELETE on an immutable relation (physical/ddl/roles.ts addWorlds), so a role's write is refused
 * by privilege, 42501. The table's owner, the migration identity, holds every privilege on it, and a direct writer that
 * runs as the owner, or a foreign key's ON UPDATE CASCADE, which PostgreSQL runs as the referencing table's owner, is
 * refused by no privilege. The guard refuses them too: one function per immutable relation,
 *
 *   CREATE OR REPLACE FUNCTION <schema>.<guard of R>() RETURNS trigger ... SECURITY DEFINER AS $$
 *   BEGIN
 *     IF TG_OP = 'DELETE' THEN
 *       RAISE EXCEPTION 'a DELETE of an immutable relation removes its row'
 *         USING ERRCODE = 'insufficient_privilege', SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME,
 *         HINT = 'declare mutable(R) among the schema''s rules: a closed relation''s facts are never removed';
 *     END IF;
 *     IF pg_catalog.record_image_ne(ROW(OLD."f1", …), ROW(NEW."f1", …)) THEN
 *       RAISE EXCEPTION 'an UPDATE of an immutable relation changes its row'
 *         USING ERRCODE = 'insufficient_privilege', SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME,
 *         HINT = 'declare mutable(R) among the schema''s rules, or insert a fact that supersedes it';
 *     END IF;
 *     RETURN NEW;
 *   END $$;
 *
 * the UPDATE's test over its fixed fields, every field but those its rows change in place (ir/law.ts RelationInfo
 * `inPlace`: an accumulated copy an owner axis carries from a mutable owner, and a generated field over one) and its
 * generated fields, which PostgreSQL computes from the row's other fields, and none where it has no fixed field; and the
 * table's trigger, `BEFORE UPDATE OR DELETE ... FOR EACH ROW` (sql/ast.ts CreateImmutableGuardTrigger), so a DELETE of
 * a row, and an UPDATE that would change a fixed field of one, is refused before it writes anything, with the error a
 * role's write meets (core/sqlstate.ts insufficientPrivilege), and every other UPDATE, an owner axis's cascade of its
 * count and copies, and a statement that changes no fixed field, runs as before. So a closed relation loses no row but by
 * a migration's data step, which runs with the guard dropped and is judged at its COMMIT (guardBracket): a unit-local
 * rule's judge and a stored relation's upkeep read its relations under this premise (analysis/theory/unit.ts wholeRule,
 * analysis/theory/upkeep.ts): an UPDATE of a fixed field gives a row and loses none, and no served write, nor any
 * other writer of its rows, loses one. So a row a served write adds to it is a row of a new key, and a probe whose
 * occurrence of it a sibling pins at a key reads none of it (analysis/theory/query.ts Cover `fresh`), and no judge or
 * upkeep reads the rows a write removes of it.
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
 * place and whose deletes remove its rows, takes none.
 */
export const addImmutableGuards = (b: InstallBuilder): void => {
	for (const on of guardFirings) {
		b.name(guardIdentity(on))
	}
	for (const relation of b.checked.relations.values()) {
		if (relation.mutable) {
			continue
		}
		const fixed = fixedFields(relation)
		/** The refusal of a write of the table, its message `message` and its hint `hint`. */
		const refusal = (message: string, hint: string): PlStatement => ({
			kind: "raise",
			message,
			using: [
				{ option: "ERRCODE", value: lit.text("insufficient_privilege", types.text) },
				{ option: "SCHEMA", value: { kind: "plSpecial", name: "TG_TABLE_SCHEMA" } },
				{ option: "TABLE", value: { kind: "plSpecial", name: "TG_TABLE_NAME" } },
				{ option: "HINT", value: lit.text(hint, types.text) }
			]
		})
		const named = identity.immutableGuard(relation.name)
		const fn = objectName(b.schema, b.name(named))
		const ddl: readonly [PlFunction, Revoke] = [
			{
				kind: "createFunction",
				advice: noAdvice,
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
									condition: eq(
										{ kind: "plSpecial", name: "TG_OP" },
										lit.text("TRUNCATE", types.text)
									),
									body: [
										refusal(
											"a TRUNCATE of an immutable relation removes its rows",
											`declare mutable(${relation.name}) among the schema's rules: a closed relation's facts are never removed`
										)
									]
								},
								{
									condition: eq(
										{ kind: "plSpecial", name: "TG_OP" },
										lit.text("DELETE", types.text)
									),
									body: [
										refusal(
											"a DELETE of an immutable relation removes its row",
											`declare mutable(${relation.name}) among the schema's rules: a closed relation's facts are never removed`
										)
									]
								}
							],
							else: []
						},
						...(isNonEmpty(fixed)
							? [
									{
										kind: "if",
										branches: [
											{
												condition: call("record_image_ne", [
													rowOf("OLD", fixed),
													rowOf("NEW", fixed)
												]),
												body: [
													refusal(
														"an UPDATE of an immutable relation changes its row",
														`declare mutable(${relation.name}) among the schema's rules, or insert a fact that supersedes it`
													)
												]
											}
										],
										else: []
									} as const satisfies PlStatement
								]
							: []),
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
		for (const on of guardFirings) {
			const trigger: CreateImmutableGuardTrigger = {
				kind: "createImmutableGuardTrigger",
				name: guardTriggerName(on),
				table: b.names.relation(relation.name),
				function: fn,
				on
			}
			b.add(
				{
					kind: "immutableTrigger",
					ident: {
						kind: "trigger",
						schema: b.names.levelOf(relation.name),
						relation: b.names.relationNamed(relation.name),
						name: guardIdentity(on)
					},
					ddl: [trigger],
					reasons,
					phase: "validate"
				},
				[fnNode, table]
			)
		}
	}
}
