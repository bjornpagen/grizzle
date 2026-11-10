import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import type { CompileError, EncodingFailure } from "#compiler/core/errors.ts"
import type { UnservedMember } from "#compiler/served/unserved.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import { buildInstall } from "#test/support/worlds/execute/build.ts"
import {
	offlineCompile,
	offlineServedBind,
	parsedChange
} from "#test/support/worlds/execute/offline.ts"
import { plannedWrite, type WritingRole } from "#test/support/worlds/execute/session.ts"
import { knownNonEmpty, pooled } from "#test/support/worlds/generate/domain.ts"
import { compileRefused, opFault } from "#test/support/worlds/model/session/apply.ts"
import { relationSpecOf } from "#test/support/worlds/model/session/state.ts"
import {
	refusedAtBuild,
	serialHead,
	type Written,
	writtenNamed
} from "#test/support/worlds/model/session/writes.ts"
import type {
	BaseSpec,
	Comparison,
	EntryOp,
	EntrySpec,
	FieldSpec,
	HostFact,
	InstallSpec,
	RelationSpec,
	Rule,
	Term
} from "#test/support/worlds/model/types.ts"

/**
 * The write front end over its small box, every point of it (README "Writes", "Writing through a role"): a relation of
 * one to three fields, each serial or not and in the key or not (the key never empty); written whole, or through a
 * query entry of one rule over it, each field carried in the head, carried and read by a comparison of the filter (a
 * serial field), fixed by a literal, or unnamed, the head never empty. Every point is built as an application builds
 * it and compiled as db.apply compiles an insert through it, then bound with every list of up to two facts drawn from
 * the entry's fact kinds: complete, generated (every classed serial field left out), partial (some and not all) and
 * filtered (a serial field the filter reads left out).
 *
 * The worlds model is the oracle, each verdict its own: grizzle refuses to build the role exactly where refusedAtBuild
 * does; a built role's insert compiles exactly where compileRefused admits it, so a compile refusal over a write the
 * model admits fails here, whatever its kind; and an input is refused at its encoder exactly where the model's opFault
 * is an encoding fault. Inside the box these are theorems: an entry whose every carried field is serial, with its
 * generated facts of no field, is a point of it, written whole or through an entry.
 */
type Use = "carried" | "read" | "fixed" | "unnamed"

interface BoxField {
	readonly serial: boolean
	readonly key: boolean
}

type BoxEntry =
	| { readonly kind: "whole" }
	| { readonly kind: "query"; readonly uses: Arr.NonEmptyReadonlyArray<Use> }

interface BoxPoint {
	readonly fields: Arr.NonEmptyReadonlyArray<BoxField>
	readonly entry: BoxEntry
}

type BoxFeature =
	| "refused at build"
	| "compiled whole"
	| "compiled entry"
	| "every carried field serial, whole"
	| "every carried field serial, entry"
	| "a serial field the filter reads"
	| "facts refused at their shape"
	| "generated facts bound"

/** The uses of a field that leave it out of the head. */
const uncarried: ReadonlyArray<Use> = ["fixed", "unnamed"]

/**
 * A point of the box. The key is the fields marked keyed, the first marked whenever no other is, and the last field of
 * an entry whose earlier fields carry none is carried: each relation and entry the box holds is drawn once.
 */
const pointGen: Gen<BoxPoint> = (source) => {
	const count = source.draw(int(1, 3))
	const serials: Array<boolean> = []
	for (let i = 0; i < count; i += 1) {
		serials.push(source.draw(boolean))
	}
	const restKeys: Array<boolean> = []
	for (let i = 1; i < count; i += 1) {
		restKeys.push(source.draw(boolean))
	}
	const firstKey = Arr.some(restKeys, (k) => k) ? source.draw(boolean) : true
	const keys = [firstKey, ...restKeys]
	const fields = knownNonEmpty(
		Arr.zipWith(serials, keys, (serial, key): BoxField => ({ serial, key })),
		"the box's fields"
	)
	if (source.draw(boolean)) {
		return { fields, entry: { kind: "whole" } }
	}
	const uses: Array<Use> = []
	for (const [i, f] of fields.entries()) {
		const carrying: Arr.NonEmptyReadonlyArray<Use> = f.serial ? ["carried", "read"] : ["carried"]
		const carried = Arr.some(uses, (u) => u === "carried" || u === "read")
		uses.push(
			source.draw(
				element(i < fields.length - 1 || carried ? Arr.appendAll(carrying, uncarried) : carrying)
			)
		)
	}
	return { fields, entry: { kind: "query", uses: knownNonEmpty(uses, "the entry's uses") } }
}

