// A small, safe calculator for the AI assistant. It parses the expression itself
// (no eval / Function), so all it can ever do is arithmetic.
//
//   numbers          12, 3.5, .5, 1e3
//   operators        + - * / ^ (or **)   unary minus   postfix % (15% = 0.15)
//   grouping         ( )
//   constants        pi, e
//   functions        sqrt abs round(x, places) ceil floor min max pow mod ln log10 exp
//                    sin cos tan asin acos atan (radians; use rad(deg) / deg(rad))

const FUNCS = {
  sqrt: (x) => Math.sqrt(x), abs: Math.abs, ceil: Math.ceil, floor: Math.floor, ln: Math.log, log10: Math.log10, exp: Math.exp,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  rad: (d) => (d * Math.PI) / 180, deg: (r) => (r * 180) / Math.PI,
  round: (x, places = 0) => { const f = 10 ** places; return Math.round((x + Number.EPSILON) * f) / f; },
  min: Math.min, max: Math.max, pow: Math.pow, mod: (a, b) => a % b,
};
const CONSTS = { pi: Math.PI, e: Math.E };

function tokenize(src) {
  const tokens = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = src.slice(i).match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
    if (num) { tokens.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = src.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/);
    if (id) { if (id[0] === 'x' || id[0] === 'X') tokens.push({ t: 'op', v: '*' }); else tokens.push({ t: 'id', v: id[0].toLowerCase() }); i += id[0].length; continue; }
    if (src.startsWith('**', i)) { tokens.push({ t: 'op', v: '^' }); i += 2; continue; }
    if ('+-*/^%(),'.includes(c)) { tokens.push({ t: 'op', v: c }); i++; continue; }
    // common ways people write maths
    if (c === 'x' || c === 'X' || c === '×') { tokens.push({ t: 'op', v: '*' }); i++; continue; }
    if (c === '÷') { tokens.push({ t: 'op', v: '/' }); i++; continue; }
    if (c === '−') { tokens.push({ t: 'op', v: '-' }); i++; continue; }
    throw new Error(`Unexpected character "${c}"`);
  }
  return tokens;
}

function evaluate(src) {
  if (typeof src !== 'string' || !src.trim()) throw new Error('Give an expression to calculate.');
  if (src.length > 500) throw new Error('That expression is too long.');
  const tokens = tokenize(src);
  let pos = 0, depth = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;

  function parseExpr() {            // + -
    let left = parseTerm();
    while (isOp('+') || isOp('-')) { const op = take().v; const right = parseTerm(); left = op === '+' ? left + right : left - right; }
    return left;
  }
  function parseTerm() {            // * /
    let left = parseUnary();
    while (isOp('*') || isOp('/')) {
      const op = take().v; const right = parseUnary();
      if (op === '/' && right === 0) throw new Error('Division by zero');
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }
  function parseUnary() {
    if (isOp('-')) { take(); return -parseUnary(); }
    if (isOp('+')) { take(); return parseUnary(); }
    return parsePower();
  }
  function parsePower() {           // ^ (right associative)
    const base = parsePostfix();
    if (isOp('^')) { take(); const exp = parseUnary(); return base ** exp; }
    return base;
  }
  function parsePostfix() {         // 15%
    let v = parsePrimary();
    while (isOp('%')) { take(); v = v / 100; }
    return v;
  }
  function parsePrimary() {
    const tk = take();
    if (!tk) throw new Error('The expression ends too soon');
    if (tk.t === 'num') return tk.v;
    if (tk.t === 'id') {
      if (isOp('(')) {
        const fn = FUNCS[tk.v];
        if (!fn) throw new Error(`Unknown function "${tk.v}"`);
        take(); const args = [];
        if (!isOp(')')) { do { args.push(parseExpr()); } while (isOp(',') && take()); }
        if (!isOp(')')) throw new Error('Missing a closing bracket');
        take();
        return fn(...args);
      }
      if (tk.v in CONSTS) return CONSTS[tk.v];
      throw new Error(`Unknown name "${tk.v}"`);
    }
    if (tk.t === 'op' && tk.v === '(') {
      if (++depth > 40) throw new Error('Too many nested brackets');
      const v = parseExpr();
      if (!isOp(')')) throw new Error('Missing a closing bracket');
      take(); depth--;
      return v;
    }
    throw new Error(`Unexpected "${tk.v}"`);
  }

  const result = parseExpr();
  if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].v}"`);
  if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('That does not give a real number');
  return Number(result.toPrecision(12));
}

module.exports = { evaluate };
