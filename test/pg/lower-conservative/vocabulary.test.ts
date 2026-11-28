/**
 * The conservative lowering's scalar vocabulary and literal forms on PostgreSQL 19.
 *
 * Every entry of the default operator table names a real overload: an operator form's identity is the implementing
 * function (pg_operator.oprcode) of a builtin operator spelled with the form's symbol, unary for negation. Every
 * function the default vocabulary lowers is a registry entry whose OpId is its regprocedure signature, an exact
 * carrier's own overload prefixing the numeric signature that implements it, and the call it emits names that function. That every literal kind reaches PostgreSQL exactly is the generated oracle suites': their
 * compared and projected literals and closed payloads over every palette type, against the reference.
 *
 * Oracle: PostgreSQL's catalog, pg_operator for each form's function and pg_proc for each registry entry's signature.
 *
 * Features: a binary operator and the negation among the forms; a function lowered to its call among the entries.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, contains, defined } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { describeOp } from "#compiler/ir/expr.ts"
import { defaultOps } from "#compiler/lower/conservative/expr/ops.ts"
import { nativeOps, operandCarriers } from "#compiler/scalar/compute/registry.ts"
import { col } from "#compiler/sql/build.ts"
import { operatorForms } from "#test/pg/lower-conservative/vocabulary.dictionary.ts"
import {
	type FormFeature,
	listedSignature,
	type LoweredFeature,
	opExpr
} from "#test/pg/lower-conservative/vocabulary.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { temporaryLibrary } from "#test/support/unit/compute/support.ts"

/** The conservative vocabulary on PostgreSQL 19 names a builtin operator for every operator form. */
export const theConservativeVocabularyOnPostgreSQL19NamesABuiltinOperatorForEveryOperatorForm =
	property.exhaust(finite(word(operatorForms)), {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: ["binary", "negation"] satisfies ReadonlyArray<Reached<FormFeature>>,
		check:
			({ tx }, c: Case<FormFeature>) =>
			([identity, form]) =>
				Effect.gen(function* () {
					const { connection: admin } = yield* tx
					const rows = yield* admin.queryValues(
						"SELECT o.oprname::text, (o.oprleft = 0)::text FROM pg_catalog.pg_operator AS o WHERE o.oprcode::text = $1::text",
						[identity]
					)
					assert.ok(rows.length > 0, identity)
					contains(
						Arr.map(rows, (r) => `${String(r[0])} ${String(r[1])}`),
						form.kind === "negate" ? "- true" : `${form.op} false`,
						identity
					)
					c.note(form.kind === "negate" ? "negation" : "binary")
				}),
		oracle: {
			kind: "postgresql",
			name: "pg_operator's operators implemented by the form's function"
		},
		box: "every entry of the default operator table",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/ops.ts",
				original:
					'\tput({ kind: "binary", op: "%" }, ["int2mod", "int4mod", "int8mod", "numeric_mod"])',
				replacement:
					'\tput({ kind: "binary", op: "/" }, ["int2mod", "int4mod", "int8mod", "numeric_mod"])',
				why: "The table spells the modulo functions with the division symbol; the operator forms property fails."
			}
		]
	})

/** The conservative vocabulary on PostgreSQL 19 lowers every function by its regprocedure signature to a call of that function. */
export const theConservativeVocabularyOnPostgreSQL19LowersEveryFunctionByItsRegprocedureSignatureToACallOfThatFunction =
	property.exhaust(finite(int(0, nativeOps.length - 1)), {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: ["lowered to its function"] satisfies ReadonlyArray<Reached<LoweredFeature>>,
		check:
			({ tx }, c: Case<LoweredFeature>) =>
			(i) =>
				Effect.gen(function* () {
					const { connection: admin } = yield* tx

					const native = defined(nativeOps[i], `entry ${i}`)
					if (
						native.sql.kind !== "function" ||
						native.totality.kind === "exact" ||
						native.totality.kind === "ieee"
					) {
						c.note("not lowered by name")
						return
					}
					const args = Arr.map(indices(operandCarriers(native.operands).length), (n) =>
						col("r1", `c${n + 1}`)
					)
					const lowered = defaultOps(opExpr(native), args, temporaryLibrary)
					if (lowered === undefined) {
						c.note("not lowered by name")
						return
					}
					const name = describeOp(native.id)
					assert.ok(lowered.kind === "call", name)
					/** A range-polymorphic function's identity is its signature at a range carrier. */
					const signature = listedSignature(native.id)
					const rows = yield* admin.queryValues(
						"SELECT p.proname::text FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure($1::text) AND p.pronamespace = 'pg_catalog'::regnamespace",
						[signature]
					)
					assert.deepEqual(
						Arr.map(rows, (r) => r[0]),
						[lowered.fn.name],
						name
					)
					c.note("lowered to its function")
				}),
		oracle: {
			kind: "postgresql",
			name: "pg_proc's function at the entry's regprocedure signature"
		},
		box: "every entry of the scalar registry",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/ops.ts",
				original: "\t\t\t\t? call(sql.name, args)",
				replacement: '\t\t\t\t? call("abs", args)',
				why: "Every function lowers to a call of abs; the functions property fails."
			}
		]
	})
