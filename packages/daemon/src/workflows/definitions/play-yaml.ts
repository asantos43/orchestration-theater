// SPDX-License-Identifier: MPL-2.0
/**
 * The text of 'play.yaml', embedded so the daemon does not read a file at run time (the bundle of
 * the release has no source tree). [proposta] 'play-definition.test.ts' fails when this copy and
 * the '.yaml' next to it differ: edit the '.yaml' and paste it here.
 */
export const PLAY_DEFINITION_YAML = `# The official play, version 2.0 (plan of Phase 11b, P3; decision D2/N311). It has the states of the
# hand-written machine it replaced (1.x), with NEED folded into 'start'. Every choice of this file is
# a [proposta]: the plan fixes the states, 'skip' and the counters of today.
#
# - 'inputs.skip' is the 'flows.<id>' of the configuration (N243) as a parameter: the optional steps
#   it leaves out, 'plan_review' and 'critique'. Empty: the whole play.
# - The loops are bounded by the counters of the machine (the 'limits' below are the 'moderate'
#   preset). The numbers a play really runs on are the ones of its 'limits' in the configuration:
#   the daemon keeps them in the play and the Producer may raise one ('raise_limit'). When a loop is
#   used up the play goes to the Producer, as it always did.
# - 'producer_rounds' only exists so that every cycle of the Producer's menu has a bound for the
#   validator; the machine of today does not count the Producer's choices, and neither does the 2.0.
# - What the machine has beyond these edges is pinned in 'play-definition.test.ts' (the failure of a
#   stage goes to AWAITING_PRODUCER as a failed step, not as an edge; the restarts that need an
#   output the step types do not have yet stay in the machine). [proposta]
id: play
version: 2.0.0
engine: '>=1 <2'
description: 'The play: plan, script, execution by the Actors, critique and delivery.'
inputs:
  skip: { type: { list: string }, default: [] }
nodes:
  planning: { step: plan, role: director }
  clarifying: { step: clarify }
  reviewing_plan: { step: review, role: reviewer, params: { subject: plan } }
  scripting: { step: script, role: scriptwriter }
  reviewing_script: { step: review, role: reviewer, params: { subject: script } }
  executing: { step: execute_dag, role: actor }
  integrating: { step: integrate }
  critiquing: { step: critique, role: critic }
  deciding: { step: decide, role: director }
  delivering: { step: deliver }
  awaiting_producer: { step: await_producer }
start: planning
edges:
  - planning -> clarifying when output.has_open_questions
  - planning -> scripting when "plan_review" in inputs.skip
  - planning -> reviewing_plan

  - clarifying -> scripting when "plan_review" in inputs.skip
  - clarifying -> reviewing_plan

  - { from: reviewing_plan, to: scripting, when: output.approved }
  - { from: reviewing_plan, to: planning, limit: plan_reviews, on_limit: awaiting_producer }

  - scripting -> reviewing_script when output.valid
  - { from: scripting, to: scripting, limit: script_validations, on_limit: awaiting_producer }

  - reviewing_script -> executing when output.approved
  - { from: reviewing_script, to: scripting, limit: script_vetoes, on_limit: awaiting_producer }

  - executing -> integrating when output.outcome == "completed"
  - {
      from: executing,
      to: scripting,
      when: output.outcome == "restart_script",
      limit: script_returns,
      on_limit: awaiting_producer,
    }
  - {
      from: executing,
      to: planning,
      when: output.outcome == "restart_plan",
      limit: structural_restarts,
      on_limit: awaiting_producer,
    }

  - integrating -> delivering when output.ok and "critique" in inputs.skip
  - integrating -> critiquing when output.ok
  - {
      from: integrating,
      to: scripting,
      when: not output.ok,
      limit: script_returns,
      on_limit: awaiting_producer,
    }

  - critiquing -> delivering when output.approved
  - { from: critiquing, to: deciding, limit: critic_rejections, on_limit: awaiting_producer }

  - deciding -> scripting when output.decision == "script"
  - deciding -> executing when output.decision == "execution"
  - deciding -> awaiting_producer

  - delivering -> done when output.outcome == "delivered"
  - delivering -> awaiting_producer

  - {
      from: awaiting_producer,
      to: planning,
      when: output.choice == "plan",
      limit: producer_rounds,
      on_limit: cancelled,
    }
  - {
      from: awaiting_producer,
      to: scripting,
      when: output.choice == "script",
      limit: producer_rounds,
      on_limit: cancelled,
    }
  - {
      from: awaiting_producer,
      to: executing,
      when: output.choice == "execution",
      limit: producer_rounds,
      on_limit: cancelled,
    }
  - {
      from: awaiting_producer,
      to: delivering,
      when: output.choice == "deliver",
      limit: producer_rounds,
      on_limit: cancelled,
    }
  - awaiting_producer -> cancelled
limits:
  plan_reviews: 2
  script_validations: 3
  script_vetoes: 2
  script_returns: 2
  structural_restarts: 1
  critic_rejections: 2
  producer_rounds: 20
`;
