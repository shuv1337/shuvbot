import type { ToolSchema, ToolSpec } from "../tool-spec.ts";

interface SetOutputInput {
  name: string;
  value: unknown;
}

const SET_OUTPUT_INPUT_SCHEMA = {
  type: "object",
  required: ["name", "value"],
  properties: {
    name: { type: "string", minLength: 1 },
    value: { type: "object", properties: {}, additionalProperties: true }
  },
  additionalProperties: false
} satisfies ToolSchema;

const ANY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true
} satisfies ToolSchema;

export const setOutputTool: ToolSpec<SetOutputInput, Record<string, unknown>> = {
  name: "set_output",
  description: "Set a structured action output value.",
  inputSchema: SET_OUTPUT_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  async handler(input, context) {
    await context.outputs?.set(input.name, input.value);
    return {
      name: input.name,
      value: input.value,
      set: context.outputs !== undefined
    };
  }
};

export const outputTools = [setOutputTool] as const;
