/**
 * A comparison of texts that read no row field is a constant, and a schema holding one installs and judges each row by
 * its value, on PostgreSQL 19rc1, in a generated field, a row check and a selection alike.
 *
 * PostgreSQL pre-evaluates a function of constants while it checks a generation expression's immutability, before it
 * assigns the expression's collations, so a collatable comparison of constants there fails with 42P22
 * (upstream/generated-column-collation-before-planning). The persistent lowering prints every compound subterm that
 * reads no row as its value, which the host's exact evaluator computes as PostgreSQL does under pg_c_utf8: by code
 * points, NULL included.
 *
 * Each case draws a roster Kind of one to three handles; Pick, a closed relation of a text at a drawn subset of the
 * kinds, so a read at a kind it holds no row at is NULL; and a constant predicate over constant texts: literals over an
 * alphabet that orders by code point unlike by UTF-16 unit or by case (Z, a, b, é and 𝒳), Pick.at at a handle written
 * in the term, their concatenation and GREATEST (a check admits no LEAST); compared by =, <>, <, <=, > and >=, IN a list of literals,
 * starts_with and ends_with, under AND, OR and NOT. The predicate stands alone, or beside an arm that reads the row's
 * integer, under OR or AND, as GEN-NULL found it. Its positions, each its own relation:
 *
 * - a generated integer field, `Compute.cond(φ, n, m)`, a generation expression;
 * - a generated text field, a constant text term alone;
 * - a row check of φ;
 * - a key over the selection of φ, a law column `CASE WHEN φ THEN n END`, a generation expression;
 * - a containment of the selection of φ into a closed relation, a table CHECK guarded by φ.
 *
 * The oracle is the contract restated over the drawn texts: SQL's three-valued logic, a closed read at an absent key
 * NULL, texts ordered by code point. A list value is a bare literal, which adopts its subject's type and is judged by it,
 * and a concatenation is text of at most its operands' bytes together, a literal operand by its own (README,
 * Compute.concat), so a schema whose constant lists a value of more bytes than a concatenation of two literals is
 * refused at compile, ContractLiteral; any other schema must install. Each row written by grizzle's writer is accepted where
 * lawful and refused by its relation's one law otherwise, and every stored generated value is the model's.
 *
 * The planted bug, the lowering's constant folding turned off (~/.cache/grizzle-release/BR09/plants/
 * constant-texts-folding-off.patch), fails the installation of the first case whose generation expression compares
 * constant texts, with 42P22.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	element,
	type Gen,
	int,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, generated, pg } from "#compiler/public/fields.ts"
import {
	check,
	closed,
	contained,
	key,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Predicate, Term } from "#compiler/types/core/phantom.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"

const kindOf = (code: number): string => `k${code}`

type TextTerm =
	| { readonly kind: "literal"; readonly text: string }
	| { readonly kind: "pick"; readonly handle: number }
	| {
			readonly kind: "concat" | "greatest"
			readonly a: Atom
			readonly b: Atom
	  }

/** A text term of one node: a literal, or a closed read at a handle written in the term. */
type Atom = Extract<TextTerm, { readonly kind: "literal" | "pick" }>

const comparisons = ["eq", "ne", "lt", "le", "gt", "ge"] as const
type Comparison = (typeof comparisons)[number]

type Const =
	| {
			readonly kind: "compare"
			readonly op: Comparison
			readonly a: TextTerm
			readonly b: TextTerm
	  }
	| { readonly kind: "in"; readonly a: TextTerm; readonly values: NonEmptyReadonlyArray<string> }
	| { readonly kind: "startsWith" | "endsWith"; readonly a: TextTerm; readonly b: TextTerm }
	| { readonly kind: "and" | "or"; readonly args: readonly [Const, Const] }
	| { readonly kind: "not"; readonly arg: Const }

/** Where the constant stands: alone, or beside an arm that reads the row's integer, `n = at`. */
type Mixed = { readonly kind: "alone" } | { readonly kind: "or" | "and"; readonly at: number }

interface Phi {
	readonly constant: Const
	readonly mixed: Mixed
}

interface Item {
	readonly kind: number
	readonly n: number
	readonly m: number
}

