// Arguments the model passes when it opens the app set the inputs that share
// their names. The bridge holds Shiny's initialization until they arrive and
// writes them into the page's markup, where Shiny's own input bindings read
// them when they initialize (applyToMarkup()): the server function's first
// render uses them, and nothing is sent twice. Inputs whose markup this file
// doesn't know (those from packages) are set through their bindings just
// before the session starts (applyToInitialInput()), and arguments that
// arrive later are ordinary input changes, as update*Input() makes them
// (applyAsUpdates()).
//
// Only arguments the app declared with mcpConfigure(arguments = ) are
// applied. Every argument still reaches the server through mcpUpdates().

export type InputValues = { [key: string]: unknown };

export type InputBindingLike = {
  getValue(el: HTMLElement): unknown;
  getType?(el: HTMLElement): string | false | null | undefined;
  receiveMessage(el: HTMLElement, data: unknown): unknown;
};

export type ArgumentTarget = { el: HTMLElement; binding: InputBindingLike };

// Finds the bound input with the given id, or null.
export type FindTarget = (id: string) => ArgumentTarget | null;

// The declared arguments present in `args`, in declaration order.
export function selectArguments(
  args: InputValues | null | undefined,
  declared: readonly string[] | null | undefined,
): Array<[string, unknown]> {
  if (!args || !declared) return [];
  const out: Array<[string, unknown]> = [];
  for (const name of declared) {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      const value = args[name];
      if (value !== undefined && value !== null) out.push([name, value]);
    }
  }
  return out;
}

function asStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((v) => String(v));
}

function sliderNumber(el: HTMLElement, value: unknown): string | null {
  const type = el.getAttribute("data-data-type");
  // Date sliders hold milliseconds since the epoch.
  const n =
    (type === "date" || type === "datetime") && typeof value === "string"
      ? Date.parse(value)
      : Number(value);
  return Number.isFinite(n) ? String(n) : null;
}

// Sets an input's value in the page's markup, where Shiny's built-in input
// bindings read it when they initialize. Returns false for inputs it doesn't
// know, and for values that don't fit the input.
export function setMarkupValue(el: HTMLElement, value: unknown): boolean {
  const tag = (el.tagName || "").toLowerCase();
  const hasClass = (name: string): boolean => !!el.classList?.contains(name);

  if (tag === "select") {
    const wanted = asStrings(value);
    const options = Array.from((el as HTMLSelectElement).options);
    if (!options.some((o) => wanted.includes(o.value))) return false;
    for (const o of options) o.selected = wanted.includes(o.value);
    return true;
  }
  if (tag === "input" && hasClass("js-range-slider")) {
    const values = Array.isArray(value) ? value : [value];
    const from = sliderNumber(el, values[0]);
    if (from === null) return false;
    el.setAttribute("data-from", from);
    if (values.length > 1 && el.hasAttribute("data-to")) {
      const to = sliderNumber(el, values[1]);
      if (to !== null) el.setAttribute("data-to", to);
    }
    return true;
  }
  if (tag === "input" && (el as HTMLInputElement).type === "checkbox") {
    (el as HTMLInputElement).checked = Boolean(value);
    return true;
  }
  if (tag === "input" || tag === "textarea") {
    if (value !== null && typeof value === "object") return false;
    (el as HTMLInputElement).value = String(value);
    return true;
  }
  if (
    hasClass("shiny-input-radiogroup") ||
    hasClass("shiny-input-checkboxgroup")
  ) {
    const wanted = asStrings(value);
    const boxes = Array.from(
      el.querySelectorAll<HTMLInputElement>(
        'input[type="radio"], input[type="checkbox"]',
      ),
    );
    if (boxes.length === 0) return false;
    for (const box of boxes) box.checked = wanted.includes(box.value);
    return true;
  }
  if (hasClass("shiny-date-range-input")) {
    const inputs = el.querySelectorAll("input");
    if (inputs.length < 2 || !Array.isArray(value) || value.length < 2) {
      return false;
    }
    inputs[0].setAttribute("data-initial-date", String(value[0]));
    inputs[1].setAttribute("data-initial-date", String(value[1]));
    return true;
  }
  if (hasClass("shiny-date-input")) {
    const input = el.querySelector("input");
    if (!input || typeof value !== "string") return false;
    input.setAttribute("data-initial-date", value);
    return true;
  }
  return false;
}

