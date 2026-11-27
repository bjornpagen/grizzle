/**
 * The guard of every clock (ir/instant.ts Clock): every row a writer adds to a clock's relation, or moves within it,
 * holds its transaction's stamp of the clock at its scope's key, whoever writes it, a served Db, a role's direct SQL, a
 * migration's data step and the owner alike, so a scope's instants are commit-ordered across its clocks for every writer
 * (ir/instant.ts scopeOrder), and a prover that reads that order holds for every row it reads.
 *
 * A transaction's stamp at a key is the head row its own transaction stamped there (physical/ddl/stamps.ts), its
 * `__stamper` the transaction's 64-bit id: the instant the stamp function returned it there, one for every call of it
 * at the key in the transaction, which no other transaction can move until it ends, since the stamp holds the head
 * row's lock. So the stamp is exactly what a stated instant must equal, and a writer states one by calling the stamp
 * function first, as a served write's statement does, at no instant it did not stamp. Each relation of a clock has one
 * guard of each event:
 *
 *   CREATE OR REPLACE FUNCTION <schema>.<clock guard of R>() RETURNS trigger ... SECURITY DEFINER AS $$
 *   BEGIN
 *     IF EXISTS (SELECT FROM (SELECT DISTINCT "r1"."<k1>", …, "r1"."<at>" FROM "news" AS "r1") AS "r2"("c1", …)
 *         WHERE NOT EXISTS (SELECT FROM <head> AS "r3" WHERE "r3"."<k1>" = "r2"."c1" AND …
 *           AND "r3"."__instant" = "r2"."c<n>" AND "r3"."__stamper" = pg_catalog.pg_current_xact_id())) THEN
 *       RAISE EXCEPTION '…' USING ERRCODE = 'check_violation', CONSTRAINT = '__clocked', …;
 *     END IF;
 *     …one test a clock of R…
 *     RETURN NEW;
 *   END $$
 *   CREATE TRIGGER "__clocked" AFTER INSERT ON R REFERENCING NEW TABLE AS "news" FOR EACH STATEMENT
 *     EXECUTE FUNCTION <schema>.<clock guard of R>()
 *
 *   CREATE OR REPLACE FUNCTION <schema>.<clock move guard of R>() RETURNS trigger ... SECURITY DEFINER AS $$
 *   BEGIN
 *     IF ROW(NEW."<k1>", …, NEW."<at>") <> ROW(OLD."<k1>", …, OLD."<at>") AND NOT EXISTS (SELECT FROM
 *         <head> AS "r1" WHERE "r1"."<k1>" = NEW."<k1>" AND … AND "r1"."__instant" = NEW."<at>"
 *         AND "r1"."__stamper" = pg_catalog.pg_current_xact_id()) THEN
 *       RAISE EXCEPTION '…' USING ERRCODE = 'check_violation', CONSTRAINT = '__clock_moved', …;
 *     END IF;
 *     …
 *     RETURN NEW;
 *   END $$
 *   CREATE CONSTRAINT TRIGGER "__clock_moved" AFTER UPDATE OF "<k1>", …, "<at>" ON R DEFERRABLE INITIALLY DEFERRED
 *     FOR EACH ROW EXECUTE FUNCTION <schema>.<clock move guard of R>()
 *
 * The insert guard runs once a statement, as a sealed unit's seal guard does (physical/ddl/seal.ts): one probe of the
 * head's primary key for each distinct key and instant the statement's rows hold, so a served write, whose rows of one
 * call at a key share their instant, probes the head once a key a statement, the row its own stamp wrote a moment
 * before. The move guard fires only for a row an UPDATE names a clock's or its scope key's column of, which no served
 * write does (a put of a relation with a clock is refused, write/frontend/instants.ts), and tests the row only where
 * the UPDATE changed one: a closed relation's immutability guard refuses such an UPDATE before it already
 * (physical/ddl/immutable.ts), but for a migration's data step, which runs with that guard lifted and this one standing.
 * A DELETE moves no instant: what a key keeps is never above its head.
 *
 * A refusal raises 23514 under the trigger's name on the relation's table, `__clocked` or `__clock_moved`, a name of the
 * root's readable identities no law or constraint takes. A migration that adds a stored row's clock, by a DEFAULT of its
 * instant (deploy/diff/diff.ts stampedColumn), adds a column, which inserts no row, and makes its scope's head again
 * above it.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Identifier } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { type Clock, clocksOf, headNameOf } from "#compiler/ir/instant.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { revokeOf } from "#compiler/physical/ddl/deltas.ts"
import { headStamper } from "#compiler/physical/ddl/stamps.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import {
	type CreateConstraintTrigger,
	type CreateTransitionTrigger,
	type Expr,
	type ObjectName,
	type PlFunction,
	type PlStatement,
	transitionTables
} from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	call,
	col,
	distinctCore,
	derived,
	eq,
	exists,
	lit,
	not,
	objectName,
	operandSelect,
	row,
	simpleSelect,
	table,
	target,
	types
} from "#compiler/sql/build.ts"
import { namedQuery } from "#compiler/sql/naming.ts"
import { headValue } from "#compiler/write/insert/stamp.ts"

/** The constraint every clock guard's refusal of an insert reports, its trigger's name on its table. */
const clockTriggerName: Identifier<"clockTrigger"> = identifierOf(identity.clockTrigger())

