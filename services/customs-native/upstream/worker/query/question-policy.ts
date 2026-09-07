/**
 * Questions that may be shown by the public classifier.  This is deliberately
 * a closed list: neither a model nor a caller may invent a legal or identity
 * question that has not been reviewed for the public contract.
 */
export interface ApprovedQuestion {
  readonly id: string;
  readonly label: string;
  readonly attribute: "codeCountry" | "vacuumInsulated";
  readonly options: readonly string[];
}

const QUESTIONS: readonly ApprovedQuestion[] = [
  {
    id: "codeCountry",
    label: "这个编码属于哪个国家或地区的税则？",
    attribute: "codeCountry",
    options: ["中国", "美国", "加拿大"],
  },
  {
    id: "vacuumInsulated",
    label: "产品是否为真空或双层保温结构？",
    attribute: "vacuumInsulated",
    options: ["是", "否", "不确定"],
  },
];

export const APPROVED_QUESTION_IDS = QUESTIONS.map((question) => question.id) as readonly string[];

const QUESTIONS_BY_ID = new Map(QUESTIONS.map((question) => [question.id, question]));

export function getApprovedQuestion(id: string): ApprovedQuestion | null {
  return QUESTIONS_BY_ID.get(id) ?? null;
}

export function isApprovedQuestionId(id: string): boolean {
  return QUESTIONS_BY_ID.has(id);
}

export function isApprovedAttribute(attribute: string): attribute is ApprovedQuestion["attribute"] {
  return QUESTIONS.some((question) => question.attribute === attribute);
}

export function selectNextApprovedQuestion(input: {
  readonly answeredAttributes: readonly string[];
  readonly preferredId?: string;
}): ApprovedQuestion | null {
  const answered = new Set(input.answeredAttributes);
  const preferred = input.preferredId ? getApprovedQuestion(input.preferredId) : null;
  if (input.preferredId && !preferred) return null;
  if (preferred) return answered.has(preferred.attribute) ? null : preferred;

  for (const question of QUESTIONS) {
    if (!answered.has(question.attribute)) return question;
  }
  return null;
}

export function questionForAttribute(attribute: string): ApprovedQuestion | null {
  if (!isApprovedAttribute(attribute)) return null;
  return QUESTIONS.find((question) => question.attribute === attribute) ?? null;
}
