# Antigravity Agent Guidelines & Core Memory

## Mandatory Workflow: TaskFlow Pro Integration

Whenever working on this codebase, **all coding sessions, tasks, bug fixes, refactors, and feature work must be tracked and synchronized on the TaskFlow Pro application**.

### Instructions:
1. **At the start of any coding session**:
   - Always call `sync_coding_work` with:
     - `project_name`: `"DashBorad Project"`
     - `task_title`: A clear, descriptive title of the specific task or feature being worked on.
     - `task_description`: Summary of what is being implemented, fixed, or audited.
     - `status`: `"in_progress"` (default)
   - This automatically creates/finds the project and assigns the task to the connected user (**Pawan Shukla** / `returnorders@vbexports.co.in`).

2. **During the session**:
   - Keep the same task updated by passing:
     - `task_id`: The task UUID returned from the initial call.
     - `progress_note`: What changed, what was tested, decisions made, PR links, etc.
     - `status`:
       - `"in_progress"` while implementing
       - `"in_review"` when a review or approval is needed / PR open
       - `"done"` when finished and verified

3. **Rules**:
   - **Do not create unassigned tasks**: The task must always be assigned to the connected user.
   - **Persistence**: Git commits, PRs, and documentation stay in the repo/coding tool; TaskFlow Pro tracks progress, accountability, and project status.
   - **MCP Server Connection**:
     - Remote Server URL: `https://nekdjoquirhecmejuoba.supabase.co/functions/v1/mcp-server`
     - MCP Config: Stored in `~/.gemini/config/mcp_config.json` under `taskflow-pro`.

## Marketplace Data Upload Architecture & Specifications

Whenever modifying, extending, or debugging data ingestion, orders, returns, settlements, or rate card mappings across any marketplace, **agents must strictly conform to [MARKETPLACE_DATA_UPLOAD_SPEC.md](MARKETPLACE_DATA_UPLOAD_SPEC.md)**.

### Core Architectural Invariants:
1. **Myntra Account Separation**:
   - `myntra_vb`: Seller ID `10708`
   - `myntra_ej`: Seller ID `45833`
   - Files with mismatched seller IDs must be rejected immediately with zero rows saved.
   - Blank tracking number rule: If tracking number is blank, order is marked `Delivered` with `return_type = 'RTO'`, and a synthesized return (`Cancel before ship`) is inserted into `returns`.
   - Return date resolution: If `return_created_date` is empty or 1970 epoch, fallback to `order_rto_date`.
2. **Amazon Pipeline**:
   - Zero synthetic keys: Never create synthetic `AMZ-{order_id}-{sku}` keys.
   - Flex returns column swap: file `SKU` = FNSKU; file `mSKU` = Merchant SKU (backend maps `mSKU -> sku` and `SKU -> fnsku`).
   - Settlement V2 join strategy: joins via `order_item_code` or `order_id` at query time; unlinked rows are non-order deductions.
3. **Database Batching**:
   - Always batch multi-row inserts via `forEachDbBatch` to avoid PostgreSQL's 65,535 parameter limit.
   - Always invoke `refreshOrderSettlementTotals(pool)` after ingesting orders or settlement items.

