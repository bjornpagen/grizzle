import { boolean, type Gen, int as intGen, map, option, uniqueArray } from "@grizzle/testing/gen"
import { Array as Arr, Option } from "effect"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { OpId, type TypedLiteral } from "#compiler/ir/expr.ts"
import { rewriteClaim } from "#compiler/ir/keys.ts"
import {
	conservativeMeta,
	type Heading,
	type MetaSpec,
	type RelNode,
	type VarDecl
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { bool, compareParamType, int4, scalarOfSpec } from "#test/support/oracle/gen/domain.ts"
import { type GenRelation, type GenSchema, schemaName } from "#test/support/oracle/gen/schema.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { present } from "#test/unit/lower/support.ts"

/**
 * Unrefined text: no pattern, so no byte bound, which is what makes a column wide payload (late-fetch widePayload).
 *
 * Wide-payload query cases for R06 late fetch.
 *
 * The query generator draws text only with the generated pattern's byte bound (gen/domain.ts), so none of its columns
 * is wide payload and R06 never fires on it. These cases carry what R06 is about: a bounded take whose stage holds an
 * unrefined text column beside a declared key, under an order that avoids the text. Each is an ordinary QueryCase, so
 * the reference evaluator and the PostgreSQL oracle run it like a generated one.
 *
 * The schema is Doc(id, body, score) keyed by id, and Ref(id, doc, n) keyed by id; body is unrefined text. The
 * installer declares every text field with the generated pattern (gen/domain.ts fieldDescOf), which every body below
 * satisfies, so the installed column holds exactly the values the unrefined field holds. The stage is a region over
 * Doc, optionally joined to Ref, optionally filtered and optionally renamed; the take orders by score in either
 * direction, then a key, so its order is complete and ties in score are common, or, in a share of the
 * cases R06 must refuse, by the payload itself; the root is the take or a projection of it.
 */
const wideText: ScalarType = compareParamType(scalarOfSpec({ carrier: "text" }))

const relation = (
	name: string,
	columns: ReadonlyArray<readonly [string, ScalarType]>,
	primaryKey: ReadonlyArray<string>
): GenRelation => ({
	name,
	columns: Arr.map(columns, ([c, type]) => ({ name: c, type })),
	primaryKey,
	keys: [],
	mutable: false
})

const Doc = relation(
	"Doc",
	[
		["id", int4],
		["body", wideText],
		["score", int4]
	],
	["id"]
)

const Ref = relation(
	"Ref",
	[
		["id", int4],
		["doc", int4],
		["n", int4]
	],
	["id"]
)

const wideSchema: GenSchema = {
	name: schemaName,
	relations: [Doc, Ref],
	closed: [],
	containments: []
}

const int = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
const text = (s: string): TypedLiteral => ({ kind: "text", value: s })

/** Every value at most two code points, as the installed pattern requires. */
const bodies = ["", "a", "b", "ab", "é", "ba"] as const

const headingOf = (r: GenRelation): Heading =>
	Arr.map(r.columns, (c) => ({ name: c.name, type: c.type }))

interface WideSketch {
	readonly docs: ReadonlyArray<readonly [number, number, number]>
	readonly refs: ReadonlyArray<readonly [number, number, number]>
	readonly join: boolean
	readonly filter: number | undefined
	readonly rename: boolean
	readonly descending: boolean
	/** The order reads the payload, which R06 then refuses (the narrow tuple no longer decides the first k). */
	readonly orderBody: boolean
	readonly k: number
	readonly project: boolean
}

/** Up to six facts of one relation over ids 0..7, each id at most once. */
const factsGen = (
	second: number,
	third: number
): Gen<ReadonlyArray<readonly [number, number, number]>> =>
	uniqueArray(
		(source) =>
			[
				source.draw(intGen(0, 7)),
				source.draw(intGen(0, second)),
				source.draw(intGen(0, third))
			] as const,
		([id]) => id,
		{ min: 0, max: 6 },
		16
	)

const wideSketchGen: Gen<WideSketch> = (source) => ({
	docs: source.draw(factsGen(bodies.length - 1, 3)),
	refs: source.draw(factsGen(7, 2)),
	join: source.draw(boolean),
	filter: source.draw(map(option(intGen(0, 3)), Option.getOrUndefined)),
	rename: source.draw(boolean),
	descending: source.draw(boolean),
	orderBody: source.draw(map(intGen(0, 3), (n) => n === 0)),
	k: source.draw(intGen(1, 3)),
	project: source.draw(boolean)
})

const keyed = (key: ReadonlyArray<string>): MetaSpec => ({
	...conservativeMeta,
	logicalKeys: [rewriteClaim(key, [])]
})

const resolveWide = (s: WideSketch): QueryCase => {
	const b = new DagBuilder(makeIdSupply())
	const column = (node: RelNode, name: string, type: ScalarType) =>
		b.expr({
			kind: "column",
			column: { node: node.id, name },
			args: [],
			type,
			nonNull: "storage"
		})
	const base = (r: GenRelation) =>
		b.node({
			kind: "Base",
			relation: r.name,
			occurrence: b.ids.occurrence(),
			primaryKey: nonEmptyList(r.primaryKey, "a primary key"),
			keys: [],
			relationKind: "relation",
			heading: headingOf(r),
			loc: undefined,
			meta: conservativeMeta
		})
	const vars = new Map<string, VarDecl>()
	const v = (name: string, type: ScalarType): VarDecl => {
		const known = vars.get(name)
		if (known !== undefined) {
			return known
		}
		const made: VarDecl = { id: b.ids.var(), name, type }
		vars.set(name, made)
		return made
	}
	const docOcc = {
		id: b.ids.occurrence(),
		source: base(Doc),
		bindings: [
			{ column: "id", var: v("id", int4) },
			{ column: "body", var: v("body", wideText) },
			{ column: "score", var: v("score", int4) }
		],
		constants: []
	}
	const refOcc = s.join
		? {
				id: b.ids.occurrence(),
				source: base(Ref),
				bindings: [
					{ column: "id", var: v("rid", int4) },
					{ column: "doc", var: v("id", int4) }
				],
				constants: []
			}
		: undefined
	const occurrences = refOcc === undefined ? [docOcc] : [refOcc, docOcc]
	const names = s.join ? ["rid", "id", "body", "score"] : ["id", "body", "score"]
	const key = s.join ? "rid" : "id"
	const typeOf = (name: string): ScalarType => present(vars.get(name), `the variable ${name}`).type
	let stage = b.node({
		kind: "MatchRegion",
		scope: b.ids.scope(),
		vars: [...vars.values()],
		occurrences,
		equalities: [],
		correlated: [],
		heading: Arr.map(names, (name) => ({ name, type: typeOf(name) })),
		meta: keyed([key]),
		loc: undefined
	})
	let heading: Heading = Arr.map(names, (name) => ({ name, type: typeOf(name) }))
	if (s.filter !== undefined) {
		const pred = b.expr({
			kind: "op",
			op: OpId("int4ge"),
			args: [
				column(stage, "score", int4),
				b.expr({
					kind: "literal",
					value: int(s.filter),
					args: [],
					type: int4,
					nonNull: "literal"
				})
			],
			type: bool,
			nonNull: "strict",
			volatility: "immutable",
			failure: "total"
		})
		stage = b.node({
			kind: "Filter",
			input: stage,
			pred,
			heading,
			meta: keyed([key]),
			loc: undefined
		})
	}
	const rename = (name: string) => (s.rename ? `${name}_out` : name)
	if (s.rename) {
		const input = stage
		const out = Arr.map(heading, (c) => ({
			name: rename(c.name),
			expr: column(input, c.name, c.type)
		}))
		heading = Arr.map(heading, (c) => ({ name: rename(c.name), type: c.type }))
		stage = b.node({
			kind: "ProjectSet",
			input,
			out,
			heading,
			meta: keyed([rename(key)]),
			loc: undefined
		})
	}
	const take = b.node({
		kind: "Take",
		input: stage,
		order: {
			keys: [
				{ column: rename(s.orderBody ? "body" : "score"), dir: s.descending ? "desc" : "asc" },
				{ column: rename(key), dir: "asc" }
			]
		},
		bound: { kind: "literal", k: BigInt(s.k) },
		correlation: [],
		heading,
		meta: keyed([rename(key)]),
		loc: undefined
	})
	const root = s.project
		? b.node({
				kind: "ProjectSet",
				input: take,
				out: Arr.map([rename("id"), rename("body")], (name) => ({
					name,
					expr: column(take, name, name === rename("body") ? wideText : int4)
				})),
				heading: [
					{ name: rename("id"), type: int4 },
					{ name: rename("body"), type: wideText }
				],
				loc: undefined,
				meta: conservativeMeta
			})
		: take
	return {
		schema: wideSchema,
		facts: {
			Doc: Arr.map(s.docs, ([id, body, score]) => [
				int(id),
				text(present(bodies[body], `body ${body}`)),
				int(score)
			]),
			Ref: Arr.map(s.refs, ([id, doc, n]) => [int(id), int(doc), int(n)])
		},
		query: { dag: validateDag(b.build(Arr.of(root))), params: {} },
		spelling: { mode: "perCase", choices: [], edge: false }
	}
}

/** Wide-payload cases: a bounded take over unrefined text beside a declared key. */
export const wideCaseGen: Gen<QueryCase> = map(wideSketchGen, resolveWide)
