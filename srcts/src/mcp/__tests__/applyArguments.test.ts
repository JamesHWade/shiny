/* eslint-disable @typescript-eslint/naming-convention */
import assert from "node:assert";
import test from "node:test";
import type { ArgumentTarget, InputBindingLike } from "../applyArguments";
import {
  applyAsUpdates,
  applyToInitialInput,
  applyToMarkup,
  selectArguments,
  setMarkupValue,
  updateMessage,
} from "../applyArguments";

type FakeEl = { id: string; classes: string[]; value: unknown };

function fakeEl(
  id: string,
  value: unknown,
  classes: string[] = [],
): HTMLElement {
  const el: FakeEl & { classList: { contains(c: string): boolean } } = {
    id,
    classes,
    value,
    classList: { contains: (c: string) => classes.includes(c) },
  };
  return el as unknown as HTMLElement;
}

// A binding that stores the value it's given, the way Shiny's do.
function fakeBinding(
  type: string | null,
  received: unknown[],
): InputBindingLike {
  return {
    getValue: (el) => (el as unknown as FakeEl).value,
    getType: () => type,
    receiveMessage: (el, data) => {
      received.push(data);
      const msg = data as { value?: unknown; start?: unknown; end?: unknown };
      (el as unknown as FakeEl).value =
        msg.value !== undefined ? msg.value : [msg.start, msg.end];
    },
  };
}

void test("selectArguments keeps declared arguments that were given", () => {
  assert.deepEqual(
    selectArguments({ a: 1, b: null, c: 3 }, ["c", "a", "b", "z"]),
    [
      ["c", 3],
      ["a", 1],
    ],
  );
  assert.deepEqual(selectArguments({ a: 1 }, null), []);
  assert.deepEqual(selectArguments(null, ["a"]), []);
});

void test("updateMessage matches update*Input() messages", () => {
  assert.deepEqual(updateMessage(fakeEl("x", null), "b"), { value: "b" });
  assert.deepEqual(
    updateMessage(fakeEl("r", null, ["shiny-date-range-input"]), [
      "2024-01-01",
      "2024-02-01",
    ]),
    { start: "2024-01-01", end: "2024-02-01" },
  );
});

void test("applyToInitialInput sets widgets and the init values", () => {
  const received: unknown[] = [];
  const targets: { [id: string]: ArgumentTarget } = {
    n: { el: fakeEl("n", 10), binding: fakeBinding("shiny.number", received) },
    region: {
      el: fakeEl("region", "East"),
      binding: fakeBinding(null, received),
    },
  };
  const initial: { [key: string]: unknown } = {
    "n:shiny.number": 10,
    region: "East",
    other: 1,
  };
  const values = { ...initial };
  const applied = applyToInitialInput(
    { n: 200, region: "West", undeclared: "x", note: "y" },
    ["n", "region", "note"],
    (id) => targets[id] ?? null,
    initial,
    values,
  );
  assert.deepEqual(applied, ["n", "region"]);
  assert.deepEqual(initial, {
    "n:shiny.number": 200,
    region: "West",
    other: 1,
  });
  assert.deepEqual(values, initial);
  assert.deepEqual(received, [{ value: 200 }, { value: "West" }]);
});

void test("applyToInitialInput records the value the widget reports", () => {
  // A checkbox group reports its choices in page order.
  const binding: InputBindingLike = {
    getValue: () => ["a", "c"],
    getType: () => null,
    receiveMessage: () => undefined,
  };
  const initial: { [key: string]: unknown } = { g: ["a"] };
  applyToInitialInput(
    { g: ["c", "a"] },
    ["g"],
    () => ({ el: fakeEl("g", ["a"]), binding }),
    initial,
    {},
  );
  assert.deepEqual(initial.g, ["a", "c"]);
});

void test("a binding that throws is skipped", () => {
  const binding: InputBindingLike = {
    getValue: () => 1,
    getType: () => null,
    receiveMessage: () => {
      throw new Error("nope");
    },
  };
  const initial: { [key: string]: unknown } = { n: 1 };
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const applied = applyToInitialInput(
      { n: 5 },
      ["n"],
      () => ({ el: fakeEl("n", 1), binding }),
      initial,
      {},
    );
    assert.deepEqual(applied, []);
    assert.deepEqual(initial, { n: 1 });
  } finally {
    console.warn = warn;
  }
});

void test("applyAsUpdates sends update messages to bound inputs only", () => {
  const received: unknown[] = [];
  const target = { el: fakeEl("n", 1), binding: fakeBinding(null, received) };
  const applied = applyAsUpdates({ n: 3, gone: 4 }, ["n", "gone"], (id) =>
    id === "n" ? target : null,
  );
  assert.deepEqual(applied, ["n"]);
  assert.deepEqual(received, [{ value: 3 }]);
});