interface ConstantCase {
	readonly kinds: number
	/** Pick's text at each kind, undefined where it holds no row. */
	readonly pick: ReadonlyArray<string | undefined>
	/** The kinds the closed relation Allowed holds, which the selection's containment reads. */
	readonly allowed: ReadonlyArray<boolean>
	readonly generated: Phi
	readonly text: TextTerm
	readonly checked: Phi
	readonly keyed: Phi
	readonly contained: Phi
	readonly items: NonEmptyReadonlyArray<Item>
}

/** A text of up to three code points from boxes that order by code point unlike by case or by UTF-16 unit. */
const textGen: Gen<string> = string(
	oneOf([
		codePoint(0x5a, 0x5a),
		codePoint(0x61, 0x62),
		codePoint(0xe9, 0xe9),
		codePoint(0x1d4b3, 0x1d4b3)
	]),
	{ min: 0, max: 3 }
)

const atomGen = (kinds: number): Gen<Atom> =>
	oneOf<Atom>([
		(s) => ({ kind: "literal", text: s.draw(textGen) }),
		(s) => ({ kind: "pick", handle: s.draw(int(0, kinds - 1)) })
	])

const textTermGen = (kinds: number): Gen<TextTerm> =>
	weighted<TextTerm>([
		[3, atomGen(kinds)],
		[
			2,
			(s) => ({
				kind: s.draw(element(["concat", "greatest"] as const)),
				a: s.draw(atomGen(kinds)),
				b: s.draw(atomGen(kinds))
			})
		]
	])

const constGen = (kinds: number, depth: number): Gen<Const> => {
	const term = textTermGen(kinds)
	const leaf = oneOf<Const>([
		(s) => ({
			kind: "compare",
			op: s.draw(element(comparisons)),
			a: s.draw(term),
			b: s.draw(term)
		}),
		(s) => ({
			kind: "in",
			a: s.draw(term),
			values: [s.draw(textGen), ...s.draw(array(textGen, { min: 0, max: 2 }))]
		}),
		(s) => ({
			kind: s.draw(element(["startsWith", "endsWith"] as const)),
			a: s.draw(term),
			b: s.draw(term)
		})
	])
	return depth === 0
		? leaf
		: weighted<Const>([
				[3, leaf],
				[
					1,
					(s) => ({
						kind: s.draw(element(["and", "or"] as const)),
						args: [s.draw(constGen(kinds, depth - 1)), s.draw(constGen(kinds, depth - 1))]
					})
				],
				[1, (s) => ({ kind: "not", arg: s.draw(constGen(kinds, depth - 1)) })]
			])
}

const phiGen =
	(kinds: number): Gen<Phi> =>
	(s) => ({
		constant: s.draw(constGen(kinds, 1)),
		mixed: s.draw(
			oneOf<Mixed>([
				() => ({ kind: "alone" }),
				(t) => ({ kind: t.draw(element(["or", "and"] as const)), at: t.draw(int(0, 2)) })
			])
		)
	})

const caseGen: Gen<ConstantCase> = (s) => {
	const kinds = s.draw(int(1, 3))
	const item: Gen<Item> = (t) => ({
		kind: t.draw(int(0, kinds - 1)),
		n: t.draw(int(0, 2)),
		m: t.draw(int(0, 2))
	})
	return {
		kinds,
		pick: upTo(kinds, () => (s.draw(boolean) ? s.draw(textGen) : undefined)),
		allowed: upTo(kinds, () => s.draw(boolean)),
		generated: s.draw(phiGen(kinds)),
		text: s.draw(textTermGen(kinds)),
		checked: s.draw(phiGen(kinds)),
		keyed: s.draw(phiGen(kinds)),
		contained: s.draw(phiGen(kinds)),
		items: [s.draw(item), ...s.draw(array(item, { min: 0, max: 3 }))]
	}
}

/** Kleene's truth values. */
type Truth = "true" | "false" | "unknown"

const truthOf = (holds: boolean): Truth => (holds ? "true" : "false")
const not = (t: Truth): Truth => (t === "unknown" ? t : t === "true" ? "false" : "true")
const both = (a: Truth, b: Truth): Truth =>
	a === "false" || b === "false" ? "false" : a === "true" && b === "true" ? "true" : "unknown"
