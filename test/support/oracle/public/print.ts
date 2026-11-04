import { Array as Arr, Formatter } from "effect"
import { moneyMinorUnits } from "#compiler/ir/carriers.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { SpelledValue } from "#test/support/oracle/gen/domain.ts"
import { printPerturbation } from "#test/support/oracle/perturb.ts"
import {
	type ArgTerm,
	type ProgramCase,
	type Comparison,
	type ComputedTerm,
	type ProgramFact,
	type StoredFact,
	type HeadItem,
	type Operand,
	type OrderKey,
	type Padding,
	paddingBounds,
	type Param,
	type ParentColumn,
	powerBounds,
	type Query,
	type ProgramRead,
	type Rule,
	type Source,
	type StatedDelivery,
	unguarded,
	type Var
} from "#test/support/oracle/public/program.ts"

/** The items joined by `separator`, or `none` when there is no item. */
const listed = (items: ReadonlyArray<string>, separator: string, none: string): string =>
	items.length === 0 ? none : Arr.join(items, separator)

const literal = (l: TypedLiteral): string => {
	switch (l.kind) {
		case "int":
			return `${l.value}`
		case "numeric":
			return `${decimalPayload(l.value)}d`
		case "float":
			return `${l.value}f`
		case "floatSpecial":
			return l.value
		case "money":
			return `$${moneyMinorUnits(l.value)}`
		case "bool":
			return `${l.value}`
		case "text":
		case "uuid":
			return Formatter.format(l.value)
		case "enum":
			return l.handle
		case "span":
			return `[${l.start},${l.end})`
		case "vector":
			return l.value.toString()
	}
}

const printValue = (l: TypedLiteral | undefined): string =>
	l === undefined ? "missing" : literal(l)

const variable = (v: Var): string => `v${v.id}`

/** A parameter as its rule declares it: with its field's own descriptor, or with its base's. */
const param = (p: Param): string =>
	`r.param(${Formatter.format(p.name)}, ${p.declaration.kind === "field" ? p.declaration.field.kind : `base ${p.type.carrier}`})`

const operand = (o: Operand<ParentColumn>): string => {
	switch (o.kind) {
		case "var":
			return variable(o.var)
		case "literal":
			return literal(o.literal)
		case "param":
			return param(o.param)
		case "parent":
			return `p.${o.column.name}`
	}
}

/** A padding as its guarded casts write it, its bounds paddingBounds. */
const padding = (p: Padding): string => {
	const v = variable(p.arg)
	const [low, high] = paddingBounds(p.arg.field.type)
	return `Compute.when(Compute.within(${v}, ${literal(low)}, ${literal(high)}), (${v}) => Compute.cast(Compute.cast(${v}, pg.numeric(1000, ${p.scale})), pg.numeric), Compute.cast(${v}, pg.numeric))`
}

const argTerm = (a: ArgTerm): string => (a.kind === "var" ? variable(a.var) : padding(a.padding))

const computed = (t: ComputedTerm): string => {
	switch (t.kind) {
		case "base":
			return `Compute.base(${variable(t.arg)})`
		case "cast numeric":
			return `Compute.cast(${variable(t.arg)}, pg.numeric)`
		case "cond":
			return `Compute.cond(r.${t.op}(${variable(t.arg)}, ${literal(t.than)}), ${variable(t.arg)}, ${literal(t.otherwise)})`
		case "padded":
			return padding(t.padding)
		case "div":
			return `Compute.div(${argTerm(t.dividend)}, ${literal(t.divisor)})`
		case "sqrt": {
			const a = argTerm(t.radicand)
			return `Compute.when(Compute.nonnegative(${a}), (a) => Compute.sqrt(a), ${literal(unguarded)})`
		}
		case "power": {
			const a = argTerm(t.base)
			const [low, high] = powerBounds
			return `Compute.when(Compute.within(${a}, ${literal(low)}, ${literal(high)}), (a) => Compute.power(a, ${literal(t.exponent)}), ${literal(unguarded)})`
		}
	}
}

