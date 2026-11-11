import { isSuppression } from "#oxlint/comments.ts"
import { problem } from "#oxlint/rule.ts"

/**
 * Every inline suppression: `oxlint-disable*`, `eslint-disable*`, `@effect-diagnostics*` and fallow's ignore comments.
 * An exception is the project's to state in its configuration, where every exception is listed in one place.
 * TypeScript's directives are typescript/ban-ts-comment's.
 */
export const noInlineSuppression = problem((context) => ({
	Program: () => {
		for (const comment of context.sourceCode.getAllComments()) {
			if (comment.type !== "Shebang" && isSuppression(comment)) {
				context.report({
					node: comment,
					message:
						"Inline suppressions are banned. Fix the code; an exception goes into the project's configuration (an oxlint override, the Effect plugin's overrides, fallow's config)."
				})
			}
		}
	}
}))
