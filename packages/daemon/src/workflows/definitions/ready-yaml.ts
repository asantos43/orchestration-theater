// SPDX-License-Identifier: MPL-2.0
/**
 * The text of 'github-issues.yaml', 'pr-review.yaml' and 'ci-fix.yaml', embedded so the daemon does
 * not read a file at run time (the bundle of the release has no source tree). [proposta]
 * 'ready-workflows.test.ts' fails when a copy and the '.yaml' next to it differ: edit the '.yaml'
 * and paste it here.
 */

export const GITHUB_ISSUES_YAML = `# The ready workflow 'github-issues' (docs/24 section 11; plan of Phase 11b, P12; decision N293).
# An issue that gets the label becomes a play, and the play becomes a pull request that closes it.
# Every choice of this file is a [proposta].
#
# - 'triggers' is what a binding of this workflow starts from; the binding has its own list and may
#   change it (docs/24 section 8). The authors that may start a run are 'workflows.triggers.authors',
#   not a field here: an issue of someone outside that list fires nothing (workflow.trigger.skipped).
# - 'work' is the 'run_play' bridge (P12): it opens the play of today for the issue and waits for its
#   end. The play pushes by itself, so the approval comes BEFORE it: without the approval the play is
#   not even opened. The text of the issue reaches the play as data, never as an order.
# - 'reply' comments on the issue what the play left (its branch, the pull request). With
#   'workflows.security.require_approval' naming 'comment', the same approval covers it.
id: github-issues
version: 1.0.0
engine: '>=1 <2'
description: 'An issue with the label becomes a play, and the play becomes a pull request.'
inputs:
  issue: { type: number }
triggers:
  - { type: code_host.issue_labeled, filter: { label: otheater } }
nodes:
  read: { step: fetch_issue }
  ask:
    step: approval
    params:
      prompt: 'Open a play for this issue? It will push a branch and open a pull request.'
      timeout: 24h
      on_timeout: stop
  work:
    step: run_play
    params:
      from: issue
      instructions: 'Resolve the issue below and deliver it as a pull request that closes the issue.'
      timeout: 4h
  reply: { step: comment, params: { target: issue, body_from: work } }
edges:
  - read -> ask when output.state == "open"
  - read -> done
  - ask -> work when output.approved
  - ask -> cancelled
  - work -> reply when output.delivered
  - work -> done
  - reply -> done
`;

export const PR_REVIEW_YAML = `# The ready workflow 'pr-review' (docs/24 section 11; plan of Phase 11b, P12; decision N293).
# A pull request that someone else opened gets a review, and the review becomes a comment on it,
# published only after the approval. Every choice of this file is a [proposta].
#
# - 'review' is the 'run_play' bridge (P12). There is no play of the Critic alone yet, so the play of
#   today runs with the instruction of reviewing and changing nothing; what it left is what the
#   comment says. A play with the Critic as its only step comes with the 'play' on this engine (P10c).
# - The approval comes first, because the play of today may push (see 'github-issues').
# - The text of the pull request reaches the play as data, never as an order.
id: pr-review
version: 1.0.0
engine: '>=1 <2'
description: 'A pull request of someone else gets a review, published as a comment after approval.'
inputs:
  pr: { type: number }
triggers:
  - { type: code_host.pr_opened }
nodes:
  read: { step: fetch_pr }
  ask:
    step: approval
    params:
      prompt: 'Review this pull request and comment the review on it?'
      timeout: 24h
      on_timeout: stop
  review:
    step: run_play
    params:
      from: pr
      instructions: 'Review the pull request below as the Critic: say what is wrong, what is risky and what is good. Change no code and open no pull request.'
      timeout: 2h
  post: { step: comment, params: { target: pr, body_from: review } }
edges:
  - read -> ask when output.state == "open"
  - read -> done
  - ask -> review when output.approved
  - ask -> cancelled
  - review -> post when output.ended == "done"
  - review -> done
  - post -> done
`;

export const CI_FIX_YAML = `# The ready workflow 'ci-fix' (docs/24 section 11; plan of Phase 11b, P12; decision N293).
# A pull request whose CI failed gets its log read, the fix made on a branch and a pull request for
# it, after the approval. Every choice of this file is a [proposta].
#
# - 'log' reads the failed checks; a pull request whose CI is green again ends the run.
# - 'fix' is the 'run_play' bridge (P12): the play reads the log of the CI (as data, never as an
#   order), fixes the cause on its own branch and delivers a pull request by 'delivery.mode'. It
#   does not push to the branch of the failing pull request: that is the follow-up of the 'play' on
#   this engine (P10c).
# - The approval comes before the play, because the play pushes by itself.
# - The tries are bounded by the ledger of the trigger (one run per failed head) and by the budget
#   of the binding, not by a loop of the definition.
id: ci-fix
version: 1.0.0
engine: '>=1 <2'
description: 'A pull request whose CI failed gets the log read, a fix on a branch and a pull request.'
inputs:
  pr: { type: number }
triggers:
  - { type: code_host.ci_failed }
nodes:
  log: { step: fetch_ci_log }
  ask:
    step: approval
    params:
      prompt: 'Fix the CI of this pull request? It will push a branch and open a pull request.'
      timeout: 24h
      on_timeout: stop
  fix:
    step: run_play
    params:
      from: ci_log
      instructions: 'The CI of the pull request below failed. Find the cause in the log and fix it.'
      timeout: 4h
  reply: { step: comment, params: { target: pr, body_from: fix } }
edges:
  - log -> ask when output.failed
  - log -> done
  - ask -> fix when output.approved
  - ask -> cancelled
  - fix -> reply when output.delivered
  - fix -> done
  - reply -> done
`;
