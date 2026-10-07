# TaskFlow Pro Integration Guide

This document outlines how work on the **DashBorad Project** (ReconCentral) is tracked and managed on **TaskFlow Pro**.

> **Security note (2026-10-04):** Earlier revisions of this document
> committed a live TaskFlow PAT in §3.3 (line 79). The PAT was
> committed on 2026-09-10 in `db37fd7` and remained in master until
> the security/redact-taskflow-pat PR. The PAT is replaced below
> with `<TASKFLOW_PAT — …>` placeholder. The original token is still
> valid in git history — rotate it in TaskFlow project settings and
> optionally scrub history with `git filter-repo` if a full revocation
> is required. See [`docs/SECURITY_AUDIT_2026-10-03.md`](SECURITY_AUDIT_2026-10-03.md)
> for the audit finding.

---

## 1. Overview
TaskFlow Pro is the project and task management system for our engineering team. All coding tasks, audits, fixes, and features must be mirrored in TaskFlow Pro so teammates and managers have real-time visibility into development progress.

- **Web Dashboard**: [https://task.youthnic.shop/](https://task.youthnic.shop/)
- **Default Project Name**: `DashBorad Project` (ID: `ee11667b-fe64-4f33-9d07-b81c4ce1d99f`)
- **Connected Account**: Pawan Shukla (`returnorders@vbexports.co.in`)

---

## 2. Agent & Developer Lifecycle

### Step 1: Session Kickoff
At the beginning of any task or debugging session, call `sync_coding_work`:
```json
{
  "project_name": "DashBorad Project",
  "task_title": "Descriptive task title (e.g. Myntra EJ/VB Audit & Order Blank Tracking Logic)",
  "task_description": "Detailed explanation of what is being built, audited, or fixed.",
  "status": "in_progress"
}
```
*The response returns `task.id` and `task_url`.*

### Step 2: In-Progress Updates
As major changes, migrations, or tests are run:
```json
{
  "project_name": "DashBorad Project",
  "task_title": "Descriptive task title",
  "task_id": "<TASK_UUID_FROM_STEP_1>",
  "progress_note": "Detailed note: files modified, migrations applied, test suite status.",
  "status": "in_progress"
}
```

### Step 3: Review / Approval
When changes are staged or awaiting user/manager review:
```json
{
  "project_name": "DashBorad Project",
  "task_title": "Descriptive task title",
  "task_id": "<TASK_UUID_FROM_STEP_1>",
  "progress_note": "Implementation complete. Pending user approval / PR merge.",
  "status": "in_review"
}
```

### Step 4: Completion
When verification is complete, all tests pass, and work is delivered:
```json
{
  "project_name": "DashBorad Project",
  "task_title": "Descriptive task title",
  "task_id": "<TASK_UUID_FROM_STEP_1>",
  "progress_note": "All tests passed. Changes deployed/merged successfully.",
  "status": "done"
}
```

---

## 3. Rules & Boundaries
1. **Assignment**: Every task must be assigned to the user owning the PAT (`returnorders@vbexports.co.in`). Never create unassigned tasks.
2. **Persistence**: Code commits, PRs, and documentation stay in Git (`git`/`gh`). TaskFlow Pro tracks status, lifecycle, and progress notes.
3. **MCP Configuration**:
   The MCP server is registered in `~/.gemini/config/mcp_config.json`:
   ```json
   "taskflow-pro": {
     "type": "http",
     "url": "https://nekdjoquirhecmejuoba.supabase.co/functions/v1/mcp-server",
     "serverUrl": "https://nekdjoquirhecmejuoba.supabase.co/functions/v1/mcp-server",
     "headers": {
       "Authorization": "<TASKFLOW_PAT — load from your local MCP config (~/.gemini/config/mcp_config.json) or ~/.minimax/mcp.json. NEVER commit a live PAT to the repo.>"
     }
   }
   ```
