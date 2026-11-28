/**
 * Every precondition kind's refusal names a guard its operand's type can write (core/errors.ts GuardTest), over an
 * exhaustive box of planted faults: each kind's partial operation, over a column of each operand type the registry
 * admits for it, with its precondition left unproved, in a query, or in a check for a text's UTF-16 units, which no
 * query reads.
 *
 * The oracle: the refusal is PartialOperation of exactly the planted kind; its guard's test is one the scalar catalogue writes over
 * the operand's type (a number's Num.nonzero, Num.nonnegative, Num.positive, Num.isFinite or
 * Num.within; a text's Text.matches or a bound on its bytes; over any other type no scalar test, a value of the
 * target's own type); and, where that guard alone
 * proves the precondition, the term with the named guard written around it, or its operand a parameter of the target's
 * type, is admitted. Everything is read off the error's fields, never its prose.
 *
 * Features: a refusal for each precondition kind, a text operand's guard, a guard no scalar test writes, and a named
 * guard, written, admitted.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { v } from "#test/support/unit/compute/support.ts"
import {
	type Feature,
	kinds,
	lowered,
	plants,
	widest,
	writable
} from "#test/unit/compute/guards.fixtures.ts"

/** A partial operation's refusal names its precondition and a guard its operand's type writes, which, written, admits the operation. */
export const aPartialOperationsRefusalNamesItsPreconditionAndAGuardItsOperandsTypeWritesWhichWrittenAdmitsTheOperation =
	property.exhaust(
		finite((source) => [source.draw(element(kinds)), source.draw(int(0, widest - 1))] as const),
		{
			needs: {},
			situations: [
				...Arr.map(kinds, (k): Feature => `refused for ${k}`),
				"a text operand's guard",
				"a guard no scalar test writes",
				"a named guard, written, admitted"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check:
				(_, c: Case<Feature>) =>
				([kind, pick]) =>
					Effect.sync(() => {
						const list = plants[kind]
						const plant = defined(list[pick % list.length], "a plant of the kind")
						const x = v("x", plant.operand)
						const faulty = lowered(kind, plant.faulty(x), plant.operand)
						if (faulty.ok) {
							return assert.fail(`the unguarded ${kind} operation is refused`)
						}
						const reason = faulty.error.reason
						if (reason._tag !== "PartialOperation") {
							return assert.fail(
								`the unguarded ${kind} operation is PartialOperation, not ${reason._tag}`
							)
						}
						assert.equal(reason.precondition, kind)
						const carrier = plant.operand.scalar.carrier
						assert.ok(
							Arr.contains(writable(carrier), reason.guard.remedy.kind),
							`a ${reason.guard.remedy.kind} guard is one the scalar catalogue writes over a ${carrier}`
						)
						c.note(`refused for ${kind}`)
						if (carrier === "text") {
							c.note("a text operand's guard")
						}
						if (reason.guard.remedy.kind === "typed") {
							c.note("a guard no scalar test writes")
						}
						const mended = plant.mended
						switch (mended.kind) {
							case "guarded": {
								const admitted = lowered(kind, mended.term(x), plant.operand)
								assert.ok(admitted.ok, `the ${kind} operation under its named guard is admitted`)
								c.note("a named guard, written, admitted")
								return
							}
							case "typed": {
								assert.equal(reason.guard.remedy.kind, "typed")
								const admitted = lowered(kind, mended.term(), plant.operand)
								assert.ok(admitted.ok, `the ${kind} operation over a typed parameter is admitted`)
								c.note("a named guard, written, admitted")
								return
							}
							case "beyond one guard":
								return
						}
					}),
			oracle: {
				kind: "specification",
				name: "the planted precondition and the guards the scalar catalogue writes over its operand's type"
			},
			box: "every precondition kind, over each operand type it plants",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/compute/lower.ts",
					original:
						'\t\t\treturn withinGuards(valueType(operand.nominal).carrier)\n\t\t\t\t? { kind: "within" }\n\t\t\t\t: { kind: "typed" }',
					replacement: '\t\t\treturn { kind: "within" }',
					why: "A contract's guard is Num.within whatever its operand's type, so the text and boolean contract casts name a guard no scalar test writes over them; the refusal property fails."
				},
				{
					file: "packages/engine/src/scalar/compute/typing.ts",
					original: '\t\tcase "int4":\n\t\tcase "float4":\n\t\tcase "float8":\n\t\t\treturn 0\n',
					replacement: '\t\tcase "float4":\n\t\tcase "float8":\n\t\t\treturn 0\n',
					why: "The one table of a constant guard's comparisons (typing.ts constantGuardTests) holds no zero of an integer, so Num.nonzero, the guard a division over integers names, is refused where it is written; the refusal property fails."
				}
			]
		}
	)
