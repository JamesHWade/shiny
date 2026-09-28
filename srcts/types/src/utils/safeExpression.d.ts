declare function compileSafeExpression(expr: string): (scope: unknown) => unknown;
declare function isEvalRefused(e: unknown): boolean;
export { compileSafeExpression, isEvalRefused };
