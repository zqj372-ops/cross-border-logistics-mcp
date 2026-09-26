import type { z } from "zod";
import type { customsReferenceData } from "../../services/customs-native/reference";
export function renderCustomsReference(ui: { esc: (value: unknown) => string; panel: (title: string, subtitle: string, body: string) => string; note: (message: string, tone?: string) => string }, data: z.infer<typeof customsReferenceData>): string;
