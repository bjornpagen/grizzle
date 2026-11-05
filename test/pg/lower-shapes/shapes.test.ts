import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int } from "@grizzle/testing/gen"
import { exact, multiset, ordered } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, pipe, Record as Rec, String as Str } from "effect"
import { resultTextCasts, type ScalarCodec, scalarCodec } from "#compiler/codec/scalar.ts"
import { indices } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { type Codebook, codecOf, codeOf } from "#compiler/ir/codes.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type {
	CompletedOrder,
	Heading,
	HeadingColumn,
	NodeOf,
	RelDag,
	RelNode,
	ValidDag
} from "#compiler/ir/rel.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import { parentColumnsOf, statementRows } from "#compiler/lower/conservative/deliver.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	type ConservativeParamSlot,
	type ConservativeProgram,
	deliveredHeading,
	flight,
	statementOutput
} from "#compiler/lower/conservative/types.ts"
import { fusedTexts } from "#compiler/lower/shapes/attach/decode.ts"
import {
	fusedLayout,
	pipelinedAttachment,
	withFusedAttachments
} from "#compiler/lower/shapes/attach/index.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import { decorrelatedTake } from "#compiler/lower/shapes/take/index.ts"
import { groupRows } from "#compiler/lower/shapes/union/index.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { emit } from "#compiler/sql/emit.ts"
import { renameToPublicHeading } from "#compiler/sql/naming.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { fixtureGroup, type ResetGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"
import { relations, T, Task, uuidOf } from "#test/unit/lower/conservative/fixtures.ts"
import * as Cases from "#test/unit/lower/conservative/queries.ts"
import {
	accountsWithAmounts,
	amountsPerAccount,
	type ConditionalForm,
	conditional,
	tasksByKind,
	topAmounts
} from "#test/unit/lower/shapes/queries.ts"

import { jsonText } from "#compiler/core/trusted.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	context,
	shapedFacts,
	shapedProgram,
	testOptions
} from "#test/unit/lower/shapes/support.ts"

/**
 * The lowering shapes on PostgreSQL 19 (packages/engine/src/lower/shapes), where no generator reaches them yet.
 *
 * The ledger fixture installs under a fresh schema, and each shape is checked against the conservative lowering, the
 * oracle baseline that deduplicates at every set boundary, by raw text row multisets and with no repeated row:
 *
 * - an unsound fact in each shape (uniqueness, contribution exactness, uniqueness per parent) reproduces a
 *   counterexample the sound facts do not;
 * - the conditional aggregate's count(*) FILTER and CASE sum (R24.conditionalCount) agree with the composition where no
 *   binding, some and every binding satisfies the predicate, the case a filtered sum gets wrong.
 *
 * Every other shape is the generated suites': the per-group takes, heading groups and the VALUES transport the
 * optimized differential's (test/pg/oracle/optimized), and the fused and pipelined attachments, spellings and
 * array_out quoting the public-boundary differential's (test/pg/oracle/public), decoded as an application reads them.
 */

/** The fixture's physical names, its codebook among them: the names the lowerings under test emit. */
const namesOf = (schema: string) => testOptions(schema).names

/** The fixture's codes, which no schema name changes: what every delivered closed id decodes by. */
const fixtureCodes = (): Codebook => namesOf("shapes").codes

/** A roster's domain in the fixture's schema, quoted: what a closed id's column and literal are typed by. */
const rosterDomainSql = (schema: string, roster: string): string => {
	const domain = namesOf(schema).rosterDomain(parsedName(roster))
	return `"${domain.schema}"."${domain.name}"`
}

const sqlType = (schema: string, c: HeadingColumn): string => {
	switch (c.type.carrier) {
		case "uuid":
			return "uuid"
		case "int4":
			return "integer"
		case "int8":
			return "bigint"
		case "float8":
			return "double precision"
		case "numeric":
			return "numeric"
		case "money":
			return "money"
		case "bool":
			return "boolean"
		case "text":
			return "text COLLATE pg_catalog.pg_c_utf8"
		case "code":
			return rosterDomainSql(schema, c.type.roster.closed)
		case "float4":
		case "int2":
		case "range4":
		case "range8":
		case "vector":
		case "bits":
		case "exactInteger":
		case "exactMoney":
			throw new Error(`no fixture column type for ${c.type.carrier}`)
	}
}

