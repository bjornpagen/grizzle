/**
 * The schema vocabulary over the real field descriptors, str.regex and the scalar catalogue:
 * a row check's field terms are typed terms of the term protocol, so Num's arithmetic, casts and charLength compose
 * with them, and ownership accepts the result.
 *
 * The relations are built by the public, typed builders; the checks go through the builder's admission core, which
 * takes the callback as a JavaScript caller passes it, so the refusals below reach it at run time.
 *
 * Oracle: ownership's own acceptance of each composed check, and its refusal of a literal of another host kind or
 * roster and of two contracts of different identity.
 *
 * Features: arithmetic, a cast, charLength and a handle; each refusal.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { bigint } from "@bjornpagen/testing/values"
import { Effect } from "effect"
import { isCompileError } from "#compiler/core/errors.ts"
import { Logic, Num, Text } from "#compiler/public/compute.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { key, on, relation } from "#compiler/public/schema.ts"
import { own } from "#compiler/schema/own.ts"
import { schemaBuilder as schema, schemaDescOf } from "#compiler/schema/schema.ts"
import { checkBuilder } from "#compiler/schema/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	Account,
	Cents,
	type Composed,
	Kind,
	type LooseRow,
	type Refused,
	type Row,
	type SamePairRow
} from "#test/unit/schema/integration.fixtures.ts"

/** Row checks over the field registry and the scalar catalogue composes Num's arithmetic, casts and charLength with the row's field terms, and ownership accepts the result. Its budget is its suite's before it was a property (test/unit/schema/integration.test.ts at 4ca3036a): 60 runs and 60 steered cases. */
export const rowChecksOverTheFieldRegistryAndComputeComposesComputeArithmeticCastsAndCharLengthWithTheRowsFieldTermsAndOwnershipAcceptsTheResult =
	property.explore(
		(source) => ({
			composed: source.draw(element<Composed>(["arithmetic", "a cast", "charLength and a handle"])),
			n: source.draw(bigint(-1000n, 1000n)),
			bound: source.draw(int(0, 20)),
			handle: source.draw(element(["a" as const, "b" as const]))
		}),
		{
			needs: {},
			budget: { runs: 60, steered: 60 },
			situations: ["arithmetic", "a cast", "charLength and a handle"] satisfies ReadonlyArray<
				Reached<Composed>
			>,
			check:
				(_, c: Case<Composed>) =>
				({ composed, n, bound, handle }) =>
					Effect.sync(() => {
						c.note(composed)
						const statement =
							composed === "arithmetic"
								? checkBuilder("headroom", Account, (r: Row) => Logic.ge(Num.add(r.bal, n), n))
								: composed === "a cast"
									? checkBuilder("scaled", Account, (r: Row) =>
											Logic.ge(Num.numeric(r.bal), `${n}.5`)
										)
									: checkBuilder("short", Account, (r: Row) =>
											Logic.and([Logic.le(Text.charLength(r.slug), bound), r.ne(r.kind, handle)])
										)
						succeeded(
							own(
								defined(
									schemaDescOf(
										schema("bank", [Account, Kind], [statement, key(on(Account, "slug"))], [])
									)
								)
							)
						)
					}),
			oracle: { kind: "specification", name: "ownership of the composed row check" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/own.ts",
					original: '\ttypeof value === "string" && roster.handles.includes(value)',
					replacement: "\tfalse",
					why: 'Operator mutant (boolean-return) at packages/engine/src/schema/own.ts:753 in isRosterHandle: `typeof value === "string" && roster.handles.includes(value)` becomes `false`; the property fails (lane CATCH, grizzle 0baff5d6).'
				}
			]
		}
	)

const otherKey = Symbol("Other")
/** Row checks over the field registry and the scalar catalogue refuses a row field's literal of another host kind or roster, and two contracts of different identity. Its budget is its suite's before it was a property (test/unit/schema/integration.test.ts at 4ca3036a): 60 runs and 60 steered cases. */
export const rowChecksOverTheFieldRegistryAndComputeRefusesARowFieldsLiteralOfAnotherHostKindOrRosterAndTwoContractsOfDifferentIdentity =
	property.explore(
		(source) => ({
			refused: source.draw(
				element<Refused>([
					"a number for a bigint",
					"a handle off the roster",
					"two contracts meeting"
				])
			),
			n: source.draw(int(-1000, 1000))
		}),
		{
			needs: {},
			budget: { runs: 60, steered: 60 },
			situations: [
				"a number for a bigint",
				"a handle off the roster",
				"two contracts meeting"
			] satisfies ReadonlyArray<Reached<Refused>>,
			check:
				(_, c: Case<Refused>) =>
				({ refused, n }) =>
					Effect.sync(() => {
						c.note(refused)
						const build = (): unknown => {
							switch (refused) {
								case "a number for a bigint":
									return checkBuilder("bad", Account, (r: LooseRow) =>
										Logic.ge(Num.add(r.bal, n), 0n)
									)
								case "a handle off the roster":
									return checkBuilder("bad", Account, (r: LooseRow) => r.eq(r.kind, "c"))
								case "two contracts meeting": {
									/** A contract's name is one literal by its type: the other identity is written here. */
									const Pair = relation(
										"Pair",
										{ a: Cents, b: contract<typeof otherKey>()("Other", pg.bigint) },
										["a"]
									)
									return checkBuilder("mixed", Pair, (r: SamePairRow) =>
										Logic.ge(Num.add(r.a, r.b), 0n)
									)
								}
							}
						}
						assert.throws(build, isCompileError)
					}),
			oracle: {
				kind: "specification",
				name: "a literal of another host kind or roster, and two contracts of different identity, refused"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/errors.ts",
					original: '\tError.isError(value) && "_tag" in value && value._tag === "CompileError"',
					replacement: '\tError.isError(value) && "_tag" in value && value._tag !== "CompileError"',
					why: "Operator mutant (comparison) at packages/engine/src/core/errors.ts:1015 in isCompileError: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)
