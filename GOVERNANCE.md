# Governance

How decisions get made in minamo, who can make them, and how that set of people can grow.

This document is deliberately honest about the project's current size. minamo is a small, design-led
library with a **single maintainer**. The goal of writing governance down now — before it is strictly
necessary — is to make the path to a second maintainer explicit, because resolving the single-maintainer
risk is one of the stated conditions for the 1.0.0 release (see [`docs/concept.md`](docs/concept.md) §12
and [`docs/roadmap-v1.md`](docs/roadmap-v1.md) §5).

## 1. Current state

- **Sole maintainer:** [@seike460](https://github.com/seike460). Bus factor is **1**, and this is stated
  plainly rather than hidden.
- **No SLA.** Bug fixes, security fixes, reviews, and releases are all best-effort. See
  [`SECURITY.md`](SECURITY.md) for the (best-effort) vulnerability-response timeline.
- **Forking is a first-class option.** minamo is MIT-licensed. If the maintainer becomes unresponsive,
  or you disagree with a scope decision, forking is a legitimate and supported outcome — not a failure
  state. See §6.
- **Scope is fixed by design, not by neglect.** The public API follows `docs/concept.md` §5 verbatim,
  and the permanent non-goals are listed in §6 of that document. "We will not build that" is a valid,
  common answer here.

## 2. Decision-making

Technical decisions are recorded, not just made. The audit trail is the mechanism that lets a second
person trust — and eventually share — the maintainer's judgment.

- **Design decisions live in `docs/concept.md` §11 (the `DEC-NNN` log).** Every entry carries four
  parts: trigger, decision, rationale, and rejected alternatives. A change to the public API surface is
  expected to land with a corresponding DEC.
- **Scope is defended via §6 Non-Goals.** Proposals that fall outside the declared scope (Read-model
  persistence, Sagas, CDK constructs, multi-DB support, …) are declined on principle. This keeps the
  library thin enough for one or two people to maintain.
- **Proposal flow:**
  1. Open an issue or a discussion describing the problem (not just a patch).
  2. Reach rough agreement on whether it fits the scope and how it should look.
  3. For anything touching the public surface, draft (or co-author) the DEC.
  4. Send the PR. CI must be green, and Contract Tests must pass against **both** `InMemoryEventStore`
     and `DynamoEventStore` where applicable.
- **Disagreement:** the maintainer has the final call while bus factor is 1. Co-maintainers (§3) share
  that call. Persistent, fundamental disagreement is a legitimate reason to fork (§6).

## 3. Roles & responsibilities

Roles are a ladder, not a wall. Each rung is earned through demonstrated work, and the criteria are
intentionally concrete so the path is legible.

| Role | What they can do | How you get there |
|---|---|---|
| **Contributor** | Open issues, discussions, and PRs. Anyone. | Just contribute. |
| **Committer** | Triage issues, review PRs, and merge changes that are clearly in-scope and CI-green. No release authority. | Invited after a track record of in-scope, high-quality PRs and useful reviews. |
| **Co-maintainer** | Everything a committer does, plus: share design authority (co-author DECs, decide scope calls), and hold release authority (§5). | Invited per §4. Resolves bus factor = 1. |

Responsibilities scale with the role. A co-maintainer is expected to uphold the same discipline the
project is built on: scope restraint, the DEC audit trail, Contract-Test parity, and honest
communication about capacity.

## 4. Becoming a co-maintainer

This is the section that matters most for the project's long-term health, so it is spelled out.

**What earns an invitation (not a checklist to game, but the shape of what we look for):**

- A sustained history of merged, in-scope PRs — enough that the maintainer can predict your judgment.
- Demonstrated respect for the scope (`docs/concept.md` §6) and the design posture (§4 "設計の姿勢"):
  thin, strict, framework-free, and not wrapping AWS primitives away from the consumer.
- Discipline with the things that keep this library trustworthy: Contract Tests against both stores,
  `instanceof` invariants for error classes, `exactOptionalPropertyTypes`-safe code, and DECs for
  surface changes.
- Helpful, accurate participation in reviews and issues — including saying "this is out of scope."
- A credible signal of continuity: you intend to be around, and you communicate when you cannot be.

**Process:**

1. The maintainer (or an existing co-maintainer) extends an invitation, or you may express interest in
   an issue/discussion and ask what would make the case.
2. Agreement is reached publicly in an issue, referencing the work that supports it.
3. Access is granted incrementally: `CODEOWNERS` / review rights first, then release authority (§5)
   once the OIDC trusted-publishing and branch-protection implications are set up.

**What a co-maintainer is *not* asked to do:** provide an SLA, be on call, or accept scope creep. The
no-SLA, best-effort posture (§1) applies to maintainers too.

## 5. Release authority

Releases are automated and provenance-backed, which keeps the trusted surface small (see
[`RELEASE.md`](RELEASE.md) and `docs/concept.md` DEC-016).

- Pipeline: Changesets → `changesets/action@v1` opens a Release PR → merging it runs `release.yml`,
  which publishes to npm with **provenance** via **npm Trusted Publishing (OIDC)**, scoped to the
  `seike460/minamo` repository and the `release.yml` workflow.
- Because publishing is tied to the repository's OIDC identity (not a personal token), release authority
  is effectively "able to merge the Release PR." Granting it to a co-maintainer is a branch-protection /
  `CODEOWNERS` change, not a secret hand-off.
- Versioning is SemVer. While on `0.x`, breaking changes are allowed but preceded by one release of
  deprecation warning. The conditions for cutting `1.0.0` are in `docs/concept.md` §12.

## 6. Fork & succession

- **Forking is always permitted** (MIT) and is the intended escape hatch if the maintainer goes inactive
  or a scope disagreement is irreconcilable. A fork is not a hostile act here.
- **If the maintainer becomes unresponsive for an extended period**, the realistic path for the community
  is to fork and continue under a new name, or — if a trusted co-maintainer exists — to hand off the npm
  package and repository. minamo will state plainly in the README if it becomes unmaintained, consistent
  with the project's dog-fooding honesty principle (`docs/concept.md` §12).
- **The library is intentionally small** precisely so that a fork, or a single successor, can carry it
  without inheriting an unmaintainable surface.

---

Questions about governance can be raised in a GitHub discussion or issue.
