# Scheduled Discord creator-origin hotfix

OpenClaw 2026.10.10 drops an external caller origin when exporting both requester and management cron grants. A fresh Discord-created test persisted an authenticated Discord requester but no caller origin; its scheduled read then failed at the creator-origin guard.

The Docker build applies a narrowly scoped workaround to the installed authority bundle. It retains a host-captured external origin only when the scope's private, authenticated channel requester matches that origin's provider. Existing local-origin behavior is preserved. Unknown origins, provider mismatches, missing requester proof, expired grants, exact caller identity, and revocation checks keep their existing restrictions. No job-store authorization records are edited.

The patch requires the exact OpenClaw version and exact expected capture statements. An upstream version or bundle change fails the build for review. Remove this workaround once an upstream release contains a verified fix.

Every image build runs `verify-openclaw-cron-origin.mjs` against the real patched OpenClaw authority module and host run registry. Its ten scenarios cover requester and management provenance, unknown and mismatched origins, missing native identity, copied-result mutation, wrong run or method, caller substitution, grant reuse, and revocation. The first scenario fails against the original unpatched 2026.10.10 module.

Existing jobs with missing provenance still need a supported explicit tool-cap update from the original authenticated Discord conversation, or fresh creation there. Starting a job manually does not supply missing creator authorization.
