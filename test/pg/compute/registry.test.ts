/**
 * The Compute registry against PostgreSQL 19's catalog (scalar/compute/registry.ts): every entry names the operator,
 * function, cast, input function or constructor PostgreSQL has, with the operand types, result type and volatility the
 * catalog states, and no node has two entries over the same operands.
 *
 * Oracle: PostgreSQL itself, pg_operator, pg_proc, pg_cast and pg_type's rows for the object an entry names.
 *
 * Plants: compute-registry-int4pl-int8 (integer + integer is typed bigint).
 *
 * Features: an entry of each kind, operator, function, cast, input and construct.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Equivalence, Option, pipe, String as Str } from "effect"
import { describeOp } from "#compiler/ir/expr.ts"
import {
	type NativeOp,
	nativeOps,
	type Operands,
	operandCarriers
} from "#compiler/scalar/compute/registry.ts"
import { textCell } from "#test/pg/compute/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

const vectorSchema = "vector_ext"

const regtype = (name: string, extension: boolean): string =>
	extension && name === "vector" ? `${vectorSchema}.vector` : name

const volatilityOf = (code: string): "immutable" | "stable" =>
	code === "i" ? "immutable" : "stable"

type Catalog = NativeOp["catalog"]

const sameCarriers = Arr.makeEquivalence(Equivalence.strictEqual<string>())

/** Whether two nodes take the same operands: both positional over one list, or both variadic over one element. */
const sameOperands = (a: Operands, b: Operands): boolean =>
	a.kind === b.kind && sameCarriers(operandCarriers(a), operandCarriers(b))

/**
 * The namespaces of carriers' own overloads, whose OpIds prefix the code that implements them: the exact carriers'
 * over numeric's code, and a closed id's over smallint's (scalar/compute/registry.ts, "code:int2eq").
 */
const overloadNamespaces: ReadonlyArray<string> = ["exact:", "exactMoney:", "code:"]

/** The operator's code an entry's OpId lists: the id itself, or, for a carrier's own overload, the code it prefixes. */
const listedCode = (id: NativeOp["id"]): string => {
	const text = typeof id === "string" ? id : id.code
	return Option.match(
		Arr.findFirst(overloadNamespaces, (n) => Str.startsWith(n)(text)),
		{ onNone: () => text, onSome: (n) => Str.slice(n.length)(text) }
	)
}

/** What pg_operator says against an operator entry. */
const operatorProblems = (
	db: RawSession,
	op: NativeOp,
	c: Extract<Catalog, { readonly kind: "operator" }>
) =>
	Effect.gen(function* () {
		const ext = c.owner === "vector"
		const rows = yield* db.values(
			`SELECT o.oprcode::regproc::text, o.oprresult::regtype::text, p.provolatile::text
			FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_proc p ON p.oid = o.oprcode
			WHERE o.oprname = $1::text
				AND o.oprleft = (CASE WHEN $2::text = '-' THEN 0::oid ELSE $2::text::regtype::oid END)
				AND o.oprright = $3::text::regtype::oid`,
			[
				c.name,
				c.operands.kind === "prefix" ? "-" : regtype(c.operands.left, ext),
				regtype(c.operands.right, ext)
			]
		)
		const [row] = rows
		if (rows.length !== 1 || row === undefined) {
			return [
				`${describeOp(op.id)}: no operator ${c.name}(${c.operands.kind === "prefix" ? "" : c.operands.left}, ${c.operands.right})`
			]
		}
		const code = pipe(textCell(row, 0), Str.replace(`${vectorSchema}.`, ""))
		const listed = listedCode(op.id)
		return [
			...(code === listed ? [] : [`${describeOp(op.id)}: implemented by ${code}, not ${listed}`]),
			...(textCell(row, 1) === c.result
				? []
				: [`${describeOp(op.id)}: returns ${textCell(row, 1)}, not ${c.result}`]),
			...(volatilityOf(textCell(row, 2)) === op.volatility
				? []
				: [`${describeOp(op.id)}: volatility ${textCell(row, 2)}`])
		]
	})

/** What pg_proc says against a function entry. */
const functionProblems = (
	db: RawSession,
	op: NativeOp,
	c: Extract<Catalog, { readonly kind: "function" }>
) =>
	Effect.gen(function* () {
		const ext = c.owner === "vector"
		const signature = `${ext ? `${vectorSchema}.` : ""}${c.name}(${Arr.join(
			Arr.map(c.args, (a) => regtype(a, ext)),
			","
		)})`
		const [row] = yield* db.values(
			`SELECT p.prorettype::regtype::text, p.provolatile::text, p.prokind::text
			FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure($1::text)`,
			[signature]
		)
		if (row === undefined) {
			return [`${describeOp(op.id)}: no function ${signature}`]
		}
		const result = pipe(textCell(row, 0), Str.replace(`${vectorSchema}.`, ""))
		return [
			...(result === c.result
				? []
				: [`${describeOp(op.id)}: returns ${textCell(row, 0)}, not ${c.result}`]),
			...(volatilityOf(textCell(row, 1)) === op.volatility
				? []
				: [`${describeOp(op.id)}: volatility ${textCell(row, 1)}`]),
			...(textCell(row, 2) === "f" ? [] : [`${describeOp(op.id)}: prokind ${textCell(row, 2)}`])
		]
	})

