import { dictionary } from "@bjornpagen/testing/dictionary"

/**
 * Each way a data step meets the re-check its bracket runs after it (physical/ddl/recheck.ts): a custom migration's
 * file or a step written at a draft's data step, each breaking a rule over closed rows or none, a draft with no data
 * step, and a draft whose one data step grizzle drafts, a fill of a column no rule reads or one a rule reads. The migration's kinds of step, never cases a person chose.
 */
export const steps = dictionary([
	"a custom step deletes a parent's last child",
	"a custom step deletes a family",
	"a custom step lowers a cap under a child",
	"a custom step raises a cap",
	"a draft's step deletes a parent's last child",
	"a draft's step raises a cap",
	"a draft with no data step",
	"a draft's generated fill of a column no rule reads",
	"a draft's generated fill of a column a rule reads"
] as const)
