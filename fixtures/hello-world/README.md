# Hello World Fixture

This is the standard reference implementation for a minimal **Edge Canon** project.

## Structure

* `.config.json`: The project manifest (validates against `schemas/config.schema.json`).
* `functions/index.ts`: The entry point handler.

## Usage

You can use this fixture to test compliance tools.

```bash
# Validate this fixture
denictl validate ./edge-canon/fixtures/hello-world
```
