/** What the property of meaning-identity.test.ts reads: its box of spellings, its schemas and its drafts. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, HashMap, Option } from "effect"
import { alterationStatement, type Step } from "#compiler/deploy/diff/plan.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import {
	type CanonicalRule,
	canonicalRules,
	canonicalizerOf,
	installationsOf,
	ownUnder,
	rostersOf
} from "#compiler/schema/own.ts"
import { nameKey, type SqlStatement } from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { installedCodes } from "#test/support/compile.ts"
import {
	check,
	closed,
	contained,
	eq,
	f,
	field,
	key,
	literal,
	on,
	onWhere,
	relation,
	type AuthoredStatementDesc,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import {
	asDrafted,
	compile,
	draftCodes,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { schemaDescIn } from "#test/support/policy.ts"

/**
 * A rule an earlier grizzle's canonical form lacked, and the two spellings of one predicate it alone makes one: the
 * first as such a grizzle stated it, the second as another statement of the same schema writes it.
 */
interface Spelled {
	readonly rule: CanonicalRule
	readonly spellings: readonly [ExprDesc, ExprDesc]
}

const n = field("n")
const m = field("m")
const kind = field("kind")
const int = (v: number): ExprDesc => literal(v)
const compare = (op: "lt" | "gt", left: ExprDesc, right: ExprDesc): ExprDesc => ({
	kind: "compare",
	op,
	left,
	right
})
const isIn = (arg: ExprDesc, values: Arr.NonEmptyReadonlyArray<string | number>): ExprDesc => ({
	kind: "in",
	arg,
	values
})
const or = (first: ExprDesc, second: ExprDesc): ExprDesc => ({ kind: "or", args: [first, second] })
const both = (first: ExprDesc, second: ExprDesc): ExprDesc => ({
	kind: "and",
	args: [first, second]
})

/** Each rule's two spellings of one predicate over R. */
const spelledBy: { readonly [R in CanonicalRule]: Spelled } = {
	orientation: { rule: "orientation", spellings: [compare("gt", n, m), compare("lt", m, n)] },
	connectives: {
		rule: "connectives",
		spellings: [or(eq(n, int(1)), eq(m, int(2))), or(eq(m, int(2)), eq(n, int(1)))]
	},
	conjuncts: {
		rule: "conjuncts",
		spellings: [
			both(compare("gt", n, int(0)), compare("gt", m, int(0))),
			both(compare("gt", m, int(0)), compare("gt", n, int(0)))
		]
	},
	inValues: { rule: "inValues", spellings: [isIn(n, [9, 7, 7]), isIn(n, [7, 9])] },
	inOfOne: { rule: "inOfOne", spellings: [isIn(kind, ["b"]), eq(kind, literal("b"))] }
}

/** The rules whose rewrite moves a predicate's SQL as well as its canonical text: every one but a membership of one,
 * which PostgreSQL stores as its equality and grizzle writes so (sql/build.ts isIn). A law column whose SQL a moved
 * rule reorders takes its new expression in place, where a membership of one moves no SQL at all. */
export const movesSql = (rule: CanonicalRule): boolean => rule !== "inOfOne"

/** A case: the rule the earlier grizzle lacked. */
export interface MeaningCase {
	readonly rule: CanonicalRule
}

export const meaningCases: Gen<MeaningCase> = (source) => ({
	rule: source.draw(element(canonicalRules))
})

/**
 * The case's schema: R and the roster Kind, S keyed by n; two keys over the rows of R the predicate keeps, each spelled
 * its own way, on a term of its own, so an earlier grizzle stated them under two canonical texts that today's form
 * makes one; a containment from the first's rows into S, on the first's term; and, where the rule moves no SQL, a row
 * check of the predicate. No two laws spelled apart share a term: an earlier grizzle's two law columns that today's
 * form makes one are one column, the other dropped, which no rename keeps.
 */