// Before Shiny initializes: write the declared arguments into the markup of
// the inputs that share their names. Returns the names written, and the
// declared names whose inputs weren't found or aren't known here.
export function applyToMarkup(
  args: InputValues | null | undefined,
  declared: readonly string[] | null | undefined,
  findElement: (id: string) => HTMLElement | null,
): { applied: string[]; unapplied: string[] } {
  const applied: string[] = [];
  const unapplied: string[] = [];
  for (const [name, value] of selectArguments(args, declared)) {
    const el = findElement(name);
    let done = false;
    try {
      done = !!el && setMarkupValue(el, value);
    } catch (err) {
      console.warn("shiny-mcp-bridge: couldn't set input " + name, err);
    }
    (done ? applied : unapplied).push(name);
  }
  return { applied, unapplied };
}

// The message an input binding's receiveMessage() takes to set a value, in
// the shape the update*Input() functions send.
export function updateMessage(
  el: HTMLElement,
  value: unknown,
): { [key: string]: unknown } {
  if (
    Array.isArray(value) &&
    el.classList?.contains("shiny-date-range-input")
  ) {
    return { start: value[0], end: value[1] };
  }
  return { value };
}

function setWidget(
  target: ArgumentTarget,
  name: string,
  value: unknown,
): boolean {
  try {
    const done = target.binding.receiveMessage(
      target.el,
      updateMessage(target.el, value),
    );
    if (done && typeof (done as Promise<unknown>).then === "function") {
      (done as Promise<unknown>).then(undefined, (err: unknown) =>
        console.warn("shiny-mcp-bridge: couldn't set input " + name, err),
      );
    }
    return true;
  } catch (err) {
    console.warn("shiny-mcp-bridge: couldn't set input " + name, err);
    return false;
  }
}

// Before the "init" message: set each widget, then record the value it now
// reports (and its input type) in the values Shiny will send. The binding's
// own change event, queued until after "init", sends the same value again,
// which changes nothing on the server. Returns the names applied.
export function applyToInitialInput(
  args: InputValues | null | undefined,
  declared: readonly string[] | null | undefined,
  find: FindTarget,
  initialInput: InputValues,
  inputValues: InputValues,
): string[] {
  const applied: string[] = [];
  for (const [name, value] of selectArguments(args, declared)) {
    const target = find(name);
    if (!target || !setWidget(target, name, value)) continue;

    let current: unknown = value;
    try {
      current = target.binding.getValue(target.el);
    } catch {
      // Keep the model's value.
    }
    let type: string | false | null | undefined = null;
    try {
      type = target.binding.getType?.(target.el);
    } catch {
      type = null;
    }
    const key = type ? name + ":" + type : name;
    for (const existing of Object.keys(initialInput)) {
      if (existing === name || existing.startsWith(name + ":")) {
        delete initialInput[existing];
      }
    }
    for (const existing of Object.keys(inputValues)) {
      if (existing === name || existing.startsWith(name + ":")) {
        delete inputValues[existing];
      }
    }
    initialInput[key] = current;
    inputValues[key] = current;
    applied.push(name);
  }
  return applied;
}

// After the session has started: set each widget as update*Input() would.
// Its binding reports the change to the server. Returns the names applied.
export function applyAsUpdates(
  args: InputValues | null | undefined,
  declared: readonly string[] | null | undefined,
  find: FindTarget,
): string[] {
  const applied: string[] = [];
  for (const [name, value] of selectArguments(args, declared)) {
    const target = find(name);
    if (target && setWidget(target, name, value)) applied.push(name);
  }
  return applied;
}
