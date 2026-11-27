import type * as Result from "@bjornpagen/grizzle-text/base/result"
import type { QueryRead } from "#compiler/check/checker.ts"
import { fail } from "#compiler/check/fail.ts"
import { entries } from "#compiler/check/scan.ts"
import type { CheckSession, QueryEntry } from "#compiler/check/session.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { childLoc, locBelow, type SourceLoc } from "#compiler/core/loc.ts"
import {
	exprChildren,
	type ImportDesc,
	type Inferred,
	type InferredExpr,
	type InferredHead,
	type InferredQuery,
	type InferredRule,
	type InferredSource,
	type InferredStage,
	type Located
} from "#compiler/ir/desc.ts"
import { armArgument, seriesArguments } from "#compiler/ir/rel.ts"

export interface StructureOptions {
	/**
	 * How the query is read (checker.ts QueryRead): a read-back's delta sources are in scope, a membership's row, and a
	 * page's parent variables the checker refuses as AttachedPage rather than as malformed.
	 */
	readonly read: QueryRead
	/** What the checks of its compile share (check/session.ts): each query whose structure they have validated. */
	readonly session: CheckSession
}

interface Context {
	readonly recursiveStep: boolean
	readonly attachment: boolean
}

/** The context a query's rules are read in, entered as `QueryEntry` says. */
const entered: Readonly<Record<QueryEntry, Context>> = {
	query: { recursiveStep: false, attachment: false },
	attachment: { recursiveStep: false, attachment: true }
}

class Structure {
	readonly options: StructureOptions

	constructor(options: StructureOptions) {
		this.options = options
	}

	/**
	 * A query entered as `entry`, validated once for the compile under this check's reading and that entry (CheckSession
	 * validated): its validity is a function of it, the reading and its entry alone, its rules' scopes its own and every
	 * location a refusal names one of its own nodes', so a query the compile validated so is valid wherever else it is
	 * read. It is recorded once its walk passes: a query refused is refused again at every reader that meets it.
	 */
	query(q: InferredQuery, entry: QueryEntry): void {
		const validated = this.options.session.validated[this.options.read][entry]
		if (validated.has(q)) {
			return
		}
		this.stage(q.stage, entered[entry])
		validated.add(q)
	}

	stage(s: InferredStage, cx: Context): void {
		switch (s.kind) {
			case "rules":
				for (const r of s.arms) {
					this.rule(r, cx)
				}
				return
			case "recursive":
				for (const r of s.recursive.base) {
					this.rule(r, { ...cx, recursiveStep: false })
				}
				for (const r of s.recursive.rec) {
					this.rule(r, { ...cx, recursiveStep: true })
				}
				return
			case "union":
				this.stage(s.input, cx)
				for (const r of s.arms) {
					this.rule(r, cx)
				}
				return
			case "attach":
				this.stage(s.input, cx)
				this.query(s.attach.child, "attachment")
				return
			case "named":
			case "order":
			case "take":
			case "approx":
				this.stage(s.input, cx)
				return
		}
	}

	rule(r: InferredRule, cx: Context): void {
		const vars = new Set(r.vars.map((v) => v.id))
		const interiors = new Set(r.interiors.map((i) => i.id))
		const expr = (e: InferredExpr, at: SourceLoc): void => {
			this.expr(e, vars, interiors, cx, at)
		}
		for (const m of r.matches) {
			this.source(m.source, vars, interiors, cx, m.loc)
			for (const [column, e] of entries(m.bindings)) {
				expr(e, childLoc(childLoc(m.loc, "bindings"), column))
			}
		}
		for (const [i, e] of r.where.entries()) {
			expr(e, childLoc(childLoc(r.loc, "where"), i))
		}
		for (const [key, h] of entries(r.head)) {
			this.head(h, vars, interiors, cx, childLoc(childLoc(r.loc, "head"), key))
		}
		for (const interior of r.interiors) {
			for (const arm of interior.arms) {
				this.rule(arm, { recursiveStep: false, attachment: false })
			}
		}
		for (const a of r.attach) {
			this.query(a.child, "attachment")
		}
	}

	head(
		h: InferredHead,
		vars: ReadonlySet<string>,
		interiors: ReadonlySet<string>,
		cx: Context,
		loc: SourceLoc
	): void {
		if (h.kind === "aggregate") {
			if (h.fn !== "count") {
				this.expr(h.arg, vars, interiors, cx, loc)
			}
			return
		}
		if (h.kind === "producer") {
			for (const [i, a] of h.args.entries()) {
				this.expr(a, vars, interiors, cx, childLoc(loc, i))
			}
			return
		}
		this.expr(h, vars, interiors, cx, loc)
	}

