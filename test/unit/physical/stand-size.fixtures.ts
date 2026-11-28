/**
 * What stand-size.test.ts reads: the session tables each judged table's capture names, and those its stand-up makes,
 * itself and by the makers of the closures and shares it calls (physical/ddl/rules.ts addCapture, addStandUps), over the
 * stacks of upkeep-size.fixtures.ts, qti-pie's Node's shape: N, written, read by a stack of stored derivations one to
 * four levels deep, each over every derivation of the level below and N, then a stored D over T and the top, and a live
 * Linked over Link and the top under a check, so a write of N reaches, through the upkeeps, every stored relation above
 * it and every delta the judge reads beside theirs, as a write of qti.node reaches the 499 deltas of its closure. Beside
 * the stack, where the case says: W, X and Y, written, W's places contained in X's, a whole rule whose block reads W's
 * delta and X's with no stored relation's, and F, stored over X and contained in Y, whose upkeep reads X's deltas, so
 * F's closure holds X's, which W's stand-up needs too; and E, stored over T, a live Linked2 reading E across documents at
 * each link's target under the check Smaller, so E's closure holds T's and Link's deltas, which the stack's holds too.
 */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derivedBuilder, relationBuilder as relation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import {
	checkBuilder,
	containedBuilder,
	mutableBuilder,
	onBuilder,
	selectBuilder
} from "#compiler/schema/statements.ts"
import type { RowTerm, rowHelpers } from "#compiler/schema/terms.ts"
import type { PlFunction, PlStatement } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { capturedDeltasOf, filledBy, judgeStatementsOf } from "#test/support/judge.ts"
import { owning } from "#test/support/policy.ts"
import {
	Link,
	type Stack,
	stackGen,
	stackSchemaOf,
	T
} from "#test/unit/physical/upkeep-size.fixtures.ts"

/** The leads of the names of the judge's session tables: a delta's, the sentinel's and a marker's. */
const sessionLeads = ["__delta_", "__sentinel_", "__stood_"] as const

