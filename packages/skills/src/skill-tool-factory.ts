import { dirname } from "node:path";
import type { ToolDefinition } from "@companion/tools";
import type { Skill } from "./index";

interface SkillParam {
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
}

interface SkillTool {
  name: string;
  description: string;
  parameters: Record<string, SkillParam>;
  kind?: "script" | "guide";
}

export const createSkillToolDefinition = (
  _skill: Skill,
  tool: SkillTool,
  handler: ToolDefinition["handler"],
): ToolDefinition => {
  void dirname("");

  return {
    schema: {
      type: "function",
      function: {
        name: tool.name,
        description: `[skill:${tool.kind ?? "script"}] ${tool.description}`,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(tool.parameters).map(([key, value]) => [
              key,
              { type: value.type, description: value.description },
            ]),
          ),
          required: Object.entries(tool.parameters)
            .filter(([, value]) => value.required !== false)
            .map(([key]) => key),
        },
      },
    },
    handler,
  };
};