const either = (a: Truth, b: Truth): Truth => not(both(not(a), not(b)))

/** Two texts' order by code point, pg_c_utf8's, which is their UTF-8 bytes' order: negative, zero or positive. */
const order = (a: string, b: string): number => {
	const x = new TextEncoder().encode(a)
	const y = new TextEncoder().encode(b)
	const differing = Arr.findFirstIndex(Arr.fromIterable(x), (byte, i) => byte !== y[i])
	if (Option.isSome(differing) && differing.value < y.length) {
		return (x[differing.value] ?? 0) - (y[differing.value] ?? 0)
	}
	return x.length - y.length
}

/** A text term's value, undefined where it is NULL: a read at a kind Pick holds no row at, and what is strict over one. */
const textOf = (c: ConstantCase, t: TextTerm): string | undefined => {
	switch (t.kind) {
		case "literal":
			return t.text
		case "pick":
			return c.pick[t.handle]
		case "concat": {
			const a = textOf(c, t.a)
			const b = textOf(c, t.b)
			return a === undefined || b === undefined ? undefined : a + b
		}
		case "greatest": {
			const values = Arr.filter([textOf(c, t.a), textOf(c, t.b)], (v) => v !== undefined)
			return Arr.reduce(values, undefined, (best: string | undefined, v: string) =>
				best === undefined || order(v, best) > 0 ? v : best
			)
		}
	}
}

const compared = (op: Comparison, d: number): boolean => {
	switch (op) {
		case "eq":
			return d === 0
		case "ne":
			return d !== 0
		case "lt":
			return d < 0
		case "le":
			return d <= 0
		case "gt":
			return d > 0
		case "ge":
			return d >= 0
	}
}

/** A constant's truth: SQL's three-valued logic over the texts. */
const constTruth = (c: ConstantCase, p: Const): Truth => {
	switch (p.kind) {
		case "compare": {
			const a = textOf(c, p.a)
			const b = textOf(c, p.b)
			return a === undefined || b === undefined ? "unknown" : truthOf(compared(p.op, order(a, b)))
		}
		case "in": {
			const a = textOf(c, p.a)
			return a === undefined ? "unknown" : truthOf(Arr.some(p.values, (v) => order(a, v) === 0))
		}
		case "startsWith":
		case "endsWith": {
			const a = textOf(c, p.a)
			const b = textOf(c, p.b)
			return a === undefined || b === undefined
				? "unknown"
				: truthOf(p.kind === "startsWith" ? Str.startsWith(b)(a) : Str.endsWith(b)(a))
		}
		case "and":
			return both(constTruth(c, p.args[0]), constTruth(c, p.args[1]))
		case "or":
			return either(constTruth(c, p.args[0]), constTruth(c, p.args[1]))
		case "not":
			return not(constTruth(c, p.arg))
	}
}

/** φ's truth over a row: the constant's, or beside the arm `n = at`. */
const phiTruth = (c: ConstantCase, phi: Phi, item: Item): Truth => {
	const constant = constTruth(c, phi.constant)
	switch (phi.mixed.kind) {
		case "alone":
			return constant
		case "or":
			return either(truthOf(item.n === phi.mixed.at), constant)
		case "and":
			return both(truthOf(item.n === phi.mixed.at), constant)
	}
}

/** Every closed read a constant states. */
const picksOf = (p: Const): ReadonlyArray<number> => {
	const ofTerm = (t: TextTerm): ReadonlyArray<number> =>
		t.kind === "pick" ? [t.handle] : t.kind === "literal" ? [] : [...ofTerm(t.a), ...ofTerm(t.b)]
	switch (p.kind) {
		case "compare":
		case "startsWith":
		case "endsWith":
			return [...ofTerm(p.a), ...ofTerm(p.b)]
		case "in":
			return ofTerm(p.a)
		case "and":
		case "or":
			return [...picksOf(p.args[0]), ...picksOf(p.args[1])]
		case "not":
			return picksOf(p.arg)
	}
}

/** A text's UTF-8 bytes. */
const bytesOf = (text: string): number => new TextEncoder().encode(text).length

