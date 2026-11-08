/** True when `next` is strictly newer than what the renderer already holds. */
export const newer = (have: number, next: number): boolean => next > have
