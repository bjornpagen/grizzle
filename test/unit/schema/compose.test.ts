/**
 * Composing relations into a schema (schema/schema.ts): relations are a list, so concatenating two libraries' lists
 * drops nothing, and the build holds every name to one meaning: within a level, against every level below, and for
 * every relation a statement was built over. Ownership then holds each level to the levels below it (schema/own.ts
 * #checkLevels, README "A level reaches the levels below it only where their writes need nothing of it"): a statement
 * that changes how a lower level's relation is written, such as `mutable`, is LevelRefused.
 *
 * Oracle: a model of the declarations by name, variant and level, written apart from the builder. A drawn composition is
 * levels of lists over a pool of relations of a few drawn names, each name in two variants (another heading), each
 * relation the pool's own value or a copy built again; each level states `mutable` over relations, each a pool relation
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
 *
 * Plants (~/.cache/grizzle-release/CLASH/plants): last-wins (a later declaration of a name replaces the earlier),
 * name-only (any repeat of a name refused, identical ones too), value-identity (declarations compared as values, not
 * by meaning), no-lower-levels (an extension compares its list with itself alone), one-location (the refusal's earlier
 * location is the later declaration's), statements-unchecked (no statement's relations held to the declarations).
 * (~/.cache/grizzle-release/COMPOSEORACLE/plants): reach-admitted (ownership's level rule removed, so a statement over
 * a lower level's relation is admitted), relisted-level (a relation's level the last level that lists it), restated-reach
 * (a statement held at every level that states it).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	type Weighted,
	weighted
} from "@grizzle/testing/gen"
import { agree, exact, set, structuralHash } from "@grizzle/testing/oracle"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex as arkregex } from "arkregex"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { natural, uuid } from "#compiler/public/fields.ts"
import { relation, relationDescOf } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import { mutableBuilder, statementDescOf } from "#compiler/schema/statements.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { assert, defined, placeOf, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownInput } from "#test/support/policy.ts"

/** A relation of the pool, by the index of its name and its variant, the pool's own value or a copy built again. */
interface Drawn {
	readonly name: number
	readonly variant: 0 | 1
	readonly copy: boolean
}

/** A level of a drawn composition: the relations its list holds, and the relations it states mutable. */
interface Level {
	readonly listed: ReadonlyArray<Drawn>
	readonly stated: ReadonlyArray<Drawn>
}

const wordGen = matching(arkregex("^[A-Z][a-z]{1,7}$"))

const drawnGen = (names: number) =>
	drawn((source) => ({
		name: source.draw(int(0, names - 1)),
		variant: source.draw(
			weighted<0 | 1>([
				[3, () => 0],
				[1, () => 1]
			])
		),
		copy: source.draw(boolean)
	}))

/** One of `relations` again, its name and variant, the pool's own value or a copy built again; no option where none. */
const againOf = (relations: ReadonlyArray<Drawn>): ReadonlyArray<Weighted<Drawn>> =>
	Arr.isReadonlyArrayNonEmpty(relations)
		? [[1, (source) => ({ ...source.draw(element(relations)), copy: source.draw(boolean) })]]
		: []

/**
 * The relation a level states mutable: a pool relation, whose name no level need declare, or one its own list holds,
 * one a lower level's list holds, or one a lower level states, each an option only where some level gives one.
 */
const statedGen = (
	pool: Gen<Drawn>,
	listed: ReadonlyArray<Drawn>,
	below: ReadonlyArray<Level>
): Gen<Drawn> =>
	weighted<Drawn>([
		[1, pool],
		...againOf(listed),
		...againOf(Arr.flatMap(below, (level) => level.listed)),
		...againOf(Arr.flatMap(below, (level) => level.stated))
	])

/** A relation of the name `name` in the variant `variant`: an id, and in the second variant a count beside it. */
const relationOf = (name: string, variant: 0 | 1): AnyRelation =>
	variant === 0
		? relation(name, { id: uuid }, ["id"], [])
		: relation(name, { id: uuid, n: natural }, ["id"], [])

