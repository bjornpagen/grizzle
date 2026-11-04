import { compareText } from "#compiler/core/canonical.ts"
import { identity } from "#compiler/core/identity.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import type { CreateFunction, Expr, ObjectName, Revoke } from "#compiler/sql/ast.ts"
import {
	call,
	cast,
	col,
	core,
	functionNameOf,
	gt,
	lit,
	row,
	table,
	target,
	types
} from "#compiler/sql/build.ts"

/** The advance function's DDL for `sequence`: its CREATE FUNCTION, then its REVOKE EXECUTE ... FROM PUBLIC. */
const advanceFunctionDdl = (
	name: ObjectName,
	sequence: ObjectName
): readonly [CreateFunction, Revoke] => {
	const past = { kind: "plVar", name: "past" } as const
	const seq: Expr = { kind: "regclass", relation: sequence }
	const catalogClass: Expr = {
		kind: "regclass",
		relation: { schema: "pg_catalog", name: "pg_class" }
	}
	const fn: CreateFunction = {
		kind: "createFunction",
		language: "plpgsql",
		name,
		params: [{ name: "past", type: types.bigint }],
		returns: "void",
		volatility: "VOLATILE",
		parallel: "UNSAFE",
		security: "DEFINER",
		planCacheMode: "force_custom_plan",
		body: {
			declare: [],
			body: [
				{
					kind: "perform",
					query: {
						body: core(
							[
								target(
									call("pg_advisory_xact_lock", [
										cast(catalogClass, types.integer),
										cast(seq, types.integer)
									])
								)
							],
							[],
							undefined
						),
						orderBy: [],
						limit: undefined,
						offset: undefined
					}
				},
				{
					kind: "perform",
					query: {
						body: core(
							[target(call("setval", [seq, past]))],
							[table(sequence.schema, sequence.name, "r1")],
							gt(
								row([past, lit.bool(true)]),
								row([col("r1", "last_value"), col("r1", "is_called")])
							)
						),
						orderBy: [],
						limit: undefined,
						offset: undefined
					}
				}
			]
		}
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

/** Each serial field's advance function, by relation, then by field. */
export type AdvanceFunctions = ReadonlyMap<string, ReadonlyMap<string, Node<"structure">>>

/** Every serial field's advance function, each after its table, named for its field (identity.advance).
 *
 * One advance function per serial field of a stored relation, the one way a role moves the field's identity sequence.
 *
 * A serial field is GENERATED ALWAYS AS IDENTITY, and a write that inserts explicit serial values advances its sequence
 * past them in the same transaction. No role holds a privilege on the sequence: reading its
 * position would count every insert, hidden facts included, and setval would let one login rewind the counter every
 * other login draws from, so a later generated value repeats a stored one. The advance function moves it instead, and
 * only forward, past the largest value given, never back. It does not stop exhaustion: a writer that inserts a very
 * large explicit value moves the counter toward its end, which explicit serial values allow anyway:
 *
 *   CREATE OR REPLACE FUNCTION <schema>.<advance>("past" bigint) RETURNS "pg_catalog"."void" LANGUAGE plpgsql
 *   VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET plan_cache_mode = force_custom_plan AS $$
 *   BEGIN
 *     PERFORM pg_catalog.pg_advisory_xact_lock('"pg_catalog"."pg_class"'::regclass::integer,
 *       '"<schema>"."<sequence>"'::regclass::integer);
 *     PERFORM pg_catalog.setval('"<schema>"."<sequence>"'::regclass, past) FROM <sequence> AS r1
 *     WHERE (past, true) > (r1.last_value, r1.is_called);
 *   END $$
 *
 * Each relation the body names as a regclass value is a relation reference (sql/ast.ts RegclassRef), so a move of the
 * function into another schema (the drift check's scratch replay) moves the sequence it names with it.
 *
 * It moves the sequence to `past` when `past` is at least the next value the sequence would generate (a sequence never
 * called reports its start value with is_called false, so `(past, true) > (last_value, is_called)` is the comparison),
 * and never below the position it reads. Advancers of one sequence are serialized by a transaction-scoped advisory lock
 * keyed by the sequence's class and OID, so no advance rewinds another's. PostgreSQL locks no sequence against nextval
 * (LOCK refuses a sequence), so a value the identity default draws inside one advance's read-to-setval window can be
 * drawn again, which the relation's key refuses: the window is one statement, and no stored fact is lost. The function
 * returns nothing, so a caller learns nothing of the position.
 *
 * EXECUTE goes to each role that writes the relation, and PUBLIC holds none, revoked right
 * after its creation as every grizzle function's is. It waits for its table, whose sequence it names. */
export const addAdvanceFunctions = (b: InstallBuilder): AdvanceFunctions => {
	const out = new Map<string, ReadonlyMap<string, Node<"structure">>>()
	for (const [relation, r] of Object.entries(b.owned.relations).toSorted(([x], [y]) =>
		compareText(x, y)
	)) {
		if (r.kind !== "relation") {
			continue
		}
		const fields = new Map<string, Node<"structure">>()
		for (const field of Object.values(r.fields)) {
			if (field.sequence === undefined) {
				continue
			}
			const named = identity.advance(relation, field.name)
			b.name(named)
			const name = b.names.advance(relation, field.name)
			fields.set(
				field.name,
				b.add(
					{
						kind: "advanceFunction",
						ident: b.qualified("function", named),
						ddl: advanceFunctionDdl(name, b.names.sequence(relation, field.name)),
						reasons: [enforcement(`the identity sequence of ${relation}.${field.name}`)],
						phase: "structure"
					},
					[b.table(relation)]
				)
			)
		}
		out.set(relation, fields)
	}
	return out
}