/**
 * The bytes a text term's type bounds it within: a concatenation of two literals', each by its own bytes; none for any
 * other term, whose operands' types (Wild, Pick.at's) bound no bytes.
 */
const boundOf = (t: TextTerm): number | undefined =>
	t.kind === "concat" && t.a.kind === "literal" && t.b.kind === "literal"
		? bytesOf(t.a.text) + bytesOf(t.b.text)
		: undefined

/** Whether a constant lists a value of more bytes than its subject's type bounds, which no value of it can equal. */
const listsStray = (p: Const): boolean => {
	switch (p.kind) {
		case "in": {
			const bound = boundOf(p.a)
			return bound !== undefined && Arr.some(p.values, (v) => bytesOf(v) > bound)
		}
		case "compare":
		case "startsWith":
		case "endsWith":
			return false
		case "and":
		case "or":
			return listsStray(p.args[0]) || listsStray(p.args[1])
		case "not":
			return listsStray(p.arg)
	}
}

const Wild = str.regex("^.*$", "su")

/** A text term with the API's text type, whatever its node and whatever values its column delivers. */
type TextTermOf = Term<string, unknown, unknown, "text", unknown>

/**
 * The case's schema: Kind, Pick and Allowed, and a relation per position; and its full world's workload, an insert
 * into each written relation of the facts each call gives.
 */
const schemaOf = (c: ConstantCase) => {
	const Kind = closed("Kind", [kindOf(0), ...upTo(c.kinds - 1, (i) => kindOf(i + 1))])
	const Pick = closed.relation(
		"Pick",
		{ kind: closedId(Kind), t: Wild },
		["kind"],
		Arr.flatMap(c.pick, (t, kind) => (t === undefined ? [] : [{ kind: kindOf(kind), t }]))
	)
	const Allowed = closed.relation(
		"Allowed",
		{ kind: closedId(Kind) },
		["kind"],
		Arr.flatMap(c.allowed, (held, kind) => (held ? [{ kind: kindOf(kind) }] : []))
	)
	const atomOf = (t: Atom): TextTermOf =>
		t.kind === "literal" ? Compute.literal(Wild, t.text) : Pick.at("t", kindOf(t.handle))
	const termOf = (t: TextTerm): TextTermOf => {
		switch (t.kind) {
			case "literal":
			case "pick":
				return atomOf(t)
			case "concat":
				return Compute.concat(atomOf(t.a), atomOf(t.b))
			case "greatest":
				return Compute.greatest(atomOf(t.a), atomOf(t.b))
		}
	}
	const constOf = (p: Const): Predicate => {
		switch (p.kind) {
			case "compare":
				return Compute[p.op](termOf(p.a), termOf(p.b))
			case "in":
				return Compute.in(termOf(p.a), p.values)
			case "startsWith":
				return Compute.eq(Compute.startsWith(termOf(p.a), termOf(p.b)), true)
			case "endsWith":
				return Compute.eq(Compute.endsWith(termOf(p.a), termOf(p.b)), true)
			case "and":
				return Compute.and(constOf(p.args[0]), constOf(p.args[1]))
			case "or":
				return Compute.or(constOf(p.args[0]), constOf(p.args[1]))
			case "not":
				return Compute.not(constOf(p.arg))
		}
	}
	const fields = { id: pg.integer, kind: closedId(Kind), n: pg.integer, m: pg.integer }
	const itemOf = (name: string) => relation(name, fields, ["id"])
	type Row = { readonly n: Term<number, unknown, unknown, "integer"> }
	const phiOf = (phi: Phi, r: Row): Predicate => {
		const constant = constOf(phi.constant)
		switch (phi.mixed.kind) {
			case "alone":
				return constant
			case "or":
				return Compute.or(Compute.eq(r.n, phi.mixed.at), constant)
			case "and":
				return Compute.and(Compute.eq(r.n, phi.mixed.at), constant)
		}
	}
	const GenCond = relation.generated("GenCond", fields, ["id"], (r) => ({
		g: generated(pg.integer, Compute.cond(phiOf(c.generated, r), r.n, r.m))
	}))
	const GenText = relation.generated("GenText", fields, ["id"], () => ({
		g: generated(Wild, termOf(c.text))
	}))
	const Checked = itemOf("Checked")
	const Keyed = itemOf("Keyed")
	const Contained = itemOf("Contained")
	const statements = [
		check("Holds", Checked, (r) => phiOf(c.checked, r)),
		key(
			on(
				select(Keyed, (r) => phiOf(c.keyed, r)),
				"n"
			)
		),
		contained(
			on(
				select(Contained, (r) => phiOf(c.contained, r)),
				"kind"
			),
			on(Allowed, "kind")
		)
	] as const
	const Constants = schema(
		"Constants",
		{ Kind, Pick, Allowed, GenCond, GenText, Checked, Keyed, Contained },
		statements
	)
	return {
		GenCond,
		GenText,
		Constants,
		programs: {
			insertGenCond: ChangeSet.empty(Constants).insert(GenCond, []),
			insertGenText: ChangeSet.empty(Constants).insert(GenText, []),
			insertChecked: ChangeSet.empty(Constants).insert(Checked, []),
			insertContained: ChangeSet.empty(Constants).insert(Contained, []),
			insertKeyed: ChangeSet.empty(Constants).insert(Keyed, [])
		}
	}
}

