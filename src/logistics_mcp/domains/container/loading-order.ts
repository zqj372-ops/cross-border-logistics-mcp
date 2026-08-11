import type { Notice } from "../../platform/envelope";
import {
  validateLoadingConstraints,
  validateLoadingLines,
  type LoadingConstraints,
  type LoadingLine,
} from "./constraints";

export interface LoadingOrderResult {
  readonly loading_order: readonly string[];
  readonly explanations: readonly string[];
  readonly warnings: readonly Notice[];
  readonly conflict: boolean;
}

interface RankedLine {
  readonly line: LoadingLine;
  readonly index: number;
  readonly rank: number;
}

function invalidInput(message: string): Error {
  return new TypeError(message);
}

function isTailLine(line: LoadingLine): boolean {
  return line.declaration_required || line.inspection_required === true;
}

function lineRank(
  line: LoadingLine,
  constraints: LoadingConstraints,
): { readonly rank: number; readonly conflict: boolean } {
  const tailLine = isTailLine(line);
  const headConflict =
    line.sensitive &&
    tailLine &&
    constraints.sensitive_at_head &&
    constraints.declaration_at_tail;

  if (line.sensitive && constraints.sensitive_at_head) {
    return { rank: 0, conflict: headConflict };
  }
  if (tailLine && constraints.declaration_at_tail) {
    return { rank: 3, conflict: false };
  }
  if (line.customer_priority !== null) {
    return { rank: 1, conflict: false };
  }
  return { rank: 2, conflict: false };
}

function loadingConflictNotice(): Notice {
  return {
    code: "container.loading.constraint-conflict",
    message:
      "同一货物同时满足敏感货置前与申报/查验货置尾，顺序按敏感货置前输出，并需要人工复核。",
    severity: "warning",
    field: "loading_constraints",
  };
}

export function deriveLoadingOrder(
  inputLines: readonly LoadingLine[],
  inputConstraints: LoadingConstraints,
): LoadingOrderResult {
  const constraints = validateLoadingConstraints(inputConstraints);
  if (!constraints.ok) {
    throw invalidInput(constraints.issues[0]?.message ?? "Invalid loading constraints.");
  }
  const lines = validateLoadingLines(inputLines);
  if (!lines.ok) {
    throw invalidInput(lines.issues[0]?.message ?? "Invalid loading lines.");
  }

  const warnings: Notice[] = [];
  const rankedLines: RankedLine[] = lines.value.map((line, index) => {
    const ranked = lineRank(line, constraints.value);
    if (ranked.conflict) {
      warnings.push(loadingConflictNotice());
    }
    return { line, index, rank: ranked.rank };
  });

  rankedLines.sort((left, right) => {
    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    if (
      left.rank === 1 &&
      left.line.customer_priority !== null &&
      right.line.customer_priority !== null &&
      left.line.customer_priority !== right.line.customer_priority
    ) {
      return left.line.customer_priority - right.line.customer_priority;
    }
    if (constraints.value.fifo_for_other && left.index !== right.index) {
      return left.index - right.index;
    }
    return left.index - right.index;
  });

  const explanations = rankedLines.map(({ line, rank }) => {
    if (rank === 0) {
      return `${line.line_id}: 敏感货物按约束置前。`;
    }
    if (rank === 1) {
      return `${line.line_id}: 按客户优先级 ${line.customer_priority ?? "未提供"} 排序。`;
    }
    if (rank === 3) {
      return `${line.line_id}: 申报/查验货物按约束置尾。`;
    }
    return `${line.line_id}: 普通货物保持输入 FIFO 顺序。`;
  });

  return {
    loading_order: rankedLines.map(({ line }) => line.line_id),
    explanations,
    warnings,
    conflict: warnings.length > 0,
  };
}
