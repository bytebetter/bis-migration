import fs from "node:fs";
import readline from "node:readline";

const PATHS = {
  mam: "exports/dbo.mammogram.1778687994264.json",
  mass: "exports/dbo.mammogram_mass.1778689200500.json",
  cal: "exports/dbo.mammogram_cal.1778688685378.json",
};

function loadRows(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return raw.rows;
}

function mapMam(row) {
  return {
    old_exam_id: row.Exam_ID,
    old_pid: row.PID,
    exam_date: row.Exam_Date,
    breast_composition: row.BreastComposition,
    breast_composition_des: row.BreastComposition_Des,
    implant: row.Implant,
    implant_des: row.Implant_Des,
    implant_finding: row.Implant_Finding,
    implant_finding_des: row.Implant_Finding_Des,
    technique: row.Technique,
    r_technique: row.r_technique,
    l_technique: row.l_technique,
    technique_des: row.Technique_Des,
    mass: row.Mass,
    mass_des: row.Mass_Des,
    num_of_mass_actual_found: row.Num_of_Mass_ActualFound,
    cal: row.Cal,
    cal_des: row.Cal_Des,
    num_of_cal_actual_found: row.Num_of_Cal_ActualFound,
    r_specialcase: row.r_specialcase,
    r_specialcase_des: row.r_specialcase_Des,
    l_specialcase: row.l_specialcase,
    l_specialcase_des: row.l_specialcase_Des,
    r_ass_finding: row.r_AssFinding,
    r_ass_finding_des: row.r_AssFinding_Des,
    l_ass_finding: row.l_AssFinding,
    l_ass_finding_des: row.l_AssFinding_Des,
    is_convert_from_old_system: row.IsConvertFromOldSystem,
    l_implant: row.l_Implant,
    l_implant_des: row.l_Implant_Des,
    l_implant_finding: row.l_Implant_Finding,
    l_implant_finding_des: row.l_Implant_Finding_Des,
    r_implant: row.Implant,
    r_implant_des: row.Implant_Des,
    r_implant_finding: row.Implant_Finding,
    r_implant_finding_des: row.Implant_Finding_Des,
  };
}

function mapMass(row) {
  return {
    described_mass_id: row.Described_Mass_ID,
    old_exam_id: row.Exam_ID,
    exam_date: row.Exam_Date,
    old_pid: row.PID,
    shape: row.Shape,
    shape_des: row.Shape_Des,
    wall_margin: row.Wall_Margin,
    wall_margin_des: row.Wall_Margin_Des,
    cal_in_mass: row.Cal_in_Mass,
    size_width: row.Size_Width,
    size_depth: row.Size_Depth,
    mass_density: row.Mass_Density,
    mass_density_des: row.Mass_Density_Des,
    l_position: row.l_Position,
    l_position_des: row.l_Position_Des,
    r_position: row.r_Position,
    r_position_des: row.r_Position_Des,
    depth: row.Depth,
    depth_des: row.Depth_Des,
    l_position_clock: row.l_Position_Clock,
    r_position_clock: row.r_Position_Clock,
  };
}

function mapCal(row) {
  return {
    described_cal_id: row.Described_Cal_ID,
    old_exam_id: row.Exam_ID,
    exam_date: row.Exam_Date,
    old_pid: row.PID,
    type: row.Type,
    type_des: row.Type_Des,
    distribution: row.Distribution,
    distribution_des: row.Distribution_Des,
    r_position: row.r_Position,
    r_position_des: row.r_Position_Des,
    l_position: row.l_Position,
    l_position_des: row.l_Position_Des,
    l_position_clock: row.l_Position_Clock,
    r_position_clock: row.r_Position_Clock,
  };
}

async function findMamRow(examId) {
  const rl = readline.createInterface({
    input: fs.createReadStream(PATHS.mam, { encoding: "utf8" }),
  });
  let inRows = false;
  for await (const line of rl) {
    if (line.includes('"rows": [')) {
      inRows = true;
      continue;
    }
    if (!inRows) continue;
    if (line.trim() === "],") break;
    const trimmed = line.trim().replace(/,$/, "");
    if (!trimmed.startsWith("{")) continue;
    const row = JSON.parse(trimmed);
    if (row.Exam_ID === examId) return row;
  }
  return null;
}

async function streamMamRows(onRow) {
  const rl = readline.createInterface({
    input: fs.createReadStream(PATHS.mam, { encoding: "utf8" }),
  });
  let inRows = false;
  for await (const line of rl) {
    if (line.includes('"rows": [')) {
      inRows = true;
      continue;
    }
    if (!inRows) continue;
    if (line.trim() === "],") break;
    const trimmed = line.trim().replace(/,$/, "");
    if (!trimmed.startsWith("{")) continue;
    onRow(JSON.parse(trimmed));
  }
}

const massRows = loadRows(PATHS.mass);
const calRows = loadRows(PATHS.cal);
const massByExam = new Map();
for (const r of massRows) {
  const id = r.Exam_ID;
  if (!massByExam.has(id)) massByExam.set(id, []);
  massByExam.get(id).push(mapMass(r));
}
const calByExam = new Map();
for (const r of calRows) {
  const id = r.Exam_ID;
  if (!calByExam.has(id)) calByExam.set(id, []);
  calByExam.get(id).push(mapCal(r));
}

