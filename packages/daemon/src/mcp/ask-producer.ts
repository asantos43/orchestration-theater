// SPDX-License-Identifier: MPL-2.0
import type { askProducerInput } from '@otheater/core';
import type { z } from 'zod';

/** How strict the daemon is about the questions of the Director (`chat.producer_questions`, 5.3). */
export const PRODUCER_QUESTION_MODES = ['choices', 'choices_strict', 'free'] as const;
export type ProducerQuestionMode = (typeof PRODUCER_QUESTION_MODES)[number];

/**
 * The rules of 5.3 that depend on the mode, applied after the zod schema:
 * - `choices` (default): a question without options passes only with the `open` mark; without it
 *   the validation error goes back to the Director, who asks again;
 * - `choices_strict`: every question needs options; free text is only the "Other" of the interface;
 * - `free`: no requirement.
 *
 * Returns the error texts, one per question, empty when the input passes.
 * [proposta] The key itself belongs to the chat step (P12); until it exists the server takes the
 * mode as an option, with the default of the architecture.
 */
export function producerQuestionErrors(
  input: z.infer<typeof askProducerInput>,
  mode: ProducerQuestionMode,
): readonly string[] {
  if (mode === 'free') return [];
  const errors: string[] = [];
  input.questions.forEach((question, index) => {
    const hasOptions = question.options !== undefined;
    if (mode === 'choices_strict' && !hasOptions) {
      errors.push(
        `questions[${String(index)}]: every question needs 2 to 4 options (chat.producer_questions is choices_strict); free text is only the "Other" the interface adds`,
      );
    } else if (mode === 'choices' && !hasOptions && !question.open) {
      errors.push(
        `questions[${String(index)}]: give 2 to 4 options, or set "open": true for a question that does not fit options`,
      );
    }
  });
  return errors;
}
