export type DeepImmutable<T> = T

export type Permutations<T> = T extends readonly (infer U)[] ? U[] : never