const relationOf = (point: BoxPoint): RelationSpec => {
	const fields = Arr.map(point.fields, (f, i): FieldSpec => ({
		name: `f${i}`,
		domain: f.serial ? { kind: "serial", bits: 64 } : { kind: "integer", bits: 32 }
	}))
	return {
		name: "Cell",
		fields,
		key: knownNonEmpty(
			Arr.flatMap(fields, (f, i) => (point.fields[i]?.key === true ? [f.name] : [])),
			"the box's key"
		),
		mutability: "immutable"
	}
}

/** A literal of a field's domain, the first of its pool. */
const literalOf = (f: FieldSpec): Term => ({ kind: "literal", value: pooled(f.domain, 0) })

/** The entry's one rule over the relation: each field's term by its use, the head its carried fields under their names. */
const ruleOf = (relation: RelationSpec, uses: Arr.NonEmptyReadonlyArray<Use>): Rule => {
	const used = Arr.zip(relation.fields, uses)
	const variable = (f: FieldSpec): Term => ({ kind: "var", name: `x_${f.name}` })
	const carried = Arr.filter(used, ([, use]) => use === "carried" || use === "read")
	return {
		matches: [
			{
				source: { kind: "ordinary", name: relation.name },
				fields: Rec.fromEntries(
					Arr.flatMap(used, ([f, use]): ReadonlyArray<readonly [string, Term]> => {
						switch (use) {
							case "carried":
							case "read":
								return [[f.name, variable(f)]]
							case "fixed":
								return [[f.name, literalOf(f)]]
							case "unnamed":
								return []
						}
					})
				)
			}
		],
		negations: [],
		comparisons: Arr.flatMap(used, ([f, use]): ReadonlyArray<Comparison> =>
			use === "read" ? [{ left: variable(f), op: ">=", right: literalOf(f) }] : []
		),
		head: Rec.fromEntries(Arr.map(carried, ([f]) => [f.name, variable(f)] as const))
	}
}

/** The installation of a point: one role writing the relation through its one entry, in one login. */
const installOf = (point: BoxPoint): { readonly install: InstallSpec; readonly entry: string } => {
	const relation = relationOf(point)
	const base: BaseSpec = {
		name: "Box",
		closed: [],
		relations: [relation],
		laws: [],
		contexts: [],
		derived: []
	}
	const [entry, spec]: readonly [string, EntrySpec] =
		point.entry.kind === "whole"
			? [relation.name, { kind: "whole", relation: relation.name }]
			: ["View0", { kind: "query", rules: [ruleOf(relation, point.entry.uses)] }]
	return {
		install: {
			base,
			roles: [{ name: "alpha", entries: { [entry]: spec }, write: [entry], refresh: [] }],
			logins: [{ name: "web", roles: ["alpha"] }]
		},
		entry
	}
}

/** A fact without some of its fields. */
const without = (fact: HostFact, fields: ReadonlyArray<string>): HostFact =>
	Rec.filter(fact, (_, field) => !fields.includes(field))

/**
 * The facts an insert through a written relation tries: complete, each carried field at the first value of its pool;
 * generated, leaving out every classed serial field; partial, leaving out the first of two or more classed ones; and
 * filtered, leaving out the first serial field the filter reads. A kind the relation's fields do not offer is not tried.
 */
const factKinds = (base: BaseSpec, w: Written): Arr.NonEmptyReadonlyArray<HostFact> => {
	const fields = defined(relationSpecOf(base, w.target), `the relation ${w.target}`).fields
	const domainOf = (field: string): FieldSpec["domain"] =>
		defined(
			Option.getOrUndefined(Arr.findFirst(fields, (f) => f.name === field)),
			`the field ${field}`
		).domain
	const carried =
		w.kind === "whole"
			? Arr.map(fields, (f) => [f.name, f.name] as const)
			: Arr.map(Rec.toEntries(w.head), ([head, h]) => [head, h.field] as const)
	const complete: HostFact = Rec.fromEntries(
		Arr.map(carried, ([head, field]) => [head, pooled(domainOf(field), 0)] as const)
	)
	const { classed, filtered } = serialHead(base, w)
	const [firstClassed, ...moreClassed] = classed
	const [firstFiltered] = filtered
	return [
		complete,
		...(firstClassed === undefined ? [] : [without(complete, classed)]),
		...(firstClassed === undefined || moreClassed.length === 0
			? []
			: [without(complete, [firstClassed])]),
		...(firstFiltered === undefined ? [] : [without(complete, [firstFiltered])])
	]
}

