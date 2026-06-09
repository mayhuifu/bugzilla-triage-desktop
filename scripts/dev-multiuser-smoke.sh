#!/usr/bin/env bash
# scripts/dev-multiuser-smoke.sh — Phase 2 acceptance: two-user server smoke.
# Needs TWO real Bugzilla API keys. Run on a machine that can reach Bugzilla.
#
# Boot the server in multi-user mode:
#
#   MULTI_USER=1 \
#   APP_SECRET="$(openssl rand -hex 32)" \
#   PROFILES_DB=/tmp/bt-profiles.db \
#   BUGZILLA_URL=https://your-bugzilla.example.com \
#   BUGZILLA_INSECURE=true \
#   COMPANY_LLM_PROVIDER=openai-compatible \
#   COMPANY_LLM_BASE_URL=https://api.deepseek.com \
#   COMPANY_LLM_API_KEY=sk-... \
#   COMPANY_LLM_MODEL=deepseek-chat \
#   npm run dev
#
# Then verify (the gating part is already auto-smoked; this is the SUCCESS +
# attribution path that needs real keys):
#
# 1. No session is gated:
#      curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/whoami     # → 401
#
# 2. User A sets up (browser, fresh cookie jar) — http://localhost:3000/setup
#      email = userA@company.com, userA's Bugzilla API key, "Use company AI".
#    After "Get started" you're redirected home and /api/whoami returns USER A.
#
# 3. User B sets up in a SEPARATE browser/profile (separate cookie jar):
#      email = userB@company.com, userB's Bugzilla API key.
#    /api/whoami in B's browser returns USER B.
#
# 4. ATTRIBUTION: have A triage a ticket and post a comment → it appears in
#    Bugzilla authored by USER A. Have B do the same → authored by USER B.
#    (Each uses their own stored key via getEffectiveSettings → runWithUser.)
#
# 5. No cross-contamination: A's requests never use B's key. Confirm the store
#    holds both, encrypted:
#      sqlite3 /tmp/bt-profiles.db \
#        "SELECT email, length(bugzilla_key_enc)>0 AS has_key FROM users; \
#         SELECT count(*) AS sessions FROM sessions;"
#
# PASS when: (1) 401 without session; (2)/(3) each browser resolves to the right
# identity; (4) writes are attributed to the acting user in Bugzilla; (5) two
# encrypted user rows + ≥2 sessions, no key leakage between users.
echo "This is a runbook — read the comments. It needs two real Bugzilla keys."
