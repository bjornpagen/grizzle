import { nonEmpty } from "@bjornpagen/testing/assert"
import { dictionary } from "@bjornpagen/testing/dictionary"
import { Record as Rec } from "effect"
import { refusedText } from "#test/generated/event-stream.fixtures.ts"

/**
 * One event of each type a read sends whose data its contentSchema refuses, by the roster the box's events are
 * written by (event-stream.fixtures.ts refusedText).
 */
export const refusedEvents = dictionary(nonEmpty(Rec.keys(refusedText), "the refused events"))