/**
 * A statement of a composition that builds, as the model holds it: the name of the relation it is over, the level
 * stating it, the level that first declares the relation, whether the stating level's own list holds the relation, and
 * the statement.
 */
interface Written {
	readonly name: string
	readonly level: number
	readonly declared: number
	readonly relisted: boolean
	readonly statement: Statement
}

/** What the model predicts of a composition. */
type Predicted =
	| {
			readonly kind: "admitted"
			readonly names: ReadonlyArray<string>
			readonly first: ReadonlyArray<unknown>
	  }
	| { readonly kind: "clash"; readonly later: unknown; readonly earlier: unknown }
	| { readonly kind: "undeclared"; readonly level: number }
	| { readonly kind: "reach"; readonly written: Written }

/** The reason a composition's build, or its ownership, refused; none where it succeeded. */
const refusedReason = (
	result: Result.Result<unknown, CompileError>
): CompileError["reason"] | undefined => (result.ok ? undefined : result.error.reason)

/** A declaration the model holds: its variant, the value first declared under its name, and the level declaring it. */
interface Held {
	readonly variant: 0 | 1
	readonly value: unknown
	readonly level: number
}

/** The situations the search must reach. */
type Feature =
	| "admitted"
	| "a clash within a level"
	| "a clash across levels"
	| "a clash through a statement"
	| "a statement over an undeclared name"
	| "one value listed twice"
	| "a copy beside its original"
	| "a level declaring a lower relation again"
	| "a statement over a lower level's relation"
	| "a statement over a lower relation its own level lists again"
	| "a statement at an extension over its own level's relation"
	| "a lower level's statement stated again above"

/** A built composition owned, as a compilation's entry point owns it. */
const ownedOf = (top: AnySchema | undefined) => Result.flatMap(parseSchemaInput(top), ownInput)

describe("composing relations into a schema", () => {
	it.effect(
		"refuses two declarations of one name differing, at the later with the earlier's location, refuses a statement changing a lower level's writes, and admits one meaning as one declaration",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "a model of the declarations by name, variant and level"
						},
						suite: "unit/schema/compose",
						draw: drawn((source) => {
							const names = Arr.dedupe(source.draw(array(wordGen, { min: 1, max: 3 })))
							const levelNames = Arr.map(
								source.draw(array(wordGen, { min: 1, max: 3 })),
								(w, i) => `${w}${i}`
							)
							const item = drawnGen(names.length).generator
							const levels = Arr.reduce(levelNames, Arr.empty<Level>(), (below): Array<Level> => {
								const listed = source.draw(array(item, { min: 0, max: 4 }))
								const stated = source.draw(
									array(statedGen(item, listed, below), { min: 0, max: 2 })
								)
								return [...below, { listed, stated }]
							})
							return { names, levelNames, levels }
						}),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
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
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.gen(function* () {
							const originals = Arr.map(
								s.names,
								(name) => [relationOf(name, 0), relationOf(name, 1)] as const
							)
							const nameOf = (d: Drawn): string => Arr.getUnsafe(s.names, d.name)
							const valueOf = (d: Drawn): AnyRelation =>
								d.copy
									? relationOf(nameOf(d), d.variant)
									: Arr.getUnsafe(originals, d.name)[d.variant]
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
												prior.value === value
													? "one value listed twice"
													: "a copy beside its original"
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
												? schema(name, list, statements, [])
												: schema.extend(below, name, list, statements, [])
									}
									return below
								})
							const lists = Arr.map(built, (level) => Arr.map(level.listed, ({ value }) => value))
							const result = compose(lists)
							const locOf = (value: unknown): SourceLoc =>
								relationDescOf(value, "a pool relation").loc
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
									assert.equal(
										reason.at,
										locOf(predicted.later),
										"refused at the later declaration"
									)
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
											at: placeOf(
												defined(statementDescOf(written.statement), "a built statement").loc
											)
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
						})
				)
			)
	)
})