type Feature =
	| `a constant ${Truth} in a generated field`
	| `a constant ${Truth} in a row check`
	| `a constant ${Truth} in a key's selection`
	| `a constant ${Truth} in a containment's selection`
	| "a constant beside a row arm"
	| "a closed read at a constant key it holds"
	| "a closed read at a constant key it holds no row at"
	| "a constant text generated"
	| "a NULL constant text generated, refused by its NOT NULL"
	| "a list value no value of its concatenation, refused"

const truths: ReadonlyArray<Truth> = ["true", "false", "unknown"]
const situations: NonEmptyReadonlyArray<Feature> = [
	"a constant beside a row arm",
	"a closed read at a constant key it holds",
	"a closed read at a constant key it holds no row at",
	"a constant text generated",
	"a NULL constant text generated, refused by its NOT NULL",
	...Arr.flatMap(truths, (t): ReadonlyArray<Feature> => [
		`a constant ${t} in a generated field`,
		`a constant ${t} in a row check`,
		`a constant ${t} in a key's selection`,
		`a constant ${t} in a containment's selection`
	])
]

/** Whether a law is `relation`'s one law. */
const namesLaw = (law: Law, relation: string): boolean => {
	switch (law.kind) {
		case "check":
		case "generated":
			return law.relation === relation
		case "contained":
			return law.from.relation === relation
		case "key":
			return law.side.relation === relation
		case "primaryKey":
		case "coverage":
		case "family":
		case "tree":
		case "above":
		case "fold":
		case "contract":
		case "pattern":
			return false
	}
}

/** Holds a write's outcome to the model's verdict: accepted where lawful, else refused by `relation`'s one law. */
const verdict = (
	applied: Result.Result<ApplyOutcome<unknown>, unknown>,
	relation: string,
	lawful: boolean,
	where: string
): void => {
	if (!Result.isSuccess(applied)) {
		return assert.fail(
			`${where}: the write is an outcome, not ${Formatter.format(applied.failure)}`
		)
	}
	const outcome = applied.success
	if (lawful) {
		return assert.equal(outcome.kind, "accepted", `${where} is lawful`)
	}
	if (outcome.kind !== "invariant-rejected") {
		return assert.fail(`${where} is unlawful, so refused, not ${outcome.kind}`)
	}
	assert.ok(
		Arr.every(refusedLaws(outcome.refused), (law) => namesLaw(law, relation)),
		`${where} is refused by ${relation}'s law, not ${Formatter.format(refusedLaws(outcome.refused))}`
	)
}

