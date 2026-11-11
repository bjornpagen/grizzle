/**
 * Composing relations into a schema (schema/schema.ts): relations are a list, so concatenating two libraries' lists
 * drops nothing, and the build holds every name to one meaning: within a level, against every level below, and for
 * every relation a statement was built over.
 *
 * Oracle: a model of the declarations by name and variant, written apart from the builder. A drawn composition is
 * levels of lists over a pool of relations of a few drawn names, each name in two variants (another heading), each
 * relation the pool's own value or a copy built again; each level holds statements over the pool's relations, some of
 * them listed nowhere. The model walks the levels in order and predicts the first refusal, DuplicateIdentity at the
 * later declaration with the earlier's location, or a statement over a name no level declares; or the admitted
 * schema: its record's names in first-declared order, each the value first declared under it, and its fingerprint,
 * which the composition's lists with every repeat removed, or each level's list reversed, own to as well.
 *
 * Features: as the search names them.
 *
 * Plants (~/.cache/grizzle-release/CLASH/plants): last-wins (a later declaration of a name replaces the earlier),
 * name-only (any repeat of a name refused, identical ones too), value-identity (declarations compared as values, not
 * by meaning), no-lower-levels (an extension compares its list with itself alone), one-location (the refusal's earlier
 * location is the later declaration's), statements-unchecked (no statement's relations held to the declarations).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, int, weighted } from "@grizzle/testing/gen"
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
import { mutableBuilder } from "#compiler/schema/statements.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownInput } from "#test/support/policy.ts"

/** A relation of the pool, by the index of its name and its variant, the pool's own value or a copy built again. */
interface Drawn {
	readonly name: number
	readonly variant: 0 | 1
	readonly copy: boolean
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

/** A relation of the name `name` in the variant `variant`: an id, and in the second variant a count beside it. */
const relationOf = (name: string, variant: 0 | 1): AnyRelation =>
	variant === 0
		? relation(name, { id: uuid }, ["id"], [])
		: relation(name, { id: uuid, n: natural }, ["id"], [])

/** What the model predicts of a composition. */
type Predicted =
	| {
			readonly kind: "admitted"
			readonly names: ReadonlyArray<string>
			readonly first: ReadonlyArray<unknown>
	  }
	| { readonly kind: "clash"; readonly later: unknown; readonly earlier: unknown }
	| { readonly kind: "undeclared"; readonly level: number }

/** The reason a composition's build refused, none where it built. */
const refusedReason = (
	result: Result.Result<unknown, CompileError>
): CompileError["reason"] | undefined => (result.ok ? undefined : result.error.reason)

/** A declaration the model holds: its variant and the value first declared under its name. */
interface Held {
	readonly variant: 0 | 1
	readonly value: unknown
}

describe("composing relations into a schema", () => {
	it.effect(
		"refuses two declarations of one name differing, at the later with the earlier's location, and admits one meaning as one declaration",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "a model of the declarations by name and variant"
						},
						suite: "unit/schema/compose",
						draw: drawn((source) => {
							const names = Arr.dedupe(source.draw(array(wordGen, { min: 1, max: 3 })))
							const levelNames = Arr.map(
								source.draw(array(wordGen, { min: 1, max: 3 })),
								(w, i) => `${w}${i}`
							)
							const item = drawnGen(names.length).generator
							const levels = Arr.map(levelNames, () => ({
								listed: source.draw(array(item, { min: 0, max: 4 })),
								stated: source.draw(array(item, { min: 0, max: 2 }))
							}))
							return { names, levelNames, levels }
						}),
						literal: Formatter.format,
						coverage: required<
							| "admitted"
							| "a clash within a level"
							| "a clash across levels"
							| "a clash through a statement"
							| "a statement over an undeclared name"
							| "one value listed twice"
							| "a copy beside its original"
							| "a level declaring a lower relation again"
						>(
							[
								"admitted",
								"a clash within a level",
								"a clash across levels",
								"a clash through a statement",
								"a statement over an undeclared name",
								"one value listed twice",
								"a copy beside its original",
								"a level declaring a lower relation again"
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
								stated: Arr.map(level.stated, (d) => ({ d, value: valueOf(d) }))
							}))
							const predicted = ((): Predicted => {
								const held = new Map<string, Held>()
								const order: Array<string> = []
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
											held.set(name, { variant: d.variant, value })
											order.push(name)
										}
										own.add(name)
									}
									for (const { d, value } of level.stated) {
										const prior = held.get(nameOf(d))
										if (prior === undefined) {
											c.note("a statement over an undeclared name")
											return { kind: "undeclared", level: index }
										}
										if (prior.variant !== d.variant) {
											c.note("a clash through a statement")
											return { kind: "clash", later: value, earlier: prior.value }
										}
									}
								}
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
										const statements = Arr.map(level.stated, ({ value }) => mutableBuilder(value))
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
										succeeded(Result.flatMap(parseSchemaInput(value), ownInput)).fingerprint
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
