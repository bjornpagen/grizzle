/**
 * The set judge runs each of a rule's probes once (physical/ddl/rules.ts addRules): in each of its guarded blocks, a
 * rule's probes over one table's delta of one side, its rows as the transaction left them (its NEW probes) or as it found
 * them (its OLD probes), no two probes are one statement, so no COMMIT runs one query twice over one region.
 *
 * Each case is a containment of S's k in a derived relation D of T: D has one to three arms, each matching T by k and
 * holding its a to a literal of its own or not at all, and each arm may join U by k. T's delete withdraws a fact of D
 * through each arm that matches it, and each such occurrence is a probe (analysis/theory/query.ts oldProbes); the
 * probes of arms that hold nothing of T's row apart read one query, so the judge's block over T's removed rows holds that
 * statement once.
 *
 * Oracle: universal, a set: each guarded block of the judge holds every probe statement, printed as PostgreSQL reads it,
 * at most once.
 *
 * Features: a block whose table's probes outnumber its statements (two probes of one statement), and a block of two
 * statements or more.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { oldProbes, type TouchedField } from "#compiler/analysis/theory/query.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import type { PlStatement } from "#compiler/sql/ast.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"
import { owner } from "#test/unit/physical/fixtures.ts"

/** One case: D's arms, whether each holds T's a to a literal of its own, and whether each joins U by k. */
interface Shape {
	readonly arms: 1 | 2 | 3
	readonly literal: boolean
	readonly joined: boolean
}

const shapeGen: Gen<Shape> = (s) => ({
	arms: s.draw(element<Shape["arms"]>([1, 2, 3])),
	literal: s.draw(boolean),
	joined: s.draw(boolean)
})

type Reached = "a block whose probes outnumber its statements" | "a block of two statements"

/** The schema of a shape: T, U and S on a base level, D over them and S's containment in it above. */
const schemaOf = (shape: Shape) => {
	const T = relation("T", { k: pg.integer, a: pg.integer }, ["k"])
	const U = relation("U", { k: pg.integer }, ["k"])
	const S = relation("S", { k: pg.integer }, ["k"])
	const Base = schema("rule_probes", [T, U, S], [])
	const first = query(Base).rule((r) => {
		const { k } = v(T, "t")
		const held = r.match(T, shape.literal ? { k, a: 1 } : { k })
		return (shape.joined ? held.match(U, { k }) : held).find({ k })
	})
	const second = first.rule((r) => {
		const { k } = v(T, "t")
		const held = r.match(T, shape.literal ? { k, a: 2 } : { k })
		return (shape.joined ? held.match(U, { k }) : held).find({ k })
	})
	const third = second.rule((r) => {
		const { k } = v(T, "t")
		const held = r.match(T, shape.literal ? { k, a: 3 } : { k })
		return (shape.joined ? held.match(U, { k }) : held).find({ k })
	})
	const D = derived("D", shape.arms === 1 ? first : shape.arms === 2 ? second : third)
	return schema.extend(Base, "rule_probes_1", [D], [contained(on(S, "k"), on(D, "k"))])
}

/** A guarded block of the judge: whether it reads a delta of removed rows, the one a DELETE or an UPDATE fills, and its
 * probe statements, each printed as PostgreSQL reads it. */
interface Block {
	readonly olds: boolean
	readonly statements: ReadonlyArray<string>
}

/** The guarded blocks of the judge's body: each IF's branches, a tamper check's holding no probe statement. */
const blocksOf = (body: ReadonlyArray<PlStatement>): ReadonlyArray<Block> =>
	Arr.flatMap(body, (s) =>
		s.kind === "if"
			? Arr.map(s.branches, (b): Block => ({
					olds: Str.includes("__delta_olds_")(printExpr(b.condition)),
					statements: Arr.flatMap(b.body, (p) =>
						p.kind === "if" ? Arr.map(p.branches, (inner) => printExpr(inner.condition)) : []
					)
				}))
			: []
	)

/** Judges the judge of `shape`'s installation. */
const judged = (shape: Shape, note: (r: Reached) => void): void => {
	const built = schemaOf(shape)
	const owned = owning(built)
	const installation = succeeded(compileInstallation(owned, installOptions(owned, owner)))
	/** The OLD probes of every rule trigger's table, each occurrence of the touched relation one (oldProbes). */
	const probes = Arr.reduce(succeeded(testArtifacts(built, testCompile)).laws.rules, 0, (n, rule) =>
		Arr.reduce(rule.tables, n, (m, table) =>
			table.touches.kind === "news"
				? m
				: m +
					oldProbes(
						rule.rule,
						table.relation.name,
						Arr.map(table.relation.fields, (f): TouchedField => ({ name: f.name, desc: f.desc })),
						rule.law.loc
					).length
		)
	)
	let statements = 0
	for (const object of installation.manifest.objects) {
		const [fn] = object.ddl
		if (object.kind !== "ruleJudge" || fn?.kind !== "createFunction" || fn.language !== "plpgsql") {
			continue
		}
		for (const block of blocksOf(fn.body.body)) {
			assert.equal(
				new Set(block.statements).size,
				block.statements.length,
				`${object.ident}: each probe statement once in its guarded block`
			)
			if (block.statements.length >= 2) {
				note("a block of two statements")
			}
			if (block.olds) {
				statements += block.statements.length
			}
		}
	}
	if (probes > statements) {
		note("a block whose probes outnumber its statements")
	}
}

describe("the set judge", () => {
	it.effect("runs each probe statement once in each guarded block", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/physical/rule-probes",
					generator: shapeGen,
					literal: Formatter.format,
					box: "every containment of S in a derived relation of T of one to three arms, each holding T's a to a literal of its own or not at all, each joining U by k or not",
					oracle: {
						kind: "universal",
						name: "a set: each guarded block holds every probe statement, as printed, at most once"
					},
					coverage: requiredInSpace<Reached>([
						"a block whose probes outnumber its statements",
						"a block of two statements"
					]),
					caseHang,
					concurrency: 1
				},
				(shape, c) => Effect.sync(() => judged(shape, c.note))
			)
		)
	)
})