const stats = {
  mamRows: 0,
  calCode: new Map(),
  massCode: new Map(),
  calMissingNumWhenCode2: 0,
  calCode2WithNum: 0,
  calCountMismatch: 0,
  massMissingNumWhenCode2: 0,
  massCode2WithNum: 0,
  massCountMismatch: 0,
  mamWithoutMassRows: 0,
  mamWithoutCalRows: 0,
};

const mamIds = new Set();
await streamMamRows((row) => {
  stats.mamRows += 1;
  mamIds.add(row.Exam_ID);
  stats.calCode.set(row.Cal, (stats.calCode.get(row.Cal) ?? 0) + 1);
  stats.massCode.set(row.Mass, (stats.massCode.get(row.Mass) ?? 0) + 1);
  const calChild = calByExam.get(row.Exam_ID)?.length ?? 0;
  const massChild = massByExam.get(row.Exam_ID)?.length ?? 0;
  if (row.Cal === 2) {
    if (row.Num_of_Cal_ActualFound == null) stats.calMissingNumWhenCode2 += 1;
    else stats.calCode2WithNum += 1;
    if (
      row.Num_of_Cal_ActualFound != null &&
      row.Num_of_Cal_ActualFound > calChild
    ) {
      stats.calCountMismatch += 1;
    }
  }
  if (row.Mass === 2) {
    if (row.Num_of_Mass_ActualFound == null) stats.massMissingNumWhenCode2 += 1;
    else stats.massCode2WithNum += 1;
    if (
      row.Num_of_Mass_ActualFound != null &&
      row.Num_of_Mass_ActualFound > massChild
    ) {
      stats.massCountMismatch += 1;
    }
  }
  if (row.Mass !== 0 && row.Mass !== 1 && massChild === 0) {
    stats.mamWithoutMassRows += 1;
  }
  if (row.Cal !== 0 && row.Cal !== 1 && calChild === 0) {
    stats.mamWithoutCalRows += 1;
  }
});

let massRowsWithoutMam = 0;
for (const id of massByExam.keys()) {
  if (!mamIds.has(id)) massRowsWithoutMam += 1;
}
let calRowsWithoutMam = 0;
for (const id of calByExam.keys()) {
  if (!mamIds.has(id)) calRowsWithoutMam += 1;
}

const sampleExamIds = [6183890, 6186090, 6187220];
const samples = [];
for (const examId of sampleExamIds) {
  const mamLine = await findMamRow(examId);
  if (!mamLine) continue;
  samples.push({
    examination: {
      old_exam_id: String(examId),
      old_pid: mamLine.PID,
      mam: [mapMam(mamLine)],
      mammogram_mass: massByExam.get(examId) ?? [],
      mammogram_cal: calByExam.get(examId) ?? [],
    },
  });
}

const out = {
  draftNote:
    "จัดกลุ่มตามโครงฝั่ง Directus: examination -> mam + mammogram_mass + mammogram_cal",
  sourceFiles: {
    mam: "dbo.mammogram",
    mass: "dbo.mammogram_mass",
    cal: "dbo.mammogram_cal",
  },
  totals: {
    mammogram: stats.mamRows,
    mammogram_mass: massRows.length,
    mammogram_cal: calRows.length,
  },
  stats: {
    calCode: Object.fromEntries(stats.calCode),
    massCode: Object.fromEntries(stats.massCode),
    calMissingNumWhenCode2: stats.calMissingNumWhenCode2,
    calCode2WithNum: stats.calCode2WithNum,
    calCountMismatch: stats.calCountMismatch,
    massMissingNumWhenCode2: stats.massMissingNumWhenCode2,
    massCode2WithNum: stats.massCode2WithNum,
    massCountMismatch: stats.massCountMismatch,
    mamWithoutMassRows: stats.mamWithoutMassRows,
    mamWithoutCalRows: stats.mamWithoutCalRows,
    massRowsWithoutMam,
    calRowsWithoutMam,
  },
  samples,
};

fs.writeFileSync(
  "exports/mam-draft-nested.sample.json",
  `${JSON.stringify(out, null, 2)}\n`,
  "utf8",
);

const calDes = new Map();
const massDes = new Map();
await streamMamRows((row) => {
  const calKey = `${row.Cal}|${row.Cal_Des}`;
  calDes.set(calKey, (calDes.get(calKey) ?? 0) + 1);
  const massKey = `${row.Mass}|${row.Mass_Des}`;
  massDes.set(massKey, (massDes.get(massKey) ?? 0) + 1);
});
const codeSummary = {
  cal: [...calDes.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => {
      const [code, des] = key.split("|");
      return { code, des, count };
    }),
  mass: [...massDes.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => {
      const [code, des] = key.split("|");
      return { code, des, count };
    }),
};
fs.writeFileSync(
  "exports/mam-code-summary.json",
  `${JSON.stringify(codeSummary, null, 2)}\n`,
  "utf8",
);
console.error(JSON.stringify({ totals: out.totals, stats: out.stats }, null, 2));
