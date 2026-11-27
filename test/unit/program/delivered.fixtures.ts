/** What the properties of delivered.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, deepEquals, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { constant, type Gen, map, oneOf } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Result as Answered, Array as Arr, Formatter, Option, String as Str } from "effect"
import { rowOptions } from "#adapter/engine.ts"
import { readProgram } from "#adapter/reader/run.ts"
import type { AttachmentLayout, BindContext, Layout } from "#compiler/core/decoder.ts"
import { type CompileError, isCompileError } from "#compiler/core/errors.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import { codeNames } from "#compiler/ir/codes.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { toQueryDescription } from "#compiler/ir/describe.ts"
import type { NodeOf } from "#compiler/ir/rel.ts"
import type { DeliveredPart } from "#compiler/lower/shapes/index.ts"
import { queryInput } from "#compiler/program/input.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { StatementTree } from "#compiler/runtime/lower/tree.ts"
import { recordsReader } from "#compiler/runtime/read/record.ts"
import { bindGroups } from "#compiler/schema/record.ts"
import { servedSource } from "#compiler/served/read.ts"
import { servedSpine } from "#compiler/served/spine.ts"
import type { Decoders } from "#compiler/types/query/query.ts"
import { type Place, placeOf, refusalLoc, succeeded } from "#test/support/assert.ts"
import {
	codebookFor,
	compileTemplate,
	firstCodes,
	schemaInputOf,
	testCompile
} from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { queryFromDescription } from "#test/support/describe.ts"
import {
	answerEquivalence,
	answersReport,
	mixedRows,
	mixedShapes,
	type Nested,
	type Shape,
	shapeOf
} from "#test/support/oracle/public/answer.ts"
import {
	buildMixed,
	buildRoot,
	buildSchema,
	type BuiltSchema,
	type SchemaValue
} from "#test/support/oracle/public/build.ts"
import { deliveryProof, licensed } from "#test/support/oracle/public/delivery.ts"
import { mixedFeatures, type MixedForm } from "#test/support/oracle/public/generate.ts"
import {
	expectedMixed,
	expectedQuery,
	referenceCells
} from "#test/support/oracle/public/meaning.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import type {
	Attachment,
	CaseRoster,
	MixedRoot,
	ParentColumn,
	ProgramCase,
	ProgramQuery,
	ProgramRead,
	Root,
	Rule,
	StatedDelivery,
	Var
} from "#test/support/oracle/public/program.ts"
import { unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { outputText } from "#test/support/wire.ts"

/**
 * Typed rows at bind: a query's decoder binds to the layouts of its compiled program only where every field it delivers
 * is one the program delivers, in the delivery it states, so a read never decodes a value the program does not hold.
 *
 * Over generated public programs (test/support/oracle/public), each compiled as the runtime compiles it and its
 * decoder bound to the layouts of either artifact's program (adapter/reader/run.ts readProgram, schema/record.ts
 * bindGroups), as a compiled handle (db.compile) binds it before any SQL:
 *
 * - A stated delivery the facts break is refused at bind. Every attachment is restated in turn as an array, an Option
 *   and the one child. Where the reference's children of some parent under the case's facts break the delivery's count
 *   (at most one for an Option, exactly one for the one child), the binding is CompileError MalformedDescription at
 *   that delivered field: the analysis, which is sound, cannot have proved it. Where the program language proves the
 *   delivery (delivery.ts) it binds. Anything else may bind or be refused, but only so.
 * - A layout without one of its keys is refused at bind: every program's layouts, with one of the record's columns or
 *   attachments removed from one of them, bind to nothing, CompileError MalformedDescription at a delivered field.
 * - A query rebuilt from its Description (queryFromDescription) has no decoder of its own: it compiles, and its rows
 *   bind to none of its program's layouts, CompileError MalformedDescription at the delivered field `query`.
 * - A heterogeneous union decodes each heading group as its own record: the reference's rows of a mixed root, written
 *   as the text cells the database returns (meaning.ts referenceCells), decoded through the query value's decoder bound
 *   to either artifact's layouts, are the reference's answer of each group, every arm's literal read as its own.
 *
 * Features: each stated delivery the facts break, refused, and each the program proves, bound; a column, an attachment
 * and a nested key removed, refused; a rebuilt query, and a rebuilt arm beside a typed arm, refused; each heading group
 * of a mixed root decoded.
 */
