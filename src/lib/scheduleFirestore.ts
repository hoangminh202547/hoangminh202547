import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { OperationType, auth, db, handleFirestoreError } from './firebase';
import { getShiftMeta, isValidScheduleShiftCode } from './scheduleMeta';
import type {
  OfficialWorkSchedule,
  ScheduleMatrixConfig,
  ScheduleMatrixSortMode,
  ScheduleShiftCode,
  ShiftRegistration,
  ShiftRegistrationStatus,
} from '../types';

function toIso(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (typeof (val as Timestamp).toDate === 'function') {
    return (val as Timestamp).toDate().toISOString();
  }
  if (val instanceof Date) return val.toISOString();
  return null;
}

function buildMemberUids(primaryUid: string, extraUids: string[] = []): string[] {
  const actorUid = auth.currentUser?.uid || primaryUid;
  const set = new Set<string>();
  if (primaryUid && /^[a-zA-Z0-9_-]+$/.test(primaryUid)) set.add(primaryUid);
  if (actorUid && /^[a-zA-Z0-9_-]+$/.test(actorUid)) set.add(actorUid);
  for (const u of extraUids) {
    if (u && /^[a-zA-Z0-9_-]+$/.test(u) && set.size < 180) {
      set.add(u);
    }
  }
  return Array.from(set);
}

function mapRegistration(id: string, data: Record<string, unknown>): ShiftRegistration {
  const rawShift = data.shiftType;
  const shiftType: ScheduleShiftCode = isValidScheduleShiftCode(rawShift)
    ? rawShift
    : 'ca_sang';
  const rawStatus = String(data.status || 'pending');
  const status: ShiftRegistrationStatus =
    rawStatus === 'approved' || rawStatus === 'rejected' ? rawStatus : 'pending';

  return {
    id,
    staffUid: String(data.staffUid || ''),
    staffName: String(data.staffName || ''),
    department: String(data.department || ''),
    date: String(data.date || ''),
    shiftType,
    note: String(data.note || ''),
    status,
    memberUids: Array.isArray(data.memberUids)
      ? data.memberUids.filter((x): x is string => typeof x === 'string')
      : [],
    createdBy: String(data.createdBy || ''),
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
  };
}

function mapWorkSchedule(
  id: string,
  data: Record<string, unknown>
): OfficialWorkSchedule {
  const rawShift = data.shiftType;
  const shiftType: ScheduleShiftCode = isValidScheduleShiftCode(rawShift)
    ? rawShift
    : 'ca_sang';
  const meta = getShiftMeta(shiftType);

  return {
    id,
    staffUid: String(data.staffUid || ''),
    staffName: String(data.staffName || ''),
    department: String(data.department || ''),
    date: String(data.date || ''),
    shiftType,
    startTime: String(data.startTime || meta.startTime),
    endTime: String(data.endTime || meta.endTime),
    isPublished: data.isPublished !== false,
    sourceRegId: typeof data.sourceRegId === 'string' ? data.sourceRegId : null,
    note: String(data.note || ''),
    isTrucDam: Boolean(data.isTrucDam),
    memberUids: Array.isArray(data.memberUids)
      ? data.memberUids.filter((x): x is string => typeof x === 'string')
      : [],
    createdBy: String(data.createdBy || ''),
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
  };
}

