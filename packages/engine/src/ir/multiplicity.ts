/**
 * How a consumer treats repeats of its input: it passes them on, cannot see them (an emptiness test, a
 * set operator that absorbs them), or changes meaning because of them (COUNT, SUM, LIMIT, pagination, row numbering,
 * recursive feedback, a public stream, a storage operation).
 */
export type ConsumerSensitivity = "preserves" | "ignores" | "observes"
