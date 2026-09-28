export type InputValues = {
    [key: string]: unknown;
};
export type InputBindingLike = {
    getValue(el: HTMLElement): unknown;
    getType?(el: HTMLElement): string | false | null | undefined;
    receiveMessage(el: HTMLElement, data: unknown): unknown;
};
export type ArgumentTarget = {
    el: HTMLElement;
    binding: InputBindingLike;
};
export type FindTarget = (id: string) => ArgumentTarget | null;
export declare function selectArguments(args: InputValues | null | undefined, declared: readonly string[] | null | undefined): Array<[string, unknown]>;
export declare function setMarkupValue(el: HTMLElement, value: unknown): boolean;
export declare function applyToMarkup(args: InputValues | null | undefined, declared: readonly string[] | null | undefined, findElement: (id: string) => HTMLElement | null): {
    applied: string[];
    unapplied: string[];
};
export declare function updateMessage(el: HTMLElement, value: unknown): {
    [key: string]: unknown;
};
export declare function applyToInitialInput(args: InputValues | null | undefined, declared: readonly string[] | null | undefined, find: FindTarget, initialInput: InputValues, inputValues: InputValues): string[];
export declare function applyAsUpdates(args: InputValues | null | undefined, declared: readonly string[] | null | undefined, find: FindTarget): string[];
