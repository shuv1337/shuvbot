export interface ReviewFinding {
  id: string;
  skill: string;
  title: string;
  body: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: "high" | "medium" | "low";
  path: string;
  line?: number;
  side?: "RIGHT" | "LEFT";
  startLine?: number;
  endLine?: number;
  suggestedFix?: string;
  tags?: string[];
}