/** The constraint every clock guard's refusal of a move reports, its trigger's name on its table. */
const clockMoveTriggerName: Identifier<"clockMoveTrigger"> = identifierOf(
	identity.clockMoveTrigger()
)

/** This transaction's 64-bit id, its top-level transaction's. */
const thisTransaction: Expr = call("pg_current_xact_id", [])

/** The fields of a clock's row that hold its scope's key, the first of its child, then the clock itself. */
const stampedFields = (clock: Clock): NonEmptyReadonlyArray<LawField> => [
	...mapNonEmpty(clock.head.key, (_, i) =>
		defined(clock.child[i], "a clock's child field at each field of its scope's key")
	),
	clock.field
]

/**
 * Whether the head of `clock`'s scope, under the alias `head`, holds at a key the instant its own transaction stamped
 * there, the key and the instant `values` gives position for position with stampedFields.
 */
const stampedHere = (
	b: InstallBuilder,
	clock: Clock,
	head: string,
	values: NonEmptyReadonlyArray<Expr>
): Expr => {
	const name = b.names.head(headNameOf(clock.head))
	const columns = [...mapNonEmpty(clock.head.key, (f) => f.column), headValue(clock.head).column]
	return exists(
		simpleSelect(
			[],
			[table(name.schema, name.name, head)],
			and([
				...mapNonEmpty(values, (v, i) =>
					eq(col(head, defined(columns[i], "a head column at each stamped field")), v)
				),
				eq(col(head, headStamper), thisTransaction)
			])
		)
	)
}

/** The refusal a guard raises under `constraint`, its message and hint naming the clock. */
const refusalOf = (clock: Clock, constraint: string, what: string): PlStatement => ({
	kind: "raise",
	message: `a row of ${clock.relation} is ${what} an instant of ${clock.relation}.${clock.field.name} its transaction did not stamp at its key`,
	using: [
		{ option: "ERRCODE", value: lit.text("check_violation", types.text) },
		{ option: "CONSTRAINT", value: lit.text(constraint, types.text) },
		{ option: "SCHEMA", value: { kind: "plSpecial", name: "TG_TABLE_SCHEMA" } },
		{ option: "TABLE", value: { kind: "plSpecial", name: "TG_TABLE_NAME" } },
		{
			option: "HINT",
			value: lit.text(
				`leave ${clock.field.name} out of a served insert, which stamps it; a direct writer calls its scope's stamp function first and states the instant it returns`,
				types.text
			)
		}
	]
})

/** The insert guard's test of one clock (see the header): a distinct key and instant of the statement's rows its
 * transaction did not stamp. */
const insertTest = (b: InstallBuilder, clock: Clock): PlStatement => {
	const [rows, distinct, head] = ["r1", "r2", "r3"]
	const fields = stampedFields(clock)
	const named = mapNonEmpty(fields, (_, i) => `c${i + 1}`)
	const unstamped = exists(
		simpleSelect(
			[],
			[
				derived(
					namedQuery(
						operandSelect(
							distinctCore(
								mapNonEmpty(fields, (f) => target(col(rows, f.column))),
								[{ kind: "transition", table: transitionTables.news, alias: rows }],
								undefined
							)
						),
						named
					),
					distinct,
					false
				)
			],
			not(
				stampedHere(
					b,
					clock,
					head,
					mapNonEmpty(named, (c) => col(distinct, c))
				)
			)
		)
	)
	return {
		kind: "if",
		branches: [{ condition: unstamped, body: [refusalOf(clock, clockTriggerName, "inserted at")] }],
		else: []
	}
}

/** The move guard's test of one clock (see the header): a row whose clock or scope key the UPDATE changed to a key and
 * an instant its transaction did not stamp. */
