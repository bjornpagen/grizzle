import type { RuleTester } from "oxlint/plugins-dev"

/** A rule as oxlint's plugin API types it. */
export type Rule = Parameters<RuleTester["run"]>[1]
type CreateRule = Extract<Rule, { create: unknown }>
export type Context = Parameters<CreateRule["create"]>[0]
type Visitor = ReturnType<CreateRule["create"]>
type Program = Context["sourceCode"]["ast"]
export type AnyNode = Extract<Program["body"][number], { type: "ExpressionStatement" }>["parent"]
export type NodeOf<T extends AnyNode["type"]> = Extract<AnyNode, { type: T }>

/**
 * A rule that refuses every shape its visitor reports, under one message. Brittleness signals a missing vocabulary, so
 * the message names the expressive API that states the same check without the brittleness.
 */
export const refusal = (
	messageId: string,
	message: string,
	visit: (context: Context, refuse: (node: AnyNode) => void) => Visitor
): CreateRule => ({
	meta: { type: "problem", messages: { [messageId]: message } },
	create: (context) =>
		visit(context, (node) => {
			context.report({ node, messageId })
		})
})
