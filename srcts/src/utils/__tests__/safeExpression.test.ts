/* eslint-disable @typescript-eslint/naming-convention */
import assert from "node:assert";
import test from "node:test";
import { compileSafeExpression, isEvalRefused } from "../safeExpression";

const scope = {
  input: {
    x: "b",
    n: 4,
    more: true,
    g: ["p", "q"],
    empty: [],
    name: "  Ada ",
    "mod-y": "d",
  },
  output: { o: "b", ready: false },
};

const run = (expr: string, s: unknown = scope): unknown =>
  compileSafeExpression(expr)(s);

void test("reads comparisons, logic, and ternaries", () => {
  assert.equal(run("input.x == 'b'"), true);
  assert.equal(run('input.x === "a"'), false);
  assert.equal(run("input.n >= 3 && input.more"), true);
  assert.equal(run("!input.more || input.n < 2"), false);
  assert.equal(run("input.n >= 3 ? 'big' : 'small'"), "big");
  assert.equal(run("input.n % 2 == 0"), true);
  assert.equal(run("-input.n + 10 * 2"), 16);
  assert.equal(run("typeof input.x"), "string");
  assert.equal(run("input.missing == null"), true);
  assert.equal(run("(input.n + 1) / 5"), 1);
});

void test("reads property access, arrays, and allowed methods", () => {
  assert.equal(run("input.g.length > 0 && input.g.indexOf('q') > -1"), true);
  assert.equal(run("input.empty.length"), 0);
  assert.equal(run("input['mod-y'] == 'd'"), true);
  assert.equal(run("input.g[0]"), "p");
  assert.equal(run("input.g.includes('p')"), true);
  assert.equal(run("input.name.trim().toLowerCase()"), "ada");
  assert.equal(run("['a', 'b'].indexOf(input.x)"), 1);
  assert.equal(run("/^b/.test(input.x)"), true);
  assert.equal(run("/B/i.test(output.o)"), true);
  assert.equal(run("input.n / 2 > 1"), true);
  assert.equal(run("output.ready"), false);
});

void test("has no access to globals or prototypes", () => {
  assert.throws(() => run("window.alert"), /not defined/);
  assert.equal(run("input.constructor"), undefined);
  assert.equal(run("input.x.constructor"), undefined);
  assert.throws(() => run("input.x.replace('b', 'c')"), /can't call/);
  assert.throws(() => run("input.missing.length"), /can't read/);
});

void test("refuses what it can't read", () => {
  assert.throws(() => compileSafeExpression("input.x == 'b"), /unterminated/);
  assert.throws(() => compileSafeExpression("input.x = 1"), /unexpected/);
  assert.throws(
    () => compileSafeExpression("(() => 1)()"),
    /unexpected|only methods/,
  );
  assert.throws(() => compileSafeExpression("f(1)"), /only methods/);
});

void test("recognizes errors from a Content Security Policy", () => {
  assert.equal(isEvalRefused(new EvalError("Refused to evaluate")), true);
  assert.equal(
    isEvalRefused(
      new Error("call to Function() blocked by Content Security Policy"),
    ),
    true,
  );
  assert.equal(isEvalRefused(new SyntaxError("Unexpected token")), false);
});