/** Whether a refusal of a write's inputs before any SQL is an encoder's. */
const atEncoder = (
	refusal: EncodingFailure | "ResourceBound" | CompileError | UnservedMember
): boolean => refusal !== "ResourceBound" && refusal._tag === "EncodingFailure"

/** Every list of up to two of the facts, each pair once in either order. */
const factLists = (
	facts: Arr.NonEmptyReadonlyArray<HostFact>
): ReadonlyArray<ReadonlyArray<HostFact>> => [
	[],
	...Arr.map(facts, (f) => [f]),
	...Arr.flatMap(facts, (f, i) => Arr.map(facts.slice(i), (g) => [f, g]))
]

describe("the write front end over its small box", () => {
	it.effect(
		"builds, compiles and binds every insert of the box exactly where the worlds model says",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/write/entry-box",
						generator: pointGen,
						literal: Formatter.format,
						limit: 2125,
						coverage: requiredInSpace<BoxFeature>([
							"refused at build",
							"compiled whole",
							"compiled entry",
							"every carried field serial, whole",
							"every carried field serial, entry",
							"a serial field the filter reads",
							"facts refused at their shape",
							"generated facts bound"
						]),
						caseHang
					},
					(point, c) =>
						Effect.gen(function* () {
							const { install, entry } = installOf(point)
							const base = install.base
							const built = yield* Effect.result(buildInstall(install, base.name))
							const refused = refusedAtBuild(install)
							if (Result.isFailure(built)) {
								assert.ok(
									refused,
									`grizzle refuses to build a role the model builds: ${messageOf(built.failure.refusal)}`
								)
								c.note("refused at build")
								return
							}
							assert.ok(!refused, "grizzle builds a role the model refuses to build")
							const [role] = install.roles
							const written = defined(writtenNamed(base, role, entry), `the written entry ${entry}`)
							const writer: WritingRole = {
								role,
								value: defined(built.success.roles[role.name], "the role as built")
							}
							const insert = (facts: ReadonlyArray<HostFact>): EntryOp => ({
								relation: entry,
								kind: "insert",
								facts
							})
							const changeOf = (facts: ReadonlyArray<HostFact>) =>
								Effect.flatMap(plannedWrite(base, writer, [[insert(facts)]], []), (write) =>
									Result.isFailure(write)
										? Effect.die(
												new Error(
													`the builder refuses an insert of facts: ${messageOf(write.failure)}`
												)
											)
										: Effect.succeed({
												change: parsedChange(write.success.changes),
												facts: write.success.facts
											})
								)
							const { change } = yield* changeOf([])
							const compiled = offlineCompile(writer.value, change, new Set())
							assert.ok(
								!compileRefused(base, role, [[insert([])]], []),
								"the model refuses an insert through the role's one written entry"
							)
							if (!compiled.ok) {
								return assert.fail(
									`the model admits the insert, and grizzle refuses it when it compiles: ${messageOf(compiled.error)}`
								)
							}
							const { classed, filtered } = serialHead(base, written)
							const carried =
								written.kind === "whole"
									? Arr.map(
											defined(relationSpecOf(base, written.target), "the written relation").fields,
											(f) => f.name
										)
									: Rec.keys(written.head)
							c.note(written.kind === "whole" ? "compiled whole" : "compiled entry")
							if (Arr.every(carried, (f) => classed.includes(f))) {
								c.note(
									written.kind === "whole"
										? "every carried field serial, whole"
										: "every carried field serial, entry"
								)
							}
							if (filtered.length > 0) {
								c.note("a serial field the filter reads")
							}
							for (const facts of factLists(factKinds(base, written))) {
								const predicted = opFault(base, written, insert(facts))?.kind === "encoding"
								const call = yield* changeOf(facts)
								const bound = offlineServedBind(compiled.value, call.change, call.facts)
								const refusal = bound.ok ? undefined : bound.error
								if (refusal !== undefined && !atEncoder(refusal)) {
									return assert.fail(
										`binding ${Formatter.format(facts)} is refused before any SQL, not at its encoder: ${messageOf(refusal)}`
									)
								}
								const encoding = refusal !== undefined
								assert.equal(
									encoding,
									predicted,
									`binding ${Formatter.format(facts)}: the model ${predicted ? "refuses" : "admits"} it at its encoder`
								)
								if (encoding) {
									c.note("facts refused at their shape")
								} else if (Arr.some(facts, (f) => Arr.some(classed, (s) => f[s] === undefined))) {
									c.note("generated facts bound")
								}
							}
						})
				)
			)
	)
})
