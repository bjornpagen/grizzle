import { Result, Schema, String as Str } from "effect"
import type { RuleTester } from "oxlint/plugins-dev"

/** A rule as oxlint's plugin API types it. */
export type Rule = Parameters<RuleTester["run"]>[1]
export type CreateRule = Extract<Rule, { create: unknown }>
export type Context = Parameters<CreateRule["create"]>[0]
export type Visitor = ReturnType<CreateRule["create"]>
type Program = Context["sourceCode"]["ast"]
export type AnyNode = Extract<Program["body"][number], { type: "ExpressionStatement" }>["parent"]
export type NodeOf<T extends AnyNode["type"]> = Extract<AnyNode, { type: T }>
export type Expression = NodeOf<"ExpressionStatement">["expression"]
export type TypeNode = NodeOf<"TSAsExpression">["typeAnnotation"]
export type Comment = Program["comments"][number]

/** A rule that bans what its visitor reports. */
export const problem = (create: CreateRule["create"]): CreateRule => ({
	meta: { type: "problem" },
	create
})

/** A rule that takes options, carrying the Schema of its options so a configuration can be typed by it. */
export type ConfiguredRule<S extends Schema.ConstraintDecoder<unknown>> = CreateRule &
	Readonly<{ options: S }>

/** The options a rule takes in a configuration, as written there: its Schema's encoded side, or null for a rule
 * that takes none. */
export type OptionsOf<R> =
	R extends Readonly<{ options: infer S extends Schema.ConstraintDecoder<unknown> }>
		? S["Encoded"]
		: null

/**
 * A rule that takes its project's names as one options object: `["error", { ... }]` in the oxlint config. oxlint
 * checks that the options are one object; the Schema decodes it, and a rule whose options do not decode reports that
 * at the top of every file it lints instead of linting it. Every field is required: a project with nothing for the
 * rule to guard passes empty lists.
 */
export const configured = <S extends Schema.ConstraintDecoder<unknown>>(
	options: S,
	create: (context: Context, options: S["Type"]) => Visitor
): ConfiguredRule<S> => {
	const decode = Schema.decodeUnknownResult(options)
	return {
		options,
		meta: { type: "problem", schema: [{ type: "object" }] },
		create: (context) =>
			Result.match(decode(context.options[0]), {
				onSuccess: (decoded) => create(context, decoded),
				onFailure: (error) => ({
					Program: (node) => {
						context.report({
							node,
							message: `${context.id} is configured with options that do not decode: ${error.message}`
						})
					}
				})
			})
	}
}

/** Paths in a rule's options are repository-relative; a linted file's name is absolute. A path names the file whose
 * name ends with it at a "/" boundary. */
export const isFileAt = (filename: string, path: string): boolean =>
	filename === path || Str.endsWith(`/${path}`)(filename)
