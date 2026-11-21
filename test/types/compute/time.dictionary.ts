import { dictionary } from "@bjornpagen/testing/dictionary"
import { timeBoxItems } from "#test/types/compute/time.ts"

/** The box: every operand Time.wall, Time.epochDay and Time.dateOfEpochDay take or refuse, and what they deliver. */
export const timeBox = dictionary(timeBoxItems)
