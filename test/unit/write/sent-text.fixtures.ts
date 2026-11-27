/** What the properties of sent-text.test.ts read: its spaces and the texts each side gives. */

import { assembled } from "@bjornpagen/grizzle/compile"
import { int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { pg } from "#compiler/public/fields.ts"
import { key, on, schema } from "#compiler/public/schema.ts"
import { relationBuilder } from "#compiler/schema/relation.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, projectWrite, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { checking, owning } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/** How many relations the write inserts a fact into, each a part of its single statement. */
export const relations = int(2, 4)

/** One parted statement of the write, as each side gives its text: the exported assembly's and the runtime's. */
export interface SentPair {
	readonly index: number
	readonly exported: { readonly text: string; readonly params: number }
	readonly runtime: { readonly text: string; readonly params: number }
}

/**
 * The parted statements of one insert of a fact into each of `n` relations R0..R(n-1), each keyed by its id and keyed
 * again by `ref`, so the write's one statement holds a part per relation: for each, the text and the placeholder count
 * of its every unit assembled by @bjornpagen/grizzle/compile's `assembled` over the served form's units (what a served
 * file decodes to), and of the form the runtime's loaded write sends when every part's needs hold
 * (runtime/write/flight.ts partedFlight `sentFor`), the text a Db prepares and sends on the wire as it stands.
 */
export const sentPairs = (n: number): ReadonlyArray<SentPair> => {
	const written = upTo(n, (i) =>
		relationBuilder(`R${i}`, { id: pg.integer, ref: pg.integer, v: pg.integer }, ["id"], [])
	)
	const wide = schema(
		"Sent",
		written,
		Arr.map(written, (r) => key(on(r, "ref")))
	)
	const owned = owning(wide)
	const names = succeeded(
		compileInstallation(owned, {
			...installOptions(owned),
			levels: [identity.schema(parsedSchemaName("sent"))]
		})
	).names
	const artifacts = succeeded(testArtifacts(wide, testCompile))
	const facts = Rec.fromEntries(upTo(n, (i) => [`R${i}`, [{ id: 1, ref: 2, v: 3 }]] as const))
	const compiled = succeeded(
		compileWrite(checking(wide), descOf(ChangeSet.empty(wide).insertAll(facts)), {
			names,
			reads: names,
			claims: { kind: "every" },
			world: { kind: "reality" },
			laws: artifacts.laws,
			derived: artifacts.derived,
			level: "serializable",
			clock: noClock,
			source: transactionClock
		})
	)
	const servable = servableWrite(compiled)
	const served = projectWrite(servable)
	const flight = flightOf(servable, compiled.frontend.codes)
	return Arr.flatMap(served.statements, (s, index) => {
		const loaded = flight.statements[index]
		if (s.kind !== "parted" || loaded?.kind !== "parted") {
			return []
		}
		const exported = assembled(s.form.units)
		const sent = loaded.form.sentFor(() => true)
		return sent === undefined
			? []
			: [
					{
						index,
						exported: { text: exported.text, params: exported.params.length },
						runtime: { text: sent.text.sql, params: sent.paramSlots.length }
					}
				]
	})
}
