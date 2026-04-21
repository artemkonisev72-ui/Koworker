import { parentPort } from "worker_threads";
import { loadPyodide } from "pyodide";
if (!parentPort) {
  throw new Error("pyodide-worker must be run in a worker_thread");
}
let pyodide = null;
let currentStdout = "";
const SANDBOX_BOOTSTRAP = `
import builtins as __builtins_mod
# Keep single-underscore aliases to avoid Python name-mangling inside _TraceHelper methods.
import math as _sandbox_math
import sympy as _sandbox_sympy
import numpy as _sandbox_numpy
import json as _sandbox_json

_ALLOWED_IMPORTS = {"math", "sympy", "numpy", "json"}
_REAL_IMPORT = __builtins_mod.__import__

def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root not in _ALLOWED_IMPORTS:
        raise ImportError(f"Import '{name}' is blocked")
    return _REAL_IMPORT(name, globals, locals, fromlist, level)

_SAFE_BUILTINS = {
    "__import__": _safe_import,
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "pow": pow,
    "print": print,
    "range": range,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
    "isinstance": isinstance,
    "Exception": Exception,
    "ValueError": ValueError,
    "TypeError": TypeError,
    "True": True,
    "False": False,
    "None": None
}

class _TraceHelper:
    def __init__(self):
        self._doc = {
            "version": "solution-doc-2.0",
            "locale": "ru",
            "meta": {
                "mathcad": {
                    "originVariable": "ORIGIN",
                    "unitFormatting": "auto"
                }
            },
            "sections": []
        }
        self._current_section = None
        self.section("Solution")

    def _ensure_section(self):
        if self._current_section is None:
            self.section("Solution")
        return self._current_section

    def _format(self, value):
        try:
            if isinstance(value, _sandbox_sympy.Basic):
                return _sandbox_sympy.sstr(value)
        except Exception:
            pass

        if isinstance(value, (list, tuple)):
            return "[" + ", ".join(self._format(item) for item in value) + "]"
        if isinstance(value, dict):
            items = list(value.items())
            preview = items[:8]
            text = ", ".join(f"{k}: {self._format(v)}" for k, v in preview)
            if len(items) > len(preview):
                text += ", ..."
            return "{" + text + "}"

        try:
            return str(value)
        except Exception:
            return "<unprintable>"

    def _id_node_from_text(self, text):
        raw = self._format(text).strip()
        if "_" in raw:
            base, sub = raw.split("_", 1)
            if base and sub:
                return {"type": "id", "name": base, "subscript": sub}
        return {"type": "id", "name": raw}

    def _parse_function_signature(self, text):
        raw = self._format(text).strip()
        open_idx = raw.find("(")
        close_idx = raw.rfind(")")
        if open_idx <= 0 or close_idx <= open_idx or close_idx != len(raw) - 1:
            return None
        name = raw[:open_idx].strip()
        if not name:
            return None
        args_raw = raw[open_idx + 1:close_idx].strip()
        if not args_raw:
            return (name, [])
        args = [part.strip() for part in args_raw.split(",")]
        if any(not arg for arg in args):
            return None
        return (name, args)

    def _to_math(self, value):
        if value is None:
            return {"type": "text", "value": "None"}

        if value is True or value is _sandbox_sympy.true:
            return {"type": "id", "name": "true"}
        if value is False or value is _sandbox_sympy.false:
            return {"type": "id", "name": "false"}

        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return {"type": "num", "value": self._format(value)}

        if isinstance(value, _sandbox_numpy.generic):
            return self._to_math(value.item())

        if isinstance(value, _sandbox_sympy.Symbol):
            return self._id_node_from_text(value)

        if isinstance(value, (_sandbox_sympy.Integer, _sandbox_sympy.Float, _sandbox_sympy.Rational)):
            return {"type": "num", "value": self._format(value)}

        if isinstance(value, _sandbox_sympy.Equality):
            return {
                "type": "apply",
                "op": "equal",
                "args": [self._to_math(value.lhs), self._to_math(value.rhs)]
            }

        rel_op = getattr(value, "rel_op", None)
        if isinstance(rel_op, str):
            op_map = {
                "==": "equal",
                "<": "lessThan",
                "<=": "lessOrEqual",
                ">": "greaterThan",
                ">=": "greaterOrEqual"
            }
            op = op_map.get(rel_op, "equal")
            return {
                "type": "apply",
                "op": op,
                "args": [self._to_math(value.lhs), self._to_math(value.rhs)]
            }

        if isinstance(value, _sandbox_sympy.Add):
            return {"type": "apply", "op": "plus", "args": [self._to_math(arg) for arg in value.args]}

        if isinstance(value, _sandbox_sympy.Mul):
            return {"type": "apply", "op": "mult", "args": [self._to_math(arg) for arg in value.args]}

        if isinstance(value, _sandbox_sympy.Pow):
            return {"type": "apply", "op": "pow", "args": [self._to_math(value.base), self._to_math(value.exp)]}

        if isinstance(value, _sandbox_sympy.And):
            return {"type": "apply", "op": "and", "args": [self._to_math(arg) for arg in value.args]}

        if isinstance(value, _sandbox_sympy.Or):
            return {"type": "apply", "op": "or", "args": [self._to_math(arg) for arg in value.args]}

        if isinstance(value, _sandbox_sympy.Not):
            return {"type": "apply", "op": "not", "args": [self._to_math(value.args[0])]}

        if isinstance(value, _sandbox_sympy.Integral):
            body = self._to_math(value.function)
            variable = {"type": "id", "name": "x"}
            lower = {"type": "num", "value": "0"}
            upper = {"type": "num", "value": "1"}
            if value.limits:
                first = value.limits[0]
                if isinstance(first, tuple) and len(first) >= 1:
                    variable = self._to_math(first[0])
                    if len(first) >= 3:
                        lower = self._to_math(first[1])
                        upper = self._to_math(first[2])
            return {
                "type": "integral",
                "variable": variable,
                "lower": lower,
                "upper": upper,
                "body": body
            }

        if isinstance(value, _sandbox_sympy.Piecewise):
            branches = []
            otherwise = None
            for expr, cond in value.args:
                is_otherwise = cond is True or cond == True
                if is_otherwise:
                    otherwise = self._to_math(expr)
                else:
                    branches.append({"condition": self._to_math(cond), "value": self._to_math(expr)})
            if not branches and otherwise is not None:
                return otherwise
            result = {"type": "program", "branches": branches}
            if otherwise is not None:
                result["otherwise"] = otherwise
            return result

        if isinstance(value, _sandbox_sympy.MatrixBase):
            rows = int(value.rows)
            cols = int(value.cols)
            values = []
            for row in range(rows):
                for col in range(cols):
                    values.append(self._to_math(value[row, col]))
            return {"type": "matrix", "rows": rows, "cols": cols, "values": values}

        if isinstance(value, _sandbox_sympy.Lambda):
            params = [self._to_math(entry) for entry in value.variables]
            return {"type": "lambda", "params": params, "body": self._to_math(value.expr)}

        if isinstance(value, _sandbox_sympy.Basic):
            func = getattr(value, "func", None)
            func_name = getattr(func, "__name__", None)
            if isinstance(func_name, str) and len(value.args) > 0:
                return {
                    "type": "call",
                    "fn": {"type": "id", "name": func_name},
                    "args": [self._to_math(arg) for arg in value.args]
                }

        if isinstance(value, (list, tuple)):
            return {
                "type": "text",
                "value": "[" + ", ".join(self._format(item) for item in value) + "]"
            }

        return {"type": "text", "value": self._format(value)}

    def _normalize_plot_points(self, points):
        normalized = []
        if isinstance(points, _sandbox_numpy.ndarray):
            points = points.tolist()
        if not isinstance(points, (list, tuple)):
            return normalized
        for entry in points:
            if isinstance(entry, dict):
                x = entry.get("x")
                y = entry.get("y")
                if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                    normalized.append({"x": float(x), "y": float(y)})
                continue
            if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                x = entry[0]
                y = entry[1]
                if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                    normalized.append({"x": float(x), "y": float(y)})
        return normalized

    def _add_block(self, kind, payload):
        section = self._ensure_section()
        block = {
            "id": f"b{len(section['blocks']) + 1}",
            "kind": kind
        }
        block.update(payload)
        section["blocks"].append(block)
        return block

    def section(self, title):
        title_text = self._format(title)
        section = {
            "id": f"s{len(self._doc['sections']) + 1}",
            "title": title_text,
            "blocks": []
        }
        self._doc["sections"].append(section)
        self._current_section = section
        return section

    def note(self, text, title=None):
        payload = {"text": self._format(text)}
        if title is not None:
            payload["title"] = self._format(title)
        return self._add_block("note", payload)

    def define(self, name, expr, value=None, title=None):
        name_text = self._format(name)
        rhs_node = self._to_math(expr)
        signature = self._parse_function_signature(name_text)
        if signature is not None:
            fn_name, fn_args = signature
            math_ast = {
                "type": "function_def",
                "name": self._id_node_from_text(fn_name),
                "params": [self._id_node_from_text(arg) for arg in fn_args],
                "body": rhs_node
            }
        else:
            math_ast = {
                "type": "define",
                "lhs": self._id_node_from_text(name_text),
                "rhs": rhs_node
            }

        payload = {
            "title": self._format(title) if title else "Definition",
            "text": "Define notation.",
            "expression": f"{name_text} := {self._format(expr)}",
            "mathAst": math_ast
        }
        if value is not None:
            payload["value"] = self._format(value)

        if name_text == "ORIGIN":
            meta = self._doc.setdefault("meta", {})
            mathcad_meta = meta.setdefault("mathcad", {})
            mathcad_meta["originVariable"] = "ORIGIN"

        return self._add_block("definition", payload)

    def equation(self, lhs, rhs=None, title=None):
        if rhs is None and isinstance(lhs, _sandbox_sympy.Equality):
            expression = self._format(lhs)
            math_ast = {
                "type": "apply",
                "op": "equal",
                "args": [self._to_math(lhs.lhs), self._to_math(lhs.rhs)]
            }
        elif rhs is None:
            expression = self._format(lhs)
            math_ast = self._to_math(lhs)
        else:
            expression = f"{self._format(lhs)} = {self._format(rhs)}"
            math_ast = {
                "type": "apply",
                "op": "equal",
                "args": [self._to_math(lhs), self._to_math(rhs)]
            }
        payload = {
            "title": self._format(title) if title else "Equation",
            "text": "Apply relation.",
            "expression": expression,
            "mathAst": math_ast
        }
        return self._add_block("equation", payload)

    def solve(self, target, variable=None, result=None, title=None):
        payload = {
            "title": self._format(title) if title else "Solve",
            "text": "Solve for target quantity.",
            "expression": self._format(target),
            "mathAst": self._to_math(target)
        }
        if variable is not None:
            payload["text"] = f"Solve for {self._format(variable)}"
        if result is not None:
            payload["value"] = self._format(result)
        return self._add_block("solve", payload)

    def eval(self, expr, title=None):
        payload = {
            "title": self._format(title) if title else "Evaluation",
            "text": "Evaluate expression.",
            "expression": self._format(expr),
            "mathAst": {"type": "eval", "expr": self._to_math(expr)}
        }
        return self._add_block("evaluation", payload)

    def function(self, name, args, expr, title=None):
        name_text = self._format(name)
        params = args if isinstance(args, (list, tuple)) else [args]
        payload = {
            "title": self._format(title) if title else "Function",
            "text": "Define function.",
            "expression": f"{name_text}({', '.join(self._format(arg) for arg in params)}) := {self._format(expr)}",
            "mathAst": {
                "type": "function_def",
                "name": self._id_node_from_text(name_text),
                "params": [self._id_node_from_text(arg) for arg in params],
                "body": self._to_math(expr)
            }
        }
        return self._add_block("definition", payload)

    def result(self, label, value, title=None):
        label_text = self._format(label)
        payload = {
            "title": self._format(title) if title else "Answer",
            "text": label_text,
            "value": self._format(value),
            "mathAst": self._to_math(value)
        }
        return self._add_block("result", payload)

    def plot(self, title, points, diagramType=None, memberId=None, epure=None):
        payload = {
            "title": self._format(title) if title else "Plot",
            "kindHint": "native-plot",
            "data": {
                "title": self._format(title) if title else "Plot",
                "type": "diagram" if diagramType is not None else "function",
                "diagramType": self._format(diagramType) if diagramType is not None else None,
                "memberId": self._format(memberId) if memberId is not None else None,
                "epure": epure if isinstance(epure, dict) else None,
                "points": self._normalize_plot_points(points)
            }
        }
        return self._add_block("plot", payload)

    def code(self, code_text, title=None):
        payload = {
            "title": self._format(title) if title else "Technical details",
            "code": self._format(code_text)
        }
        return self._add_block("code", payload)

    def export(self):
        return self._doc

def _run_sandbox(__sandbox_code):
    __trace = _TraceHelper()
    _globals = {
        "__builtins__": _SAFE_BUILTINS,
        "math": _sandbox_math,
        "sympy": _sandbox_sympy,
        "numpy": _sandbox_numpy,
        "np": _sandbox_numpy,
        "json": _sandbox_json,
        "trace": __trace
    }
    exec(compile(__sandbox_code, "<sandbox>", "exec"), _globals, None)
`;
async function init() {
  pyodide = await loadPyodide({
    stdout: (s) => {
      currentStdout += s + "\n";
    },
    stderr: (s) => {
      currentStdout += s + "\n";
    }
  });
  await pyodide.loadPackage(["sympy", "numpy"]);
  await pyodide.runPythonAsync(SANDBOX_BOOTSTRAP);
  parentPort.postMessage({ type: "ready" });
}
async function runTask(id, code) {
  if (!pyodide) {
    parentPort.postMessage({ id, ok: false, error: "Pyodide not initialized" });
    return;
  }
  currentStdout = "";
  try {
    pyodide.globals.set("__sandbox_code", code);
    await pyodide.runPythonAsync("_run_sandbox(__sandbox_code)");
    parentPort.postMessage({ id, ok: true, stdout: currentStdout.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort.postMessage({ id, ok: false, error: message });
  } finally {
    try {
      pyodide.globals.delete("__sandbox_code");
    } catch {
    }
    currentStdout = "";
  }
}
parentPort.on("message", (msg) => {
  runTask(msg.id, msg.code).catch((err) => {
    parentPort.postMessage({
      id: msg.id,
      ok: false,
      error: String(err)
    });
  });
});
init().catch((err) => {
  parentPort.postMessage({ type: "init_error", error: String(err) });
  process.exit(1);
});