const quote = (value: string): string => `'${Str.replaceAll("'", "''")(value)}'`

/** A fixture fact's value as a typed literal: a closed id's handle as its code under the fixture's codebook. */
const literalOf = (schema: string, c: HeadingColumn, value: string): string =>
	c.type.carrier === "code"
		? `${codeOf(codecOf(namesOf(schema).codes, c.type.roster), value)}::smallint::${sqlType(schema, c)}`
		: `${quote(value)}::${pipe(sqlType(schema, c), Str.replace(" COLLATE pg_catalog.pg_c_utf8", ""))}`

type Relation = (typeof relations)[number]

const tableOf = (schema: string, r: Relation): string =>
	`"${schema}"."${identifierOf(identity.table(parsedName(r.name)))}"`

/** The INSERT of a relation's fixture facts (Cases.facts), none when it has none. */
const factInserts = (schema: string, r: Relation): ReadonlyArray<string> => {
	const rows = Arr.map(
		Cases.facts[r.name] ?? [],
		(row) =>
			`(${Arr.join(
				Arr.map(row, (v, i) => literalOf(schema, defined(r.heading[i], "column"), v)),
				", "
			)})`
	)
	return rows.length === 0
		? []
		: [`INSERT INTO ${tableOf(schema, r)} VALUES ${Arr.join(rows, ", ")}`]
}

/** Every table the fixture creates in `schema`, which a reset truncates together (substrate/replace.ts). */
const fixtureTables = (schema: string): ResetGroup =>
	fixtureGroup(Arr.map(relations, (r) => tableOf(schema, r)))

const install = (schema: string): ReadonlyArray<string> => [
	`CREATE DOMAIN ${rosterDomainSql(schema, "Kind")} AS smallint`,
	...Arr.flatMap(relations, (r) => {
		const columns = Arr.map(
			r.heading,
			(c) => `"${identifierOf(identity.column(parsedName(c.name)))}" ${sqlType(schema, c)} NOT NULL`
		)
		const pk = Arr.join(
			Arr.map(r.primaryKey, (k) => `"${identifierOf(identity.column(parsedName(k)))}"`),
			", "
		)
		return [
			`CREATE TABLE ${tableOf(schema, r)} (${Arr.join(columns, ", ")}, PRIMARY KEY (${pk}))`,
			...factInserts(schema, r)
		]
	})
]

type Params = Readonly<Record<string, string | ReadonlyArray<Readonly<Record<string, string>>>>>

interface Ran {
	/** Each row as record text, and its columns as text. */
	readonly text: ReadonlyArray<string>
	readonly columns: ReadonlyArray<ReadonlyArray<string>>
}

/**
 * Runs one SQL text whose output has `width` columns, or the columns of a heading, every column read back as its
 * exact text, money through numeric as the outermost SELECT casts it (codec resultTextCasts). A numeric column of a
 * heading is read as its value, through trim_scale: a value is only its value, and the display scale PostgreSQL
 * computes for a sum or a cast is none of it; the row's text is then the row of those column texts.
 */
const runText = (text: string, width: number | Heading, params: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const count = typeof width === "number" ? width : width.length
		const names = Arr.map(indices(count), (i) => `"p${i}"`)
		const column = (n: string, i: number): string => {
			if (typeof width === "number") {
				return `t.${n}::text`
			}
			const type = defined(width[i], "column").type
			return Arr.reduce(
				resultTextCasts(type),
				baseOf(type).carrier === "numeric" ? `pg_catalog.trim_scale(t.${n})` : `t.${n}`,
				(e, cast) => `(${e})::${cast}`
			)
		}
		const columns = Arr.map(names, column)
		const row = typeof width === "number" ? "t::text" : `ROW(${Arr.join(columns, ", ")})::text`
		const wrapped = `SELECT ${row}, ${Arr.join(columns, ", ")} FROM (${text}) AS t(${Arr.join(names, ", ")})`
		const rows = yield* admin.queryValues(wrapped, params)
		return {
			text: Arr.map(rows, (r) => String(r[0])),
			columns: Arr.map(rows, (r) => Arr.map(r.slice(1), (v) => String(v)))
		} satisfies Ran
	})