type QueryRead = Extract<ProgramRead, { readonly kind: "query" }>

/**
 * What each exploration reaches: a restated delivery refused where the facts break it and bound where the program
 * proves it; a layout key removed and refused; a rebuilt query refused.
 */
export type RestatedFeature =
	| `${StatedDelivery["kind"]} the facts break: refused`
	| `${StatedDelivery["kind"]} the program proves: bound`

export type LayoutFeature =
	| "column removed: refused"
	| "attachment removed: refused"
	| "nested key removed: refused"

export type RebuiltFeature = "rebuilt: refused" | "rebuilt arm beside a typed arm: refused"

const artifactNames = ["optimized", "conservative"] as const

const ok = <A>(r: Result.Result<A, CompileError>, what: string, c: ProgramCase): A => {
	if (!r.ok) {
		throw new Error(`${what}: ${r.error.message}\n${printCase(c)}`)
	}
	return r.value
}

/** The place a binding refuses at the delivered field `key`: the record's key, as its binder locates it. */
const deliveredField = (key: string): Place => ({ label: `delivered field ${key}`, path: [] })

/** A binding's refusal, which must be CompileError MalformedDescription at a delivered field: its place. */
const refusedAt = (
	r: Result.Result<unknown, CompileError>,
	what: string,
	c: ProgramCase
): Place | undefined => {
	if (r.ok) {
		return undefined
	}
	const error = r.error
	assert.ok(
		isCompileError(error),
		`${what}: the binding failed with no CompileError\n${printCase(c)}`
	)
	assert.equal(
		error.reason._tag,
		"MalformedDescription",
		`${what}: ${error.message}\n${printCase(c)}`
	)
	const place = placeOf(refusalLoc(error))
	assert.ok(
		place.path.length === 0 && Str.startsWith("delivered field ")(place.label),
		`${what}: refused at ${formatLoc(refusalLoc(error))}, no delivered field\n${printCase(c)}`
	)
	return place
}

/**
 * One compiled read: the template, and each artifact's program layouts its decoder binds to. It compiles against the
 * case's one schema value, so every read of a case finds the artifacts src memoizes by that value.
 */
interface Compiled {
	readonly template: OracleTemplate
	/** What a decoder binds under: the row vocabulary, and the names of a fresh installation's codes. */
	readonly bind: BindContext
	readonly layouts: ReadonlyArray<{
		readonly artifact: string
		readonly layouts: ReadonlyArray<Layout>
	}>
}

/** Every Attach node a program's part trees name: each attached part's, and each fused attachment's. */
const lowered = (
	roots: ReadonlyArray<StatementTree<DeliveredPart>>
): ReadonlyArray<NodeOf<"Attach">> =>
	Arr.flatMap(roots, (tree) => [
		...Arr.map(tree.statement.fused, (f) => f.attach),
		...Arr.flatMap(tree.attachments, (a) => [a.attach, ...lowered([a])])
	])

/**
 * Each attachment of both lowered programs carries the delivered type the template's analysis judged (ir/rel.ts Attach
 * judged): the analyzed DAG's Attach node under the same label, which the reader read before the lowerings carried it.
 */
const judgedAsAnalyzed = (template: OracleTemplate): void => {
	const analyzed = new Map(
		Arr.flatMap(topoOrder(template.analyzed), (n) =>
			n.kind === "Attach" ? [[n.id, n.delivered] as const] : []
		)
	)
	for (const artifact of artifactNames) {
		for (const attach of lowered(template.runs[artifact].roots)) {
			const label = `${artifact} ${attach.name} at ${attach.id}`
			assert.equal(attach.judged, defined(analyzed.get(attach.id), label), label)
		}
	}
}

const compiled = (c: ProgramCase, value: SchemaValue, query: unknown): Compiled => {
	const template = ok(
		compileTemplate(query, value, testCompile),
		"a generated query does not compile",
		c
	)
	judgedAsAnalyzed(template)
	const desc = ok(queryInput(query), "the builder refuses a generated query", c).desc
	const spine = servedSpine(desc)
	const codes = succeeded(codebookFor(schemaInputOf(value), firstCodes))
	return {
		template,
		bind: { options: rowOptions, names: codeNames(codes) },
		layouts: Arr.map(artifactNames, (artifact) => ({
			artifact,
			layouts: readProgram(servedSource(template.runs[artifact]), spine, codes).layouts
		}))
	}
}