/** One case: its schema installed, each row written into each relation, and the generated values read back. */
const constantCase = (c: ConstantCase, notes: Case<Feature>) =>
	Effect.gen(function* () {
		const built = schemaOf(c)
		const install = installed(
			built.Constants,
			{},
			{ label: "constants", extensions: [], programs: built.programs }
		)
		if (
			Arr.some([c.generated, c.checked, c.keyed, c.contained], (phi) => listsStray(phi.constant))
		) {
			const refused = yield* Effect.flip(install)
			assert.ok(
				refused._tag === "CompileError" && refused.reason._tag === "ContractLiteral",
				`a list value no value of its concatenation is ContractLiteral, not ${Formatter.format(refused)}: ${Formatter.format(c)}`
			)
			notes.note("a list value no value of its concatenation, refused")
			return
		}
		const o = yield* install
		const names = namesOf(o.installed)
		const where = (relation: string, id: number) =>
			`${relation} row ${id} of ${Formatter.format(c)}`
		const fact = (item: Item, id: number) => ({ id, kind: kindOf(item.kind), n: item.n, m: item.m })
		const expected = yield* Effect.gen(function* () {
			const db = yield* Db.open(o.served.login.roles.app, {})
			const conds: Array<string> = []
			const texts: Array<string> = []
			const text = textOf(c, c.text)
			for (const [id, item] of c.items.entries()) {
				const t = phiTruth(c, c.generated, item)
				const genCond = yield* Effect.result(
					db.workload.insertGenCond.apply({ insert: { GenCond: [fact(item, id)] } }, {})
				)
				verdict(genCond, "GenCond", true, where("GenCond", id))
				conds.push(`${id} ${t === "true" ? item.n : item.m}`)
				notes.note(`a constant ${constTruth(c, c.generated.constant)} in a generated field`)
				const genText = yield* Effect.result(
					db.workload.insertGenText.apply({ insert: { GenText: [fact(item, id)] } }, {})
				)
				verdict(genText, "GenText", text !== undefined, where("GenText", id))
				if (text === undefined) {
					notes.note("a NULL constant text generated, refused by its NOT NULL")
				} else {
					texts.push(`${id} ${text}`)
					notes.note("a constant text generated")
				}
				const checked = yield* Effect.result(
					db.workload.insertChecked.apply({ insert: { Checked: [fact(item, id)] } }, {})
				)
				verdict(checked, "Checked", phiTruth(c, c.checked, item) === "true", where("Checked", id))
				notes.note(`a constant ${constTruth(c, c.checked.constant)} in a row check`)
				const inside = c.allowed[item.kind] === true
				const containedRow = yield* Effect.result(
					db.workload.insertContained.apply({ insert: { Contained: [fact(item, id)] } }, {})
				)
				verdict(
					containedRow,
					"Contained",
					phiTruth(c, c.contained, item) !== "true" || inside,
					where("Contained", id)
				)
				notes.note(`a constant ${constTruth(c, c.contained.constant)} in a containment's selection`)
			}
			const selected: Array<number> = []
			for (const [id, item] of c.items.entries()) {
				const t = phiTruth(c, c.keyed, item)
				const taken = t === "true" && selected.includes(item.n)
				const keyed = yield* Effect.result(
					db.workload.insertKeyed.apply({ insert: { Keyed: [fact(item, id)] } }, {})
				)
				verdict(keyed, "Keyed", !taken, where("Keyed", id))
				if (t === "true" && !taken) {
					selected.push(item.n)
				}
				notes.note(`a constant ${constTruth(c, c.keyed.constant)} in a key's selection`)
			}
			return { conds, texts }
		}).pipe(Effect.scoped, withLayer(o.served.layer))
		const s = yield* Substrate
		const owner = yield* s.session(ownerSession())
		const readBack = (target: typeof built.GenCond | typeof built.GenText) =>
			Effect.map(
				owner.values(
					`SELECT ${names.column(target, "id")}::text, ${names.column(target, "g")}::text FROM ${names.table(target)} ORDER BY ${names.column(target, "id")}`,
					[]
				),
				(rows): ReadonlyArray<string> => Arr.map(rows, (row) => Arr.join(Arr.map(row, String), " "))
			)
		const conds = yield* readBack(built.GenCond)
		const texts = yield* readBack(built.GenText)
		assert.deepEqual(
			conds,
			expected.conds,
			`GenCond stores n where φ is true and m elsewhere: ${Formatter.format(c)}`
		)
		assert.deepEqual(
			texts,
			expected.texts,
			`GenText stores the constant text: ${Formatter.format(c)}`
		)
		const phis = [c.generated, c.checked, c.keyed, c.contained]
		if (Arr.some(phis, (phi) => phi.mixed.kind !== "alone")) {
			notes.note("a constant beside a row arm")
		}
		const picks = Arr.flatMap(phis, (phi) => picksOf(phi.constant))
		if (Arr.some(picks, (h) => c.pick[h] !== undefined)) {
			notes.note("a closed read at a constant key it holds")
		}
		if (Arr.some(picks, (h) => c.pick[h] === undefined)) {
			notes.note("a closed read at a constant key it holds no row at")
		}
	}).pipe(Effect.scoped)

