import { Array as Arr, Option } from "effect"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import {
	conservativeMeta,
	type Heading,
	type HeadingColumn,
	type Occurrence,
	type RelNode,
	type VarDecl
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { int4, numeric, scalarOfSpec } from "#test/support/oracle/gen/domain.ts"
import type { GenFacts } from "#test/support/oracle/gen/facts.ts"
import { type GenParam, normalQuery } from "#test/support/oracle/gen/query.ts"
import { type GenRelation, type GenSchema, schemaName } from "#test/support/oracle/gen/schema.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import type { LabelledCase } from "#test/support/oracle/runner.ts"

export const text: ScalarType = scalarOfSpec({ carrier: "text" })

export const int = (v: number | bigint): TypedLiteral => ({ kind: "int", value: BigInt(v) })
export const dec = (v: string): TypedLiteral => ({ kind: "numeric", value: Decimal.of(v) })
export const str = (v: string): TypedLiteral => ({ kind: "text", value: v })
export const flt = (v: number): TypedLiteral => ({ kind: "float", value: v })

export const relation = (
	name: string,
	columns: ReadonlyArray<readonly [string, ScalarType]>,
	primaryKey: ReadonlyArray<string>,
	keys: ReadonlyArray<ReadonlyArray<string>>
): GenRelation => ({
	name,
	columns: Arr.map(columns, ([c, type]) => ({ name: c, type })),
	primaryKey,
	keys,
	mutable: false
})

export const posting = relation(
	"Posting",
	[
		["id", int4],
		["account", text],
		["amount", numeric]
	],
	["id"],
	[]
)
export const account = relation("Account", [["id", text]], ["id"], [])
const edge = relation(
	"Edge",
	[
		["src", int4],
		["dst", int4]
	],
	["src", "dst"],
	[]
)

const tagged = relation(
	"Tagged",
	[
		["k", int4],
		["v", text]
	],
	["k"],
	[]
)

export const schema: GenSchema = {
	name: schemaName,
	relations: [account, posting, edge, tagged],
	closed: [],
	containments: []
}

export const facts: GenFacts = {
	Account: [[str("A")], [str("B")], [str("C")]],
	Posting: [
		[int(1), str("A"), dec("10")],
		[int(2), str("A"), dec("10")],
		[int(3), str("B"), dec("5.0")]
	],
	Edge: [
		[int(1), int(2)],
		[int(2), int(3)],
		[int(1), int(3)]
	],
	Tagged: [
		[int(1), str("\u{E000}")],
		[int(2), str("\u{1F600}")],
		[int(3), str("a")]
	]
}

type Bind = string | { readonly literal: TypedLiteral } | null

/** The column of a heading named `name`; a fixture that names a column its input lacks is a broken fixture. */
const columnOf = (heading: Heading, name: string): HeadingColumn => {
	const c = Arr.findFirst(heading, (h) => h.name === name)
	if (Option.isNone(c)) {
		throw new Error(`no column ${name} in the heading`)
	}
	return c.value
}

/**
 * Hand-built query cases for the runner (test/pg/oracle/reference.test.ts): a tiny builder over DagBuilder that records exactly the IR the
 * checker produces for small rules, so a test states a query and its documented answer side by side.
 */
export class Q {
	readonly b = new DagBuilder(makeIdSupply())
	readonly params: Record<string, GenParam> = {}

	base(r: GenRelation): RelNode {
		return this.b.node({
			kind: "Base",
			loc: undefined,
			meta: conservativeMeta,
			relation: r.name,
			occurrence: this.b.ids.occurrence(),
			primaryKey: nonEmptyList(r.primaryKey, "a primary key"),
			keys: Arr.map(r.keys, (k) => nonEmptyList(k, "a candidate key")),
			relationKind: "relation",
			heading: Arr.map(r.columns, (c) => ({ name: c.name, type: c.type }))
		})
	}

	col(node: RelNode, name: string): ScalarExpr {
		const c = columnOf(node.heading, name)
		return this.b.expr({
			kind: "column",
			column: { node: node.id, name },
			args: [],
			type: c.type,
			nonNull: "storage"
		})
	}

	lit(value: TypedLiteral, type: ScalarType): ScalarExpr {
		return this.b.expr({
			kind: "literal",
			value,
			args: [],
			type,
			nonNull: "literal"
		})
	}

	/**
	 * A rule region: each occurrence binds its columns to variables by name, fixes them to a literal, or (null) leaves
	 * them existential.
	 */
	region(
		occurrences: ReadonlyArray<{
			readonly source: RelNode
			readonly bind: Readonly<Record<string, Bind>>
		}>
	): RelNode {
		/** Each variable once, by name, declared at its first binding: the object every binding of it holds. */
		const vars = new Map<string, VarDecl>()
		const varOf = (name: string, type: ScalarType): VarDecl => {
			const known = vars.get(name)
			if (known !== undefined) {
				return known
			}
			const declared: VarDecl = { id: this.b.ids.var(), name, type }
			vars.set(name, declared)
			return declared
		}
		const occ = Arr.map(occurrences, (o): Occurrence => {
			const id = this.b.ids.occurrence()
			const bindings: Array<{ readonly column: string; readonly var: VarDecl }> = []
			const constants: Array<{ readonly column: string; readonly expr: ScalarExpr }> = []
			for (const c of o.source.heading) {
				const bind = o.bind[c.name] ?? null
				if (bind === null) {
					continue
				}
				if (typeof bind === "string") {
					bindings.push({ column: c.name, var: varOf(bind, c.type) })
				} else {
					constants.push({ column: c.name, expr: this.lit(bind.literal, c.type) })
				}
			}
			return { id, source: o.source, bindings, constants }
		})
		return this.b.node({
			kind: "MatchRegion",
			loc: undefined,
			meta: conservativeMeta,
			scope: this.b.ids.scope(),
			vars: [...vars.values()],
			occurrences: occ,
			equalities: [],
			correlated: [],
			heading: Arr.map([...vars.values()], (v) => ({ name: v.name, type: v.type }))
		})
	}

	project(input: RelNode, out: ReadonlyArray<string>): RelNode {
		return this.b.node({
			kind: "ProjectSet",
			loc: undefined,
			meta: conservativeMeta,
			input,
			out: Arr.map(out, (name) => ({ name, expr: this.col(input, name) })),
			heading: Arr.map(out, (name) => {
				const h = columnOf(input.heading, name)
				return { name: h.name, type: h.type }
			})
		})
	}

	attach(
		parent: RelNode,
		child: RelNode,
		correlation: ReadonlyArray<readonly [string, string]>,
		name: string
	): RelNode {
		return this.b.node({
			kind: "Attach",
			loc: undefined,
			meta: conservativeMeta,
			parent,
			child,
			name,
			correlation: Arr.map(correlation, ([p, c]) => ({ parent: p, child: c })),
			delivered: "array",
			heading: parent.heading,
			order: undefined
		})
	}

	/** The case of `root` over `facts` installed under `schema`, printed with `label`. */
	case(root: RelNode, caseFacts: GenFacts, caseSchema: GenSchema, label: string): LabelledCase {
		return {
			schema: caseSchema,
			facts: caseFacts,
			query: { dag: normalQuery(this.b.build(Arr.of(root))), params: this.params },
			spelling: { mode: "perCase", choices: [], edge: false },
			label
		}
	}
}