export function subscribeShiftRegistrations(
  staffUid: string,
  canManageAll: boolean,
  onData: (rows: ShiftRegistration[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'shiftRegistrations';
  const ref = canManageAll
    ? collection(db, path)
    : query(collection(db, path), where('staffUid', '==', staffUid));

  return onSnapshot(
    ref,
    (snapshot) => {
      const list = snapshot.docs.map((d) =>
        mapRegistration(d.id, d.data() as Record<string, unknown>)
      );
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export function subscribeWorkSchedules(
  canEditOrMore: boolean,
  onData: (rows: OfficialWorkSchedule[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'workSchedules';
  const ref = canEditOrMore
    ? collection(db, path)
    : query(collection(db, path), where('isPublished', '==', true));

  return onSnapshot(
    ref,
    (snapshot) => {
      const list = snapshot.docs.map((d) =>
        mapWorkSchedule(d.id, d.data() as Record<string, unknown>)
      );
      list.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.startTime.localeCompare(b.startTime);
      });
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

const DEFAULT_MATRIX_CONFIG: ScheduleMatrixConfig = {
  sortMode: 'name_asc',
  customOrder: [],
  hiddenUids: [],
  memberUids: [],
  updatedBy: '',
  updatedByName: '',
  createdAt: null,
  updatedAt: null,
};

export function subscribeScheduleMatrixConfig(
  onData: (config: ScheduleMatrixConfig | null) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'scheduleConfigs/weekly_matrix';
  return onSnapshot(
    doc(db, 'scheduleConfigs', 'weekly_matrix'),
    (snap) => {
      if (!snap.exists()) {
        onData(null);
        return;
      }
      const data = snap.data() as Record<string, unknown>;
      const rawSort = String(data.sortMode || 'name_asc');
      const sortMode: ScheduleMatrixSortMode =
        rawSort === 'custom' ||
        rawSort === 'name_asc' ||
        rawSort === 'name_desc' ||
        rawSort === 'position_asc' ||
        rawSort === 'shifts_desc'
          ? rawSort
          : 'name_asc';
      onData({
        sortMode,
        customOrder: Array.isArray(data.customOrder)
          ? data.customOrder.filter((x): x is string => typeof x === 'string')
          : [],
        hiddenUids: Array.isArray(data.hiddenUids)
          ? data.hiddenUids.filter((x): x is string => typeof x === 'string')
          : [],
        memberUids: Array.isArray(data.memberUids)
          ? data.memberUids.filter((x): x is string => typeof x === 'string')
          : [],
        updatedBy: String(data.updatedBy || ''),
        updatedByName: String(data.updatedByName || ''),
        createdAt: toIso(data.createdAt),
        updatedAt: toIso(data.updatedAt),
      });
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export async function createShiftRegistrationsBatch(params: {
  staffUid: string;
  staffName: string;
  department: string;
  shiftType: ScheduleShiftCode;
  dates: string[];
  note: string;
  memberUids?: string[];
}): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    throw new Error('Phiên Google Auth chưa sẵn sàng. Vui lòng đăng nhập lại.');
  }
  const path = 'shiftRegistrations';
  try {
    const batch = writeBatch(db);
    const safeName = (params.staffName.trim() || 'Nhân viên').slice(0, 120);
    const safeDept = params.department.trim().slice(0, 120);
    const safeNote = params.note.trim().slice(0, 300);
    const members = buildMemberUids(params.staffUid, params.memberUids);

    for (const date of params.dates) {
      const ref = doc(collection(db, path));
      batch.set(ref, {
        staffUid: params.staffUid,
        staffName: safeName,
        department: safeDept,
        date,
        shiftType: params.shiftType,
        note: safeNote,
        status: 'pending',
        memberUids: members,
        createdBy: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function approveRegistrationsAndPublish(
  regs: ShiftRegistration[],
  memberUids: string[] = []
): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    throw new Error('Phiên Google Auth chưa sẵn sàng.');
  }
  if (regs.length === 0) return;

  // Firestore batches support up to 500 writes (each reg takes 2 ops -> max 200 per batch)
  const chunkSize = 200;
  for (let i = 0; i < regs.length; i += chunkSize) {
    const chunk = regs.slice(i, i + chunkSize);
    const batch = writeBatch(db);
    for (const reg of chunk) {
      const regRef = doc(db, 'shiftRegistrations', reg.id);
      const schedRef = doc(collection(db, 'workSchedules'));
      const meta = getShiftMeta(reg.shiftType);
      const members = buildMemberUids(reg.staffUid, [
        ...reg.memberUids,
        ...memberUids,
      ]);

      batch.update(regRef, {
        status: 'approved',
        updatedAt: serverTimestamp(),
      });

      batch.set(schedRef, {
        staffUid: reg.staffUid,
        staffName: (reg.staffName || 'Nhân viên').slice(0, 120),
        department: (reg.department || '').slice(0, 120),
        date: reg.date,
        shiftType: reg.shiftType,
        startTime: meta.startTime,
        endTime: meta.endTime,
        isPublished: true,
        sourceRegId: reg.id,
        note: (reg.note || '').slice(0, 300),
        isTrucDam: false,
        memberUids: members,
        createdBy: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'shiftRegistrations');
    }
  }
}

export async function rejectShiftRegistration(regId: string): Promise<void> {
  const path = `shiftRegistrations/${regId}`;
  try {
    await updateDoc(doc(db, 'shiftRegistrations', regId), {
      status: 'rejected',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteShiftRegistration(regId: string): Promise<void> {
  const path = `shiftRegistrations/${regId}`;
  try {
    await deleteDoc(doc(db, 'shiftRegistrations', regId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createOfficialWorkSchedule(params: {
  staffUid: string;
  staffName: string;
  department: string;
  date: string;
  shiftType: ScheduleShiftCode;
  startTime: string;
  endTime: string;
  isTrucDam: boolean;
  note: string;
  memberUids?: string[];
}): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    throw new Error('Phiên Google Auth chưa sẵn sàng.');
  }
  const path = 'workSchedules';
  try {
    const meta = getShiftMeta(params.shiftType);
    const members = buildMemberUids(params.staffUid, params.memberUids);
    await addDoc(collection(db, path), {
      staffUid: params.staffUid,
      staffName: (params.staffName.trim() || 'Nhân viên').slice(0, 120),
      department: params.department.trim().slice(0, 120),
      date: params.date,
      shiftType: params.shiftType,
      startTime: meta.isOffDay ? '00:00' : params.startTime || meta.startTime,
      endTime: meta.isOffDay ? '00:00' : params.endTime || meta.endTime,
      isPublished: true,
      sourceRegId: null,
      note: params.note.trim().slice(0, 300),
      isTrucDam: meta.isOffDay ? false : Boolean(params.isTrucDam),
      memberUids: members,
      createdBy: uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateOfficialWorkSchedule(
  scheduleId: string,
  updates: {
    staffUid: string;
    staffName: string;
    department: string;
    date: string;
    shiftType: ScheduleShiftCode;
    startTime: string;
    endTime: string;
    isTrucDam: boolean;
    note: string;
    memberUids?: string[];
  }
): Promise<void> {
  const path = `workSchedules/${scheduleId}`;
  try {
    const meta = getShiftMeta(updates.shiftType);
    const members = buildMemberUids(updates.staffUid, updates.memberUids);
    await updateDoc(doc(db, 'workSchedules', scheduleId), {
      staffUid: updates.staffUid,
      staffName: (updates.staffName.trim() || 'Nhân viên').slice(0, 120),
      department: updates.department.trim().slice(0, 120),
      date: updates.date,
      shiftType: updates.shiftType,
      startTime: meta.isOffDay ? '00:00' : updates.startTime || meta.startTime,
      endTime: meta.isOffDay ? '00:00' : updates.endTime || meta.endTime,
      isPublished: true,
      note: updates.note.trim().slice(0, 300),
      isTrucDam: meta.isOffDay ? false : Boolean(updates.isTrucDam),
      memberUids: members,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteOfficialWorkSchedule(scheduleId: string): Promise<void> {
  const path = `workSchedules/${scheduleId}`;
  try {
    await deleteDoc(doc(db, 'workSchedules', scheduleId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function saveScheduleMatrixConfig(params: {
  sortMode: ScheduleMatrixSortMode;
  customOrder: string[];
  hiddenUids: string[];
  memberUids?: string[];
  updatedByName: string;
}): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    throw new Error('Phiên Google Auth chưa sẵn sàng.');
  }
  const path = 'scheduleConfigs/weekly_matrix';
  const ref = doc(db, 'scheduleConfigs', 'weekly_matrix');
  const members = buildMemberUids(uid, params.memberUids);
  const cleanOrder = params.customOrder
    .filter((id) => /^[a-zA-Z0-9_-]+$/.test(id))
    .slice(0, 300);
  const cleanHidden = params.hiddenUids
    .filter((id) => /^[a-zA-Z0-9_-]+$/.test(id))
    .slice(0, 300);

  try {
    const existingSnap = await getDoc(ref);
    if (existingSnap.exists()) {
      await updateDoc(ref, {
        sortMode: params.sortMode,
        customOrder: cleanOrder,
        hiddenUids: cleanHidden,
        memberUids: members,
        updatedBy: uid,
        updatedByName: (params.updatedByName.trim() || 'Quản lý').slice(0, 120),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        sortMode: params.sortMode,
        customOrder: cleanOrder,
        hiddenUids: cleanHidden,
        memberUids: members,
        updatedBy: uid,
        updatedByName: (params.updatedByName.trim() || 'Quản lý').slice(0, 120),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export { DEFAULT_MATRIX_CONFIG };