layer(Substrate.layer, { excludeTestServices: true })(
	"a comparison of texts that read no row",
	(it) => {
		it.effect("installs, and judges each row by its value, in every position", (ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/closed/constant-texts",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "SQL's three-valued logic over the drawn texts ordered by code point, a closed read at an absent key NULL, a list value longer than a concatenation of literals ContractLiteral, and a schema that compiles installs"
						},
						coverage: required<Feature>(situations, { cases: 48, sense: notesOnly }),
						kept: [
							{
								note: "a pin run's draw: '' || '' IN a list of U+1D4B3, four bytes opposite text of at most none, ContractLiteral",
								sketch: {
									kinds: 2,
									pick: [undefined, ""],
									allowed: [true, true],
									generated: {
										constant: {
											kind: "in",
											a: {
												kind: "concat",
												a: { kind: "literal", text: "" },
												b: { kind: "literal", text: "" }
											},
											values: ["\u{1d4b3}"]
										},
										mixed: { kind: "alone" }
									},
									text: {
										kind: "concat",
										a: { kind: "pick", handle: 0 },
										b: { kind: "literal", text: "" }
									},
									checked: {
										constant: {
											kind: "compare",
											op: "eq",
											a: { kind: "literal", text: "" },
											b: { kind: "literal", text: "" }
										},
										mixed: { kind: "alone" }
									},
									keyed: {
										constant: {
											kind: "compare",
											op: "eq",
											a: { kind: "literal", text: "" },
											b: { kind: "literal", text: "" }
										},
										mixed: { kind: "alone" }
									},
									contained: {
										constant: {
											kind: "compare",
											op: "eq",
											a: { kind: "literal", text: "" },
											b: { kind: "literal", text: "" }
										},
										mixed: { kind: "alone" }
									},
									items: [{ kind: 0, n: 0, m: 0 }]
								},
								draws: "",
								reaches: ["a list value no value of its concatenation, refused"]
							},
							{
								note: "GEN-NULL: a generated field whose condition ORs a row arm with 'ab' IN ('ab', 'bb'), and one comparing Pick.at at a handle written in the term with a literal",
								sketch: {
									kinds: 2,
									pick: ["b", undefined],
									allowed: [true, false],
									generated: {
										constant: {
											kind: "in",
											a: { kind: "literal", text: "ab" },
											values: ["ab", "bb"]
										},
										mixed: { kind: "or", at: 2 }
									},
									text: { kind: "pick", handle: 0 },
									checked: {
										constant: {
											kind: "compare",
											op: "eq",
											a: { kind: "pick", handle: 1 },
											b: { kind: "literal", text: "a" }
										},
										mixed: { kind: "alone" }
									},
									keyed: {
										constant: {
											kind: "compare",
											op: "eq",
											a: { kind: "pick", handle: 0 },
											b: { kind: "literal", text: "a" }
										},
										mixed: { kind: "alone" }
									},
									contained: {
										constant: {
											kind: "compare",
											op: "lt",
											a: { kind: "literal", text: "ab" },
											b: { kind: "literal", text: "bb" }
										},
										mixed: { kind: "alone" }
									},
									items: [
										{ kind: 0, n: 0, m: 1 },
										{ kind: 1, n: 0, m: 2 }
									]
								},
								draws: "",
								reaches: [
									"a constant true in a generated field",
									"a constant beside a row arm",
									"a closed read at a constant key it holds no row at"
								]
							}
						],
						runs: 24,
						shrink: boundedShrink(40),
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					constantCase
				)
			)
		)
	}
)
