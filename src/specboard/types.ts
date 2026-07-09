export interface OpenQuestion {
  id: string;
  topic: string;
  positions: Record<string, string>;
  resolution?: string;
  resolved_by?: string;
}

export interface Decision {
  id: string;
  topic: string;
  resolution: string;
  by: string;
}

export interface ReviewVerdictEntry {
  [profile: string]: "pass" | "fail" | "skipped" | boolean | string | undefined;
  arbitrated: boolean;
  arbitrator?: string;
  final: "pass" | "fail";
}

export interface SpecBoard {
  requirement: string;
  artifacts: Record<string, string>;
  spec_hash?: string;
  config_hash?: string;
  open_questions: OpenQuestion[];
  decisions: Decision[];
  review_matrix: Record<string, ReviewVerdictEntry>;
}
