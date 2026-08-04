import type { ToolSchema, ToolSpec } from "../tool-spec.ts";
import { requireClient, requireRepo, STRING_ARRAY_SCHEMA } from "./shared.ts";

interface AddLabelsInput {
  issueNumber: number;
  labels: string[];
}

const ADD_LABELS_INPUT_SCHEMA = {
  type: "object",
  required: ["issueNumber", "labels"],
  properties: {
    issueNumber: { type: "integer", minimum: 1 },
    labels: STRING_ARRAY_SCHEMA
  },
  additionalProperties: false
} satisfies ToolSchema;

const ANY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true
} satisfies ToolSchema;

export const addLabelsTool: ToolSpec<AddLabelsInput, Record<string, unknown>> = {
  name: "add_labels",
  description: "Add labels to an issue or pull request.",
  inputSchema: ADD_LABELS_INPUT_SCHEMA,
  outputSchema: ANY_OBJECT_SCHEMA,
  requiredPolicy: { canAddLabels: true },
  async handler(input, context) {
    const repo = requireRepo(context);
    const response = await requireClient(context).request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
      {
        params: { owner: repo.owner, repo: repo.name, issue_number: input.issueNumber },
        body: { labels: input.labels }
      }
    );
    return {
      issueNumber: input.issueNumber,
      labels: response.data
    };
  }
};

export const labelsTools = [addLabelsTool] as const;
