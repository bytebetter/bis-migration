import {
  createdDateSortLogLine,
  reconcileCreatedDateSortCheckpoint,
  resolveMssqlCreatedDateColumn,
} from "./mssqlCreatedDateSort.mjs";

/**
 * resolve CreatedDate + สร้าง select bundle สำหรับตาราง
 * @param {import("mssql").ConnectionPool} mssqlPool
 * @param {{ migrationConfig: object, sourceSchema?: string, sourceTable: string, tableLabel: string, createSelectBundle: (createdDateColumn: string | null) => object }} opts
 */
export async function setupCreatedDateMigrationSort(mssqlPool, opts) {
  const {
    migrationConfig,
    sourceSchema = "dbo",
    sourceTable,
    tableLabel,
    createSelectBundle,
  } = opts;
  const createdDateColumn = await resolveMssqlCreatedDateColumn(mssqlPool, {
    migrationConfig,
    sourceSchema,
    sourceTable,
    tableLabel,
  });
  const sortBundle = createSelectBundle(createdDateColumn);
  console.error(createdDateSortLogLine(tableLabel, sortBundle));
  if (createdDateColumn) {
    console.error(
      `>>> [${tableLabel}] แนะนำ index MSSQL: CREATE NONCLUSTERED INDEX IX_${sourceTable}_CreatedDate ON ${sourceSchema}.${sourceTable} (CreatedDate, Exam_ID); — ช่วย keyset pagination เร็วขึ้นมาก`,
    );
  }
  return sortBundle;
}

/**
 * โหลด offset / keyset จาก checkpoint พร้อมรีเซ็ตเมื่ออัปเกรด sort v2
 */
export function initCreatedDateKeysetState(
  checkpoint,
  checkpointEnabled,
  sortBundle,
  {
    legacyNumericDefault = 0,
    legacyNumericField = "afterExamId",
  } = {},
) {
  let offset = Number(checkpointEnabled ? checkpoint.offset : 0);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  let numericAfter = Number(
    checkpointEnabled ? checkpoint[legacyNumericField] : legacyNumericDefault,
  );
  if (!Number.isFinite(numericAfter) || numericAfter < legacyNumericDefault) {
    numericAfter = legacyNumericDefault;
  }

  const useCreatedDateSort = sortBundle?.createdDateColumn != null;
  const reconciled = reconcileCreatedDateSortCheckpoint({
    checkpoint,
    sortKeyVersion: sortBundle?.sortKeyVersion,
    useCreatedDateSort,
    legacyNumericAfter: legacyNumericDefault,
    legacyNumericFieldPresent: checkpoint[legacyNumericField] != null,
  });

  if (reconciled.sortKeyVersionUpgraded) {
    offset = 0;
    numericAfter = legacyNumericDefault;
  }

  return {
    offset,
    numericAfter,
    mssqlKeysetAfter: reconciled.mssqlKeysetAfter,
    sortKeyVersionUpgraded: reconciled.sortKeyVersionUpgraded,
  };
}
