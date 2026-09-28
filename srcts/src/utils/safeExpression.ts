// A small interpreter for the JavaScript expressions in conditionalPanel()
// conditions, used when the page's Content Security Policy forbids
// `new Function()` (it lacks 'unsafe-eval'), as MCP Apps hosts' policies do.
//
// It reads what conditions are usually made of: literals (numbers, strings,
// true/false/null/undefined, arrays, and regular expressions), property
// access (`input.x`, `input['x']`, `.length`), the operators `! - + typeof`,
// `* / % + -`, `< <= > >=`, `== != === !==`, `&& ||`, and `?:`, and calls to
// a few string, array, and regular expression methods. Names resolve against
// the scope object (`input`, `output`) only; there is no access to globals or
// prototypes.

type Token =
  | { type: "value"; value: unknown }
  | { type: "name"; value: string }
  | { type: "op"; value: string };

type Node =
  | { node: "value"; value: unknown }
  | { node: "name"; name: string }
  | { node: "array"; items: Node[] }
  | { node: "member"; object: Node; key: Node }
  | { node: "call"; object: Node; key: Node; args: Node[] }
  | { node: "unary"; op: string; arg: Node }
  | { node: "logical"; op: string; left: Node; right: Node }
  | { node: "binary"; op: string; left: Node; right: Node }
  | { node: "if"; test: Node; yes: Node; no: Node };

const allowedMethods = [
  "indexOf",
  "lastIndexOf",
  "includes",
  "join",
  "concat",
  "slice",
  "toLowerCase",
  "toUpperCase",
  "trim",
  "startsWith",
  "endsWith",
  "charAt",
  "substring",
  "substr",
  "toString",
  "test",
  "match",
];

const punctuation = [
  "===",
  "!==",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "<",
  ">",
  "!",
  "(",
  ")",
  "[",
  "]",
  ".",
  ",",
  "+",
  "-",
  "*",
  "/",
  "%",
  "?",
  ":",
];

const literals: { [key: string]: unknown } = {
  true: true,
  false: false,
  null: null,
  undefined: undefined,
};

const hasOwn = (obj: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

// Whether the token before a "/" ends an operand, making it division rather
// than the start of a regular expression.
function afterOperand(tokens: Token[]): boolean {
  const last = tokens[tokens.length - 1];
  if (!last) return false;
  if (last.type === "value") return true;
  if (last.type === "name") return last.value !== "typeof";
  return last.value === ")" || last.value === "]";
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && !afterOperand(tokens)) {
      let end = i + 1;
      let inClass = false;
      while (end < src.length && (inClass || src.charAt(end) !== "/")) {
        const ch = src.charAt(end);
        if (ch === "\\") end++;
        else if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        end++;
      }
      if (end >= src.length) throw new Error("unterminated regular expression");
      const flags = (
        /^[gimsuy]*/.exec(src.slice(end + 1)) as RegExpExecArray
      )[0];
      tokens.push({
        type: "value",
        value: new RegExp(src.slice(i + 1, end), flags),
      });
      i = end + 1 + flags.length;
    } else if (
      (m = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?/.exec(rest))
    ) {
      tokens.push({ type: "value", value: parseFloat(m[0]) });
      i += m[0].length;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let text = "";
      while (j < src.length && src.charAt(j) !== c) {
        if (src.charAt(j) === "\\") {
          j++;
          const e = src.charAt(j);
          text += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else {
          text += src.charAt(j);
        }
        j++;
      }
      if (j >= src.length) throw new Error("unterminated string");
      tokens.push({ type: "value", value: text });
      i = j + 1;
    } else if ((m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest))) {
      tokens.push({ type: "name", value: m[0] });
      i += m[0].length;
    } else {
      const op = punctuation.find((p) => rest.startsWith(p));
      if (!op) throw new Error("unexpected '" + c + "'");
      tokens.push({ type: "op", value: op });
      i += op.length;
    }
  }
  return tokens;
}

const precedence = [
  ["||"],
  ["&&"],
  ["==", "!=", "===", "!=="],
  ["<", "<=", ">", ">="],
  ["+", "-"],
  ["*", "/", "%"],
];