/**
 * Binds a decoder to every artifact's layouts; both artifacts must agree on whether it binds, and a refusal is at a
 * delivered field.
 */
const binds = (
	c: ProgramCase,
	decoders: Decoders<unknown, unknown>,
	read: Compiled,
	what: string
): Place | undefined => {
	const outcomes = Arr.map(read.layouts, (program) => {
		const [first, ...rest] = program.layouts
		if (first === undefined) {
			throw new Error(`${what}: a program of no layout`)
		}
		return refusedAt(
			bindGroups(decoders.rows, (form) => recordsReader(form, [first, ...rest], read.bind)),
			`${what} (${program.artifact})`,
			c
		)
	})
	const [optimized, conservative] = outcomes
	assert.equal(
		optimized === undefined,
		conservative === undefined,
		`${what}: one artifact binds and the other refuses\n${printCase(c)}`
	)
	return optimized
}

/** Every attachment of a query, by its path of indices from the root, with the query it attaches to. */
interface Attached {
	readonly path: ReadonlyArray<number>
	readonly parent: ProgramQuery<ParentColumn>
	readonly attachment: Attachment
}

const attachedOf = (
	q: ProgramQuery<ParentColumn>,
	path: ReadonlyArray<number>
): ReadonlyArray<Attached> =>
	Arr.flatMap(q.attachments, (a, i) => [
		{ path: [...path, i], parent: q, attachment: a },
		...attachedOf(a.child, [...path, i])
	])

/** The query with the attachment at `path` replaced by `change` of it. */
const changedAt = <Q extends ProgramQuery<ParentColumn>>(
	q: Q,
	path: ReadonlyArray<number>,
	change: (attachment: Attachment) => Attachment
): Q => {
	const [at, ...rest] = path
	if (at === undefined) {
		return q
	}
	return {
		...q,
		attachments: Arr.map(q.attachments, (a, i) =>
			i !== at
				? a
				: rest.length === 0
					? change(a)
					: { ...a, child: changedAt(a.child, rest, change) }
		)
	}
}

/** The query with the attachment at `path` stated as `delivery`. */
const restated = <Q extends ProgramQuery<ParentColumn>>(
	q: Q,
	path: ReadonlyArray<number>,
	delivery: StatedDelivery
): Q => changedAt(q, path, (a) => ({ ...a, delivery }))

/** Whether a parent delivers a handle column, which an arm restates its attachment over. */
const handled = (parent: ProgramQuery<ParentColumn>): boolean =>
	Arr.some(parent.heading, (f) => f.type.carrier === "code")

/**
 * The precondition of "arm the facts break", planted. The facts break an arm where a parent has more than one child,
 * which generated facts rarely give, since a child correlates with its parent through a key. A planted case picks an
 * attachment whose parent delivers a handle column and matches the roster in every arm of its child, delivering the
 * handle, so each parent's children multiply by the roster's handles: under a roster of two or more, a parent with a
 * child has several. The planted attachment states the array, which every child admits.
 */
type Plant = { readonly kind: "none" } | { readonly kind: "planted"; readonly pick: number }

export const plantGen: Gen<Plant> = oneOf([
	constant<Plant>({ kind: "none" }),
	map(pickGen, (pick): Plant => ({ kind: "planted", pick }))
])

/**
 * The column a planted child delivers its handle under, where neither its heading nor its attachments hold the name.
 */
const plantedColumn = "plantedHandle"

/**
 * A child whose every arm matches the roster and delivers its handle. The variable's id is -1: a read's scope mints
 * its variables from zero up (generate.ts ReadScope.mint), so no generated variable holds it.
 */
const multiplied = (
	child: ProgramQuery<ParentColumn>,
	roster: CaseRoster
): ProgramQuery<ParentColumn> => {
	const handle: Var = { id: -1, field: roster.id }
	const arm = (rule: Rule<ParentColumn>): Rule<ParentColumn> => ({
		...rule,
		matches: [
			...rule.matches,
			{ source: roster, bindings: [{ field: roster.id, operand: { kind: "var", var: handle } }] }
		],
		head: [...rule.head, { kind: "var", name: plantedColumn, var: handle }]
	})
	const [first, ...rest] = child.arms
	return {
		...child,
		heading: [...child.heading, { name: plantedColumn, type: roster.id.type }],
		arms: [arm(first), ...Arr.map(rest, arm)]
	}
}