	/**
	 * An imported query is its own scope; only its bind map reads the importing rule.
	 */
	source(
		s: InferredSource,
		vars: ReadonlySet<string>,
		interiors: ReadonlySet<string>,
		cx: Context,
		loc: SourceLoc
	): void {
		switch (s.kind) {
			case "query":
			case "step":
				this.imported(s, vars, interiors, cx, loc)
				return
			case "interior":
				if (!interiors.has(s.id)) {
					fail(
						"MalformedDescription",
						loc,
						`an interior stage of this rule; ${JSON.stringify(s.id)} is not one`
					)
				}
				return
			case "self":
				if (!cx.recursiveStep) {
					fail("MalformedDescription", loc, "a self source inside a recursive step only")
				}
				return
			case "delta":
				if (this.options.read !== "readBack" && this.options.read !== "region") {
					fail(
						"MalformedDescription",
						loc,
						`a delta source inside a ChangeSet read-back only; delta.${s.side}(${s.relation}) reads a change`
					)
				}
				return
			case "row":
				if (this.options.read !== "membership") {
					fail(
						"MalformedDescription",
						loc,
						"a row source inside a write filter's membership only; a query reads no row"
					)
				}
				return
			case "call":
			case "callField":
				for (const [arg, a] of entries(s.args)) {
					const at = childLoc(childLoc(loc, "args"), arg)
					if (a.kind === "rows") {
						this.imported(a, vars, interiors, cx, at)
					} else {
						this.expr(a, vars, interiors, cx, at)
					}
				}
				return
			case "split":
				for (const [name, a] of Object.entries(s.args)) {
					this.expr(a, vars, interiors, cx, childLoc(loc, name))
				}
				return
			case "series":
				this.expr(s.low, vars, interiors, cx, childLoc(loc, seriesArguments.low))
				this.expr(s.high, vars, interiors, cx, childLoc(loc, seriesArguments.high))
				return
			case "arm":
				this.expr(s.value, vars, interiors, cx, childLoc(loc, armArgument))
				return
			case "relation":
			case "param":
			case "paramOf":
			case "context":
				return
		}
	}

	/**
	 * A query read under a bind map, an import's, a call's rows argument's or a relation parameter's bound rows: the
	 * query its own scope, and its bind map read in this one, a bound query's own bind map in turn.
	 */
	imported(
		s: ImportDesc<Located, Inferred>,
		vars: ReadonlySet<string>,
		interiors: ReadonlySet<string>,
		cx: Context,
		loc: SourceLoc
	): void {
		this.query(s.query, "query")
		for (const [param, e] of entries(s.bind)) {
			const at = childLoc(childLoc(loc, "bind"), param)
			if (e.kind === "rows") {
				this.imported(e, vars, interiors, cx, at)
			} else if (e.kind !== "relationParam") {
				this.expr(e, vars, interiors, cx, at)
			}
		}
	}

	expr(
		e: InferredExpr,
		vars: ReadonlySet<string>,
		interiors: ReadonlySet<string>,
		cx: Context,
		loc: SourceLoc
	): void {
		if (e.kind === "var") {
			if (!vars.has(e.var)) {
				fail(
					"MalformedDescription",
					loc,
					`a variable this rule declares; ${JSON.stringify(e.var)} is another scope's or no one's`
				)
			}
			return
		}
		if (e.kind === "parent") {
			if (!cx.attachment && this.options.read !== "page") {
				fail(
					"MalformedDescription",
					loc,
					`a parent variable inside an attachment's own rules; ${e.column} is read outside one`
				)
			}
			return
		}
		if (e.kind === "field" || e.kind === "value") {
			return fail(
				"MalformedDescription",
				loc,
				`a rule variable, parameter or literal; a ${e.kind} reference belongs to a row check or a contract predicate`
			)
		}
		if (e.kind === "absent" || e.kind === "exists") {
			this.source(e.source, vars, interiors, cx, loc)
			for (const [column, b] of entries(e.bindings)) {
				this.expr(b, vars, interiors, cx, childLoc(childLoc(loc, "bindings"), column))
			}
			return
		}
		for (const c of exprChildren(e)) {
			this.expr(c.term, vars, interiors, cx, locBelow(loc, c.at))
		}
	}
}

/**
 * Structural validation of a query description.
 *
 * The checker reads a query description that may come from anywhere: a JavaScript caller, another process, a
 * hand-edited payload. Its shapes are decoded by the IR's codec (ir/desc.ts decodeDesc), which refuses any value of
 * the wrong shape. What a shape cannot see is scope, and this module checks it without the schema, so a description
 * is refused before any name is resolved:
 *
 * - every variable a rule reads is one the rule itself declares: variables are lexical per rule, so a variable of
 *   another rule, an imported query or an attachment's parent query is never in scope;
 * - an interior source names an interior stage of its own rule;
 * - a `self` source appears only in a recursive step, a `parent` variable only in an attachment's own
 *   rules, and a delta source only in a ChangeSet read-back;
 * - a `field` or `value` reference, which belongs to a row check or a contract predicate, never appears in a query.
 *
 * Every refusal is MalformedDescription, located as the checker locates the same value: at the decoded location of the
 * node it is in (a rule, a match, a stage; a builder's call site, or the decoder's path for a node its author left
 * unlocated), and below it by the path the checker reads it at. Name resolution, typing and every semantic diagnostic
 * are the checker's (checker.ts).
 *
 * The structural scope check of a decoded query description.
 */
export const validateQueryStructure = <Q extends InferredQuery>(
	desc: Q,
	options: StructureOptions
): Result.Result<Q, CompileError> =>
	catchRefusal(() => {
		new Structure(options).query(desc, "query")
		return desc
	})
