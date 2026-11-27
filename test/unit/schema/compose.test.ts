/**
 * Composing relations into a schema (schema/schema.ts): relations are a list, so concatenating two libraries' lists
 * drops nothing, and the build holds every name to one meaning: within a level, against every level below, and for
 * every relation a statement was built over. Ownership then holds each level to the levels below it (schema/own.ts
 * #checkLevels, README "A level reaches the levels below it only where their writes need nothing of it"): a statement
 * that changes how a lower level's relation is written, such as `mutable`, is LevelRefused.
 *
 * Oracle: a model of the declarations by name, variant and level, written apart from the builder. A drawn composition is
 * levels of lists over a pool of relations of a few drawn names, each name in two variants (another heading), each
 * relation the pool's own value or a copy built again, every one keyed by its id, under the unit of its id the root
 * states (compose.fixtures.ts entity); each level states `mutable` over relations, each a pool relation
 * (some listed nowhere), one its own list holds, one a lower level's list holds, or one a lower level states. The model
 * walks the levels in order and predicts the build's first refusal, DuplicateIdentity at the later declaration with the
 * earlier's location, or a statement over a name no level declares. Over a composition that builds, it walks the
 * statements, each one statement however many levels state it, held at the lowest that does (own.ts
 * #collectStatements), and predicts the first that reaches below: one over a relation first declared at a level below
 * its own, LevelRefused at it, naming the relation, the statement's level and the relation's. A statement over a
 * relation its own level first declares, or one a lower level already states, changes no lower level's writes, so the
 * rest is the admitted schema: its record's names in first-declared order, each the value first declared under it, and
 * its fingerprint, which the composition's lists with every repeat removed, or each level's list reversed, own to as well.
 *
 * Features: as the search names them. The generator draws a statement over a relation its own level lists, one a lower
 * level lists and one a lower level states, so both sides of the level rule are drawn by construction.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { agree, exact, set, structuralHash } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { relationDescOf } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { mutableBuilder, statementDescOf } from "#compiler/schema/statements.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { placeOf, succeeded } from "#test/support/assert.ts"
import {
	type Drawn,
	drawnGen,
	entity,
	type Feature,
	type Held,
	type Level,
	levelNamesGen,
	ownedOf,
	type Predicted,
	refusedReason,
	relationOf,
	statedGen,
	wordGen,
	type Written
} from "#test/unit/schema/compose.fixtures.ts"

/** Composing relations into a schema refuses two declarations of one name differing, at the later with the earlier's location, refuses a statement changing a lower level's writes, and admits one meaning as one declaration. Its budget is its suite's before it was a property (test/unit/schema/compose.test.ts at 4ca3036a): 600 runs and 600 steered cases. */
export const composingRelationsIntoASchemaRefusesTwoDeclarationsOfOneNameDifferingAtTheLaterWithTheEarliersLocationRefusesAStatementChangingALowerLevelsWritesAndAdmitsOneMeaningAsOneDeclaration =
	property.explore(
		(source) => {
			const names = Arr.dedupe(source.draw(array(wordGen, { min: 1, max: 3 })))
			const levelNames = source.draw(levelNamesGen)
			const item = drawnGen(names.length)
			const levels = Arr.reduce(levelNames, Arr.empty<Level>(), (below): Array<Level> => {
				const listed = source.draw(array(item, { min: 0, max: 4 }))
				const stated = source.draw(array(statedGen(item, listed, below), { min: 0, max: 2 }))
				return [...below, { listed, stated }]
			})
			return { names, levelNames, levels }
		},
		{
			needs: {},
			budget: { runs: 600, steered: 600 },
			situations: [
				"admitted",
				"a clash within a level",
				"a clash across levels",
				"a clash through a statement",
				"a statement over an undeclared name",
				"one value listed twice",
				"a copy beside its original",
				"a level declaring a lower relation again",
				"a statement over a lower level's relation",
				"a statement over a lower relation its own level lists again",
				"a statement at an extension over its own level's relation",
				"a lower level's statement stated again above"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check: (_, c: Case<Feature>) => (s) =>
				Effect.gen(function* () {
					const originals = Arr.map(
						s.names,
						(name) => [relationOf(name, 0), relationOf(name, 1)] as const
					)
					const nameOf = (d: Drawn): string => Arr.getUnsafe(s.names, d.name)
					const valueOf = (d: Drawn): AnyRelation =>
						d.copy ? relationOf(nameOf(d), d.variant) : Arr.getUnsafe(originals, d.name)[d.variant]
					const built = Arr.map(s.levels, (level) => ({
						listed: Arr.map(level.listed, (d) => ({ d, value: valueOf(d) })),
						stated: Arr.map(level.stated, (d) => {
							const value = valueOf(d)
							return { d, value, statement: mutableBuilder(value) }
						})
					}))
					const predicted = ((): Predicted => {
						const held = new Map<string, Held>()
						const order: Array<string> = []
						const written: Array<Written> = []
						for (const [index, level] of built.entries()) {
							const own = new Set<string>()
							for (const { d, value } of level.listed) {
								const name = nameOf(d)
								const prior = held.get(name)
								if (prior !== undefined && prior.variant !== d.variant) {
									c.note(own.has(name) ? "a clash within a level" : "a clash across levels")
									return { kind: "clash", later: value, earlier: prior.value }
								}
								if (prior !== undefined && own.has(name)) {
									c.note(
										prior.value === value ? "one value listed twice" : "a copy beside its original"
									)
								} else if (prior !== undefined) {
									c.note("a level declaring a lower relation again")
								}
								if (prior === undefined) {
									held.set(name, { variant: d.variant, value, level: index })
									order.push(name)
								}
								own.add(name)
							}
							for (const { d, value, statement } of level.stated) {
								const name = nameOf(d)
								const prior = held.get(name)
								if (prior === undefined) {
									c.note("a statement over an undeclared name")
									return { kind: "undeclared", level: index }
								}
								if (prior.variant !== d.variant) {
									c.note("a clash through a statement")
									return { kind: "clash", later: value, earlier: prior.value }
								}
								written.push({
									name,
									level: index,
									declared: prior.level,
									relisted: own.has(name),
									statement
								})
							}
						}
						const kept = new Map<string, Written>()
						const sides = new Set<Feature>()
						for (const w of written) {
							const first = kept.get(w.name)
							if (first !== undefined) {
								if (w.level > first.level) {
									sides.add("a lower level's statement stated again above")
								}
								continue
							}
							kept.set(w.name, w)
							if (w.declared < w.level) {
								c.note("a statement over a lower level's relation")
								if (w.relisted) {
									c.note("a statement over a lower relation its own level lists again")
								}
								return { kind: "reach", written: w }
							}
							if (w.level > 0) {
								sides.add("a statement at an extension over its own level's relation")
							}
						}
						c.noteAll(sides)
						c.note("admitted")
						return {
							kind: "admitted",
							names: order,
							first: Arr.map(order, (name) => held.get(name)?.value)
						}
					})()
					const compose = (
						lists: ReadonlyArray<ReadonlyArray<AnyRelation>>
					): Result.Result<AnySchema | undefined, CompileError> =>
						catchCompileError(() => {
							let below: AnySchema | undefined
							for (const [index, [list, level]] of Arr.zip(lists, built).entries()) {
								const statements = Arr.map(level.stated, ({ statement }) => statement)
								const name = Arr.getUnsafe(s.levelNames, index)
								below =
									below === undefined
										? schema(name, list, [entity, ...statements], [])
										: schema.extend([below], name, list, statements, [])
							}
							return below
						})
					const lists = Arr.map(built, (level) => Arr.map(level.listed, ({ value }) => value))
					const result = compose(lists)
					const locOf = (value: unknown): SourceLoc => relationDescOf(value, "a pool relation").loc
					switch (predicted.kind) {
						case "clash": {
							const reason = refusedReason(result)
							assert.equal(
								reason?._tag,
								"DuplicateIdentity",
								"a clash is refused when the schema is built"
							)
							if (reason?._tag !== "DuplicateIdentity") {
								return
							}
							assert.equal(reason.duplicate.kind, "relation")
							assert.equal(reason.at, locOf(predicted.later), "refused at the later declaration")
							assert.equal(
								reason.duplicate.earlier,
								locOf(predicted.earlier),
								"naming the earlier declaration"
							)
							return
						}
						case "undeclared": {
							const reason = refusedReason(result)
							assert.deepEqual(
								reason?._tag === "Refused" ? reason.refusal : reason?._tag,
								"a statement names a relation no level of the schema declares"
							)
							return
						}
						case "reach": {
							const { written } = predicted
							const reason = refusedReason(Result.flatMap(result, ownedOf))
							assert.equal(
								reason?._tag,
								"LevelRefused",
								"a statement changing a lower level's writes is refused"
							)
							if (reason?._tag !== "LevelRefused") {
								return
							}
							assert.deepEqual(
								{
									relation: reason.relation,
									level: reason.level,
									below: reason.below,
									at: placeOf(reason.at)
								},
								{
									relation: written.name,
									level: Arr.getUnsafe(s.levelNames, written.level),
									below: Arr.getUnsafe(s.levelNames, written.declared),
									at: placeOf(defined(statementDescOf(written.statement), "a built statement").loc)
								},
								"at the statement, naming the relation, its level and the statement's"
							)
							return
						}
						case "admitted": {
							const top = defined(succeeded(result), "a composition of at least one level")
							yield* agree(
								[
									["the model's declared names", [...predicted.names]],
									["the schema's record's names", Rec.keys(top.relations)]
								],
								set(structuralHash, exact)
							)
							for (const [name, value] of Arr.zip(predicted.names, predicted.first)) {
								assert.equal<unknown>(
									top.relations[name],
									value,
									`${name} is its first declaration`
								)
							}
							const fingerprintOf = (value: AnySchema | undefined) =>
								succeeded(ownedOf(value)).fingerprint
							const once = Arr.map(lists, (list) =>
								Arr.filter(list, (value, i) =>
									Arr.every(Arr.take(list, i), (earlier) => {
										const a = relationDescOf(earlier, "a pool relation")
										const b = relationDescOf(value, "a pool relation")
										return a.name !== b.name
									})
								)
							)
							const fingerprint = fingerprintOf(top)
							assert.equal(fingerprintOf(succeeded(compose(once))), fingerprint)
							assert.equal(
								fingerprintOf(succeeded(compose(Arr.map(lists, (list) => Arr.reverse(list))))),
								fingerprint
							)
							return
						}
					}
				}),
			oracle: {
				kind: "second-implementation",
				name: "a model of the declarations by name, variant and level"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/schema.ts",
					original:
						"\tif (prior !== undefined && !sameContent(prior.meaning, d.meaning)) {\n\t\tdeclaredTwice(d, prior)",
					replacement:
						"\tif (prior !== undefined && !sameContent(prior.meaning, d.meaning)) {\n\t\tdeclared.delete(d.meaning.name)",
					why: "A later declaration of a name replaces the earlier (schema/schema.ts declaresFirst)."
				},
				{
					file: "packages/engine/src/schema/schema.ts",
					original: "\tif (prior !== undefined && !sameContent(prior.meaning, d.meaning)) {",
					replacement: "\tif (prior !== undefined) {",
					why: "Any repeat of a name refused, identical ones too."
				},
				{
					file: "packages/engine/src/schema/schema.ts",
					original: "\tif (prior !== undefined && !sameContent(prior.meaning, d.meaning)) {",
					replacement: "\tif (prior !== undefined && prior.value !== d.value) {",
					why: "Declarations compared as values, not by meaning."
				},
				{
					file: "packages/engine/src/schema/schema.ts",
					original:
						"): boolean => {\n\tconst prior = below.get(d.meaning.name) ?? declared.get(d.meaning.name)",
					replacement: "): boolean => {\n\tconst prior = declared.get(d.meaning.name)",
					why: "An extension compares its list with itself alone."
				},
				{
					file: "packages/engine/src/schema/schema.ts",
					original:
						'\t\tduplicate: { kind: "relation", name: later.meaning.name, earlier: earlier.meaning.loc }',
					replacement:
						'\t\tduplicate: { kind: "relation", name: later.meaning.name, earlier: later.meaning.loc }',
					why: "The refusal's earlier location is the later declaration's."
				},
				{
					file: "packages/engine/src/schema/schema.ts",
					original: "\tfor (const s of statements) {",
					replacement: "\tfor (const s of statements.slice(0, 0)) {",
					why: "No statement's relations held to the declarations (schema/schema.ts statementsDeclared)."
				},
				{
					file: "packages/engine/src/schema/own.ts",
					original: "\t\t\tthis.#checkLevels(s)\n",
					replacement: "",
					why: "Ownership's level rule removed, so a statement over a lower level's relation is admitted."
				},
				{
					file: "packages/engine/src/schema/own.ts",
					original:
						'\t\t\t\t\t\tduplicate: { kind: "relation", name: r.name, earlier: prior.desc.loc }\n\t\t\t\t\t})\n\t\t\t\t}',
					replacement:
						'\t\t\t\t\t\tduplicate: { kind: "relation", name: r.name, earlier: prior.desc.loc }\n\t\t\t\t\t})\n\t\t\t\t}\n\t\t\t\tthis.#relations.set(r.name, { desc: r, level })',
					why: "A relation's level the last level that lists it."
				},
				{
					file: "packages/engine/src/schema/own.ts",
					original:
						"\t\tconst at = new Map<string, number>()\n\t\tfor (const [level, statements] of this.#written.entries()) {",
					replacement:
						"\t\tfor (const [level, statements] of this.#written.entries()) {\n\t\t\tconst at = new Map<string, number>()",
					why: "A statement held at every level that states it."
				}
			]
		}
	)
