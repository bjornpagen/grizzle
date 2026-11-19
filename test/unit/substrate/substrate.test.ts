/**
 * The database-free naming of the native PG test substrate, against a model:
 *
 * - Names. A schema label and a role name are lowercase ASCII letter words joined by single underscores; an allocated
 *   schema name is `gz_<label>_<pid>_<n>_<ten digits>`, its own conversion at the naming door, and every role and role
 *   schema minted under it starts with its prefix, so the global setup reads the allocating process off any of them
 *   and sweeps a dead one's; no name past maxIdentifierBytes is ever made, so PostgreSQL never cuts one. The oracle is
 *   the generator's own words, each drawn whole or with a fault planted, and the byte count of the name they spell.
 *
 * The property states its oracle, the specification; invalid words, identifiers and allocations are named faults the
 * generators plant, drawn by explicit weight beside the lawful ones. Features: each of its verdicts.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, int, weighted } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Option, Result, String as Str } from "effect"
import { maxIdentifierBytes, identifierOf, identity } from "#compiler/core/identity.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	allocatingPid,
	assertIdentifier,
	roleName,
	rolePrefix,
	uniqueSchemaName
} from "#test/support/substrate/names.ts"
import {
	drawnWord,
	identifierGen,
	mintedUnder,
	type NameFeature,
	refuses,
	unallocatedGen
} from "#test/unit/substrate/substrate.fixtures.ts"

/**
 * Substrate names allocate exactly the names the word rule and the byte limit admit, every name under an allocation
 * carrying its prefix and its process.
 *
 * Budget: its suite's count before the conversion (unit/substrate/names: 400 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const substrateNamesAllocateExactlyTheNamesTheWordRuleAndTheByteLimitAdmitEveryNameUnderAnAllocationCarryingItsPrefixAndItsProcess =
	property.explore(
		(source) => ({
			label: source.draw(drawnWord(source.draw(element([6, 24, 60] as const)))),
			allocation: source.draw(
				weighted<number>([
					[3, int(0, 199)],
					[1, int(0, 2 ** 31 - 1)]
				])
			),
			role: source.draw(drawnWord(source.draw(element([6, 24, 60] as const)))),
			unallocated: source.draw(unallocatedGen),
			identifier: source.draw(identifierGen)
		}),
		{
			needs: {},
			situations: [
				"an identifier admitted",
				"an identifier past the limit",
				"an identifier refused",
				"allocated",
				"a label refused",
				"a label past the limit",
				"a role named",
				"a role refused",
				"a role past the limit",
				"no allocation"
			] satisfies ReadonlyArray<Reached<NameFeature>>,
			check:
				(_, c: Case<NameFeature>) =>
				({ label, allocation, role, unallocated, identifier }) =>
					Effect.sync(() => {
						const plain =
							Option.isNone(identifier.fault) &&
							Buffer.byteLength(identifier.text) <= maxIdentifierBytes
						assert.equal(
							refuses(() => assertIdentifier(identifier.text)),
							!plain,
							identifier.text
						)
						c.note(
							plain
								? "an identifier admitted"
								: Option.isSome(identifier.fault)
									? "an identifier refused"
									: "an identifier past the limit"
						)
						assert.ok(Option.isNone(allocatingPid(unallocated)), unallocated)
						assert.ok(
							refuses(() => roleName(unallocated, "worker")),
							unallocated
						)
						c.note("no allocation")
						const bytes = Buffer.byteLength(
							`gz_${label.text}_${process.pid}_${allocation}_0000000000`
						)
						const fits = bytes <= maxIdentifierBytes
						const made = Result.try(() => uniqueSchemaName(label.text, allocation))
						assert.equal(Result.isSuccess(made), Option.isNone(label.fault) && fits, label.text)
						if (Result.isFailure(made)) {
							c.note(Option.isSome(label.fault) ? "a label refused" : "a label past the limit")
							return
						}
						const schema = made.success
						c.note("allocated")
						assert.equal(Buffer.byteLength(schema), bytes)
						assert.equal<string>(identifierOf(identity.schema(parsedSchemaName(schema))), schema)
						assert.deepEqual(allocatingPid(schema), Option.some(process.pid))
						const prefix = rolePrefix(schema)
						for (const name of mintedUnder(schema)) {
							if (Buffer.byteLength(name) <= maxIdentifierBytes) {
								assert.ok(Str.startsWith(prefix)(name), `${name} starts with ${prefix}`)
								assert.deepEqual(allocatingPid(name), Option.some(process.pid), name)
							}
						}
						const full = `${schema}__${role.text}`
						const named = Result.try(() => roleName(schema, role.text))
						const roleFits = Buffer.byteLength(full) <= maxIdentifierBytes
						assert.equal(Result.isSuccess(named), Option.isNone(role.fault) && roleFits, full)
						if (Result.isFailure(named)) {
							c.note(Option.isSome(role.fault) ? "a role refused" : "a role past the limit")
							return
						}
						c.note("a role named")
						assert.equal(named.success, full)
						assert.ok(Str.startsWith(prefix)(named.success))
						assert.deepEqual(allocatingPid(named.success), Option.some(process.pid))
					}),
			oracle: {
				kind: "specification",
				name: "the word rule on the generator's own words, and the bytes of the names they spell"
			},
			budget: { runs: 400, steered: 0 },
			kept: [
				{
					token: ReplayToken(
						"test/unit/substrate/substrate.test.ts#substrateNamesAllocateExactlyTheNamesTheWordRuleAndTheByteLimitAdmitEveryNameUnderAnAllocationCarryingItsPrefixAndItsProcess:-:0.0.1.2.f.6.0.0.0.0.1.1.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
					),
					reason:
						"a label pg: its allocation is a schema name the naming door admits, which pg_ never leads",
					since: "2026-11-08"
				}
			],
			kills: [
				{
					file: "packages/engine/src/core/identity.ts",
					original: "\t}\n\tflush()\n\treturn segments.map((s) => s.toLowerCase())",
					replacement: "\t}\n\t{}\n\treturn segments.map((s) => s.toLowerCase())",
					why: "Operator mutant (statement) at packages/engine/src/core/identity.ts:204 in nameSegments: `flush()` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)
