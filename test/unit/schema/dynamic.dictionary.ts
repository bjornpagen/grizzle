import { dictionary } from "@bjornpagen/testing/dictionary"

/**
 * The dynamic door's constructors (public/dynamic.ts), each by the callee a caller writes, derivedName's builders among
 * them: the door's own roster is the domain, never cases a person chose.
 */
export const doorConstructors = dictionary([
	"relation",
	"relation.generated",
	"closed.ordered",
	"closed.unordered",
	"closed.relation",
	"derivedName.relation",
	"derivedName.generated",
	"derivedName.unordered"
] as const)