const slotValue = (params: Params, slot: ConservativeParamSlot): string => {
	switch (slot.kind) {
		case "scalar": {
			const value = params[slot.param]
			if (typeof value !== "string") {
				throw new Error(`no scalar value for ${slot.param}`)
			}
			return value
		}
		case "relation": {
			const value = params[slot.param]
			if (value === undefined || typeof value === "string") {
				throw new Error(`no relation value for ${slot.param}`)
			}
			/**
			 * The host codec deduplicates complete facts before encoding (codec/recordset.ts), which is what
			 * lets the statement read the recordset without a DISTINCT; the fixture facts are already canonical text.
			 */
			const rows = Arr.map(value, (row) =>
				jsonText(
					Rec.fromEntries(
						Arr.map(slot.columns, (c) => [
							c.definition.name,
							defined(row[c.name], `the fact's ${c.name}`)
						])
					)
				)
			)
			return `[${Arr.join([...new Set(rows)], ",")}]`
		}
		case "member":
		case "page":
			throw new Error(
				`a query statement's placeholder is a declared parameter, not a ${slot.kind} placeholder`
			)
	}
}

const runProgram = (program: ConservativeProgram, params: Params) =>
	Effect.gen(function* () {
		const ran: Array<Ran> = []
		for (const statement of flight(program.roots)) {
			const values = Arr.map(statement.params, (slot) => slotValue(params, slot))
			const text = yield* runText(
				statement.sql.text,
				statementOutput(statement.role, statement.heading, []).heading,
				values
			)
			ran.push(text)
		}
		return ran
	})

/** One query delivered as a statement of the context: renamed, audited, printed, with its parameter values. */
const statementOf = (
	cx: ReturnType<typeof context>,
	query: Select,
	names: ReadonlyArray<string>,
	params: Params
): { readonly text: string; readonly values: ReadonlyArray<string> } => {
	const renamed = succeeded(renameToPublicHeading(query, names))
	const text = succeeded(emit(renamed, cx.supply.map())).text
	return { text, values: Arr.map(cx.params.slots, (slot) => slotValue(params, slot)) }
}

/**
 * The problems of a shaped run against the conservative oracle's, statement by statement: a different row multiset
 * (or sequence, for an ordered statement) or a repeated row. Empty when they agree.
 */
const disagreements = (
	base: ReadonlyArray<Ran>,
	shaped: ReadonlyArray<Ran>,
	orderedStatements: ReadonlyArray<number>
): ReadonlyArray<string> => {
	const out: Array<string> = []
	if (base.length !== shaped.length) {
		out.push(`${shaped.length} statements, not ${base.length}`)
	}
	for (const [i, ran] of shaped.entries()) {
		const want = base[i]?.text ?? []
		const difference = (orderedStatements.includes(i) ? ordered(exact) : multiset(exact))(
			ran.text,
			want
		)
		if (Option.isSome(difference)) {
			out.push(`statement ${i}: ${Formatter.format(ran.text)} for ${Formatter.format(want)}`)
		}
		if (new Set(ran.text).size !== ran.text.length) {
			out.push(`statement ${i} repeats a row`)
		}
	}
	return out
}

/**
 * A query delivering a parent with attachments: the parent node, the attachments from the root down, the spine the
 * children correlate to, and the parent's delivery order when the root is an ordered result.
 */
interface Attached {
	readonly query: { readonly dag: ValidDag; readonly root: RelNode }
	readonly parent: RelNode
	readonly attaches: ReadonlyArray<NodeOf<"Attach">>
	readonly spine: ReadonlyArray<RelNode>
	readonly order: CompletedOrder | undefined
}

const attachedOf = (query: { readonly dag: ValidDag; readonly root: RelNode }): Attached => {
	const top = query.root
	const order = top.kind === "OrderedResult" ? top.order : undefined
	let node = top.kind === "OrderedResult" ? top.input : top
	const attaches: Array<NodeOf<"Attach">> = []
	const spine: Array<RelNode> = []
	while (node.kind === "Attach") {
		attaches.push(node)
		spine.push(node)
		node = node.parent
	}
	spine.push(node)
	return { query, parent: node, attaches, spine, order }
}

/**
 * Nested results: the parent rows in delivery order, each a record of column texts, and per attachment the child
 * rows (column texts joined by |) of each parent, keyed by the texts of the parent columns the child reads.
 */
interface Nested {
	readonly parents: ReadonlyArray<Readonly<Record<string, string>>>
	readonly children: ReadonlyArray<{
		readonly keys: ReadonlyArray<string>
		readonly sets: ReadonlyMap<string, ReadonlyArray<string>>
	}>
}

