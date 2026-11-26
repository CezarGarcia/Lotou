"""Confere os contratos: cada schema é válido, tem um exemplo, e o exemplo passa no schema.

Uso: python contracts/check.py   (precisa de `jsonschema`)
"""

import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).parent


def main() -> int:
    errors: list[str] = []
    schemas = sorted(p for p in ROOT.glob("*/*.schema.json"))
    for schema_path in schemas:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        topic = schema_path.parent.name
        example_path = ROOT / "examples" / topic / schema_path.name.replace(".schema.json", ".json")
        if not example_path.exists():
            errors.append(f"{schema_path.relative_to(ROOT)}: sem exemplo em {example_path.relative_to(ROOT)}")
            continue
        example = json.loads(example_path.read_text(encoding="utf-8"))
        validator = Draft202012Validator(schema, format_checker=FormatChecker())
        for error in validator.iter_errors(example):
            errors.append(f"{example_path.relative_to(ROOT)}: {error.json_path}: {error.message}")
    for example_path in sorted(ROOT.glob("examples/*/*.json")):
        schema_path = ROOT / example_path.parent.name / example_path.name.replace(".json", ".schema.json")
        if not schema_path.exists():
            errors.append(f"{example_path.relative_to(ROOT)}: exemplo sem schema")
    for error in errors:
        print(error, file=sys.stderr)
    print(f"{len(schemas)} contratos conferidos, {len(errors)} problemas")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