const head = (h: HeadItem): string => {
	switch (h.kind) {
		case "var":
			return `${h.name}: ${variable(h.var)}`
		case "count":
			return `${h.name}: r.count()`
		case "fold":
			return `${h.name}: r.${h.fn}(${argTerm(h.arg)})`
		case "computed":
			return `${h.name}: ${computed(h.term)}`
		case "literal":
			return `${h.name}: ${literal(h.literal)}`
	}
}

/**
 * A match's source as the rule writes it: a relation or the roster by name, an earlier read's query qN bound, an
 * interior stage, a relation parameter, or a closure.
 */
const source = (s: Source): string => {
	switch (s.kind) {
		case "stored":
		case "roster":
			return s.name
		case "import":
			return s.binds.length === 0
				? `q${s.read}${s.query.attachments.length > 0 ? "" : " (without its attachments)"}`
				: `q${s.read}${s.query.attachments.length > 0 ? "" : " (without its attachments)"}.bind({ ${Arr.join(
						Arr.map(
							s.binds,
							(b) =>
								`${b.param.name}: ${b.to.kind === "var" ? variable(b.to.var) : param(b.to.param)}`
						),
						", "
					)} })`
		case "interior":
			return `r.interior((r) => ${rule(s.rule)})`
		case "relation param":
			return `r.relation(${Formatter.format(s.param.name)}, ${s.param.relation.name})`
		case "closure":
			return `query(S).recursive(${Formatter.format(s.name)}, closure of ${s.edge.name} from ${s.from.name} to ${s.to.name} where ${s.from.name} < ${s.to.name})`
	}
}

const rule = (r: Rule<ParentColumn>): string => {
	const matches = Arr.map(
		r.matches,
		(m) =>
			`.match(${source(m.source)}, { ${Arr.join(
				Arr.map(m.bindings, (b) => `${b.field.name}: ${operand(b.operand)}`),
				", "
			)} })`
	)
	const comparison = (c: Comparison): string =>
		`r.${c.op}(${variable(c.left)}, ${operand(c.right)})`
	const where = [
		...Arr.map(r.where, comparison),
		...Arr.map(
			r.between,
			(b) => `r.between(${variable(b.left)}, ${operand(b.low)}, ${operand(b.high)})`
		),
		...Arr.map(
			r.inSets,
			(s) => `r.inSet(${variable(s.left)}, [${Arr.join(Arr.map(s.values, literal), ", ")}])`
		),
		...Arr.map(r.allens, (a) => `r.allen(${variable(a.left)}, ${a.mask}, ${variable(a.right)})`),
		...Arr.map(r.pointIns, (p) => `r.pointIn(${variable(p.point)}, ${variable(p.span)})`),
		...Arr.map(r.connectives, (j) => `r.${j.kind}(${Arr.join(Arr.map(j.args, comparison), ", ")})`),
		...Arr.map(
			r.negations,
			(n) =>
				`r.not(${n.source.name}, { ${Arr.join(
					Arr.map(n.bindings, (b) => `${b.field.name}: ${variable(b.var)}`),
					", "
				)} })`
		)
	]
	return `r${Arr.join(matches, "")}${where.length === 0 ? "" : `.where(${Arr.join(where, ", ")})`}.find({ ${Arr.join(Arr.map(r.head, head), ", ")} })`
}

const delivery = (d: StatedDelivery): string =>
	d.kind === "arm"
		? `arm(${Formatter.format(d.field.name)}, ${Formatter.format(d.handle)})`
		: Formatter.format(d.kind)

const order = (keys: ReadonlyArray<OrderKey>): string =>
	Arr.join(
		Arr.map(keys, (k) => `[${Formatter.format(k.column.name)}, "${k.dir}"]`),
		", "
	)

const query = (q: Query<ParentColumn>, indent: string): string => {
	const lines = Arr.map(q.arms, (arm) => `${indent}.rule((r) => ${rule(arm)})`)
	if (q.bound.kind === "take") {
		lines.push(`${indent}.orderBy(${order(q.bound.order)}).take(${q.bound.k})`)
	}
	if (q.stage.kind === "named") {
		lines.push(`${indent}.named(${Formatter.format(q.stage.name)})`)
	}
	for (const a of q.attachments) {
		lines.push(
			`${indent}.attach(${Formatter.format(a.name)}, (p) => query(S)\n${query(a.child, `${indent}\t`)}, ${delivery(a.delivery)})`
		)
	}
	return Arr.join(lines, "\n")
}

