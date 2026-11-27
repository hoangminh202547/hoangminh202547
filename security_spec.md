# Security Specification — Vận Hành TPCN (RBAC & Work Schedule)

## 1. Data Invariants
1. **Bootstrapped Super Admin & Authorized Email Allowlist**: Only `hoangminh202547@gmail.com` (verified) and active verified emails listed in `authorized_emails/{emailKey}` can access application collections.
2. **Prevent Self-Assigned Privileges**: Only verified Admins (`isAdmin()`) can create, update, list, or delete entries in `authorized_emails`. Users can only read (`get`) their own `authorized_emails/{authEmailKey()}` record.
3. **Immutable Super Admin Protection**: `hoangminh202547@gmail.com` cannot be deactivated or deleted via `authorized_emails` mutations.
4. **Work Schedule 4-Tier RBAC (`view` / `edit` / `manage` / `admin`)**:
   - `view`: Can register own shifts (`shiftRegistrations` with `status == 'pending'`, `staffUid == request.auth.uid`, `createdBy == request.auth.uid`), read/list own registrations, delete own `pending` registrations, read published `workSchedules` (`isPublished == true`), and read `scheduleConfigs/weekly_matrix`.
   - `edit`: All `view` rights + create/update `workSchedules` and create/update `scheduleConfigs/weekly_matrix`. Cannot approve/reject/delete registrations or delete `workSchedules`.
   - `manage`: All `edit` rights + list/read all `shiftRegistrations`, approve/reject/delete `shiftRegistrations`, and delete `workSchedules`.
   - `admin`: Full rights including `authorized_emails` management and terminal state overrides.
5. **Strict Schema, Array Bounds & Temporal Integrity**: All writes validate `hasAll` + `hasOnly` keys, string/array `.size()` bounds (`note <= 300`, `memberUids.size() <= 200`), `isValidId()`, `affectedKeys().hasOnly(...)`, terminal status locking, and `request.time` timestamps.

## 2. Dirty Dozen Attack Payloads (Expected: PERMISSION_DENIED)
1. Unauthenticated read/list on `/barcode_scans`, `/shiftRegistrations`, `/workSchedules`, or `/authorized_emails`
2. Verified non-authorized Gmail (`stranger@gmail.com`) listing `/shiftRegistrations` or `/workSchedules`
3. Non-admin `staff` creating `/authorized_emails` with `role: 'admin'`
4. Deactivated user (`active: false`) creating a `/shiftRegistrations` document
5. `view` role attempting to create or update `/workSchedules` or `/scheduleConfigs/weekly_matrix`
6. `view` or `edit` role attempting to approve (`/shiftRegistrations` status -> `approved`) or delete another user's `/shiftRegistrations`
7. `view` user trying to delete an already `approved` or `rejected` own `/shiftRegistrations`
8. Spoofed `staffUid` or `createdBy` when creating `/shiftRegistrations`
9. Oversized `note` (> 300 chars) or shadow field (`isAdmin: true`) on `/shiftRegistrations` or `/workSchedules`
10. Unverified email user (`email_verified: false`) writing to any collection
11. `edit` user attempting to delete a `/workSchedules` document (`manage`+ required)
12. Path ID mismatch or forged client `createdAt` timestamp on `/workSchedules` or `/shiftRegistrations`