function parse(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;

  const isOp = (value: string): boolean => {
    const t = tokens[pos];
    return !!t && t.type === "op" && t.value === value;
  };
  const expect = (value: string): void => {
    if (!isOp(value)) throw new Error("expected '" + value + "'");
    pos++;
  };
  const list = (close: string): Node[] => {
    const items: Node[] = [];
    if (!isOp(close)) {
      items.push(conditional());
      while (isOp(",")) {
        pos++;
        items.push(conditional());
      }
    }
    expect(close);
    return items;
  };

  function conditional(): Node {
    const test = binary(0);
    if (!isOp("?")) return test;
    pos++;
    const yes = conditional();
    expect(":");
    return { node: "if", test, yes, no: conditional() };
  }

  function binary(level: number): Node {
    if (level === precedence.length) return unary();
    let left = binary(level + 1);
    for (;;) {
      const t = tokens[pos];
      if (!t || t.type !== "op" || !precedence[level].includes(t.value)) break;
      pos++;
      const right = binary(level + 1);
      left =
        level < 2
          ? { node: "logical", op: t.value, left, right }
          : { node: "binary", op: t.value, left, right };
    }
    return left;
  }

  function unary(): Node {
    const t = tokens[pos];
    if (
      t &&
      ((t.type === "op" &&
        (t.value === "!" || t.value === "-" || t.value === "+")) ||
        (t.type === "name" && t.value === "typeof"))
    ) {
      pos++;
      return { node: "unary", op: t.value, arg: unary() };
    }
    return postfix();
  }

  function postfix(): Node {
    let node = primary();
    for (;;) {
      if (isOp(".")) {
        pos++;
        const name = tokens[pos++];
        if (!name || name.type !== "name") {
          throw new Error("expected a name after '.'");
        }
        node = {
          node: "member",
          object: node,
          key: { node: "value", value: name.value },
        };
      } else if (isOp("[")) {
        pos++;
        const key = conditional();
        expect("]");
        node = { node: "member", object: node, key };
      } else if (isOp("(")) {
        if (node.node !== "member")
          throw new Error("only methods can be called");
        pos++;
        node = {
          node: "call",
          object: node.object,
          key: node.key,
          args: list(")"),
        };
      } else {
        return node;
      }
    }
  }

  function primary(): Node {
    const t = tokens[pos++];
    if (!t) throw new Error("unexpected end");
    if (t.type === "value") return { node: "value", value: t.value };
    if (t.type === "name") {
      if (hasOwn(literals, t.value))
        return { node: "value", value: literals[t.value] };
      return { node: "name", name: t.value };
    }
    if (t.value === "(") {
      const inner = conditional();
      expect(")");
      return inner;
    }
    if (t.value === "[") return { node: "array", items: list("]") };
    throw new Error("unexpected '" + t.value + "'");
  }

  const tree = conditional();
  if (pos < tokens.length) {
    throw new Error("unexpected '" + String(tokens[pos].value) + "'");
  }
  return tree;
}

function readMember(object: unknown, key: unknown): unknown {
  if (object === null || object === undefined) {
    throw new TypeError(
      "can't read '" + String(key) + "' of " + String(object),
    );
  }
  if (typeof object === "string" || Array.isArray(object)) {
    const indexable = object as ArrayLike<unknown>;
    if (key === "length") return indexable.length;
    if (typeof key === "number") return indexable[key];
    return undefined;
  }
  if (typeof object === "object" && hasOwn(object, key as PropertyKey)) {
    return (object as { [key: string]: unknown })[key as string];
  }
  return undefined;
}

function binaryOp(op: string, a: any, b: any): unknown {
  switch (op) {
    case "==":
      return a == b;
    case "!=":
      return a != b;
    case "===":
      return a === b;
    case "!==":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    default:
      return a % b;
  }
}

function evaluate(node: Node, scope: { [key: string]: unknown }): unknown {
  switch (node.node) {
    case "value":
      return node.value;
    case "name":
      if (!hasOwn(scope, node.name))
        throw new ReferenceError(node.name + " is not defined");
      return scope[node.name];
    case "array":
      return node.items.map((item) => evaluate(item, scope));
    case "member":
      return readMember(
        evaluate(node.object, scope),
        evaluate(node.key, scope),
      );
    case "call": {
      const target = evaluate(node.object, scope) as { [key: string]: unknown };
      const method = evaluate(node.key, scope) as string;
      const allowed =
        typeof target === "string" ||
        Array.isArray(target) ||
        target instanceof RegExp;
      if (
        !allowed ||
        !allowedMethods.includes(method) ||
        typeof target[method] !== "function"
      ) {
        throw new TypeError("can't call " + String(method) + "()");
      }
      const args = node.args.map((arg) => evaluate(arg, scope));
      return (target[method] as (...a: unknown[]) => unknown).apply(
        target,
        args,
      );
    }
    case "unary": {
      const a = evaluate(node.arg, scope) as any;
      if (node.op === "!") return !a;
      if (node.op === "-") return -a;
      if (node.op === "+") return +a;
      return typeof a;
    }
    case "logical": {
      const a = evaluate(node.left, scope);
      if (node.op === "&&") return a ? evaluate(node.right, scope) : a;
      return a ? a : evaluate(node.right, scope);
    }
    case "binary":
      return binaryOp(
        node.op,
        evaluate(node.left, scope),
        evaluate(node.right, scope),
      );
    case "if":
      return evaluate(node.test, scope)
        ? evaluate(node.yes, scope)
        : evaluate(node.no, scope);
    default:
      throw new Error("unknown expression");
  }
}

// Parse `expr` once; the result evaluates it against a scope object. Throws
// if the expression uses anything the interpreter doesn't read.
function compileSafeExpression(expr: string): (scope: unknown) => unknown {
  const tree = parse(expr);
  return (scope: unknown): unknown =>
    evaluate(tree, (scope ?? {}) as { [key: string]: unknown });
}

// Whether an error from `new Function()` means the page's Content Security
// Policy forbids evaluating strings as code.
function isEvalRefused(e: unknown): boolean {
  if (typeof EvalError !== "undefined" && e instanceof EvalError) return true;
  return /unsafe-eval|Content Security Policy/i.test(String(e));
}

export { compileSafeExpression, isEvalRefused };