const fact = (f: ProgramFact): string => `(${Arr.join(Arr.map(f, literal), ", ")})`

/** A stored value: its literal, and the twin spelling it is stored in where it is not its one form. */
const stored = (v: SpelledValue): string =>
	v.spelling.kind === "canonical"
		? literal(v.literal)
		: `${literal(v.literal)} stored as ${Formatter.format(v.spelling.text)}`

const storedFact = (f: StoredFact): string => `(${Arr.join(Arr.map(f, stored), ", ")})`

const read = (r: ProgramRead, i: number): string => {
	if (r.kind === "handle") {
		return `read ${i}: db.get(roster, { id: ${r.handle} })`
	}
	if (r.kind === "key") {
		return `read ${i}: db.get(${
			r.candidate
				? `key(${r.relation.name}, [${Arr.join(
						Arr.map(r.key, (f) => f.name),
						", "
					)}])`
				: r.relation.name
		}, { ${Arr.join(
			Arr.map(r.key, (f, k) => `${f.name}: ${printValue(r.values[k])}`),
			", "
		)} })`
	}
	if (r.kind === "mixed") {
		return Arr.join(
			[
				`read ${i}: q${i} = query(S), heading groups ${Arr.join(
					Arr.map(
						r.root.groups,
						(g) =>
							`(${Arr.join(
								Arr.map(g, (c) => c.name),
								", "
							)})`
					),
					" "
				)}`,
				...Arr.map(r.root.arms, (arm) => `\t.rule((r) => ${rule(arm.rule)})`)
			],
			"\n"
		)
	}
	const lines = [`read ${i}: q${i} = query(S)`, query(r.query, "\t")]
	if (r.query.delivery.kind === "ordered") {
		lines.push(
			`\t.orderBy(${order(r.query.delivery.order)}), paged by ${r.query.delivery.pageSize}`
		)
	}
	if (r.params.length > 0) {
		lines.push(
			`\tparams: ${Arr.join(
				Arr.map(r.params, (p) => `${p.name} = ${literal(p.value)}`),
				", "
			)}`
		)
	}
	for (const p of r.relations) {
		lines.push(`\trelation ${p.name}: ${listed(Arr.map(p.rows, fact), " ", "no row")}`)
	}
	if (r.probe.kind !== "none") {
		lines.push(`\tprobe: ${r.probe.kind}`)
	}
	return Arr.join(lines, "\n")
}

/**
 * A case as the builder calls an application would write, for a failure report: the schema, its facts, its planner
 * settings, and each read as its chain of calls with its parameters' values.
 */
export const printCase = (c: ProgramCase): string =>
	Arr.join(
		[
			"case:",
			`closed ${c.schema.roster.name} [${Arr.join(c.schema.roster.handles, ", ")}]`,
			...Arr.map(
				c.schema.relations,
				(r) =>
					`relation ${r.name} { ${Arr.join(
						Arr.map(r.fields, (f) => `${f.name}: ${f.kind}`),
						", "
					)} } key [${Arr.join(
						Arr.map(r.primaryKey, (f) => f.name),
						", "
					)}]${Arr.join(
						Arr.map(
							r.candidates,
							(k) =>
								` key(${Arr.join(
									Arr.map(k, (f) => f.name),
									", "
								)})`
						),
						""
					)}`
			),
			...Arr.map(
				c.schema.relations,
				(r) =>
					`facts ${r.name}: ${listed(Arr.map(c.facts.get(r.name) ?? [], storedFact), " ", "none")}`
			),
			printPerturbation(c.perturbation),
			`second reading: facts rotated by ${c.restorage.shift} and reversed, stored value ${c.restorage.respell} respelled`,
			...Arr.map(c.reads, read)
		],
		"\n"
	)