/** What pg_cast says against a cast entry. */
const castProblems = (
	db: RawSession,
	op: NativeOp,
	c: Extract<Catalog, { readonly kind: "cast" }>
) =>
	Effect.gen(function* () {
		const [row] = yield* db.values(
			`SELECT p.provolatile::text FROM pg_catalog.pg_cast k JOIN pg_catalog.pg_proc p ON p.oid = k.castfunc
			WHERE k.castsource = $1::text::regtype::oid AND k.casttarget = $2::text::regtype::oid`,
			[c.source, c.target]
		)
		if (row === undefined) {
			return [`${describeOp(op.id)}: no cast ${c.source} -> ${c.target}`]
		}
		return volatilityOf(textCell(row, 0)) === op.volatility
			? []
			: [`${describeOp(op.id)}: volatility ${textCell(row, 0)}`]
	})

/** A volatility code's rank, immutable below stable below volatile. */
const volatilityRank = (code: string): number => (code === "i" ? 0 : code === "s" ? 1 : 2)

/**
 * What pg_type and pg_proc say against a parse's entry: an I/O conversion from text, which pg_cast lists for no type,
 * calls textout and then the target's input function, pg_type.typinput, so its volatility is the more volatile of the
 * two (nodeFuncs.c check_functions_in_node, CoerceViaIO).
 */
const inputProblems = (
	db: RawSession,
	op: NativeOp,
	c: Extract<Catalog, { readonly kind: "input" }>
) =>
	Effect.gen(function* () {
		const [row] = yield* db.values(
			`SELECT i.provolatile::text, o.provolatile::text,
				EXISTS (SELECT FROM pg_catalog.pg_cast k
					WHERE k.castsource = 'pg_catalog.text'::regtype AND k.casttarget = t.oid)::text
			FROM pg_catalog.pg_type t
			JOIN pg_catalog.pg_proc i ON i.oid = t.typinput
			JOIN pg_catalog.pg_proc o ON o.oid = 'pg_catalog.textout'::regproc
			WHERE t.oid = $1::text::regtype::oid`,
			[c.target]
		)
		if (row === undefined) {
			return [`${describeOp(op.id)}: no input function of ${c.target}`]
		}
		const [input, output] = [textCell(row, 0), textCell(row, 1)]
		const code = volatilityRank(input) >= volatilityRank(output) ? input : output
		return [
			...(textCell(row, 2) === "false"
				? []
				: [`${describeOp(op.id)}: pg_cast lists text -> ${c.target}, so it is no I/O conversion`]),
			...(volatilityOf(code) === op.volatility ? [] : [`${describeOp(op.id)}: volatility ${code}`])
		]
	})

/** What the catalog says against one entry: the object it names, its result type and its volatility. */
const entryProblems = (
	db: RawSession,
	op: NativeOp
): Effect.Effect<ReadonlyArray<string>, SqlError> => {
	const c = op.catalog
	switch (c.kind) {
		case "operator":
			return operatorProblems(db, op, c)
		case "function":
			return functionProblems(db, op, c)
		case "cast":
			return castProblems(db, op, c)
		case "input":
			return inputProblems(db, op, c)
		case "construct": {
			const missing = Arr.filter(c.uses, (use) => !Arr.some(nativeOps, (o) => o.id === use))
			return Effect.succeed(
				Arr.map(
					missing,
					(use) => `${describeOp(op.id)}: uses ${describeOp(use)}, which the registry lacks`
				)
			)
		}
	}
}

/** The catalog object an entry names, by its kind. */
type EntryKind = Catalog["kind"]

layer(Substrate.layer)("the Compute registry against pg_operator, pg_proc and pg_cast", (it) => {
	it.effect(
		"names the catalog's operator, function or cast for every entry, with its result type and volatility, once per node and operands",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					return yield* exhaust(
						{
							suite: "pg/compute/registry",
							generator: int(0, nativeOps.length - 1),
							literal: (i: number) => `${i}: ${describeOp(defined(nativeOps[i], "an entry").id)}`,
							box: "every entry of the Compute registry",
							oracle: {
								kind: "postgresql",
								name: "pg_operator, pg_proc, pg_cast and pg_type's entries for the object an entry names"
							},
							coverage: requiredInSpace<EntryKind>([
								"operator",
								"function",
								"cast",
								"input",
								"construct"
							]),
							caseHang
						},
						(i, c) =>
							Effect.gen(function* () {
								const op = defined(nativeOps[i], `entry ${i}`)
								const doubled =
									op.fn !== "cast" &&
									Arr.some(
										Arr.take(nativeOps, i),
										(o) => o.fn === op.fn && sameOperands(o.operands, op.operands)
									)
										? [
												`${describeOp(op.id)}: a second ${op.fn} over ${Arr.join(operandCarriers(op.operands), ", ")}`
											]
										: []
								const problems = yield* entryProblems(db, op)
								assert.deepEqual([...doubled, ...problems], [])
								c.note(op.catalog.kind)
							})
					)
				})
			)
	)
})