/** Whether `c` is a character of an installed identifier as grizzle mints it: a lowercase letter, a digit or `_`. */
const identifierChar = (c: string): boolean =>
	(c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_"

/** Every session table of the judge `text` names, quoted as an identifier or inside a literal: each run of identifier
 * characters that leads with a session table's lead. */
const sessionTablesIn = (text: string): ReadonlySet<string> => {
	const named = new Set<string>()
	let run = ""
	for (const c of `${text} `) {
		if (identifierChar(c)) {
			run += c
			continue
		}
		if (Arr.some(sessionLeads, (lead) => Str.startsWith(lead)(run))) {
			named.add(run)
		}
		run = ""
	}
	return named
}

/** Every statement of `body`, at any depth of the statements it stands under. */
const statementsIn = (body: ReadonlyArray<PlStatement>): ReadonlyArray<PlStatement> =>
	Arr.flatMap(body, (s): ReadonlyArray<PlStatement> => {
		switch (s.kind) {
			case "if":
				return [s, ...Arr.flatMap(s.branches, (b) => statementsIn(b.body)), ...statementsIn(s.else)]
			case "case":
				return [s, ...Arr.flatMap(s.whens, (w) => statementsIn(w.body))]
			case "forQuery":
			case "whenFound":
			case "wholeReads":
				return [s, ...statementsIn(s.body)]
			case "assign":
			case "createSessionIndex":
			case "createSessionTable":
			case "createSessionTrigger":
			case "modify":
			case "perform":
			case "raise":
			case "return":
			case "returnQuery":
			case "truncateSessionTable":
				return [s]
		}
	})

/** The session tables a function's body makes. */
const createdBy = (fn: PlFunction): ReadonlyArray<string> =>
	Arr.flatMap(statementsIn(fn.body.body), (s) => (s.kind === "createSessionTable" ? [s.name] : []))

/** The installation's functions a function calls, by name. */
const calledBy = (fn: PlFunction): ReadonlyArray<string> => {
	const called: Array<string> = []
	transformStatement(fn, {
		...identityHooks,
		functionRef: (ref) => {
			called.push(ref.name)
			return ref
		}
	})
	return called
}

/** What stands beside the stack (the header): nothing; W contained in X, beside F over X contained in Y; E and Linked2
 * under Smaller; or both. */
export type Beside = "nothing" | "W contained in X" | "E stored over T" | "both"

const besides = [
	"nothing",
	"W contained in X",
	"E stored over T",
	"both"
] as const satisfies ReadonlyArray<Beside>

/** A case: a stack, and what stands beside it. */
export interface StandCase {
	readonly stack: Stack
	readonly beside: Beside
}

export const standCaseGen: Gen<StandCase> = (s) => ({
	stack: s.draw(stackGen),
	beside: s.draw(element(besides))
})

/** W, X and Y, written, each mutable in its document. */
const W = relation("W", { doc: int4, at: int4, u: int4 }, ["doc", "at"], [])
const X = relation("X", { doc: int4, at: int4, x: int4 }, ["doc", "at"], [])
const Y = relation("Y", { doc: int4, at: int4 }, ["doc", "at"], [])

/** A row of a relation of field `F` as a row predicate reads it. */
type RowOf<F extends string> = { readonly [K in F]: RowTerm } & typeof rowHelpers

/**
 * The case's schema: the stack's, and beside it, where the case says, W's places of a non-negative value contained in
 * X's, a whole rule within the document, whose block reads W's side of news and X's of olds, and F, stored over X,
 * its places of a positive value contained in Y's, so F's upkeep reads X's deltas and F's closure holds them, which no
 * write of W reaches; and E, T's places of a positive value, stored, which Linked2 reads across documents at each
 * link's target under Smaller, so E's closure holds T's and Link's deltas, which the stack's holds too (the header).
 */
const schemaOf = (c: StandCase): AnySchema => {
	const stack: AnySchema = stackSchemaOf(c.stack)
	const contains = c.beside === "W contained in X" || c.beside === "both"
	const second = c.beside === "E stored over T" || c.beside === "both"
	if (!contains && !second) {
		return stack
	}
	const E = derivedBuilder(
		"E",
		query(stack).rule((r: RuleValue) => {
			const t = v(T, "t")
			return r
				.match(T, { doc: t["doc"], at: t["at"], w: t["w"] })
				.where(r.gt(t["w"], 0))
				.find({ doc: t["doc"], at: t["at"], w: t["w"] })
		}),
		[]
	)
	const below: AnySchema = schema.extend(
		[stack],
		"stand_size_beside",
		[...(contains ? [W, X, Y] : []), ...(second ? [E] : [])],
		contains
			? [
					mutableBuilder(W),
					mutableBuilder(X),
					mutableBuilder(Y),
					containedBuilder(
						onBuilder(
							selectBuilder(W, (w: RowOf<"u">) => w.ge(w.u, 0)),
							["doc", "at"]
						),
						onBuilder(X, ["doc", "at"])
					)
				]
			: [],
		[]
	)
	/** F under its containment in Y. */
	const contained = () => {
		const F = derivedBuilder(
			"F",
			query(below).rule((r: RuleValue) => {
				const x = v(X, "x")
				return r
					.match(X, { doc: x["doc"], at: x["at"], x: x["x"] })
					.where(r.gt(x["x"], 0))
					.find({ doc: x["doc"], at: x["at"], x: x["x"] })
			}),
			[]
		)
		return {
			derived: F,
			rule: containedBuilder(
				onBuilder(
					selectBuilder(F, (f: RowOf<"x">) => f.ge(f.x, 1)),
					["doc", "at"]
				),
				onBuilder(Y, ["doc", "at"])
			)
		}
	}
	/** Linked2 under Smaller. */
	const linked = () => {
		const Linked2 = derivedBuilder(
			"Linked2",
			query(below).rule((r: RuleValue) => {
				const link = v(Link, "link")
				const e = v(E, "e")
				return r
					.match(Link, {
						doc: link["doc"],
						at: link["at"],
						toDoc: link["toDoc"],
						toAt: link["toAt"]
					})
					.match(E, { doc: link["toDoc"], at: link["toAt"], w: e["w"] })
					.find({ doc: link["doc"], at: link["at"], w: e["w"] })
			}),
			[]
		)
		return {
			derived: Linked2,
			rule: checkBuilder("Smaller", Linked2, (row: RowOf<"w">) => row.le(row.w, 100))
		}
	}
	const read = [...(contains ? [contained()] : []), ...(second ? [linked()] : [])]
	return schema.extend(
		[below],
		"stand_size_read",
		Arr.map(read, (x) => x.derived),
		Arr.map(read, (x) => x.rule),
		[]
	)
}

/** A judged table as its capture and stand-up stand: the deltas its capture writes, the session tables its capture's
 * text names, and the session tables its stand-up makes, itself and by each maker it calls, at any depth. */
export interface JudgedStanding {
	readonly relation: string
	readonly own: ReadonlySet<string>
	readonly named: ReadonlySet<string>
	readonly made: ReadonlySet<string>
	/** The deltas its stand-up makes itself or by a share, and those the closures it calls make. */
	readonly apart: ReadonlySet<string>
	readonly closured: ReadonlySet<string>
	/** Whether an upkeep fills every delta its capture writes: a stored relation's, written inside the judge. */
	readonly upkept: boolean
	/** Every delta a statement of the judge reads or fills beside one of the table's own, and beside each delta an
	 * upkeep that runs fills, in turn: what the judge may read or write once a statement writes the table. */
	readonly reached: ReadonlySet<string>
}

/** Which makers call the share's maker of a delta some other maker needs too: a closure's and a table's stand-up, two
 * closures', or two tables' stand-ups. */
export type SharedBy = "a closure and a stand-up" | "two closures" | "two stand-ups"

/**
 * A case's installation as its captures and stand-ups stand: each judged table's, the sentinel, how many functions of
 * the installation make each delta's table, which makers call a share, and the bytes of its captures' and its
 * stand-ups' text.
 */
export interface StackStanding {
	readonly tables: ReadonlyArray<JudgedStanding>
	readonly sentinel: string
	readonly creates: ReadonlyMap<string, number>
	readonly shared: ReadonlySet<SharedBy>
	readonly bytes: { readonly captures: number; readonly standUps: number }
}

export const standingOf = (c: StandCase): StackStanding => {
	const owned = owning(schemaOf(c))
	const installation = succeeded(
		compileInstallation(owned, installOptions(owned)),
		"every case compiles"
	)
	const functions = new Map(
		Arr.flatMap(installation.statements, (s) =>
			s.kind === "createFunction" && s.language === "plpgsql" ? [[s.name.name, s] as const] : []
		)
	)
	const kindOf = new Map<string, string>(
		Arr.map(installation.identities, (named) => [identifierOf(named), named.kind] as const)
	)
	const calls = (name: string): ReadonlyArray<string> => {
		const fn = functions.get(name)
		return fn === undefined ? [] : Arr.filter(calledBy(fn), (called) => functions.has(called))
	}
	const createdIn = (name: string): ReadonlyArray<string> => {
		const fn = functions.get(name)
		return fn === undefined ? [] : createdBy(fn)
	}
	/** What `name` makes, itself and by every function it calls, at any depth. */
	const madeBy = (name: string): ReadonlySet<string> => {
		const made = new Set<string>()
		const seen = new Set<string>()
		const pending = [name]
		for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
			if (seen.has(at)) {
				continue
			}
			seen.add(at)
			for (const table of createdIn(at)) {
				made.add(table)
			}
			for (const called of calls(at)) {
				pending.push(called)
			}
		}
		return made
	}
	const textOf = (name: string): string => {
		const fn = functions.get(name)
		return fn === undefined ? "" : printStatement(fn)
	}
	const statements = judgeStatementsOf(installation)
	/** Each group of deltas a statement of the judge reads and fills. */
	const groups = Arr.map(statements, (s) => new Set([...s.deltas, ...filledBy(s)]))
	const filled = new Set(Arr.flatMap(statements, (s) => [...filledBy(s)]))
	const reachedFrom = (own: ReadonlySet<string>): ReadonlySet<string> => {
		const reached = new Set(own)
		const pending = [...own]
		for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
			for (const group of groups) {
				if (!group.has(at)) {
					continue
				}
				for (const d of group) {
					if (!reached.has(d)) {
						reached.add(d)
						if (filled.has(d)) {
							pending.push(d)
						}
					}
				}
			}
		}
		return reached
	}
	const made = Arr.flatMap([...functions.keys()], createdIn)
	const [sentinel = ""] = Arr.filter(made, Str.startsWith("__sentinel_"))
	/** The deltas the functions `called` make, at any depth. */
	const deltasBy = (called: ReadonlyArray<string>): ReadonlySet<string> =>
		new Set(
			Arr.flatMap(called, (name) => Arr.filter([...madeBy(name)], Str.startsWith("__delta_")))
		)
	const tables = Arr.map(installation.laws.judged, (relation): JudgedStanding => {
		const own = new Set(Arr.map(capturedDeltasOf(installation, relation), (d) => d.name))
		const standUp = identifierOf(identity.ruleStandUp(relation))
		const called = calls(standUp)
		return {
			relation,
			own,
			named: sessionTablesIn(textOf(identifierOf(identity.ruleCapture(relation)))),
			made: madeBy(standUp),
			apart: new Set([
				...Arr.filter(createdIn(standUp), Str.startsWith("__delta_")),
				...deltasBy(Arr.filter(called, (name) => kindOf.get(name) === "ruleShare"))
			]),
			closured: deltasBy(Arr.filter(called, (name) => kindOf.get(name) === "ruleClosure")),
			upkept: own.size > 0 && Arr.every([...own], (d) => filled.has(d)),
			reached: reachedFrom(own)
		}
	})
	const creates = new Map<string, number>()
	for (const name of Arr.filter(made, Str.startsWith("__delta_"))) {
		creates.set(name, (creates.get(name) ?? 0) + 1)
	}
	const shared = new Set<SharedBy>()
	for (const share of Arr.filter(
		[...functions.keys()],
		(name) => kindOf.get(name) === "ruleShare"
	)) {
		const callers = Arr.filter([...functions.keys()], (name) => Arr.contains(calls(name), share))
		const closures = Arr.filter(callers, (name) => kindOf.get(name) === "ruleClosure").length
		const standUps = Arr.filter(callers, (name) => kindOf.get(name) === "ruleStandUp").length
		if (closures > 0 && standUps > 0) {
			shared.add("a closure and a stand-up")
		}
		if (closures > 1) {
			shared.add("two closures")
		}
		if (standUps > 1) {
			shared.add("two stand-ups")
		}
	}
	const bytesOf = (lead: string): number =>
		Arr.reduce(
			Arr.filter([...functions.keys()], Str.startsWith(lead)),
			0,
			(n, name) => n + textOf(name).length
		)
	return {
		tables,
		sentinel,
		creates,
		shared,
		bytes: { captures: bytesOf("__capture_"), standUps: bytesOf("__stand_") }
	}
}