const schemaOf = (c: MeaningCase): SchemaDesc => {
	const [first, second] = spelledBy[c.rule].spellings
	const statements: ReadonlyArray<AuthoredStatementDesc> = [
		key(onWhere("R", ["m"], first)),
		key(onWhere("R", ["n"], second)),
		contained(onWhere("R", ["m"], first), on("S", ["n"])),
		...(movesSql(c.rule) ? [] : [check("Picked", "R", first)])
	]
	return {
		name: "Meaning",
		relations: [
			closed.ordered("Kind", ["a", "b", "c"]),
			relation("R", { id: f.integer, kind: f.closedId("Kind"), n: f.integer, m: f.integer }, [
				"id"
			]),
			relation("S", { n: f.integer }, ["n"])
		],
		statements,
		extends: undefined
	}
}

/** The case's first installation, drafted from nothing by a grizzle whose canonical form lacked the case's rule. */
const earlierInstallation = (c: MeaningCase): Installation => {
	const owned = succeeded(
		ownUnder(
			succeeded(schemaDescIn(schemaOf(c))),
			canonicalizerOf(new Set(Arr.filter(canonicalRules, (r) => r !== c.rule)))
		)
	)
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], firstCodebook(rostersOf(owned)))
		)
	)
}

/** What a case drafts: the earlier grizzle's snapshot, today's compile of the same schema, and the follow-up from the one
 * to the other. */
export interface MeaningDraft {
	readonly earlier: DeploySnapshot
	readonly today: Installation
	readonly steps: ReadonlyArray<Step>
}

export const draftedOf = (c: MeaningCase): MeaningDraft => {
	const earlier = succeeded(
		generate({
			installation: earlierInstallation(c),
			timestamp: draftedAt(1),
			previous: fromEmpty,
			workload: noWorkload,
			declared: noDeclarations,
			name: "earlier"
		})
	).snapshot
	const codes = succeeded(draftCodes(schemaOf(c), fromSnapshot(earlier), noDeclarations))
	const today = compile(schemaOf(c), { ...asDrafted, codes: installedCodes(codes) })
	const followUp = succeeded(
		generate({
			installation: today,
			timestamp: draftedAt(2),
			previous: fromSnapshot(earlier),
			workload: noWorkload,
			declared: noDeclarations,
			name: "today"
		})
	)
	return { earlier, today, steps: followUp.plan.steps }
}

/** Every statement a plan's steps run, each alteration as the one ALTER TABLE it prints as. */
export const statementsOf = (steps: ReadonlyArray<Step>): ReadonlyArray<SqlStatement> =>
	Arr.flatMap(steps, (s): ReadonlyArray<SqlStatement> =>
		s.draft.kind === "statement"
			? [s.draft.statement]
			: s.draft.kind === "alteration"
				? [alterationStatement(s.draft.table, s.draft.actions)]
				: s.draft.kind === "confirm"
					? s.draft.keep
					: []
	)

/** What a follow-up statement does to what the earlier installation holds: renames it, comments it, re-expresses a
 * table's generated columns in place, or anything else, which builds, drops, validates or rewrites something. */
export type Move = "rename" | "comment" | "reexpress" | "other"

export const moveOf = (s: SqlStatement): Move =>
	s.kind === "rename" || s.kind === "renameColumn" || s.kind === "renameConstraint"
		? "rename"
		: s.kind === "comment"
			? "comment"
			: s.kind === "alterTable" && Arr.every(s.actions, (a) => a.kind === "setExpression")
				? "reexpress"
				: "other"

/** The tables a follow-up re-expresses, each with the count of its ALTER TABLEs that do. */
export const reexpressedTables = (
	statements: ReadonlyArray<SqlStatement>
): HashMap.HashMap<string, number> =>
	Arr.reduce(statements, HashMap.empty<string, number>(), (acc, s) =>
		s.kind === "alterTable" && moveOf(s) === "reexpress"
			? HashMap.set(
					acc,
					nameKey(s.table),
					Option.getOrElse(HashMap.get(acc, nameKey(s.table)), () => 0) + 1
				)
			: acc
	)
