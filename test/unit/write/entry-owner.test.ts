/**
 * A family's owner written through a query entry, over the entry-owner box (test/support/families/entry-owner.ts): every
 * head the entry may hold of the family's count and end, every filter, stated or reading a family field, every op and
 * every fact, each case's role declared and its write compiled and bound with no PostgreSQL, as db.apply does.
 *
 * The oracle is the box's specification: a role is refused when it is declared exactly when its entry's filter reads a
 * family field, as `filterReadsFamily` naming it; through every other role, an insert and a put of a fact stating the
 * entry's own fields compile and bind, a put being the owner's put in place, which sets the entry's free label alone
 * and never deletes the owner from under its members; a fact stating the count is refused, at bind, as no fact of the
 * entry; and a delete of any fact is refused when it compiles (UnsupportedOperation, at the delete), since a delete of
 * Store removes each store whole with its Items, which no write through a query entry may.
 *
 * Features: refused when declared at each family field; each op of each fact through a declared role; a put of the
 * owner in place.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { CompileError } from "#compiler/core/errors.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { assert, defined, placeOf, refusalLoc, refused } from "#test/support/assert.ts"
import {
	entryName,
	entryOwnerDeclared,
	entryOwnerRefused,
	entryRole,
	familyRead
} from "#test/support/families/entry-owner.ts"
import { offlineBind, offlineCompile, parsedChange } from "#test/support/worlds/execute/offline.ts"
import {
	built,
	caseGen,
	type Feature,
	features,
	id
} from "#test/unit/write/entry-owner.fixtures.ts"

/** A family's owner written through a query entry declares exactly the roles whose entry's filter reads no family field, and compiles and binds through them every insert and put whose fact states no family field, and refuses every delete through them when it compiles. */
export const aFamilysOwnerWrittenThroughAQueryEntryDeclaresExactlyTheRolesWhoseEntrysFilterReadsNoFamilyFieldAndCompilesAndBindsThroughThemEveryInsertAndPutWhoseFactStatesNoFamilyFieldAndRefusesEveryDeleteThroughThemWhenItCompiles =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, run: Case<Feature>) => (c) =>
			Effect.gen(function* () {
				const name = entryName(c.holds, c.filter)
				const declared = Result.try({
					try: () => entryRole(built, c.holds, c.filter),
					catch: (e) => e
				})
				const read = familyRead(c.filter)
				if (!entryOwnerDeclared(c)) {
					assert.ok(Result.isFailure(declared), `${Formatter.format(c)} was declared`)
					const refusal = declared.failure
					assert.ok(refusal instanceof CompileError, `${Formatter.format(c)}: ${String(refusal)}`)
					assert.deepEqual(
						refusal.reason._tag === "RoleRefused" ? refusal.reason.rule : refusal.reason,
						{
							kind: "writeUnwritable",
							entry: name,
							why: { kind: "filterReadsFamily", field: defined(read, "the field read") }
						}
					)
					run.note(`refused when declared: its filter reads ${defined(read, "the field read")}`)
					return
				}
				assert.ok(Result.isSuccess(declared), `${Formatter.format(c)} was refused`)
				const writer = declared.success
				const relation = defined(writer.relations[name], "the role's entry")
				const fact = c.fact === "stated" ? { id, label: "a" } : { id, label: "a", items: 0n }
				const empty = changeSetOver.empty(writer)
				const changes =
					c.op === "insert"
						? empty.insert(relation, [fact])
						: c.op === "put"
							? empty.put(relation, [fact])
							: empty.delete(relation, [fact])
				const parsed = parsedChange(changes)
				const compiled = offlineCompile(writer, parsed, new Set())
				if (c.op === "delete") {
					const refusal = refused(
						compiled,
						"UnsupportedOperation",
						`${Formatter.format(c)}: a whole delete through a query entry`
					)
					assert.deepEqual(
						placeOf(refusalLoc(refusal)),
						placeOf(defined(parsed.desc.strata[0]?.members[0], "the delete").loc),
						`${Formatter.format(c)}: the refusal's place`
					)
					run.note(`delete of ${c.fact} through a declared role, refused when compiled`)
					return
				}
				assert.ok(compiled.ok, `${Formatter.format(c)} was refused when compiled`)
				if (c.op === "put") {
					assert.deepEqual(
						Arr.map(compiled.value.choices, (choice) =>
							choice.target !== "ownerPut" || choice.inPlace === undefined
								? { target: choice.target, set: [] }
								: {
										target: choice.target,
										set: Arr.map(choice.inPlace.payload, (f) => f.name)
									}
						),
						[{ target: "ownerPut", set: ["label"] }],
						`${Formatter.format(c)}: the put's choice`
					)
					run.note("a put of the owner in place")
				}
				const bound = yield* offlineBind(compiled.value, parsed)
				assert.equal(
					!bound.ok,
					entryOwnerRefused(c),
					`${Formatter.format(c)} was ${bound.ok ? "bound" : "refused when bound"}`
				)
				run.note(`${c.op} of ${c.fact} through a declared role`)
			}),
		oracle: {
			kind: "specification",
			name: "the writable-entry rule's family clauses and the entry's written fields (test/support/families/entry-owner.ts)"
		},
		box: "every entry head of the family's count and end, filter, op and fact of the entry-owner box",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/entry.ts",
				original:
					'\t\tif (family(target, field)) {\n\t\t\treturn refused(name, { kind: "filterReadsFamily", field })\n\t\t}\n',
				replacement: "",
				why: "An entry whose filter reads a family field is declared, not refused as filterReadsFamily (schema/entry.ts)."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: `\t\t\tif (unitDelete && entry.kind !== "whole") {\n\t\t\t\trefuse(\n\t\t\t\t\t"UnsupportedOperation",\n\t\t\t\t\tloc,\n\t\t\t\t\t\`a delete of \${relation.name} through the query entry \${entry.entry.entry}: a delete of a tree or a family's owner removes every row nested under it, of relations its role holds whole, so delete \${relation.name} whole\`\n\t\t\t\t)\n\t\t\t}\n`,
				replacement: "",
				why: "The refusal of a whole delete through a query entry is removed (write/frontend/compile.ts `unitDelete`), so a delete of a fact compiles."
			}
		]
	})
