# Security Specification — Barcode & Work Schedule App (RBAC)

## 1. Data Invariants
1. **Bootstrapped Super Admin & Authorized Email Allowlist**: Only `hoangminh202547@gmail.com` (verified) and active emails listed in `authorized_emails/{emailKey}` can access `barcode_scans` and `work_schedules`.
2. **Prevent Self-Assigned Privileges**: Only verified Admins (`isAdmin()`) can create, update, list, or delete entries in `authorized_emails`. Users can only read (`get`) their own `authorized_emails/{authEmailKey()}` record.
3. **Immutable Super Admin Protection**: `hoangminh202547@gmail.com` cannot be deactivated or deleted via `authorized_emails` mutations.
4. **Module & Role Enforcement**:
   - `viewer`: Read-only access to `barcode_scans` and `work_schedules`; all writes rejected.
   - `staff`: Can create/update/delete only their own documents (`ownerId == request.auth.uid`) in modules enabled for them (`allowBarcode`, `allowSchedule`).
   - `manager`: Can read and manage team scans/schedules (`isManagerOrAdmin()`).
   - `admin`: Full access including `authorized_emails` management and cancelled schedule override.
5. **No Shadow Fields & Temporal Integrity**: All writes validate strict `hasAll` + `hasOnly` keys, `affectedKeys().hasOnly(...)`, and `request.time` timestamps.

## 2. Dirty Dozen Attack Payloads (Expected: PERMISSION_DENIED)
1. Unauthenticated read/list on `/barcode_scans` or `/authorized_emails`
2. Verified but non-authorized Gmail (`stranger@gmail.com`) listing `/barcode_scans` or `/work_schedules`
3. Non-admin `staff` attempting to create their own `/authorized_emails` record with `role: 'admin'`
4. Deactivated user (`active: false`) attempting to create a `/barcode_scans` document
5. `viewer` role attempting to create or delete a `/work_schedules` entry
6. `staff` without `allowBarcode: true` attempting to write to `/barcode_scans`
7. `staff` attempting to update or delete another user's `/work_schedules` document
8. Attempting to deactivate or delete the super admin `hoangminh202547@gmail.com` in `/authorized_emails`
9. Spoofed `ownerId` (`"victim_uid"`) when creating a `/barcode_scans` document
10. Unverified email user attempting to read or write any collection
11. Updating a `work_schedules` document by non-admin after `status` is `'cancelled'`
12. Path ID mismatch (`emailToKey(email) != emailId`) or oversized string on `/authorized_emails/{emailId}`