/** The case's query reads, the one attachment the plant picks among those a handle column's parent holds multiplied. */
const plantedReads = (c: ProgramCase, plant: Plant): ReadonlyArray<QueryRead> => {
	const reads = Arr.flatMap(c.reads, (read) => (read.kind === "query" ? [read] : []))
	if (plant.kind === "none") {
		return reads
	}
	const sites = Arr.flatMap(reads, (read, index) =>
		Arr.flatMap(attachedOf(read.query, []), ({ path, parent, attachment }) =>
			handled(parent) &&
			!Arr.some(attachment.child.heading, (f) => f.name === plantedColumn) &&
			!Arr.some(attachment.child.attachments, (a) => a.name === plantedColumn)
				? [{ index, path }]
				: []
		)
	)
	const [first, ...rest] = sites
	if (first === undefined) {
		return reads
	}
	const site = pickFrom([first, ...rest], plant.pick)
	return Arr.map(reads, (read, index) =>
		index !== site.index
			? read
			: {
					...read,
					query: changedAt(read.query, site.path, (a) => ({
						...a,
						child: multiplied(a.child, c.schema.roster),
						delivery: { kind: "array" }
					}))
				}
	)
}

/** The children per parent of the attachment at `path`, over the rows the reference delivers. */
const childCounts = (
	rows: ReadonlyArray<Nested>,
	path: ReadonlyArray<number>
): ReadonlyArray<number> => {
	const [at, ...rest] = path
	if (at === undefined) {
		return []
	}
	return Arr.flatMap(rows, (row) => {
		const children = defined(row.attachments[at], `the attachment at ${at}`)
		return rest.length === 0 ? [children.length] : childCounts(children, rest)
	})
}

/**
 * Every delivery an attachment may be restated as: the array, an Option and the one child.
 */
const deliveries: ReadonlyArray<StatedDelivery> = [
	{ kind: "array" },
	{ kind: "option" },
	{ kind: "one" }
]

/**
 * Whether the children per parent break a delivery's count at bind: more than one under an Option, other than one under
 * the one child.
 */
const breaks = (delivery: StatedDelivery, counts: ReadonlyArray<number>): boolean => {
	switch (delivery.kind) {
		case "array":
			return false
		case "option":
			return Arr.some(counts, (n) => n > 1)
		case "one":
			return Arr.some(counts, (n) => n !== 1)
	}
}

/**
 * One query read: every attachment restated as every delivery, bound against what the facts and the proof say. A
 * Description holds no delivery, so every restatement compiles to the read's one template, as the runtime's template
 * cache finds it, and binds to its layouts.
 */
const restatedReads = (
	c: ProgramCase,
	read: QueryRead,
	built: BuiltSchema,
	note: Case<RestatedFeature>["note"]
): void => {
	const value = built.schema
	/** The reference's answer, Effect's Result (oracle/public/answer.ts Answer). */
	const expected = expectedQuery(c, read, unobserved)
	if (Answered.isFailure(expected)) {
		throw new Error(`the reference refuses a generated read: ${expected.failure}`)
	}
	const program = compiled(c, value, buildRoot(built, value, read.query))
	for (const { path, parent, attachment } of attachedOf(read.query, [])) {
		const counts = childCounts(expected.success, path)
		const proved = licensed(deliveryProof(parent, attachment.child))
		for (const delivery of deliveries) {
			const root: Root = restated(read.query, path, delivery)
			const query = buildRoot(built, value, root)
			const what = `${attachment.name} stated ${delivery.kind}`
			const refused = binds(c, query, program, what)
			const provable = Arr.some(proved, (d) => d.kind === delivery.kind)
			if (breaks(delivery, counts)) {
				assert.ok(!provable, `the language proves ${what}, which the facts break\n${printCase(c)}`)
				assert.deepEqual(
					refused,
					deliveredField(attachment.name),
					`${what} over children the facts give ${Arr.join(
						Arr.map(counts, (n) => String(n)),
						", "
					)} binds\n${printCase(c)}`
				)
				note(`${delivery.kind} the facts break: refused`)
			} else if (provable) {
				assert.equal(
					refused,
					undefined,
					`${what}, which the program proves, is refused\n${printCase(c)}`
				)
				note(`${delivery.kind} the program proves: bound`)
			} else {
				assert.ok(
					refused === undefined || deepEquals(refused, deliveredField(attachment.name)),
					`${what} is refused at ${Formatter.format(refused)}, not at its own field\n${printCase(c)}`
				)
			}
		}
	}
}

