"""Write the API's OpenAPI schema to a file (used to generate @campuscart/contracts types).

Usage: python scripts/export_openapi.py <output.json>
"""

import json
import sys
from pathlib import Path

from app.core.config import Environment, Settings
from app.main import create_app


def main() -> None:
    output = Path(sys.argv[1])
    schema = create_app(Settings(environment=Environment.TEST)).openapi()
    output.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
