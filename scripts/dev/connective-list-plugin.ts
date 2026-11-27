import type { CreateRule, NodeOf, Plugin } from "@bjornpagen/devtools/oxlint/rule"
import { Array as Arr, Option, Record, String as Str } from "effect"

/**
 * The oxlint plugin connective-list.ts runs: one rule, `rewrite`, that moves each call to r.and, r.or, Logic.and,
 * Logic.or or a row check's and and or the typecheck refused, after grizzle's hard cutover to one list, to that list,
 * each at the position its diagnostic names, and touches no other call: `and(p, q)` is `and([p, q])`, `and(...ps)` is
 * `and(ps)`, `and(...ps, q)` is `and([...ps, q])`, `and()` is `and([])` and `and(p)` is `and([p])`. Its one option names
 * each diagnosed call by its file (absolute, as oxlint names a linted file) and its 1-based line and column, with what
 * the typecheck said of it: `excess` at its second argument (Expected 1 arguments, but got N), `none` at the name it
 * calls (got 0), `spread` at a spread argument (a spread argument must be passed to a rest parameter) and `single` at
 * its one argument (not assignable to a list). Each bracket is a fix of its own, so oxlint applies a connective's and
 * the connectives nested in it in one pass: no two of them touch one position.
 */

/** What the typecheck said of a call, at the position it names. */
type Said = "excess" | "none" | "spread" | "single"

/** A diagnosed call: its 1-based line and column, and what the typecheck said there. */
type Target = Readonly<{ line: number; column: number; said: Said }>

const SAID: ReadonlyArray<Said> = ["excess", "none", "spread", "single"]

/** The rule's option, as connective-list.ts writes it: the diagnosed calls of each file. */
type Targets = ReadonlyMap<string, ReadonlyArray<Target>>

/** Whether a value is an object whose properties can be read by name. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null

/** A target as connective-list.ts writes it, or none for anything else. */
const targetOf = (value: unknown): ReadonlyArray<Target> => {
	if (!isRecord(value)) {
		return []
	}
	const { line, column, said } = value
	return Option.match(
		Arr.findFirst(SAID, (each) => each === said),
		{
			onNone: () => [],
			onSome: (known) =>
				typeof line === "number" && typeof column === "number"
					? [{ line, column, said: known }]
					: []
		}
	)
}

/** The rule's option read: `{ targets: { [file]: Target[] } }`, each file's targets that read as one. */
const targetsOf = (option: unknown): Targets => {
	const targets = isRecord(option) ? option["targets"] : undefined
	return new Map(
		isRecord(targets)
			? Arr.map(Record.toEntries(targets), ([file, list]) => [
					file,
					Arr.isArray(list) ? Arr.flatMap(list, targetOf) : []
				])
			: []
	)
}

/** The offset in `text` of each line's first character, in UTF-16 code units, as the typecheck counts columns. */
const lineStartsOf = (text: string): ReadonlyArray<number> =>
	Arr.scan(Str.split("\n")(text), 0, (start, line) => start + line.length + 1)

const CONNECTIVES: ReadonlyArray<string> = ["and", "or"]

/**
 * Where a call names what it calls, if what it calls may be a connective: `and` or `x.and` at its name, `x[kind]` at
 * its key (a key of "and" | "or", which only the typecheck knows); none for a call that names another member.
 */
const calledAt = (node: NodeOf<"CallExpression">): Option.Option<number> => {
	const { callee } = node
	if (callee.type === "Identifier") {
		return Arr.contains(CONNECTIVES, callee.name) ? Option.some(callee.range[0]) : Option.none()
	}
	if (callee.type !== "MemberExpression") {
		return Option.none()
	}
	const key = callee.property
	if (!callee.computed) {
		return key.type === "Identifier" && Arr.contains(CONNECTIVES, key.name)
			? Option.some(key.range[0])
			: Option.none()
	}
	return key.type === "Literal" && !Arr.contains(CONNECTIVES, key.value)
		? Option.none()
		: Option.some(key.range[0])
}

const MESSAGE = "grizzle's and and or take one list of predicates: this call moves to it."

/** Whether the typecheck refused this call, at what it calls `called` and its arguments `args`. */
const refusedAt = (
	at: ReadonlyArray<Readonly<{ offset: number; said: Said }>>,
	called: number,
	args: NodeOf<"CallExpression">["arguments"]
): boolean =>
	Arr.some(at, ({ offset, said }) => {
		switch (said) {
			case "excess":
				return Option.exists(Arr.get(args, 1), (arg) => arg.range[0] === offset)
			case "none":
				return args.length === 0 && called === offset
			case "spread":
				return Arr.some(args, (arg) => arg.type === "SpreadElement" && arg.range[0] === offset)
			case "single":
				return args.length === 1 && Option.exists(Arr.head(args), (arg) => arg.range[0] === offset)
		}
	})

const rewrite: CreateRule = {
	meta: { type: "problem", fixable: "code", schema: [{ type: "object" }] },
	create: (context) => {
		const targets = targetsOf(context.options[0]).get(context.filename) ?? []
		if (!Arr.isReadonlyArrayNonEmpty(targets)) {
			return {}
		}
		const starts = lineStartsOf(context.sourceCode.text)
		const at = Arr.flatMap(targets, (target) =>
			Option.match(Arr.get(starts, target.line - 1), {
				onNone: () => [],
				onSome: (start) => [{ offset: start + target.column - 1, said: target.said }]
			})
		)
		return {
			CallExpression: (node) => {
				const args = node.arguments
				if (!Option.exists(calledAt(node), (called) => refusedAt(at, called, args))) {
					return
				}
				if (!Arr.isReadonlyArrayNonEmpty(args)) {
					const close = node.range[1] - 1
					context.report({
						node,
						message: MESSAGE,
						fix: (fixer) => fixer.insertTextBeforeRange([close, close], "[]")
					})
					return
				}
				const first = Arr.headNonEmpty(args)
				const last = Arr.lastNonEmpty(args)
				if (args.length === 1 && first.type === "SpreadElement") {
					context.report({
						node,
						message: MESSAGE,
						fix: (fixer) => fixer.removeRange([first.range[0], first.argument.range[0]])
					})
					return
				}
				context.report({
					node,
					message: MESSAGE,
					fix: (fixer) => fixer.insertTextBeforeRange([first.range[0], first.range[0]], "[")
				})
				context.report({
					node: last,
					message: MESSAGE,
					fix: (fixer) => fixer.insertTextAfterRange([last.range[1], last.range[1]], "]")
				})
			}
		}
	}
}

const plugin: Plugin = { meta: { name: "grizzle-connective" }, rules: { rewrite } }

export default plugin