const recordOf = (heading: Heading, row: ReadonlyArray<string>): Readonly<Record<string, string>> =>
	Rec.fromEntries(Arr.map(heading, (h, i) => [h.name, defined(row[i], "column")]))

const keyOf = (row: Readonly<Record<string, string>>, keys: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(keys, (k) => defined(row[k], `the key column ${k}`)),
		"|"
	)

/**
 * A child value's text as the host delivers it: PostgreSQL's text converted by the column's codec and printed back, so
 * every form is compared on the values the library returns (a float's -0 is the host's one zero).
 */
const delivered = (codec: ScalarCodec, text: string): string => codec.text(codec.convert(text))

/** Child rows of a statement whose columns are the parent key columns, then the child's heading. */
const childSets = (
	rows: ReadonlyArray<ReadonlyArray<string>>,
	keyCount: number,
	child: Heading
) => {
	const codecs = Arr.map(child, (h) => scalarCodec(h.type, fixtureCodes()))
	const sets = new Map<string, Array<string>>()
	for (const row of rows) {
		const key = Arr.join(row.slice(0, keyCount), "|")
		const values = Arr.map(row.slice(keyCount), (text, j) =>
			delivered(defined(codecs[j], "codec"), text)
		)
		sets.set(key, [...(sets.get(key) ?? []), Arr.join(values, "|")])
	}
	return sets
}

/**
 * The problems of one nested result against another: parents in order (or as a set) and each parent's children in
 * the attachment's order (or as a multiset).
 */
const nestedDisagreements = (
	want: Nested,
	got: Nested,
	attached: Attached
): ReadonlyArray<string> => {
	const out: Array<string> = []
	const parentsAgree = attached.order === undefined ? multiset(exact) : ordered(exact)
	if (Option.isSome(parentsAgree(want.parents, got.parents))) {
		out.push(`parents ${Formatter.format(got.parents)} for ${Formatter.format(want.parents)}`)
	}
	for (const [i, attach] of attached.attaches.entries()) {
		const a = want.children[i]
		const b = got.children[i]
		if (a === undefined || b === undefined) {
			out.push(`no children for ${attach.name}`)
			continue
		}
		for (const parent of want.parents) {
			const x = a.sets.get(keyOf(parent, a.keys)) ?? []
			const y = b.sets.get(keyOf(parent, b.keys)) ?? []
			const childrenAgree = attach.order === undefined ? multiset(exact) : ordered(exact)
			if (Option.isSome(childrenAgree(x, y))) {
				out.push(
					`${attach.name} of ${Formatter.format(parent)}: ${Formatter.format(y)} for ${Formatter.format(x)}`
				)
			}
		}
	}
	return out
}

const conservative = (
	query: { readonly dag: ValidDag; readonly root: RelNode },
	schema: string
) => {
	const r = lowerConservative(query, testOptions(schema))
	if (!r.ok) {
		throw new Error(r.error.message)
	}
	return r.value
}

/**
 * The conservative program's nested result, the oracle: its parent statement, then one attachment statement per
 * attachment from the root down, each the parent key columns and then the child's heading, always deduplicated.
 */
const oracleNested = (attached: Attached, schema: string) =>
	Effect.gen(function* () {
		const program = conservative(attached.query, schema)
		const ran = yield* runProgram(program, {})
		const main = flight(program.roots)[0]
		return {
			parents: Arr.map(defined(ran[0], "parent run").columns, (r) => recordOf(main.heading, r)),
			children: Arr.map(attached.attaches, (attach, i) => {
				const statement = flight(program.roots)[i + 1]
				if (statement?.role.kind !== "attachment") {
					throw new Error(`a statement for ${attach.name}`)
				}
				const key = statement.role.parentKey
				return {
					keys: Arr.map(key, (h) => h.name),
					sets: childSets(
						defined(ran[i + 1], "child run").columns,
						key.length,
						deliveredHeading(statement.heading)
					)
				}
			})
		} satisfies Nested
	})

/**
 * The pipelined form: the shaped parent statement, then this package's pipelinedAttachment per attachment, which
 * computes the parent's rows again in its own statement, stitched by parent key.
 */
