#!/usr/bin/env python3
"""Check the live app's styling contract without installing dependencies.

Standalone design-reference HTML and vendor KaTeX output are deliberately outside
this check. Runtime values are explicitly listed rather than silently permitting
arbitrary undefined theme variables. Run from any directory.
"""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"
RUNTIME = {
    "--label-color", "--summary-inline-highlight-color", "--summary-swatch-color",
    "--sidebar-overlay-layer", "--advanced-results-height",
}


def blocks(source):
    """Yield nested CSS blocks, handling comments, quoted strings and escapes."""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    stack = []
    start = 0
    quote = None
    escaped = False
    for i, char in enumerate(source):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
        elif char == "{":
            stack.append((source[start:i].strip(), i + 1))
            start = i + 1
        elif char == "}":
            if not stack:
                raise ValueError("unmatched closing brace")
            selector, body_start = stack.pop()
            yield selector, source[body_start:i]
            start = i + 1
    if stack or quote:
        raise ValueError("unclosed CSS block or string")


def check():
    errors = []
    css_files = sorted(STATIC.glob("*.css"))
    contents = {path: path.read_text() for path in css_files}
    declared = set()
    references = set()
    for path, source in contents.items():
        clean = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
        declared.update(re.findall(r"(--[\w-]+)\s*:", clean))
        references.update(re.findall(r"var\(\s*(--[\w-]+)", clean))
        try:
            for selector, body in blocks(source):
                if selector.startswith("@"):
                    continue  # inspect its child declarations separately
                if path.name == "theme.css":
                    if selector != ":root":
                        errors.append(f"{path.name}: theme values must belong to :root, found {selector}")
                    continue
                if re.search(r"--[\w-]+\s*:", body):
                    errors.append(f"{path.name}: declare theme defaults in theme.css ({selector})")
                if re.search(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(", body):
                    errors.append(f"{path.name}: literal paint in {selector}")
                if re.search(r"(?:^|[;\s])(?:color|background(?:-color)?|border-color)\s*:\s*(?:white|black)\b", body):
                    errors.append(f"{path.name}: named literal paint in {selector}")
                for family in re.findall(r"font-family\s*:\s*([^;]+)", body):
                    if family.strip() != "inherit" and not family.strip().startswith("var("):
                        errors.append(f"{path.name}: literal font family in {selector}")
                # Literal lengths are legitimate in query *conditions*, never
                # necessary in app-owned decorative component declarations.
                if re.search(r"(?<![\w-])-?\d*\.?\d+(?:px|rem|em)\b", body):
                    errors.append(f"{path.name}: literal length in {selector}")
        except ValueError as exc:
            errors.append(f"{path.name}: {exc}")
    for name in sorted(references - declared - RUNTIME):
        errors.append(f"Undefined CSS variable: {name}")
    for path in sorted(STATIC.glob("*.html")):
        source = path.read_text()
        if re.search(r"<style\b|\sstyle\s*=", source, re.I):
            errors.append(f"{path.name}: embedded or inline app stylesheet")
    for path in sorted(STATIC.glob("*.js")):
        source = path.read_text()
        if re.search(r"<style\b|\sstyle\s*=", source, re.I):
            errors.append(f"{path.name}: generated decorative style attribute")
        for prop in re.findall(r"\.style\.([A-Za-z]+)\s*=", source):
            if prop not in {"left", "top"}:
                errors.append(f"{path.name}: direct inline style assignment: {prop}")
        for literal in re.findall(r"[\"'](#[0-9a-fA-F]{3,8})[\"']", source):
            if not (path.name == "summary.js" and literal.lower() == "#fff3a3"):
                errors.append(f"{path.name}: literal appearance colour {literal}")
    if errors:
        print("Style checks failed:\n" + "\n".join(f"- {error}" for error in errors))
        return 1
    print(f"Style checks passed: {len(css_files)} stylesheets, {len(declared)} central variables; runtime exceptions verified.")
    return 0


if __name__ == "__main__":
    sys.exit(check())