/**
 * A layout with `key` taken away, at the layout `path` leads to: a list of attachment names from the given layout
 * down, then the index of a child heading group's layout.
 */
type LayoutPath = ReadonlyArray<{ readonly attachment: string; readonly group: number }>

const without = (layout: Layout, path: LayoutPath, key: string): Layout => {
	const [step, ...rest] = path
	if (step === undefined) {
		const columns = new Map(layout.columns)
		const attachments = new Map(layout.attachments)
		columns.delete(key)
		attachments.delete(key)
		return { columns, attachments }
	}
	const at = layout.attachments.get(step.attachment)
	if (at === undefined) {
		throw new Error(`no attachment ${step.attachment} in a layout`)
	}
	const changed: AttachmentLayout = {
		...at,
		layouts: Arr.map(at.layouts, (l, i) => (i === step.group ? without(l, rest, key) : l))
	}
	return {
		columns: layout.columns,
		attachments: new Map([...layout.attachments, [step.attachment, changed]])
	}
}

/**
 * Every key the record of `shape` reads from a layout, with the path to that layout: the shape's columns and
 * attachments, then each attachment's child's, under each of its child layouts.
 */
const recordKeys = (
	shape: Shape,
	layout: Layout,
	path: LayoutPath
): ReadonlyArray<{ path: LayoutPath; key: string }> => [
	...Arr.map(
		Arr.filter(shape.columns, (c) => layout.columns.has(c.name)),
		(c) => ({ path, key: c.name })
	),
	...Arr.flatMap(shape.attachments, (a) => {
		const at = layout.attachments.get(a.name)
		if (at === undefined) {
			return []
		}
		return [
			{ path, key: a.name },
			...Arr.flatMap(at.layouts, (l, group) =>
				recordKeys(a.shape, l, [...path, { attachment: a.name, group }])
			)
		]
	})
]

/** One query read: each of its record's keys taken from each layout it is read under, which must not bind. */
const removedKeys = (
	c: ProgramCase,
	read: QueryRead,
	built: BuiltSchema,
	note: Case<LayoutFeature>["note"]
): void => {
	const value = built.schema
	const query = buildRoot(built, value, read.query)
	const shape = shapeOf(read.query)
	const compiledRead = compiled(c, value, query)
	for (const program of compiledRead.layouts) {
		for (const [g, layout] of program.layouts.entries()) {
			for (const { path, key } of recordKeys(shape, layout, [])) {
				const layouts = Arr.map(program.layouts, (l, i) => (i === g ? without(l, path, key) : l))
				const [first, ...rest] = layouts
				if (first === undefined) {
					throw new Error("a program of no layout")
				}
				const what = `the ${program.artifact} layout without ${key}`
				assert.ok(
					refusedAt(
						bindGroups(query.rows, (form) =>
							recordsReader(form, [first, ...rest], compiledRead.bind)
						),
						what,
						c
					) !== undefined,
					`${what} binds\n${printCase(c)}`
				)
				note(
					path.length > 0
						? "nested key removed: refused"
						: Arr.some(shape.columns, (col) => col.name === key)
							? "column removed: refused"
							: "attachment removed: refused"
				)
			}
		}
	}
}

