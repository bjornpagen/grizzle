/**
 * The evidence catalog: the theory resolves each declared key to its installed constraint, and a scan proves exactly the
 * keys whose fields it reads, at every statement, judged over Crm's two Person keys and a scan of Person reading a
 * drawn set of its columns in either execution context.
 *
 * Oracle: the rules above, a specification. Features: no key proves the scan, a key proves the scan, a key not read.
 */

import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, subset } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { theoryCatalog } from "#compiler/analysis/physical/evidence.ts"
import { keyedBy } from "#compiler/analysis/physical/props.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { Ir, SchemaModel } from "#test/support/fixtures/ir/build.ts"
import {
	keyColumns,
	owedOf,
	physical,
	propsOf,
	snapshotOver
} from "#test/support/unit/analysis/physical/support.ts"
import {
	type CatalogFeature,
	crm,
	evidence,
	executions,
	personKeys,
	theory
} from "#test/unit/analysis/physical/evidence.fixtures.ts"

/** Catalogs resolves each Person key to its constraint, and a scan proves exactly the keys it reads, immediately. */
export const catalogsResolvesEachPersonKeyToItsConstraintAndAScanProvesExactlyTheKeysItReadsImmediately =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element(executions)),
					source.draw(subset(["id", "email", "city"], { min: 1, max: 3 }))
				] as const
		),
		{
			needs: {},
			situations: [
				"no key proves the scan",
				"a key proves the scan",
				"a key not read"
			] satisfies ReadonlyArray<Reached<CatalogFeature>>,
			check:
				(_, c: Case<CatalogFeature>) =>
				([context, read]) =>
					Effect.sync(() => {
						const catalog = theoryCatalog(evidence, {
							containments: [],
							relations: theory.relations
						})
						for (const k of personKeys) {
							const resolved = catalog.keyConstraint("Person", k.fields)
							assert.deepEqual(resolved, {
								relation: "Person",
								columns: k.fields,
								spans: k.spans,
								constraint: k.constraint,
								kind: k.kind
							})
						}
						assert.equal(catalog.keyConstraint("Person", ["city"]), undefined)
						/** The rules: every installed key holds at every statement; a scan proves the keys whose fields it reads. */
						const proving = Arr.filter(personKeys, (k) =>
							Arr.every(k.fields, (field) => read.includes(field))
						)
						if (proving.length < personKeys.length) {
							c.note("a key not read")
						}
						const m = new Ir(new SchemaModel(crm, {}))
						const scan = m.region(
							[
								{
									source: m.base("Person"),
									bind: Rec.fromEntries(Arr.map(read, (col) => [col, col])),
									constants: {}
								}
							],
							conservativeMeta
						)
						const a = physical(m.build(scan).dag, { ...snapshotOver(m), catalog, context })
						unorderedEqual(
							keyColumns(a, scan),
							Arr.map(proving, (k) => k.fields)
						)
						const base = Option.getOrThrow(
							Arr.findFirst(topoOrder(a.dag), (n) => n.kind === "Base")
						)
						assert.equal(propsOf(a, base).uniqueness.kind, "plain")
						const scanProps = propsOf(a, scan)
						/** The strongest proof that the scan's heading identifies its row. */
						const unique = keyedBy(scanProps, scanProps.columns)
						if (proving.length === 0) {
							c.note("no key proves the scan")
							assert.equal(unique, undefined)
							assert.deepEqual(owedOf(a, scan), {
								kind: "on",
								heading: Arr.map(scan.heading, (col) => col.name)
							})
							return
						}
						c.note("a key proves the scan")
						assert.deepEqual(owedOf(a, scan), { kind: "none" })
						const proof = defined(unique, "the strongest proof of a scan a key proves").just
						/** The proof rests on key constraints, one of them a key the scan reads, and holds at every statement. */
						const premiseOf = (k: (typeof personKeys)[number]): boolean =>
							Arr.some(
								proof.premises,
								(premise) =>
									premise.kind === "constraint" &&
									premise.constraint === k.constraint &&
									premise.constraintKind === k.kind
							)
						assert.equal(
							proof.premises.length,
							Arr.filter(personKeys, premiseOf).length,
							"every premise is a key's constraint"
						)
						assert.ok(Arr.some(proving, premiseOf), "a key the scan reads is a premise")
						assert.equal(proof.context, "immediate")
					}),
			oracle: {
				kind: "specification",
				name: "each declared key resolves to its constraint; a scan proves exactly the keys whose fields it reads, at every statement"
			},
			box: "both execution contexts by every nonempty set of Person's columns a scan reads",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/physical/evidence.ts",
					original: '\tcontext: "immediate"',
					replacement: '\tcontext: "committedSnapshot"',
					why: "A declared key's proof holds only in a committed snapshot (analysis/physical/evidence.ts keyEvidence); the property fails."
				}
			]
		}
	)
