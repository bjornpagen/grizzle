/** The latin1 bytes of the text. */
export const latin1Bytes = (text: string): Uint8Array =>
	Uint8Array.from(Buffer.from(text, "latin1"))