const pipelinedNested = (attached: Attached, facts: ShapeFacts, schema: string) =>
	Effect.gen(function* () {
		const options = testOptions(schema)
		const main = flight(shapedProgram(attached.query, facts, options).roots)[0]
		const parentRan = yield* runText(
			main.sql.text,
			statementOutput(main.role, main.heading, []).heading,
			Arr.map(main.params, (slot) => slotValue({}, slot))
		)
		const children: Array<Nested["children"][number]> = []
		for (const attach of attached.attaches) {
			const cx = context(attached.query.dag, facts, options)
			const parentKey = parentColumnsOf(cx, attach, attached.spine, attached.parent.heading)
			const p = pipelinedAttachment(
				cx,
				attach,
				attached.spine,
				{
					...statementRows(attached.parent.heading, () => cx.lower(attached.parent, new Map())),
					identity: { kind: "node", node: attached.parent },
					bound: { kind: "unbounded" },
					searches: false
				},
				facts,
				parentKey
			)
			const child = deliveredHeading(attach.child.heading)
			const heading = [...parentKey, ...child]
			const s = statementOf(
				cx,
				p.query,
				Arr.map(heading, (h) => h.name),
				{}
			)
			const rows = yield* runText(s.text, heading, s.values)
			children.push({
				keys: Arr.map(parentKey, (h) => h.name),
				sets: childSets(rows.columns, parentKey.length, child)
			})
		}
		return {
			parents: Arr.map(parentRan.columns, (r) => recordOf(main.heading, r)),
			children
		} satisfies Nested
	})

/**
 * The fused form: one statement, each attachment an ARRAY(SELECT ...) column decoded with its layout's codec and each
 * child value printed back with its scalar codec, so a decoding that lost 1.0 against 1.00, NaN, a money scale or
 * a quoted text element shows as a difference from the pipelined texts PostgreSQL printed.
 */
const fusedNested = (attached: Attached, facts: ShapeFacts, schema: string) =>
	Effect.gen(function* () {
		const { parent, query } = attached
		const cx = context(query.dag, facts, testOptions(schema))
		const fused = withFusedAttachments(
			cx,
			cx.lower(parent, new Map()),
			() => cx.lower(parent, new Map()),
			parent.heading,
			parent,
			attached.spine,
			attached.attaches,
			facts,
			attached.order
		)
		const heading: Heading = [
			...parent.heading,
			...Arr.map(attached.attaches, (a) => ({ name: a.name, type: T.text }))
		]
		const s = statementOf(
			cx,
			fused.query,
			Arr.map(heading, (h) => h.name),
			{}
		)
		const ran = yield* runText(s.text, heading, s.values)
		const width = parent.heading.length
		const children = Arr.map(attached.attaches, (attach, i) => {
			const child = attach.child
			const texts = fusedTexts(fusedLayout(attach, child.heading, parent.heading), (column) => {
				const p = Option.getOrThrowWith(
					Arr.findFirstIndex(parent.heading, (h) => h.name === column),
					() => new Error("a column the case's own heading holds")
				)
				return (row) => defined(row[p], `the parent column ${column}`)
			})
			const codecs = Arr.map(child.heading, (h) => scalarCodec(h.type, fixtureCodes()))
			const keys = Arr.map(
				Arr.filter(parent.heading, (h) => Arr.some(attach.correlation, (c) => c.parent === h.name)),
				(h) => h.name
			)
			const sets = new Map<string, ReadonlyArray<string>>()
			for (const row of ran.columns) {
				const decoded = texts(defined(row[width + i], "attachment column"), row.slice(0, width))
				sets.set(
					keyOf(recordOf(parent.heading, row), keys),
					Arr.map(decoded, (r) =>
						Arr.join(
							Arr.map(r, (text, j) => delivered(defined(codecs[j], "codec"), text)),
							"|"
						)
					)
				)
			}
			return { keys, sets }
		})
		return {
			parents: Arr.map(ran.columns, (r) => recordOf(parent.heading, r.slice(0, width))),
			children
		} satisfies Nested
	})

const takeOf = (dag: RelDag): NodeOf<"Take"> =>
	Option.getOrThrowWith(
		Arr.findFirst(topoOrder(dag), (n): n is NodeOf<"Take"> => n.kind === "Take"),
		() => new Error("a take")
	)