/** One query read rebuilt from its Description: it compiles, and its rows bind to none of its layouts. */
const rebuiltRead = (
	c: ProgramCase,
	read: QueryRead,
	built: BuiltSchema,
	note: Case<RebuiltFeature>["note"]
): void => {
	const value = built.schema
	const original = buildRoot(built, value, read.query)
	const description = ok(
		Result.flatMap(queryInput(original), (input) => toQueryDescription(input.desc)),
		"a generated query has no Description",
		c
	)
	const rebuilt = ok(queryFromDescription(description, value), "the Description is refused", c)
	const refused = binds(c, rebuilt, compiled(c, value, rebuilt), "the rebuilt query")
	assert.deepEqual(
		refused,
		deliveredField("query"),
		`the rebuilt query's rows bind\n${printCase(c)}`
	)
	note("rebuilt: refused")
	if (
		!(
			read.query.heading.length > 0 &&
			read.query.attachments.length === 0 &&
			read.query.delivery.kind === "set" &&
			read.params.length === 0 &&
			read.relations.length === 0
		)
	) {
		return
	}
	const importing = (source: unknown) => (r: RuleValue) => {
		const x = v(source, "source")
		return r.match(source, x).find(x)
	}
	const union = query(value).rule(importing(rebuilt)).rule(importing(original))
	const beside = binds(c, union, compiled(c, value, union), "a union beside a rebuilt arm")
	assert.deepEqual(
		beside,
		deliveredField("query"),
		`a union beside a rebuilt arm binds\n${printCase(c)}`
	)
	note("rebuilt arm beside a typed arm: refused")
}

/**
 * One mixed root: the reference's rows of each heading group, as text cells laid out in the group's statement's column
 * order, decoded through either artifact's layouts, against the reference's answer of the group.
 */
export const mixedRead = (
	c: ProgramCase,
	root: MixedRoot,
	built: BuiltSchema,
	note: Case<MixedForm>["note"]
): void => {
	const mixed = buildMixed(built, built.schema, root)
	const program = compiled(c, built.schema, mixed)
	const cells = referenceCells(c, root)
	const expected = expectedMixed(c, root, unobserved)
	const shapes = mixedShapes(root)
	for (const { artifact, layouts } of program.layouts) {
		const [first, ...rest] = layouts
		if (first === undefined) {
			throw new Error(`a mixed root's ${artifact} program of no layout`)
		}
		const read = succeeded(
			bindGroups(mixed.rows, (form) => recordsReader(form, [first, ...rest], program.bind)),
			`a mixed root's rows bind (${artifact})`
		)
		const rows = Arr.flatMap(cells, (groupRows, g) => {
			const layout = defined(layouts[g], `the ${artifact} layout of heading group ${g}`)
			const columns = defined(root.groups[g], `heading group ${g}`)
			unorderedEqual(
				[...layout.columns.keys()],
				Arr.map(columns, (col) => col.name),
				`the columns of group ${g}`
			)
			return Arr.map(groupRows, (row) => {
				const texts: Array<string> = []
				for (const [i, col] of columns.entries()) {
					texts[defined(layout.columns.get(col.name), `${col.name} in group ${g}`)] = defined(
						row[i],
						"a cell"
					)
				}
				return read({ group: g, cells: Arr.map(texts, outputText), children: [] })
			})
		})
		const decoded = succeeded(mixedRows(root, rows), `a mixed root's decoded rows (${artifact})`)
		for (const [g, shape] of shapes.entries()) {
			const reference = defined(expected[g], `the answer of group ${g}`)
			const delivered = Answered.succeed(defined(decoded[g], `the decoded group ${g}`))
			const difference = answerEquivalence(shape, false)(reference, delivered)
			if (Option.isSome(difference)) {
				throw new Error(
					`${answersReport(shape, difference.value, [
						[`the reference's group ${g}`, reference],
						[`the ${artifact} decoding of group ${g}`, delivered]
					])}\n${printCase(c)}`
				)
			}
		}
	}
	for (const feature of mixedFeatures(root)) {
		note(feature)
	}
}

/**
 * Each case's reads through `check`, over its schema built once, one attachment multiplied where the case plants it.
 */
const eachRead =
	<F extends string>(
		check: (c: ProgramCase, read: QueryRead, built: BuiltSchema, note: Case<F>["note"]) => void
	) =>
	(c: ProgramCase, note: Case<F>["note"], plant: Plant): void => {
		const built = buildSchema(c.schema)
		for (const read of plantedReads(c, plant)) {
			check(c, read, built, note)
		}
	}

/** No plant: each read as the case draws it. */
export const unplanted: Plant = { kind: "none" }

/** Each read of a case with its planted delivery restated, refused where the facts break it and bound where proved. */
export const checkRestated = eachRead(restatedReads)

/** Each read of a case bound to its layouts with one of its record's keys removed. */
export const checkRemovedKeys = eachRead(removedKeys)

/** Each read of a case rebuilt from its Description. */
export const checkRebuilt = eachRead(rebuiltRead)
