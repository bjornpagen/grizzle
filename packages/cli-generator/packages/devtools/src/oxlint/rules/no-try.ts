import { problem } from "#oxlint/rule.ts"

/**
 * Every try statement. It is enabled only on Effect-free code, where Effect's tryCatchInEffectGen does not run; a
 * project's one catch door (a function that turns a thrown value into a typed failure) is on its exception list.
 */
export const noTry = problem((context) => ({
	TryStatement: (node) => {
		context.report({
			node,
			message:
				"Try statements are banned in Effect-free code. Return a typed failure (a Result or a variant) instead of throwing; a thrown value is caught only in the project's one catch door."
		})
	}
}))
