/**
 * A small deterministic arithmetic evaluator, used to recompute an expected
 * value from values that were read out of the page ("tax is 8.5% of the
 * subtotal after discount").
 *
 * It exists so that a check pack can express arithmetic WITHOUT shipping
 * JavaScript that the engine would have to `eval`. There is no string, array or
 * host access here: numbers, the four operators, `%`, `^`, parentheses, and a
 * fixed list of pure functions. Same inputs, same result, every time.
 *
 * Grammar
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/' | '%') factor)*
 *   factor  := unary ('^' factor)?
 *   unary   := ('-' | '+') unary | primary
 *   primary := number | ident | ident '(' args ')' | '(' expr ')'
 */

export interface EvalOk {
  ok: true;
  value: number;
  /** Every variable the expression consumed, with the value it contributed. */
  used: Record<string, number>;
}

export interface EvalErr {
  ok: false;
  error: string;
}

export type EvalResult = EvalOk | EvalErr;

export interface FnDef {
  arity: number | [number, number];
  fn: (args: number[]) => number;
}

export const FUNCTIONS: Record<string, FnDef> = {
  /** Percentage of a base: pct(110, 8.5) -> 9.35 */
  pct: { arity: 2, fn: ([base, rate]) => (base * rate) / 100 },
  percent_of: { arity: 2, fn: ([base, rate]) => (base * rate) / 100 },
  round: { arity: [1, 2], fn: ([x, dp]) => round(x, dp ?? 0) },
  floor: { arity: 1, fn: ([x]) => Math.floor(x) },
  ceil: { arity: 1, fn: ([x]) => Math.ceil(x) },
  abs: { arity: 1, fn: ([x]) => Math.abs(x) },
  min: { arity: [1, 8], fn: (xs) => Math.min(...xs) },
  max: { arity: [1, 8], fn: (xs) => Math.max(...xs) },
  sum: { arity: [1, 8], fn: (xs) => xs.reduce((a, b) => a + b, 0) },
  scale: { arity: 2, fn: ([x, factor]) => x * factor },
};

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((x + Number.EPSILON) * f) / f;
}

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "end" };

function tokenize(input: string): { ok: true; tokens: Token[] } | EvalErr {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < input.length && /[0-9._]/.test(input[j])) j += 1;
      const raw = input.slice(i, j).replace(/_/g, "");
      if (!/^[0-9]*\.?[0-9]+$/.test(raw) && !/^[0-9]+\.?$/.test(raw)) return { ok: false, error: `unparseable number "${raw}"` };
      tokens.push({ t: "num", v: Number(raw) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_.]/.test(input[j])) j += 1;
      tokens.push({ t: "id", v: input.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/%^(),".includes(c)) {
      tokens.push({ t: "op", v: c });
      i += 1;
      continue;
    }
    return { ok: false, error: `unexpected character "${c}" in expression` };
  }
  tokens.push({ t: "end" });
  return { ok: true, tokens };
}

/**
 * Evaluate `expr` against `vars`. Unknown variables and non-numeric variables
 * are errors, reported by name, never silently treated as zero.
 */
export function evaluate(expr: string, vars: Record<string, number>): EvalResult {
  const tok = tokenize(expr);
  if (!tok.ok) return tok;
  const tokens = tok.tokens;
  let pos = 0;
  const used: Record<string, number> = {};

  const peek = (): Token => tokens[pos];
  const eat = (v: string): boolean => {
    const t = peek();
    if (t.t === "op" && t.v === v) {
      pos += 1;
      return true;
    }
    return false;
  };

  function parseExpr(): number {
    let left = parseTerm();
    for (;;) {
      if (eat("+")) left += parseTerm();
      else if (eat("-")) left -= parseTerm();
      else return left;
    }
  }

  function parseTerm(): number {
    let left = parseFactor();
    for (;;) {
      if (eat("*")) left *= parseFactor();
      else if (eat("/")) {
        const rhs = parseFactor();
        if (rhs === 0) throw new Error("division by zero");
        left /= rhs;
      } else if (eat("%")) {
        const rhs = parseFactor();
        if (rhs === 0) throw new Error("modulo by zero");
        left %= rhs;
      } else return left;
    }
  }

  function parseFactor(): number {
    const base = parseUnary();
    if (eat("^")) return base ** parseFactor();
    return base;
  }

  function parseUnary(): number {
    if (eat("-")) return -parseUnary();
    if (eat("+")) return parseUnary();
    return parsePrimary();
  }

  function parsePrimary(): number {
    const t = peek();
    if (t.t === "num") {
      pos += 1;
      return t.v;
    }
    if (t.t === "op" && t.v === "(") {
      pos += 1;
      const v = parseExpr();
      if (!eat(")")) throw new Error("missing closing parenthesis");
      return v;
    }
    if (t.t === "id") {
      pos += 1;
      const name = t.v;
      if (peek().t === "op" && (peek() as { t: "op"; v: string }).v === "(") {
        pos += 1;
        const args: number[] = [];
        if (!(peek().t === "op" && (peek() as { t: "op"; v: string }).v === ")")) {
          args.push(parseExpr());
          while (eat(",")) args.push(parseExpr());
        }
        if (!eat(")")) throw new Error(`missing closing parenthesis in call to ${name}(`);
        const def = FUNCTIONS[name];
        if (!def) throw new Error(`unknown function "${name}"`);
        const [lo, hi] = Array.isArray(def.arity) ? def.arity : [def.arity, def.arity];
        if (args.length < lo || args.length > hi) {
          throw new Error(`${name}() takes ${lo === hi ? lo : `${lo}-${hi}`} argument(s), got ${args.length}`);
        }
        return def.fn(args);
      }
      if (!(name in vars)) throw new Error(`expression references "${name}", which was not read from the page`);
      const v = vars[name];
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`variable "${name}" is not a finite number (got ${JSON.stringify(v)})`);
      used[name] = v;
      return v;
    }
    throw new Error("unexpected end of expression");
  }

  try {
    const value = parseExpr();
    if (peek().t !== "end") throw new Error("trailing characters after the expression");
    if (!Number.isFinite(value)) throw new Error("the expression did not produce a finite number");
    return { ok: true, value, used };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Syntax-check an expression without knowing any variable values. Used when a
 * pack is loaded, so a typo in a formula is a spec error and not a surprise in
 * the middle of a verification run.
 */
export function checkExpression(expr: string): string | null {
  const permissive = new Proxy(
    {},
    {
      has: () => true,
      get: () => 1,
    },
  ) as Record<string, number>;
  const res = evaluate(expr, permissive);
  return res.ok ? null : res.error;
}

/** Render the values an expression consumed, for the evidence trail: `subtotal=120, discount=10`. */
export function renderUsed(used: Record<string, number>): string {
  return Object.keys(used)
    .sort()
    .map((k) => `${k}=${used[k]}`)
    .join(", ");
}
