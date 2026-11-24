# Security Specification — Barcode & Work Schedule App

## 1. Data Invariants
1. **Strict Ownership**: Every document in `users/{userId}`, `barcode_scans/{scanId}`, and `work_schedules/{scheduleId}` belongs strictly to the authenticated, email-verified user whose `request.auth.uid` matches `userId` / `ownerId`.
2. **No Shadow Fields**: Creates and updates enforce strict key allowlists (`hasAll` + `hasOnly` on create, `affectedKeys().hasOnly(...)` on update).
3. **Immutable Audit Fields**: `ownerId`, `ownerEmail`, `scannedAt` (on scans), and `createdAt` (on schedules) cannot be altered after creation.
4. **Temporal Integrity**: `scannedAt`, `createdAt`, and `updatedAt` must equal `request.time`.
5. **Terminal State Locking**: Once a `work_schedules` entry transitions to `status == 'cancelled'`, further updates are blocked.
6. **Path ID & Payload Bounds**: Every document ID must match `^[a-zA-Z0-9_-]+$` (`<= 128` chars), and every string/number field has explicit type and range checks.

## 2. Dirty Dozen Attack Payloads (Expected: PERMISSION_DENIED)
1. Unauthenticated read/list on `/barcode_scans`
2. Unverified email user attempting to create a `/barcode_scans` document
3. Spoofed `ownerId` (`"victim_uid"`) when creating a `/barcode_scans` document
4. Shadow field injection (`{ isAdmin: true }`) on `/users/{uid}` create
5. Oversized `code` (`> 200` chars) on `/barcode_scans` create
6. Negative or zero `quantity` (`0` or `-5`) on `/barcode_scans` create
7. Client-forged `scannedAt` timestamp (not `request.time`) on `/barcode_scans` create
8. Cross-user `get` or `list` attempt on another user's `/work_schedules`
9. Invalid `workDate` format (`"2026/11/24"`) on `/work_schedules` create
10. Updating a `work_schedules` document after its `status` is `'cancelled'`
11. Mutating immutable `ownerId` or `createdAt` during `/work_schedules` update
12. Junk document ID (`"../../bad$id"` or `> 128` chars) on single-doc create
