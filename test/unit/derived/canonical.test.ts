/**
 * A stored table's identity is its definition's canonical form, alpha-equivalent, named or not
 * (analysis/derived/canonical.ts): every derived relation's definition and every query a definition imports under an
 * empty bind map is a canonical relation, decided once (analysis/derived/storage.ts), and two built alike, one named
 * and one anonymous, or one Description and one spelled anew, are one canonical relation, one table, named by the
 * digest of its form (core/identity.ts view). A named relation takes its canonical relation's name; an anonymous one
 * its canonical name. The lowering reads a stored canonical relation's table wherever its form stands, inside a live
 * relation's definition too (ir/derived.ts servedDag), and reads its definition where a statement's own transaction
 * writes a relation it reads.
 *
 * The box is canonical.fixtures.ts: a join of a document's place with its note, Document-local, imported by a live
 * relation at a link's target; beside it no named relation, one whose definition is that very query, or one whose
 * definition is the join spelled anew under other scope names.
 *
 * The oracle is the rule restated: one stored canonical relation, the named one's name where one states the join, its
 * table named by its form, read in the live relation's place of the join.
 *
 * Features: each naming.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { succeeded } from "#test/support/assert.ts"
import { compiledOf } from "#test/support/unit/analysis/theory/rule-query.fixtures.ts"
import { readsOf } from "#test/support/unit/derived/storage.fixtures.ts"
import {
	canonicalSchemaOf,
	joinedName,
	linkedName,
	linkedRead,
	type Naming,
	namingCase
} from "#test/unit/derived/canonical.fixtures.ts"

type CanonicalFeature = `named ${Naming}`

/**
 * One join, imported by a live relation and stated by a named one or not, alpha-equivalent or the very query, is one
 * stored canonical relation, one table named by its form, which the live relation's read reads in the join's place.
 */
export const alphaEquivalentSubQueriesNamedOrNotInstallOneTableTheLiveReaderReads =
	property.exhaust(finite(namingCase), {
		needs: {},
		situations: ["named none", "named same", "named alpha"] satisfies ReadonlyArray<
			Reached<CanonicalFeature>
		>,
		check: (_, c: Case<CanonicalFeature>) => (naming) =>
			Effect.sync(() => {
				const artifacts = succeeded(
					compiledOf(canonicalSchemaOf(naming)),
					"every schema of the box compiles"
				)
				const checked = artifacts.laws.checked
				const stored = Arr.filter(
					[...checked.canonical.values()],
					(r) => r.holding.kind === "stored"
				)
				assert.equal(
					stored.length,
					1,
					"one stored canonical relation, however many name or import it"
				)
				const [only] = stored
				if (only?.holding.kind !== "stored") {
					return assert.fail("one stored canonical relation")
				}
				assert.equal(
					only.holding.analysis.ident,
					identifierOf(identity.view(only.digest)),
					"its table is named by its form"
				)
				assert.equal(
					checked.holdings.get(linkedName)?.kind,
					"live",
					"the relation that reads it across documents is live"
				)
				switch (naming) {
					case "none":
						assert.ok(
							only.subject.name !== joinedName && checked.holdings.get(joinedName) === undefined,
							"an anonymous canonical relation takes its canonical name"
						)
						break
					case "same":
					case "alpha":
						assert.equal(only.subject.name, joinedName, "a named one takes the name")
						assert.ok(checked.canonicalOf(joinedName) === only, "the named relation is its alias")
						break
				}
				assert.deepEqual(
					Arr.sort(readsOf(artifacts, linkedRead(), new Set()), Order.String),
					Arr.sort(["Link", only.subject.name], Order.String),
					"the live relation's read reads the stored table in the join's place"
				)
				assert.deepEqual(
					Arr.sort(readsOf(artifacts, linkedRead(), new Set(["Doc"])), Order.String),
					["Doc", "Link", "Note"],
					"a write of a relation the join reads reads the join's definition, never its table"
				)
				c.note(`named ${naming}`)
			}),
		oracle: {
			kind: "specification",
			name: "analysis/derived/canonical.ts: a canonical relation per alpha-equivalent form, its table named by its digest, a named relation its alias, read in its form's place by ir/derived.ts servedDag where its table serves"
		},
		box: "a Document-local join imported by a live relation across documents, beside no named relation, one naming the very query, or one naming it spelled anew",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/derived.ts",
				original:
					"\t\treturn form !== undefined && rows.serves(form.relation) ? form : undefined\n",
				replacement: "\t\treturn undefined\n",
				why: "A stored form read where it stands, never from its table: the live relation's read derives the join again at every call."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: "\t\t\t\tident: identifierOf(identity.view(digest)),\n",
				replacement: "\t\t\t\tident: identifierOf(identity.view(named?.name ?? digest)),\n",
				why: "A table named by its relation's name, not its form: a renamed relation is a new table and its definition's change keeps the old one."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: "\t\t\t\tname: named?.name ?? canonicalName(digest),\n",
				replacement: "\t\t\t\tname: canonicalName(digest),\n",
				why: "A named relation's canonical relation under its digest's name, so the relation and its alias are two names of no one relation."
			}
		]
	})