const moveTest = (b: InstallBuilder, clock: Clock): PlStatement => {
	const fields = stampedFields(clock)
	const of = (record: "OLD" | "NEW") =>
		mapNonEmpty(fields, (f): Expr => ({
			kind: "field",
			record: { kind: "plSpecial", name: record },
			field: f.column
		}))
	/** Every field compared is NOT NULL, a key's or a clock's, so `<>` of the rows is whether one changed. */
	const moved = binary("<>", row(of("NEW")), row(of("OLD")))
	return {
		kind: "if",
		branches: [
			{
				condition: and([moved, not(stampedHere(b, clock, "r1", of("NEW")))]),
				body: [refusalOf(clock, clockMoveTriggerName, "moved to")]
			}
		],
		else: []
	}
}

/** The columns an UPDATE names that the move guard fires on: every clock's of `clocks` and its scope key's, each once,
 * in code point order. */
const movedColumns = (clocks: NonEmptyReadonlyArray<Clock>): NonEmptyReadonlyArray<string> => {
	const [first, ...rest] = [
		...new Set(clocks.flatMap((c) => stampedFields(c).map((f) => f.column)))
	].toSorted(compareStrings)
	if (first === undefined) {
		defect("a clock's stamped fields hold the clock at least")
	}
	return [first, ...rest]
}

/** A trigger function of `body`, SECURITY DEFINER, so its caller holds no privilege on the heads it reads. */
const guardFunction = (
	name: ObjectName,
	body: NonEmptyReadonlyArray<PlStatement>
): readonly [PlFunction, ReturnType<typeof revokeOf>] => [
	{
		kind: "createFunction",
		advice: noAdvice,
		language: "plpgsql",
		name,
		params: [],
		returns: "trigger",
		volatility: "VOLATILE",
		parallel: "UNSAFE",
		security: "DEFINER",
		body: {
			declare: [],
			body: [...body, { kind: "return", value: { kind: "plSpecial", name: "NEW" } }]
		}
	},
	revokeOf(name, [])
]

/**
 * Every clock relation's two guards (see the header), each function an object of its own after its relation's table
 * and its clocks' heads, and each trigger after its function, in Validate, as a rule's captures and a seal's guards
 * are: a migration creates them once its data steps are done, and a relation's clocks' guard stands through every data
 * step of a later one.
 */
export const addClockGuards = (b: InstallBuilder): void => {
	const byRelation = new Map<string, Array<Clock>>()
	for (const clock of clocksOf(b.model.theory.instants)) {
		byRelation.getOrInsertComputed(clock.relation, () => []).push(clock)
	}
	if (byRelation.size === 0) {
		return
	}
	b.name(identity.clockTrigger())
	b.name(identity.clockMoveTrigger())
	for (const [relation, clocks] of [...byRelation].toSorted(([x], [y]) => compareStrings(x, y))) {
		if (!isNonEmpty(clocks)) {
			continue
		}
		const reasons = [enforcement(`the scope order of the clocks of ${relation}`)]
		const tableNode = b.table(relation)
		const tableName = b.names.relation(relation)
		const guards = [
			{
				named: identity.clockGuard(relation),
				body: mapNonEmpty(clocks, (c) => insertTest(b, c)),
				trigger: (fn: ObjectName): CreateTransitionTrigger => ({
					kind: "createTransitionTrigger",
					name: clockTriggerName,
					table: tableName,
					event: "insert",
					function: fn
				}),
				triggerNamed: identity.clockTrigger()
			},
			{
				named: identity.clockMoveGuard(relation),
				body: mapNonEmpty(clocks, (c) => moveTest(b, c)),
				trigger: (fn: ObjectName): CreateConstraintTrigger => ({
					kind: "createConstraintTrigger",
					name: clockMoveTriggerName,
					table: tableName,
					events: [{ kind: "update", columns: movedColumns(clocks) }],
					function: fn
				}),
				triggerNamed: identity.clockMoveTrigger()
			}
		]
		for (const guard of guards) {
			const fn = objectName(b.schema, b.name(guard.named))
			const fnNode = b.add(
				{
					kind: "lawFunction",
					ident: b.qualified("function", guard.named),
					ddl: guardFunction(fn, guard.body),
					reasons,
					phase: "validate"
				},
				[tableNode]
			)
			b.add(
				{
					kind: "lawTrigger",
					ident: {
						kind: "trigger",
						schema: b.names.levelOf(relation),
						relation: b.names.relationNamed(relation),
						name: guard.triggerNamed
					},
					ddl: [guard.trigger(fn)],
					reasons,
					phase: "validate"
				},
				[fnNode, tableNode]
			)
		}
	}
}