// Minimal stand-ins for the elements Shiny's input functions produce.
class FakeNode {
  tagName: string;
  type = "";
  value = "";
  checked = false;
  selected = false;
  attrs: { [key: string]: string } = {};
  classes: string[];
  children: FakeNode[];
  options: FakeNode[] = [];
  classList = { contains: (c: string) => this.classes.includes(c) };
  constructor(
    tagName: string,
    classes: string[] = [],
    children: FakeNode[] = [],
  ) {
    this.tagName = tagName.toUpperCase();
    this.classes = classes;
    this.children = children;
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }
  querySelectorAll(): FakeNode[] {
    return this.children;
  }
  querySelector(): FakeNode | null {
    return this.children[0] ?? null;
  }
}

function option(value: string, selected = false): FakeNode {
  const o = new FakeNode("option");
  o.value = value;
  o.selected = selected;
  return o;
}

function box(type: string, value: string, checked = false): FakeNode {
  const b = new FakeNode("input");
  b.type = type;
  b.value = value;
  b.checked = checked;
  return b;
}

const asEl = (n: FakeNode): HTMLElement => n as unknown as HTMLElement;

void test("setMarkupValue sets select, text, number, and checkbox inputs", () => {
  const select = new FakeNode("select");
  select.options = [option("East", true), option("West")];
  assert.equal(setMarkupValue(asEl(select), "West"), true);
  assert.deepEqual(
    select.options.map((o) => o.selected),
    [false, true],
  );
  assert.equal(setMarkupValue(asEl(select), "North"), false);

  const multi = new FakeNode("select");
  multi.options = [option("a"), option("b"), option("c")];
  setMarkupValue(asEl(multi), ["c", "a"]);
  assert.deepEqual(
    multi.options.map((o) => o.selected),
    [true, false, true],
  );

  const num = new FakeNode("input");
  num.type = "number";
  assert.equal(setMarkupValue(asEl(num), 200), true);
  assert.equal(num.value, "200");
  assert.equal(setMarkupValue(asEl(num), { a: 1 }), false);

  const check = new FakeNode("input");
  check.type = "checkbox";
  setMarkupValue(asEl(check), true);
  assert.equal(check.checked, true);
});

void test("setMarkupValue sets sliders, including ranges and dates", () => {
  const slider = new FakeNode("input", ["js-range-slider"]);
  slider.setAttribute("data-from", "10");
  assert.equal(setMarkupValue(asEl(slider), 30), true);
  assert.equal(slider.getAttribute("data-from"), "30");

  const range = new FakeNode("input", ["js-range-slider"]);
  range.setAttribute("data-from", "1");
  range.setAttribute("data-to", "5");
  setMarkupValue(asEl(range), [2, 8]);
  assert.equal(range.getAttribute("data-from"), "2");
  assert.equal(range.getAttribute("data-to"), "8");

  const dates = new FakeNode("input", ["js-range-slider"]);
  dates.setAttribute("data-data-type", "date");
  setMarkupValue(asEl(dates), "2024-03-01");
  assert.equal(
    dates.getAttribute("data-from"),
    String(Date.parse("2024-03-01")),
  );

  assert.equal(setMarkupValue(asEl(slider), "not a number"), false);
});

void test("setMarkupValue sets radio and checkbox groups and dates", () => {
  const radios = new FakeNode(
    "div",
    ["shiny-input-radiogroup"],
    [box("radio", "a", true), box("radio", "b")],
  );
  setMarkupValue(asEl(radios), "b");
  assert.deepEqual(
    radios.children.map((b) => b.checked),
    [false, true],
  );

  const group = new FakeNode(
    "div",
    ["shiny-input-checkboxgroup"],
    [box("checkbox", "x"), box("checkbox", "y", true), box("checkbox", "z")],
  );
  setMarkupValue(asEl(group), ["x", "z"]);
  assert.deepEqual(
    group.children.map((b) => b.checked),
    [true, false, true],
  );

  const date = new FakeNode(
    "div",
    ["shiny-date-input"],
    [new FakeNode("input")],
  );
  setMarkupValue(asEl(date), "2024-05-06");
  assert.equal(
    date.children[0].getAttribute("data-initial-date"),
    "2024-05-06",
  );

  const range = new FakeNode(
    "div",
    ["shiny-date-range-input"],
    [new FakeNode("input"), new FakeNode("input")],
  );
  setMarkupValue(asEl(range), ["2024-01-01", "2024-02-01"]);
  assert.equal(
    range.children[1].getAttribute("data-initial-date"),
    "2024-02-01",
  );

  assert.equal(
    setMarkupValue(asEl(new FakeNode("div", ["my-widget"])), 1),
    false,
  );
});

void test("applyToMarkup reports what it couldn't set", () => {
  const num = new FakeNode("input");
  num.type = "number";
  const widget = new FakeNode("div", ["my-widget"]);
  const els: { [id: string]: FakeNode } = { n: num, w: widget };
  const out = applyToMarkup(
    { n: 5, w: "x", gone: 1, undeclared: 2 },
    ["n", "w", "gone"],
    (id) => (els[id] ? asEl(els[id]) : null),
  );
  assert.deepEqual(out, { applied: ["n"], unapplied: ["w", "gone"] });
  assert.equal(num.value, "5");
});
