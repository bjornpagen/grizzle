declare const emittedTextBrand: unique symbol

export type EmittedText = string & { readonly [emittedTextBrand]: true }

export declare const emit: (statement: string) => EmittedText
