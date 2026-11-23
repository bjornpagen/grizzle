/**
 * The worked example's Work with one apply as a change member, which test/pg/substrate/installs reads as its fixture
 * form's template.
 */

import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import * as W from "#test/support/fixtures/api/work.ts"

/**
 * What every case installs: the worked example's Work, its full world's workload holding the apply as a change member,
 * a described member over a stored relation: a note at the target task copying the source's note.
 */
export const commitInstall = {
	label: "real",
	programs: {
		copy: ChangeSet.empty(W.Work).insert(
			W.TaskNote,
			query(W.Work).rule((r) => {
				const { note } = v(W.TaskNote, "taskNote")
				return r
					.match(W.TaskNote, {
						task: r.param("source", W.TaskNote.fields.task),
						note
					})
					.find({ task: r.param("target", W.TaskNote.fields.task), note })
			})
		)
	}
} as const

/** Work installed once per member (reads/support.ts fixtureTemplate), which each case's seat holds. */
export const commitTemplate = fixtureTemplate(import.meta, W.Work, commitInstall)