/**
 * The Task facts an R24 case installs, each a binding of one of three accounts with an amount from a small range, and
 * the threshold its predicate compares the amount with: small enough ranges that a group none, some or all of whose
 * bindings qualify each meets most cases.
 */
interface ConditionalCase {
	readonly tasks: ReadonlyArray<readonly [account: number, amount: number]>
	readonly threshold: number
}

const accounts = [Cases.A, Cases.B, Cases.C] as const

const conditionalCaseGen: Gen<ConditionalCase> = (source) => ({
	tasks: source.draw(
		array((task) => [task.draw(int(0, 2)), task.draw(int(0, 60))] as const, { min: 0, max: 9 })
	),
	threshold: source.draw(int(-1, 61))
})

/** What a delivered group met: none, some or all of its bindings satisfying the predicate. */
type Qualifying = "none qualify" | "some qualify" | "all qualify"

const qualifying = (passed: number, bindings: number): Qualifying =>
	passed === 0 ? "none qualify" : passed === bindings ? "all qualify" : "some qualify"

layer(Substrate.layer)("the lowering shapes on PostgreSQL 19", (it) => {
	const installed = Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema(freshSchema)
		for (const statement of install(schema)) {
			yield* s.admin.query(statement, [])
		}
		return schema
	})

	it.effect(
		"R24: the conditional count and sum agree with the composition on generated groups none, some or all of whose bindings qualify",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const schema = yield* installed
					const { admin } = yield* Substrate
					const task = tableOf(schema, Task)
					const forms: ReadonlyArray<ConditionalForm> = [
						"int4",
						"int8",
						"numeric",
						"numeric5.2",
						"term"
					]
					const others = Arr.filter(relations, (r) => r !== Task)
					const otherInserts = Arr.flatMap(others, (r) => factInserts(schema, r))
					return yield* explore(
						{
							suite: "pg/lower-shapes/conditional",
							draw: drawn(conditionalCaseGen),
							literal: Formatter.format,
							coverage: required<Qualifying>(["none qualify", "some qualify", "all qualify"], {
								cases: 60,
								sense: notesOnly
							}),
							kept: [],
							runs: 60,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(c, k) =>
							Effect.gen(function* () {
								yield* replaceRows(admin, fixtureTables(schema), [
									...Arr.map(otherInserts, (sql) => ({ sql, params: [] })),
									...(c.tasks.length === 0
										? []
										: [
												{
													sql: `INSERT INTO ${task} VALUES ${Arr.join(
														Arr.map(
															c.tasks,
															([account, amount], i) =>
																`('${uuidOf(0x2000 + i)}'::uuid, '${defined(accounts[account], "an account")}'::uuid, 'Automatic', ${amount}::bigint)`
														),
														", "
													)}`,
													params: []
												}
											])
								])
								for (const form of forms) {
									const built = conditional(form, c.threshold)
									const query = conservativeInput(built)
									const composed = yield* runProgram(conservative(query, schema), {})
									const base = defined(composed[0], "the composition's statement")
									const { facts } = shapedFacts(built.dag, {}, "placement")
									const shapedRuns = yield* runProgram(
										shapedProgram(query, facts, testOptions(schema)),
										{}
									)
									const shaped = defined(shapedRuns[0], "the shaped statement")
									unorderedEqual(shaped.text, base.text, `${form} > ${c.threshold}`)
									if (form === "int4") {
										for (const [account, passed] of base.columns) {
											k.note(
												qualifying(
													Number(passed),
													Arr.filter(c.tasks, ([a]) => accounts[a] === account).length
												)
											)
										}
									}
								}
							})
					)
				})
			)
	)

	it.effect(
		"an unsound fact in each shape reproduces a counterexample the sound facts do not",
		() =>
			Effect.gen(function* () {
				const schema = yield* installed
				const options = testOptions(schema)
				/**
				 * Each shape is driven by the facts of an analysis whose placement leaves the shape's own obligation to the
				 * shape (`shapes`), so its input carries the repeats Posting's (A, 100) and the overlapping manual arms
				 * give it; the mutant states the uniqueness or exactness the elision would need.
				 */
				const unique = { unique: () => true }
				const perParent = { childUniquePerParent: () => true, keyedBy: () => true }
				/** A query of no parameters, its statements compared in order where `ordered` lists them. */
				const program = (
					query: LogicalQuery,
					ordered: ReadonlyArray<number>,
					overrides: Partial<ShapeFacts>
				) =>
					Effect.gen(function* () {
						const base = yield* runProgram(conservative(conservativeInput(query), schema), {})
						const { facts } = shapedFacts(query.dag, overrides, "shapes")
						const shaped = yield* runProgram(
							shapedProgram(conservativeInput(query), facts, options),
							{}
						)
						return disagreements(base, shaped, ordered)
					})
				const topAmountsFaults = yield* program(topAmounts().query, [0], {})
				assert.deepEqual(topAmountsFaults, [])
				const topAmountsUnsound = yield* program(topAmounts().query, [0], unique)
				assert.ok(topAmountsUnsound.length > 0, "a unique fact the take does not have disagrees")
				/** take, row_number and DISTINCT ON over every group: (A, 100) ranks first and second. */
				const perGroup = (
					shape: "distinctOn" | "rowNumber",
					k: bigint,
					overrides: Partial<ShapeFacts>
				) =>
					Effect.gen(function* () {
						const built = amountsPerAccount({ kind: "literal", k })
						const composed = yield* runProgram(conservative(conservativeInput(built), schema), {})
						const base = defined(composed[0], "statement run")
						const { facts } = shapedFacts(built.dag, overrides, "shapes")
						const cx = context(built.dag, facts, options)
						const d = decorrelatedTake(takeOf(built.dag), cx, new Map(), facts, shape)
						const s = statementOf(cx, d.query, ["account", "amount"], {})
						const taken = yield* runText(s.text, 2, s.values)
						return disagreements([base], [taken], [])
					})
				const rowNumberFaults = yield* perGroup("rowNumber", 2n, {})
				assert.deepEqual(rowNumberFaults, [])
				const distinctOnFaults = yield* perGroup("distinctOn", 1n, {})
				assert.deepEqual(distinctOnFaults, [])
				const rowNumberUnsound = yield* perGroup("rowNumber", 2n, unique)
				assert.ok(
					rowNumberUnsound.length > 0,
					"a unique fact the per-group take does not have disagrees"
				)
				/** union: the delivered manual group repeats t2 under UNION ALL. */
				const group = (overrides: Partial<ShapeFacts>) =>
					Effect.gen(function* () {
						const built = tasksByKind({ kind: "every row" }, true)
						const union = built.dag.roots[0]
						if (union.kind !== "Union") {
							throw new Error("a union")
						}
						const composed = yield* runProgram(conservative(conservativeInput(built), schema), {})
						const base = defined(composed[1], "statement run")
						const { facts } = shapedFacts(built.dag, overrides, "shapes")
						const gx = context(built.dag, facts, options)
						const s = statementOf(
							gx,
							groupRows(gx, union, defined(union.groups[1]), new Map(), facts),
							["kind", "id"],
							{}
						)
						const grouped = yield* runText(s.text, 2, s.values)
						return disagreements([base], [grouped], [])
					})
				const groupFaults = yield* group({})
				assert.deepEqual(groupFaults, [])
				const groupUnsound = yield* group(unique)
				assert.ok(
					groupUnsound.length > 0,
					"a unique fact the delivered group does not have disagrees"
				)
				/** attach, pipelined and fused: A's children hold (A, 100) twice. */
				const attached = attachedOf(conservativeInput(accountsWithAmounts().query))
				const oracle = yield* oracleNested(attached, schema)
				const sound = shapedFacts(attached.query.dag, {}, "shapes").facts
				const unsound = shapedFacts(attached.query.dag, perParent, "shapes").facts
				const pipelinedSound = yield* pipelinedNested(attached, sound, schema)
				assert.deepEqual(nestedDisagreements(oracle, pipelinedSound, attached), [])
				const fusedSound = yield* fusedNested(attached, sound, schema)
				assert.deepEqual(nestedDisagreements(oracle, fusedSound, attached), [])
				const pipelinedUnsound = yield* pipelinedNested(attached, unsound, schema)
				const pipelined = nestedDisagreements(oracle, pipelinedUnsound, attached)
				assert.ok(pipelined.length > 0, "an unsound fact disagrees in the pipelined attachment")
				const fusedUnsound = yield* fusedNested(attached, unsound, schema)
				const fused = nestedDisagreements(oracle, fusedUnsound, attached)
				assert.ok(fused.length > 0, "an unsound fact disagrees in the fused attachment")
			})
	)
})
