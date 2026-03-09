export const BaseAgent = {
  Analyst: "analyst",
  Engineer: "engineer",
  Responder: "responder",
  Planner: "planner",
  PrdDesigner: "prd_designer",
  DeliveryManager: "delivery_manager",
  OperationsCommander: "operations_commander",
  Researcher: "researcher",
} as const;

export type BaseAgent = (typeof BaseAgent)[keyof typeof BaseAgent];
