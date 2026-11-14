/**
 * The evidence catalog: the theory resolves each declared key to its installed constraint, and a scan proves exactly the
 * keys whose fields it reads, at every statement, judged over Crm's two Person keys and a scan of Person reading a
 * drawn set of its columns in either execution context.
 *
 * Oracle: the rules above, a specification. Plants (~/.cache/grizzle-release/BR03/plants): base-key-evidence-deferred
 * (a declared key's proof holds only in a committed snapshot). Features: no key proves the scan, a key proves the scan,
 * a key not read.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, subset } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { theoryCatalog } from "#compiler/analysis/physical/evidence.ts"
import { keyedBy } from "#compiler/analysis/physical/props.ts"
import { checkedSchema } from "#compiler/analysis/schema.ts"
import { buildTheory, theoryEvidence } from "#compiler/analysis/theory/theory.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import { Ir, SchemaModel } from "#test/support/fixtures/ir/build.ts"
import { contained, f, key, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	keyColumns,
	owedOf,
	physical,
	propsOf,
	snapshotOver
} from "#test/unit/analysis/physical/support.ts"

const executions: Arr.NonEmptyReadonlyArray<TemplateContext> = ["snapshot", "transaction"]

const Person = relation(
	"Person",
	{ id: f.uuid, email: f.regex("^[a-z]{1,20}$", "u"), city: f.wildcard },
	["id"]
)
const Purchase = relation("Purchase", { id: f.uuid, person: f.uuid }, ["id"])
const Crm: SchemaDesc = {
	name: "Crm",
	relations: [Person, Purchase],
	statements: [
		key(on("Person", ["email"])),
		contained(on("Purchase", ["person"]), on("Person", ["id"]))
	],
	extends: undefined
}
const crm = ownedFixture(Crm)
const theory = succeeded(buildTheory(succeeded(checkedSchema(crm.owned, everySlice(crm.owned)))))
const evidence = theoryEvidence(theory.laws, new Set())
const personKeys = Object.freeze(Arr.filter(evidence.keys, (k) => k.relation === "Person"))

type CatalogFeature = "no key proves the scan" | "a key proves the scan" | "a key not read"

describe("catalogs", () => {
	it.effect(
		"resolves each Person key to its constraint, and a scan proves exactly the keys it reads, immediately",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "both execution contexts by every nonempty set of Person's columns a scan reads",
						oracle: {
							kind: "specification",
							name: "each declared key resolves to its constraint; a scan proves exactly the keys whose fields it reads, at every statement"
						},
						suite: "unit/analysis/physical/catalog-scan",
						generator: (source) =>
							[
								source.draw(element(executions)),
								source.draw(subset(["id", "email", "city"], { min: 1, max: 3 }))
							] as const,
						literal: Formatter.format,
						coverage: requiredInSpace<CatalogFeature>([
							"no key proves the scan",
							"a key proves the scan",
							"a key not read"
						]),
						caseHang,
						concurrency: 1
					},
					([context, read], c) =>
						Effect.sync(() => {
							const catalog = theoryCatalog(evidence, {
								containments: [],
								relations: theory.relations
							})
							for (const k of personKeys) {
								const resolved = catalog.keyConstraint("Person", k.fields, {
									primary: k.primary,
									derived: false
								})
								assert.deepEqual(resolved, {
									relation: "Person",
									columns: k.fields,
									spans: k.spans,
									constraint: k.constraint,
									kind: k.primary ? "primaryKey" : "unique"
								})
							}
							assert.equal(
								catalog.keyConstraint("Person", ["city"], { primary: false, derived: false }),
								undefined
							)
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
										premise.constraintKind === (k.primary ? "primaryKey" : "unique")
								)
							assert.equal(
								proof.premises.length,
								Arr.filter(personKeys, premiseOf).length,
								"every premise is a key's constraint"
							)
							assert.ok(Arr.some(proving, premiseOf), "a key the scan reads is a premise")
							assert.equal(proof.context, "immediate")
						})
				)
			)
	)
})
