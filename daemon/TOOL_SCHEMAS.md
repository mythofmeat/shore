# Tool input schemas

Shore treats every advertised tool input schema as an executable contract. Built-in, subagent,
and MCP tool schemas are compiled as JSON Schema Draft 2020-12 before the tool can be used.
Unsupported keywords, unknown formats, invalid schemas, and duplicate tool names are registration
errors. An MCP tool with an invalid schema is left off the tool surface; other valid tools from the
same server remain available.

Runtime validation covers the Draft 2020-12 vocabulary and the standard string formats provided by
`ajv-formats`. Tool arguments must always be a JSON object. Property types, required properties,
enums, nested objects and arrays, bounds, formats, `additionalProperties`, references, and
composition keywords are enforced immediately before dispatch.

Validation does not coerce values, remove properties, or apply schema defaults. A `default` remains
an annotation for the model and tool implementation. Properties not named in `properties` remain
valid unless the schema explicitly restricts them with `additionalProperties` or an equivalent
constraint.

The `run_tool` command compiles the same schema used by model-generated calls. Its `pairs` shorthand
uses top-level property types from that compiled schema for CLI conversion, after which the complete
input passes through the normal runtime validator.
