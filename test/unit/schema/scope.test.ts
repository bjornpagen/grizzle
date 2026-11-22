/**
 * scopedEntriesOf derives each scope along declared containments (schema/scope.ts deriveScopes), over drawn schemas
 * of two to four relations, keys of one or two fields, containments into keys from a relation's own key or from a field
 * of its own, and roots stated by a field (scope.fixtures.ts). Where it admits the schema: every root is a root by its
 * field; every relation a containment chain leads from to a root is scoped, by a scope in its shortest form, and every
 * other whole; a role holding the entries holds each scope as role(...) parses it back from its Description; and on
 * lawful databases of the schema, each scoped row is the owner's by its scope exactly where the model reads it the
 * owner's along any containment, and along every one. Where a relation's containments reach scoped keys in two forms,
 * it is ScopeRefused ambiguous.
 *
 * Oracle: the specification, ownership read along the schema's declared containments over lawful databases
 * (scope.fixtures.ts modelMember), and the scoped relations' closure (scopedModel).
 *
 * Features: a root, a reached scope, a chain held in its shortest form, a relation kept whole, an ambiguous relation
 * refused.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec, Result } from "effect"
import { CompileError } from "#compiler/core/errors.ts"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { role, scopedEntriesOf } from "#compiler/public/schema.ts"
import {
	built,
	modelMember,
	relationName,
	rowText,
	type ScopeCase,
	scopeCaseGen,
	type ScopeFeature,
	scopedModel,
	scopeMember,
	Session,
	shortest
} from "#test/unit/schema/scope.fixtures.ts"

/** scopedEntriesOf scopes exactly the relations a declared containment chain leads from to a root, each by one form. */
export const scopedEntriesOfScopesExactlyTheRelationsAContainmentChainLeadsFromToARootEachByOneForm =
	property.explore(scopeCaseGen, {
		needs: {},
		situations: [
			"a root",
			"a reached scope",
			"a chain held in its shortest form",
			"a relation kept whole",
			"an ambiguous relation refused"
		] satisfies ReadonlyArray<Reached<ScopeFeature>>,
		check: (_, cx: Case<ScopeFeature>) => (c: ScopeCase) =>
			Effect.sync(() => {
				const { schema, owner } = built(c.shape)
				const roots = Rec.fromEntries(
					Arr.map(c.shape.roots, (i) => [relationName(i), "person"] as const)
				)
				const entries = Result.try({
					try: () => scopedEntriesOf(schema, { owner, roots }),
					catch: (e) => e
				})
				if (Result.isFailure(entries)) {
					const e = entries.failure
					assert.ok(
						e instanceof CompileError &&
							e.reason._tag === "ScopeRefused" &&
							e.reason.rule.kind === "ambiguous",
						`the derivation refuses only an ambiguous relation: ${String(e)}`
					)
					cx.note("an ambiguous relation refused")
					return
				}
				const student = role(schema, "student", entries.success, { contexts: [Session] })
				const parsed = parseSchemaInput(student)
				assert.ok(parsed.ok && parsed.value.kind === "role", "the role parses")
				const scoped = parsed.value.level.scoped
				const expectedScoped = scopedModel(c.shape)
				for (const [i] of c.shape.keys.entries()) {
					const name = relationName(i)
					const scope = scoped.get(name)
					assert.equal(
						scope !== undefined,
						expectedScoped.has(i),
						`${name} is scoped exactly where a containment chain leads from it to a root`
					)
					if (scope === undefined) {
						cx.note("a relation kept whole")
						continue
					}
					if (Arr.contains(c.shape.roots, i)) {
						assert.ok(
							scope.kind === "root" && scope.field === "person",
							`${name} is a root by its person`
						)
						cx.note("a root")
					}
					if (scope.kind === "reached") {
						cx.note("a reached scope")
						if (scope.parent.kind === "reached") {
							cx.note("a chain held in its shortest form")
						}
					}
					assert.ok(shortest(scope), `${name}'s scope is in its shortest form`)
					for (const db of c.databases) {
						for (const row of defined(db[i], `${name}'s rows`)) {
							const byScope = scopeMember(scope, db, row)
							assert.ok(
								modelMember(c.shape, db, "exists", i, row) === byScope,
								`${name}'s row ${rowText(row)}: its scope and ownership along any containment`
							)
							assert.ok(
								modelMember(c.shape, db, "every", i, row) === byScope,
								`${name}'s row ${rowText(row)}: its scope and ownership along every containment`
							)
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "ownership read along the schema's declared containments over lawful databases"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/scope.ts",
				original: "\t\tif (second !== undefined) {",
				replacement: "\t\tif (second !== undefined && first === undefined) {",
				why: "A relation whose containments reach scoped keys in two forms is scoped by the first; on a database where its two reached rows are different owners', the scope and ownership along every containment differ."
			},
			{
				file: "packages/engine/src/schema/scope.ts",
				original:
					'\t\t\treturn field === undefined\n\t\t\t\t? { kind: "reached", reach, parent: target }\n\t\t\t\t: { kind: "root", field }',
				replacement: '\t\t\treturn { kind: "reached", reach, parent: target }',
				why: "A reach into a root's key that holds the root's field stays a reach where it is a root of its own field; the scope is not in its shortest form, and a stratum writing both would read the root."
			}
		]
	})
